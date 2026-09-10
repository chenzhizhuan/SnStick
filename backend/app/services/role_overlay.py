"""角色权限覆盖层 — 运行时可视化调整「角色 → SnStick 菜单权限」 (方案 A, P2 通道)。

设计:
  - 基线 role_map.yaml 随代码版本管理 (镜像内只读); 本服务提供「运行时覆盖」。
  - 覆盖数据落盘 data_dir/role_overlay.json (随 ./data 卷持久化, 重启不丢)。
  - 合并优先级: overlay > 基线。overlay 只允许「收敛权限」(删减基线权限点),
    禁止「扩张」(新增基线没有的权限点), 防止管理员在页面上越权授出
    代码层未定义/未审查的权限点 (安全边界)。
  - 生效方式: 保存 overlay 后调用 reload_role_map() 清缓存, 进程内立即生效
    (无需重启容器, 与 P1 改 yaml+重启 相比是 P2 热加载通道)。
  - 权限判定 (permissions.role_perms) 合并 overlay: 角色权限 = 基线 ∪ overlay
    再做段级通配匹配 (与 _perm_matches 一致)。
  - 写路径严格只读 AGTi 库: overlay 只写本地 data_dir, 不触碰 agti 库 (P0 约束)。
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

# 覆盖文件相对 data_dir 的路径
_OVERLAY_REL = Path("role_overlay.json")

# 文件读写锁 (单进程内串行; 多进程部署需外部协调, 单容器部署无此问题)
_lock = threading.Lock()


def _overlay_path() -> Path:
    from app.config import settings

    return settings.data_dir / _OVERLAY_REL


def load_overlay() -> dict[str, list[str]]:
    """读覆盖层 → {role_key: [perms...]}。文件不存在/损坏 → {} (不抛, 基线生效)。"""
    p = _overlay_path()
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        logger.warning("role_overlay load failed: %s", e)
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[str]] = {}
    for key, val in raw.items():
        if isinstance(key, str) and isinstance(val, list):
            out[key] = [str(x) for x in val if isinstance(x, str)]
    return out


def save_overlay(data: dict[str, list[str]]) -> None:
    """原子写覆盖层到 data_dir/role_overlay.json (失败抛异常由 API 层处理)。"""
    p = _overlay_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(p)  # 原子替换, 避免写一半


def clear_overlay() -> None:
    """删除覆盖层 (恢复基线)。文件不存在时静默。"""
    p = _overlay_path()
    try:
        if p.exists():
            p.unlink()
    except OSError as e:  # noqa: BLE001
        logger.warning("role_overlay clear failed: %s", e)


def effective_role_perms(role_key: str, base: set[str]) -> set[str]:
    """合并基线 + overlay → 某角色最终权限集合 (段级匹配, 与 _perm_matches 对齐)。

    - 角色有覆盖: 只保留「基线中存在 且 与 overlay 任一项段级匹配」的权限。
      (基线含但覆盖未列出的权限点 → 视为关闭; 覆盖新增但基线没有 → 被忽略)
    - 角色无覆盖: 原样返回基线。
    """
    ov = load_overlay()
    if role_key not in ov:
        return set(base)
    ov_perms = ov[role_key]
    result: set[str] = set()
    for base_perm in base:
        if _perm_matches_segments(ov_perms, base_perm):
            result.add(base_perm)
    return result


def _perm_matches_segments(pattern_list: list[str], perm: str) -> bool:
    """perm 是否与 pattern_list 中任一模式段级匹配 (支持 *:x:x 通配, 同 permissions._perm_matches)。"""
    rr, rm, ra = [*perm.split(":"), "", ""][:3]
    for pat in pattern_list:
        pr, pm, pa = [*pat.split(":"), "", ""][:3]
        if (pr in ("*", rr)) and (pm in ("*", rm)) and (pa in ("*", ra)):
            return True
    return False