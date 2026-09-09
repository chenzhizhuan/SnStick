"""账号互通 API 路由集成测试 (零网络)。

用 FastAPI TestClient 直接打真实路由, mock 身份服务层:
  - 未启用互通 → /identity/login 404
  - 启用互通 → 登录成功/失败/503/429
  - /auth/me 返回身份
  - 中间件身份注入
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_identity_state():
    from app.services import identity_auth as ia

    with ia._sessions_lock:
        ia._sessions.clear()
    with ia._fails_lock:
        ia._account_fails.clear()
        ia._ip_fails.clear()
    yield


class TestIdentityLogin:
    def test_login_disabled_returns_404(self, client):
        with patch("app.identity.pool.is_enabled", return_value=False):
            r = client.post("/api/auth/identity/login", json={"username": "a", "password": "b"})
            assert r.status_code == 404

    def test_login_success_sets_cookie(self, client):
        from app.identity.models import IdentityUser

        user = IdentityUser(user_id=1, user_name="zhuange", nick_name="专哥", roles=("admin",))
        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=user)),
            patch("app.services.identity_auth._verify_bcrypt", return_value=True),
        ):
            r = client.post(
                "/api/auth/identity/login",
                json={"username": "zhuange", "password": "Pass123"},
            )
        assert r.status_code == 200
        assert "tf_session" in r.cookies

    def test_login_wrong_password_401(self, client):
        from app.identity.models import IdentityUser

        user = IdentityUser(user_id=1, user_name="zhuange", nick_name="专哥", roles=("admin",))
        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=user)),
            patch("app.services.identity_auth._verify_bcrypt", return_value=False),
        ):
            r = client.post(
                "/api/auth/identity/login",
                json={"username": "zhuange", "password": "Wrong"},
            )
        assert r.status_code == 401

    def test_login_identity_unavailable_503(self, client):
        """身份库不可用 → 503 (区别于密码错误 401)。"""
        from app.identity.dao import IdentityUnavailableError

        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch(
                "app.services.identity_auth.get_user_by_name",
                AsyncMock(side_effect=IdentityUnavailableError("down")),
            ),
        ):
            r = client.post(
                "/api/auth/identity/login",
                json={"username": "zhuange", "password": "Pass123"},
            )
        assert r.status_code == 503

    def test_login_no_role_rejected_401(self, client):
        """无有效角色(订阅未开通/已过期): 拒绝登录 (v2.3 §3.4 / P1 验收 7)。"""
        from app.identity.models import IdentityUser

        user = IdentityUser(user_id=1, user_name="nobody", nick_name="无角色", roles=())
        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=user)),
            patch("app.services.identity_auth._verify_bcrypt", return_value=True),
        ):
            r = client.post(
                "/api/auth/identity/login",
                json={"username": "nobody", "password": "Pass123"},
            )
        assert r.status_code == 401
        assert "tf_session" not in r.cookies
        assert r.json()["detail"] == "用户名或密码错误"


class TestMe:
    def test_me_unauthenticated_401(self, client):
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/auth/me")
        assert r.status_code == 401

    def test_me_returns_identity(self, client):
        from app.identity.models import IdentityUser
        from app.services import identity_auth as ia

        user = IdentityUser(user_id=7, user_name="vip", nick_name="VIP", roles=("premium",))
        token = ia._create_session(user)
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/auth/me", cookies={"tf_session": token})
        assert r.status_code == 200
        assert r.json()["identity"]["user_id"] == 7
        assert r.json()["identity"]["roles"] == ["premium"]

    def test_me_default_zero_db_query(self, client):
        """v2.3 §3.5: /me 默认返回会话快照, 零 DB 查询 (不触发惰性刷新)。"""
        from app.identity.models import IdentityUser
        from app.services import identity_auth as ia

        user = IdentityUser(user_id=7, user_name="vip", nick_name="VIP", roles=("premium",))
        token = ia._create_session(user)
        # 制造陈旧快照 (超 SNAPSHOT_TTL): 默认调用也不应查库
        with ia._sessions_lock:
            ia._sessions[ia._hash_token(token)]["last_refresh"] = (
                __import__("time").time() - ia.SNAPSHOT_TTL - 10
            )
        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch("app.services.identity_auth.refresh_session", AsyncMock(return_value=True)) as m,
        ):
            r = client.get("/api/auth/me", cookies={"tf_session": token})
        assert r.status_code == 200
        m.assert_not_called()  # 默认不触发刷新 (零 DB 查询)

    def test_me_refresh_param_triggers_refresh(self, client):
        """?refresh=1 → 触发一次惰性刷新 (角色变更后拿最新快照)。"""
        from app.identity.models import IdentityUser
        from app.services import identity_auth as ia

        user = IdentityUser(user_id=7, user_name="vip", nick_name="VIP", roles=("premium",))
        token = ia._create_session(user)
        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch("app.services.identity_auth.refresh_session", AsyncMock(return_value=True)) as m,
        ):
            r = client.get("/api/auth/me", cookies={"tf_session": token}, params={"refresh": "1"})
        assert r.status_code == 200
        m.assert_called_once()  # 显式刷新触发


class TestMiddleware:
    def test_identity_mode_passes_identity(self, client):
        """启用互通时, 有效身份会话放行并注入 request.state.identity。"""
        from app.identity.models import IdentityUser
        from app.services import identity_auth as ia

        user = IdentityUser(user_id=1, user_name="a", nick_name="A", roles=("admin",))
        token = ia._create_session(user)

        # 用真实受保护路径验证注入 (选一个轻量路径)
        with (
            patch("app.identity.pool.is_enabled", return_value=True),
            patch("app.services.identity_auth.refresh_session", AsyncMock(return_value=True)),
        ):
            r = client.get("/api/watchlist", cookies={"tf_session": token})

        # 注入的 identity 在 request.state 里 (路由可通过依赖读取)
        # 这里验证请求未被 401 拦截即可
        assert r.status_code != 401

    def test_single_password_mode_passes_with_valid_session(self, client):
        """未启用互通: 单密码会话逻辑不变。"""
        from app.services import auth as auth_service

        # 先设一个密码 + 建会话
        auth_service.set_password("secret123")
        token = auth_service.verify_and_create_session("secret123")
        with patch("app.identity.pool.is_enabled", return_value=False):
            r = client.get("/api/watchlist", cookies={"tf_session": token})
        assert r.status_code != 401

    def test_single_mode_no_session_401(self, client):
        with (
            patch("app.identity.pool.is_enabled", return_value=False),
            patch("app.services.auth.is_configured", return_value=True),
        ):
            r = client.get("/api/watchlist")
        assert r.status_code == 401