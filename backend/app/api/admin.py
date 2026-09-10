"""平台管理 API — 运行指标 + 审计查询 (方案 B, v2.2 设计文档 §7 / 验收 P120)。

端点 (均挂 P_ADMIN_VIEW, 无权限 → 403 NO_PERM):
  GET /api/admin/metrics — 平台运行指标 (八类, 见文档 P120):
      在线会话数 / 登录成功·失败·锁定计数 / AGTi 身份库连接状态 /
      role_map 加载状态 / NO_PERM 拒绝计数 / 审计写盘健康度 / 会话上限
  GET /api/admin/audit  — 审计事件查询 (JSONL 按天滚动):
      参数: day(YYYY-MM-DD, 默认今天) / limit(默认 200, ≤500) / category(security|access|admin)

设计约束:
  - agti 库严格只读, 用户管理/改密/订阅留在 AGTi 平台 (本页只读观测 + 审计)。
  - admin_action 审计由后续 admin:manage 操作端点使用 (当前只读页面无写操作)。
  - 全部数据来自内存态 + 本地 JSONL, 不查身份库 (metrics 仅含连接状态探测)。
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request

from app.identity.permissions import (
    P_ADMIN_MANAGE,
    P_ADMIN_VIEW,
    ROLE_LABELS,
    ROLE_ORDER,
    current_identity,
    require_perm,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])

_START_TS = time.time()


def _sessions_stats() -> dict:
    """在线会话统计 (identity_auth 内存态)。"""
    from app.services import identity_auth as ia

    with ia._sessions_lock:
        sessions = dict(ia._sessions)
    now = time.time()
    active = [s for s in sessions.values() if s.get("expires_at", 0) > now]
    stale = len(sessions) - len(active)
    return {"total": len(sessions), "active": len(active), "stale": stale}


def _role_map_stats() -> dict:
    """role_map.yaml 加载状态 (permissions 模块)。"""
    from app.identity import permissions

    try:
        rm = permissions.load_role_map()
        return {
            "loaded": True,
            "roles": sorted(rm.keys()),
            "role_count": len(rm),
        }
    except Exception as e:  # noqa: BLE001
        return {"loaded": False, "error": str(e)}


async def _agti_health() -> dict:
    """AGTi 身份库连接状态 (pool 健康探测)。"""
    from app.identity import pool as identity_pool

    if not identity_pool.is_enabled():
        return {"enabled": False, "ok": None, "latency_ms": None}
    try:
        health = await identity_pool.health_check()
        return {
            "enabled": True,
            "ok": health.ok,
            "latency_ms": health.latency_ms if health.ok else None,
            "error": health.error if not health.ok else None,
        }
    except Exception as e:  # noqa: BLE001
        return {"enabled": True, "ok": False, "error": str(e)}


@router.get("/metrics")
async def admin_metrics(_: None = Depends(require_perm(P_ADMIN_VIEW))) -> dict:
    """平台运行指标 (八类)。"""
    from app.services import audit

    audit_metrics = audit.get_metrics()
    sessions = _sessions_stats()
    role_map = _role_map_stats()
    agti = await _agti_health()

    def _cnt(key: str) -> int:
        return audit_metrics.get(key, {}).get("count", 0)

    def _last(key: str) -> float | None:
        t = audit_metrics.get(key, {}).get("last_ts")
        return t if t else None

    return {
        "sessions": sessions,
        "login": {
            "ok": _cnt("login_ok"),
            "fail": _cnt("login_fail"),
            "locked": _cnt("login_locked"),
            "last_ok_ts": _last("login_ok"),
            "last_fail_ts": _last("login_fail"),
            "last_locked_ts": _last("login_locked"),
        },
        "access": {
            "no_perm_count": _cnt("no_perm"),
            "last_no_perm_ts": _last("no_perm"),
        },
        "admin": {
            "action_count": _cnt("admin_action"),
            "last_action_ts": _last("admin_action"),
        },
        "agti": agti,
        "role_map": role_map,
        "audit": {
            "write_ok": _cnt("write_ok"),
            "write_fail": _cnt("write_fail"),
            "queue_full": _cnt("queue_full"),
            "queue_size": audit.queue_size(),
        },
        "server": {
            "uptime_s": round(time.time() - _START_TS),
            "now_ts": time.time(),
        },
    }


@router.get("/audit")
async def admin_audit(
    _: None = Depends(require_perm(P_ADMIN_VIEW)),
    day: str = None,
    limit: int = 200,
    category: str = None,
) -> dict:
    """审计事件查询 (默认今天, 倒序最新在前)。"""
    if day:
        from datetime import datetime as _dt

        try:
            _dt.strptime(str(day), "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="day 须为合法日期 YYYY-MM-DD") from None
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit 须在 1-500")
    if category and category not in ("security", "access", "admin"):
        raise HTTPException(status_code=400, detail="category 须为 security/access/admin")

    from app.services import audit

    items = audit.read_audit(day=day, limit=limit, category=category)
    return {
        "ok": True,
        "day": day or audit.today_str(),
        "count": len(items),
        "items": items,
    }


# ── 角色权限矩阵 (方案 A: 可视化授权 P2 通道) ─────────────────────────
# 角色展示顺序 / 中文名复用 permissions.py 的 ROLE_ORDER / ROLE_LABELS (单一事实来源)

# 权限点 → 归属菜单 (功能分组, 供页面矩阵展示; 与 Layout.tsx NAV / role_map 注释一致)
_PERM_MENU_GROUPS: list[dict] = [
    {
        "label": "自选股",
        "perms": [
            {"key": "stick:watchlist:read", "label": "查看自选"},
            {"key": "stick:watchlist:write", "label": "编辑自选"},
        ],
    },
    {
        "label": "行情",
        "perms": [
            {"key": "stick:kline:read", "label": "日K/指数"},
            {"key": "stick:intraday:read", "label": "分钟K"},
            {"key": "stick:depth:read", "label": "五档盘口"},
        ],
    },
    {
        "label": "选股与策略",
        "perms": [
            {"key": "stick:screener:read", "label": "策略库浏览"},
            {"key": "stick:screener:run", "label": "策略运行"},
            {"key": "stick:strategy:read", "label": "策略读取"},
            {"key": "stick:strategy:write", "label": "策略保存"},
        ],
    },
    {
        "label": "信号",
        "perms": [
            {"key": "stick:signals:read", "label": "信号查看"},
            {"key": "stick:signals:write", "label": "信号编辑"},
        ],
    },
    {
        "label": "回测与因子",
        "perms": [
            {"key": "stick:backtest:read", "label": "回测查看"},
            {"key": "stick:backtest:run", "label": "回测运行"},
            {"key": "stick:factors:read", "label": "因子查看"},
            {"key": "stick:factors:write", "label": "因子编辑"},
            {"key": "stick:mining:read", "label": "因子挖掘查看"},
            {"key": "stick:mining:run", "label": "因子挖掘运行"},
        ],
    },
    {
        "label": "市场分析",
        "perms": [
            {"key": "stick:analysis:read", "label": "分析查看"},
            {"key": "stick:analysis:write", "label": "分析编辑"},
            {"key": "stick:regime:read", "label": "市场环境"},
            {"key": "stick:financial:read", "label": "财务分析"},
        ],
    },
    {
        "label": "数据与扩展",
        "perms": [
            {"key": "stick:data:read", "label": "数据管理"},
            {"key": "stick:data:write", "label": "数据治理操作"},
            {"key": "stick:ext:read", "label": "扩展读取"},
            {"key": "stick:ext:write", "label": "扩展写入"},
        ],
    },
    {
        "label": "设置与平台",
        "perms": [
            {"key": "stick:settings:read", "label": "设置读取"},
            {"key": "stick:settings:write", "label": "设置修改"},
            {"key": "stick:admin:view", "label": "平台管理查看"},
            {"key": "stick:admin:manage", "label": "平台管理操作"},
        ],
    },
    {
        "label": "菜单可见性 (页面级)",
        "perms": [
            {"key": "stick:menu:watchlist", "label": "自选菜单"},
            {"key": "stick:menu:screener", "label": "策略菜单"},
            {"key": "stick:menu:factors", "label": "因子菜单"},
            {"key": "stick:menu:backtest", "label": "回测菜单"},
            {"key": "stick:menu:lots", "label": "持仓提醒菜单"},
            {"key": "stick:menu:signals", "label": "信号库菜单"},
            {"key": "stick:menu:stock-analysis", "label": "个股分析菜单"},
            {"key": "stick:menu:limit-ladder", "label": "连板梯队菜单"},
            {"key": "stick:menu:concept-analysis", "label": "概念分析菜单"},
            {"key": "stick:menu:industry-analysis", "label": "行业分析菜单"},
            {"key": "stick:menu:financials", "label": "财务分析菜单"},
            {"key": "stick:menu:monitor", "label": "监控中心菜单"},
            {"key": "stick:menu:regime", "label": "市场环境菜单"},
            {"key": "stick:menu:abnormal", "label": "异动监控菜单"},
            {"key": "stick:menu:review", "label": "复盘菜单"},
            {"key": "stick:menu:indices", "label": "指数菜单"},
            {"key": "stick:menu:data", "label": "数据菜单"},
        ],
    },
]


def _all_perms() -> list[str]:
    """矩阵里全部权限点 (按 _PERM_MENU_GROUPS 顺序去重)。"""
    out: list[str] = []
    seen: set[str] = set()
    for grp in _PERM_MENU_GROUPS:
        for p in grp["perms"]:
            k = p["key"]
            if k not in seen:
                seen.add(k)
                out.append(k)
    return out


def _overlay_payload() -> dict:
    """统一载荷: 基线 + 覆盖 (生效后) + 菜单分组 + 角色展示名。"""
    from app.identity import permissions
    from app.services import role_overlay

    base = permissions.load_role_map()
    overlay = role_overlay.load_overlay()

    effective: dict[str, list[str]] = {}
    for rkey in ROLE_ORDER:
        if rkey not in base:
            continue
        effective[rkey] = sorted(role_overlay.effective_role_perms(rkey, base[rkey]))

    return {
        "ok": True,
        "roles": [
            {
                "key": rkey,
                "label": ROLE_LABELS.get(rkey, rkey),
                "base": sorted(base.get(rkey, set())),
                "overlay": sorted(overlay.get(rkey, [])),
                "effective": effective[rkey],
            }
            for rkey in ROLE_ORDER
            if rkey in base
        ],
        "groups": _PERM_MENU_GROUPS,
        "all_perms": _all_perms(),
    }


# ── 角色权限矩阵 API ────────────────────────────────────────────

@router.get("/role-map")
async def admin_role_map(_: None = Depends(require_perm(P_ADMIN_VIEW))) -> dict:
    """读取角色→权限矩阵 (基线+覆盖+生效后), 供可视化授权页展示。"""
    return _overlay_payload()


@router.put("/role-map")
async def admin_role_map_update(
    request: Request,
    _: None = Depends(require_perm(P_ADMIN_MANAGE)),
    payload: dict = Body(...),
) -> dict:
    """保存角色权限覆盖 (可视化授权保存)。

    约束 (安全边界):
      - 只允许覆盖 _PERM_MENU_GROUPS 中声明的权限点 (即平台全量合法权限白名单)。
      - 覆盖为「全量授权」语义: 覆盖集合即该角色最终生效权限, 相对基线可收敛也可扩张。
      - admin 角色不可覆盖 (通配 *:*:* 由代码硬控, 页面只读)。
      - 不触碰 AGTi 库, 只写本地 data_dir/role_overlay.json (P0 只读约束)。
    生效: 写盘 → 审计 admin_action → 清 role_map 缓存 → 立即生效 (进程内)。
    """
    from app.identity import permissions
    from app.services import audit, role_overlay

    allowed = set(_all_perms())
    base = permissions.load_role_map()

    roles_in = payload.get("roles")
    if not isinstance(roles_in, dict):
        raise HTTPException(status_code=400, detail="payload.roles 须为对象 {role_key: [perms]}")

    overlay: dict[str, list[str]] = {}
    for rkey, perms in roles_in.items():
        if not isinstance(rkey, str) or rkey not in base:
            raise HTTPException(status_code=400, detail=f"未知角色: {rkey}")
        if rkey == "admin":
            raise HTTPException(status_code=400, detail="admin 角色不可覆盖 (系统通配直通)")
        if not isinstance(perms, list) or not all(isinstance(p, str) for p in perms):
            raise HTTPException(status_code=400, detail=f"角色 {rkey} 的 perms 须为字符串数组")

        for p in perms:
            if p not in allowed:
                raise HTTPException(status_code=400, detail=f"非法权限点: {p}")
        # 去重 + 排序, 保持文件稳定
        overlay[rkey] = sorted(set(perms))

    role_overlay.save_overlay(overlay)
    permissions.reload_role_map()

    # 审计: 记录被修改的角色 (admin_action 由 require_perm 门禁保证 P_ADMIN_MANAGE)
    changed = ",".join(sorted(overlay.keys())) or "(空覆盖=恢复基线)"
    audit.admin_action(
        current_identity(request)["user_name"] if current_identity(request) else "-",
        "role_map_update",
        f"overlay_roles={changed}",
    )

    return _overlay_payload()