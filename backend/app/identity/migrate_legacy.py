"""存量单密码数据 → users/local/ 迁移工具 (v2.3 §5.3)。

背景:
  互通形态启用前, 服务端以「单密码模式」运行, 全部用户工件落在
  data/user_data/ 与 data/strategies/。互通启用后, 用户工件改存
  data/users/local/ (local 降级根, 无请求上下文的兜底路径)。
  本工具把存量数据迁到新位置, 保证互通启用后存量用户数据不丢。

语义 (v2.3 §5.1 三分法 + 代码实证):
  - 用户创建类工件迁: watchlist.parquet / watchlist_groups.json /
    monitor_rules/ / lots/ / custom_signals/ / custom_factors/ /
    strategy_overrides/ / research_candidates.json / strategies/ /
    ai_reports.json / ai_stock_reports.json / ai_market_recaps.json
  - 全局保留项不迁: auth.json (单密码核心) / sessions.json / secrets.json
    / preferences.json 全局层 (部署级键)
  - preferences.json 双层拆分: 部署级键留全局层, 用户级键搬 users/local/

触发条件:
  - 仅互通形态有意义 (identity_enabled()); 桌面版/未互通调用直接 no-op。
  - 默认 dry-run (只打印计划不落盘); --apply 才真正迁移。
  - 幂等: 目标已存在的工件跳过 (不覆盖), 可重复执行。

用法 (服务端互通启用时, 以独立工具运行):
  python -m app.identity.migrate_legacy            # dry-run
  python -m app.identity.migrate_legacy --apply    # 真正迁移
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

# 用户工件清单: data/user_data/ 下需要迁到 users/local/ 的条目
# (目录整体搬迁; 文件按名匹配)。
_ARTIFACT_ENTRIES: tuple[str, ...] = (
    "watchlist.parquet",
    "watchlist_groups.json",
    "monitor_rules",
    "lots",
    "custom_signals",
    "custom_factors",
    "strategy_overrides",
    "research_candidates.json",
    "ai_reports.json",
    "ai_stock_reports.json",
    "ai_market_recaps.json",
)

# data/strategies/ 整目录 (桌面版历史位置; 互通形态迁入用户根)
_STRATEGIES_DIR_NAME = "strategies"

# 全局保留项 (绝不迁移): auth.json (单密码) / sessions.json (会话) /
# secrets.json (密钥) / preferences.json (全局层=部署级键, 拆分处理见下)
_GLOBAL_KEEP = frozenset(
    {"auth.json", "sessions.json", "secrets.json", "preferences.json"}
)

# 迁移计划项: (源路径, 目标路径, 动作类型)
#   action: "move" 整项搬移 | "split_preferences" 拆分用户层
_PlanItem = tuple[Path, Path, str]


def _is_enabled() -> bool:
    """互通是否启用 (agti_dsn 非空)。"""
    from app.identity import pool as identity_pool

    return identity_pool.is_enabled()


def _split_preferences(data: dict) -> tuple[dict, dict]:
    """把 preferences 拆成 (部署级全局层, 用户级用户层)。

    与 preferences.py 的 _DEPLOY_KEYS 同源:
    部署级键留全局层, 其余 (个人 UI 偏好) 搬用户层。
    """
    from app.services.preferences import _DEPLOY_KEYS

    deploy = {k: v for k, v in data.items() if k in _DEPLOY_KEYS}
    user = {k: v for k, v in data.items() if k not in _DEPLOY_KEYS}
    return deploy, user


def _plan(data_dir: Path) -> list[_PlanItem]:
    """生成迁移计划 [(源, 目标, 动作), ...]。源不存在则跳过; 目标已存在则跳过 (幂等)。"""
    old_root = data_dir / "user_data"
    local_root = data_dir / "users" / "local"
    plan: list[_PlanItem] = []

    if not old_root.is_dir():
        logger.info("data/user_data 不存在, 无用户工件可迁")
    else:
        for entry in _ARTIFACT_ENTRIES:
            src = old_root / entry
            if not src.exists():
                continue
            dst = local_root / entry
            if dst.exists():
                logger.info("跳过 %s: 目标已存在 %s", entry, dst)
                continue
            plan.append((src, dst, "move"))

    # strategies/ 在 data/ 根下 (非 user_data/ 下), 单独处理
    src_strategies = data_dir / _STRATEGIES_DIR_NAME
    dst_strategies = local_root / _STRATEGIES_DIR_NAME
    if src_strategies.is_dir() and not dst_strategies.exists():
        plan.append((src_strategies, dst_strategies, "move"))

    # preferences.json 拆分: 用户级键 → users/local/preferences.json
    src_pref = old_root / "preferences.json"
    dst_pref = local_root / "preferences.json"
    if src_pref.is_file() and not dst_pref.exists():
        try:
            data = json.loads(src_pref.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            logger.warning("preferences.json 解析失败, 跳过拆分: %s", e)
        else:
            _, user_part = _split_preferences(data)
            if user_part:
                plan.append((src_pref, dst_pref, "split_preferences"))

    return plan


def _apply_move(src: Path, dst: Path) -> None:
    """整项迁移 (目录 shutil.move, 文件带 backup 原子搬)。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.move(str(src), str(dst))
    else:
        # 文件: 临时名 + os.replace, 避免半截
        tmp = dst.with_suffix(dst.suffix + ".migrating")
        shutil.copy2(src, tmp)
        os.replace(str(tmp), str(dst))
        src.unlink()


def _apply_split_preferences(src: Path, dst: Path) -> None:
    """拆分 preferences: 用户级键写入 dst, 部署级键留在 src (原地重写)。"""
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        logger.warning("preferences.json 解析失败, 跳过拆分: %s", e)
        return
    deploy, user = _split_preferences(data)
    if user:
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(dst.suffix + ".migrating")
        tmp.write_text(json.dumps(user, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(str(tmp), str(dst))
    # 全局层重写为只剩部署级键 (保留原文件, 非迁移)
    if deploy != data:
        tmp = src.with_suffix(src.suffix + ".migrating")
        tmp.write_text(json.dumps(deploy, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(str(tmp), str(src))


def run(data_dir: Path | None = None, *, apply: bool = False) -> dict:
    """执行迁移 (dry-run 或 apply). 返回结果统计。"""
    from app.config import settings

    data_dir = Path(data_dir or settings.data_dir)
    if not _is_enabled():
        return {"skipped": True, "reason": "identity not enabled (desktop/未互通)"}

    plan = _plan(data_dir)
    moved: list[str] = []
    skipped_existing: list[str] = []

    for src, dst, action in plan:
        if action == "move" and dst.exists():
            skipped_existing.append(str(dst))
            continue
        if apply:
            if action == "split_preferences":
                _apply_split_preferences(src, dst)
            else:
                _apply_move(src, dst)
            logger.info("迁移 %s → %s", src, dst)
        moved.append(str(src))

    return {
        "skipped": False,
        "apply": apply,
        "planned": len(plan),
        "moved": moved,
        "skipped_existing": skipped_existing,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="真正执行迁移 (默认 dry-run 只打印计划)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    result = run(apply=args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())