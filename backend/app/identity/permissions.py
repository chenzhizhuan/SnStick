"""权限判定 — role_map.yaml 加载 + RequirePerm FastAPI 依赖 (v2.3 定稿)。

设计:
  - 权限点命名: stick:<模块>:<动作> (admin 直通 *:*:*)
  - role_map.yaml 随代码版本管理, P1 改档 = 改 yaml + 重启 (生效 < 1 分钟)
  - 多角色取并集: 任一角色持有该权限点即通过
  - 判定基于会话身份快照 (request.state.identity), 不查库
  - 与 Capability 门控 (capset) 正交: 角色门控管功能, 能力门控管数据吞吐

使用:
    from app.identity.permissions import P_BACKTEST_RUN, require_perm

    @router.post("/backtest/run")
    async def run(..., _: None = Depends(require_perm(P_BACKTEST_RUN))):
        ...
"""
from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

# 运行时覆盖层: 改 role_map 不清缓存, 由 overlay 服务合并 (方案 A P2 通道)
from app.services.role_overlay import effective_role_perms

import yaml
from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

# ── 权限点常量 ────────────────────────────────────────────────
# 便于静态引用与 IDE 补全 (字符串也可直接用)
P_WATCHLIST_READ = "stick:watchlist:read"
P_WATCHLIST_WRITE = "stick:watchlist:write"
P_KLINE_READ = "stick:kline:read"
P_SCREENER_READ = "stick:screener:read"
P_SCREENER_RUN = "stick:screener:run"
P_STRATEGY_READ = "stick:strategy:read"
P_STRATEGY_WRITE = "stick:strategy:write"
P_SIGNALS_READ = "stick:signals:read"
P_SIGNALS_WRITE = "stick:signals:write"
P_BACKTEST_READ = "stick:backtest:read"
P_BACKTEST_RUN = "stick:backtest:run"
P_FACTORS_READ = "stick:factors:read"
P_FACTORS_WRITE = "stick:factors:write"
P_MINING_READ = "stick:mining:read"
P_MINING_RUN = "stick:mining:run"
P_INTRADAY_READ = "stick:intraday:read"
P_DEPTH_READ = "stick:depth:read"
P_FINANCIAL_READ = "stick:financial:read"
P_EXT_READ = "stick:ext:read"
P_EXT_WRITE = "stick:ext:write"
P_REGIME_READ = "stick:regime:read"
P_ANALYSIS_READ = "stick:analysis:read"
P_ANALYSIS_WRITE = "stick:analysis:write"
P_DATA_READ = "stick:data:read"
P_SETTINGS_READ = "stick:settings:read"
P_SETTINGS_WRITE = "stick:settings:write"
P_ADMIN_VIEW = "stick:admin:view"
P_ADMIN_MANAGE = "stick:admin:manage"

# ── 菜单可见性权限点 (方案 2: 页面级菜单差异化) ────────────────────
# 仅控制前端侧栏菜单「可见性」, 与功能权限点 (API 门禁) 完全正交。
# 命名: stick:menu:<页面slug>; admin 通配 *:*:* 自动覆盖全部菜单。
# 消费方: Layout.tsx nav / MenuSettings.tsx BUILTIN_PAGES (perm 字段)。
P_MENU_WATCHLIST = "stick:menu:watchlist"
P_MENU_SCREENER = "stick:menu:screener"
P_MENU_FACTORS = "stick:menu:factors"
P_MENU_BACKTEST = "stick:menu:backtest"
P_MENU_LOTS = "stick:menu:lots"
P_MENU_SIGNALS = "stick:menu:signals"
P_MENU_STOCK_ANALYSIS = "stick:menu:stock-analysis"
P_MENU_LIMIT_LADDER = "stick:menu:limit-ladder"
P_MENU_CONCEPT_ANALYSIS = "stick:menu:concept-analysis"
P_MENU_INDUSTRY_ANALYSIS = "stick:menu:industry-analysis"
P_MENU_FINANCIALS = "stick:menu:financials"
P_MENU_MONITOR = "stick:menu:monitor"
P_MENU_REGIME = "stick:menu:regime"
P_MENU_ABNORMAL = "stick:menu:abnormal"
P_MENU_REVIEW = "stick:menu:review"
P_MENU_INDICES = "stick:menu:indices"
P_MENU_DATA = "stick:menu:data"

_ADMIN_WILDCARD = "*:*:*"

# ── 角色元数据 (展示名 + 优先级, 单一事实来源) ─────────────────────
# 对齐 role_map.yaml 注释顺序; 下标越小角色越"有效" (权限层级越高)。
# 多角色用户取顺序最靠前者作为「最有效角色」用于前端展示。
ROLE_ORDER = ["admin", "enterprise", "mentor", "agent", "premium", "standard", "common"]

# 角色 → 中文展示名 (对齐 AGTi sys_role)
ROLE_LABELS = {
    "admin": "超级版",
    "enterprise": "企业版",
    "mentor": "导师版",
    "agent": "服务商",
    "premium": "高级版",
    "standard": "标准版",
    "common": "体验版",
}

_ROLE_RANK = {key: i for i, key in enumerate(ROLE_ORDER)}


def effective_role(roles: tuple[str, ...]) -> dict | None:
    """多角色 → 最有效角色 (展示名 + key)。

    取 ROLE_ORDER 中顺序最靠前者 (优先级最高)。无有效角色 → None。
    未知角色 (不在 ROLE_ORDER) 视为最低优先级, 仅作为兜底展示 raw key。
    """
    if not roles:
        return None
    best_key = min(roles, key=lambda r: _ROLE_RANK.get(r, len(ROLE_ORDER)))
    return {"key": best_key, "label": ROLE_LABELS.get(best_key, best_key)}


def role_label(key: str) -> str:
    """角色 key → 中文展示名 (未知角色回退 raw key)。"""
    return ROLE_LABELS.get(key, key)


class RoleMapError(RuntimeError):
    """role_map.yaml 加载/格式错误。"""


def _role_map_path() -> Path:
    """role_map.yaml 位置: frozen → 资源目录; 非 frozen → 项目根 + 回退。

    Docker 容器: _PROJECT_ROOT 解析为 / (config.py 上三级), 但 Dockerfile
    将 role_map.yaml 复制到 /app/role_map.yaml, 故加显式回退 (与 policy.py
    的 tiers.yaml 回退 Path("/app/tiers.yaml") 同一模式)。
    """
    from app.config import _IS_FROZEN, _PROJECT_ROOT, _RESOURCE_ROOT

    if _IS_FROZEN:
        return _RESOURCE_ROOT / "role_map.yaml"
    candidates = [
        _PROJECT_ROOT / "role_map.yaml",
        Path("/app/role_map.yaml"),
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]


def reload_role_map() -> None:
    """清空 role_map 缓存 (overlay 保存后调用, 进程内立即生效)。"""
    load_role_map.cache_clear()


@lru_cache(maxsize=1)
def load_role_map() -> dict[str, set[str]]:
    """加载 role_map.yaml → {role_key: set(perms)}。

    缓存: 启动期加载一次; P1 改档 = 改 yaml + 重启 (进程重启即重载)。
    解析失败抛 RoleMapError (启动即失败, 不静默降级)。
    """
    p = _role_map_path()
    if not p.exists():
        raise RoleMapError(f"role_map.yaml not found: {p}")
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except Exception as e:
        raise RoleMapError(f"role_map.yaml parse failed: {e}") from e

    roles = raw.get("roles") or {}
    if not isinstance(roles, dict) or not roles:
        raise RoleMapError("role_map.yaml: 'roles' section missing or empty")

    result: dict[str, set[str]] = {}
    for key, cfg in roles.items():
        perms = cfg.get("perms") if isinstance(cfg, dict) else None
        if not isinstance(perms, list) or not perms:
            raise RoleMapError(f"role_map.yaml: role '{key}' perms missing/empty")
        result[key] = {str(x) for x in perms}
    return result


def role_perms(roles: tuple[str, ...]) -> set[str]:
    """多角色 → 权限并集 (admin 直通 *:*:*)。"""
    if not roles:
        return set()
    rm = load_role_map()
    merged: set[str] = set()
    for r in roles:
        if r == "admin":
            return {_ADMIN_WILDCARD}
        merged |= effective_role_perms(r, rm.get(r, set()))
    return merged


def _perm_matches(perms: set[str], required: str) -> bool:
    """权限点匹配: 支持 admin 通配 *:*:* 与段级通配 (*:backtest:run)。"""
    if _ADMIN_WILDCARD in perms:
        return True
    for p in perms:
        if p == required:
            return True
        pr, pm, pa = [*p.split(":"), "", ""][:3]
        rr, rm, ra = [*required.split(":"), "", ""][:3]
        if (pr in ("*", rr)) and (pm in ("*", rm)) and (pa in ("*", ra)):
            return True
    return False


def has_perm(roles: tuple[str, ...], required: str) -> bool:
    """身份角色 → 是否持有某权限点 (快照判定, 零 IO)。"""
    if not roles:
        return False
    return _perm_matches(role_perms(roles), required)


# ── FastAPI 依赖 ────────────────────────────────────────────────
def current_identity(request: Request) -> dict | None:
    """取中间件注入的当前身份 (互通形态) / None (单密码)。"""
    return getattr(request.state, "identity", None)


def current_roles(request: Request) -> tuple[str, ...]:
    identity = current_identity(request)
    if identity:
        return tuple(identity.get("roles") or ())
    return ()


def require_perm(perm: str):
    """FastAPI 依赖工厂: 权限不足 → 403 NO_PERM (区别于未登录 401)。

    用法:
        @router.post("/backtest/run")
        async def run(..., _: None = Depends(require_perm(P_BACKTEST_RUN))):
            ...
    单密码模式 (互通未启用, 无身份角色) → 放行 (桌面版/未互通部署零改动)。
    互通形态下未登录/角色不足 → 403 NO_PERM。
    """

    def _dep(request: Request) -> None:
        from app.identity import pool as identity_pool

        # 单密码模式 (桌面版 / 未开通互通): 不启用角色门控, 保持原行为
        if not identity_pool.is_enabled():
            return
        roles = current_roles(request)
        if not roles or not has_perm(roles, perm):
            # 审计: 权限拒绝事件 (异步落盘, 不阻塞业务)
            try:
                from app.services import audit
                audit.no_perm(
                    (current_identity(request) or {}).get("user_name", ""),
                    request.url.path,
                    perm,
                )
            except Exception:  # noqa: BLE001 审计失败绝不影响门禁
                pass
            raise HTTPException(
                status_code=403,
                detail="无权限访问该功能",
                headers={"X-Error-Code": "NO_PERM"},
            )

    return _dep