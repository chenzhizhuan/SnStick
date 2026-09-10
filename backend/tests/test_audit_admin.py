"""平台管理 API (admin/metrics + admin/audit) + 审计服务测试 (零网络)。

复用 test_identity_permissions_api.py 的 mini-app 模式 (真实 auth_middleware
身份注入 + 真实 require_perm), 验证:
  1. audit 事件写入/读取 (JSONL 落盘 + 内存计数)
  2. /api/admin/metrics 权限门控: admin 200 / mentor 403 / 未登录 401
  3. /api/admin/audit 权限门控 + 参数校验 + 数据回读
"""
from __future__ import annotations

import json
from unittest.mock import patch

import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.services import audit

# 临时审计目录: 每个测试隔离, 不污染生产 data/
_AUDIT_DIR = "tmp_audit_test"


@pytest.fixture(autouse=True)
def _isolate_audit(tmp_path, monkeypatch):
    """把 audit 目录指向 tmp_path, 并清空内存计数/队列。"""
    d = tmp_path / _AUDIT_DIR

    monkeypatch.setattr(audit, "_audit_dir", lambda: d)
    # 重置写盘线程 (每测试独立)
    monkeypatch.setattr(audit, "_writer_started", False)
    with audit._metrics_lock:
        audit._metrics.clear()
    # 清空队列
    while not audit._write_queue.empty():
        try:
            audit._write_queue.get_nowait()
        except Exception:
            break
    yield


@pytest.fixture(autouse=True)
def _clean_identity_state():
    from app.services import identity_auth as ia

    with ia._sessions_lock:
        ia._sessions.clear()
    yield


def _session_cookie(roles: tuple[str, ...]) -> str:
    from app.identity.models import IdentityUser
    from app.services import identity_auth as ia

    user = IdentityUser(user_id=1, user_name="u", nick_name="U", roles=roles)
    return ia._create_session(user)


# ── audit 服务 ──────────────────────────────────────────────
class TestAuditService:
    def test_write_and_read(self, _isolate_audit):
        """login_ok + no_perm 写入后, read_audit 能倒序读回。"""
        audit.login_ok("alice", "1.2.3.4")
        audit.no_perm("bob", "/api/x", "stick:admin:view")
        # 等待写盘线程消费 (异步)
        import time
        deadline = time.time() + 2
        while audit.queue_size() > 0 and time.time() < deadline:
            time.sleep(0.01)
        items = audit.read_audit()
        assert len(items) == 2
        # 倒序: 最新在前 (no_perm 后写)
        assert items[0]["event"] == "no_perm"
        assert items[1]["event"] == "login_ok"
        assert items[1]["actor"] == "alice"
        assert items[1]["category"] == "security"

    def test_metrics_counters(self, _isolate_audit):
        audit.login_ok("a")
        audit.login_ok("b")
        audit.login_fail("c")
        m = audit.get_metrics()
        assert m["login_ok"]["count"] == 2
        assert m["login_fail"]["count"] == 1

    def test_read_audit_category_filter(self, _isolate_audit):
        audit.login_ok("a")
        audit.no_perm("b", "/api/x", "stick:admin:view")
        import time
        deadline = time.time() + 2
        while audit.queue_size() > 0 and time.time() < deadline:
            time.sleep(0.01)
        sec = audit.read_audit(category="security")
        acc = audit.read_audit(category="access")
        assert len(sec) == 1 and sec[0]["event"] == "login_ok"
        assert len(acc) == 1 and acc[0]["event"] == "no_perm"


# ── admin API 权限门控 ──────────────────────────────────────
@pytest.fixture
def admin_client():
    """mini app: 仅挂 admin router + 身份中间件 (互通形态)。"""
    from app.api import admin as admin_api
    from app.identity.permissions import require_perm  # noqa: F401  (确保权限模块加载)

    _app = FastAPI()
    _app.include_router(admin_api.router)

    @_app.middleware("http")
    async def _auth_mw(request, call_next):
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)
        from app.identity import pool as identity_pool

        if identity_pool.is_enabled():
            from app.services import identity_auth as ia

            token = request.cookies.get("tf_session")
            if token and ia.is_valid_session(token):
                identity = ia.get_identity(token)
                if identity:
                    request.state.identity = identity
                    return await call_next(request)
            return JSONResponse(status_code=401, content={"detail": "未登录或会话已过期"})
        return await call_next(request)

    return TestClient(_app)


class TestAdminMetrics:
    def test_metrics_denied_for_common(self, admin_client):
        """互通启用 + 无管理权限 (common) → 403 NO_PERM。"""
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/metrics", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_metrics_denied_for_mentor(self, admin_client):
        """互通启用 + 导师 (无 admin:view) → 403。"""
        token = _session_cookie(("mentor",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/metrics", cookies={"tf_session": token})
        assert r.status_code == 403

    def test_metrics_ok_for_admin(self, admin_client):
        """互通启用 + 超管 (通配) → 200, 指标结构完整。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/metrics", cookies={"tf_session": token})
        assert r.status_code == 200
        data = r.json()
        # 八类核心指标
        assert "sessions" in data and "active" in data["sessions"]
        assert "login" in data and {"ok", "fail", "locked"} <= set(data["login"])
        assert "access" in data and "no_perm_count" in data["access"]
        assert "admin" in data
        assert "agti" in data
        assert "role_map" in data and data["role_map"]["loaded"] is True
        assert "audit" in data
        assert "server" in data and "uptime_s" in data["server"]

    def test_metrics_unauthenticated_401(self, admin_client):
        """互通启用 + 无会话 → 401 (先于权限)。"""
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/metrics")
        assert r.status_code == 401


class TestAdminAudit:
    def test_audit_denied_for_common(self, admin_client):
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/audit", cookies={"tf_session": token})
        assert r.status_code == 403

    def test_audit_ok_for_admin(self, admin_client):
        """超管可查; 默认返回今日审计 (可能为空但结构完整)。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/audit", cookies={"tf_session": token})
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert "items" in data and isinstance(data["items"], list)

    def test_audit_bad_day_param(self, admin_client):
        """非法 day 参数 → 400。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/audit?day=2026-13-99", cookies={"tf_session": token})
        assert r.status_code == 400

    def test_audit_bad_category_param(self, admin_client):
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/audit?category=bad", cookies={"tf_session": token})
        assert r.status_code == 400