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

from fastapi import APIRouter, Depends, HTTPException, Query

from app.identity.permissions import P_ADMIN_VIEW, require_perm

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