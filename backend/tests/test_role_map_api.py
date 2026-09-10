"""角色权限矩阵 (role-map) API + overlay 覆盖层测试 (方案 A, 零网络)。

验证:
  1. role_overlay 服务: 覆盖合并/收敛语义/恢复基线
  2. GET /api/admin/role-map: admin 200 (矩阵完整) / mentor 403 / 未登录 401
  3. PUT /api/admin/role-map: admin 可保存生效 / mentor 403 / 参数校验 (非法角色/非法权限点/扩张)
  4. 保存后 role_map 缓存刷新 → 权限判定立即生效
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.services import audit
from app.services import role_overlay as ro

# 临时审计/覆盖目录
_AUDIT_DIR = "tmp_audit_test"
_OVERLAY_REL = "role_overlay.json"


@pytest.fixture(autouse=True)
def _isolate_overlay(tmp_path, monkeypatch):
    """把 overlay 指向 tmp_path, 审计同样隔离, 并清缓存。"""
    monkeypatch.setattr(ro, "_overlay_path", lambda: tmp_path / _OVERLAY_REL)

    from app.identity import permissions

    permissions.reload_role_map()  # 清基线缓存
    yield
    permissions.reload_role_map()


@pytest.fixture(autouse=True)
def _isolate_audit(tmp_path, monkeypatch):
    d = tmp_path / _AUDIT_DIR
    monkeypatch.setattr(audit, "_audit_dir", lambda: d)
    monkeypatch.setattr(audit, "_writer_started", False)
    with audit._metrics_lock:
        audit._metrics.clear()
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


@pytest.fixture
def admin_client():
    from app.api import admin as admin_api

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


# ── role_overlay 服务 ──────────────────────────────────────────────
class TestRoleOverlayService:
    def test_effective_with_overlay(self):
        base = {"stick:watchlist:read", "stick:kline:read", "stick:backtest:run"}
        ro.save_overlay({"premium": ["stick:watchlist:read"]})
        eff = ro.effective_role_perms("premium", base)
        # 覆盖即最终集合 (未列的基线权限被关闭)
        assert eff == {"stick:watchlist:read"}

    def test_effective_keeps_all_when_no_overlay(self):
        base = {"stick:watchlist:read", "stick:kline:read"}
        eff = ro.effective_role_perms("premium", base)
        assert eff == base

    def test_overlay_can_expand(self):
        """覆盖可扩张: 基线没有的权限点也能授出 (全量授权语义)。"""
        base = {"stick:watchlist:read"}
        ro.save_overlay({"premium": ["stick:watchlist:read", "stick:backtest:run"]})
        eff = ro.effective_role_perms("premium", base)
        assert "stick:backtest:run" in eff  # 覆盖新增 → 生效
        assert "stick:watchlist:read" in eff

    def test_overlay_wildcard_expands_base(self):
        """覆盖含通配 → 展开为基线上能匹配的具体权限。"""
        base = {"stick:watchlist:read", "stick:kline:read", "stick:backtest:run"}
        ro.save_overlay({"premium": ["stick:*:read"]})
        eff = ro.effective_role_perms("premium", base)
        assert "stick:watchlist:read" in eff
        assert "stick:kline:read" in eff
        assert "stick:backtest:run" not in eff  # 通配只匹配 read 动作

    def test_clear_overlay_restores_base(self):
        base = {"stick:watchlist:read", "stick:kline:read"}
        ro.save_overlay({"premium": ["stick:watchlist:read"]})
        ro.clear_overlay()
        assert ro.effective_role_perms("premium", base) == base


# ── GET /api/admin/role-map ─────────────────────────────────────────
class TestGetRoleMap:
    def test_get_denied_for_mentor(self, admin_client):
        token = _session_cookie(("mentor",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/role-map", cookies={"tf_session": token})
        assert r.status_code == 403

    def test_get_ok_for_admin(self, admin_client):
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/role-map", cookies={"tf_session": token})
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        # 7 个角色 + 分组 + 全部权限点
        assert [x["key"] for x in data["roles"]] == [
            "admin", "enterprise", "mentor", "agent", "premium", "standard", "common",
        ]
        assert len(data["groups"]) >= 5
        assert len(data["all_perms"]) >= 20

    def test_get_unauthenticated(self, admin_client):
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.get("/api/admin/role-map")
        assert r.status_code == 401


# ── PUT role-map ────────────────────────────────────────────────────
class TestPutRoleMap:
    def test_put_denied_for_mentor(self, admin_client):
        token = _session_cookie(("mentor",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"premium": ["stick:watchlist:read"]}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403

    def test_put_admin_ok_and_effective(self, admin_client):
        """admin 保存覆盖 → 立即生效 (返回 effective 已反映)。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"premium": ["stick:watchlist:read", "stick:kline:read"]}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 200
        data = r.json()
        prem = next(x for x in data["roles"] if x["key"] == "premium")
        assert prem["effective"] == sorted(["stick:watchlist:read", "stick:kline:read"])
        # 落盘
        ov = ro.load_overlay()
        assert ov["premium"] == ["stick:kline:read", "stick:watchlist:read"]

    def test_put_allows_expansion(self, admin_client):
        """覆盖可扩张: 基线没有的权限点也能授出 → 200 且生效。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"common": ["stick:backtest:run", "stick:watchlist:read"]}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 200
        data = r.json()
        common = next(x for x in data["roles"] if x["key"] == "common")
        assert "stick:backtest:run" in common["effective"]  # 扩张生效

    def test_put_rejects_admin_role(self, admin_client):
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"admin": ["stick:watchlist:read"]}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 400

    def test_put_rejects_unknown_perm(self, admin_client):
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"premium": ["stick:notexist:read"]}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 400

    def test_put_empty_overlay_restores_base(self, admin_client):
        """空覆盖 = 恢复基线。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            # 先保存收敛
            admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"premium": ["stick:watchlist:read"]}},
                cookies={"tf_session": token},
            )
            # 再清空
            r = admin_client.put(
                "/api/admin/role-map",
                json={"roles": {}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 200
        data = r.json()
        prem = next(x for x in data["roles"] if x["key"] == "premium")
        assert prem["effective"] == prem["base"]  # 恢复基线

    def test_put_audits_admin_action(self, admin_client):
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            admin_client.put(
                "/api/admin/role-map",
                json={"roles": {"standard": ["stick:watchlist:read"]}},
                cookies={"tf_session": token},
            )
        import time

        deadline = time.time() + 2
        while audit.queue_size() > 0 and time.time() < deadline:
            time.sleep(0.01)
        items = audit.read_audit(category="admin")
        assert len(items) == 1
        assert items[0]["event"] == "admin_action"
        assert "standard" in items[0]["detail"]


# 简化: 复用 admin_client 即可, 无需额外 fixture
@pytest.fixture
def tmp_client(admin_client):
    return admin_client


# ── 最有效角色 (effective_role) ───────────────────────────────────
class TestEffectiveRole:
    def test_single_role(self):
        """单角色 → 返回该角色中文名。"""
        from app.identity.permissions import effective_role

        assert effective_role(("common",)) == {"key": "common", "label": "体验版"}
        assert effective_role(("premium",)) == {"key": "premium", "label": "高级版"}
        assert effective_role(("admin",)) == {"key": "admin", "label": "超级版"}

    def test_multirole_picks_highest(self):
        """多角色 → 取 ROLE_ORDER 中最靠前者 (权限层级最高)。"""
        from app.identity.permissions import effective_role

        assert effective_role(("agent", "premium"))["key"] == "agent"        # 服务商 > 高级版
        assert effective_role(("standard", "premium"))["key"] == "premium"   # 高级版 > 标准版
        assert effective_role(("common", "standard"))["key"] == "standard"   # 标准版 > 体验版
        assert effective_role(("mentor", "agent"))["key"] == "mentor"        # 导师版 > 服务商

    def test_empty_returns_none(self):
        from app.identity.permissions import effective_role

        assert effective_role(()) is None

    def test_unknown_role_falls_back_raw(self):
        """未知角色 (不在 ROLE_ORDER) 视为最低优先级, 展示 raw key。"""
        from app.identity.permissions import effective_role

        r = effective_role(("some_new_role",))
        assert r == {"key": "some_new_role", "label": "some_new_role"}

    def test_me_includes_effective_role(self, admin_client):
        """GET /me 返回 effective_role (单角色 → 中文名)。"""
        from app.api import auth as auth_api

        _app = FastAPI()
        _app.include_router(auth_api.router)

        @_app.middleware("http")
        async def _auth_mw(request, call_next):
            if not request.url.path.startswith("/api/"):
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
                return JSONResponse(status_code=401, content={"detail": "未登录"})
            return await call_next(request)

        client = TestClient(_app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/auth/me", cookies={"tf_session": token})
        assert r.status_code == 200
        body = r.json()
        assert body["identity"]["effective_role"] == {"key": "premium", "label": "高级版"}
        # roles 原样透传, perms 并集解析仍正常
        assert body["identity"]["roles"] == ("premium",) or "premium" in body["identity"]["roles"]