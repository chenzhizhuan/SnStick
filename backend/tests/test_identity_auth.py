"""身份会话服务单元测试 (零网络)。

不连真实数据库 —— mock identity.dao 层, 验证:
  - bcrypt 校验 (真哈希) 与 dummy 防枚举
  - 会话生命周期: 创建/校验/过期/注销/恢复
  - 快照刷新: 惰性 300s / 硬上限 24h / DB 不可用保留
  - 双层限流: 账号 5次/10min + IP 10次/10min
  - 会话上限 5000 驱逐最旧
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import bcrypt
import pytest

from app.services import identity_auth as ia


# ── fixtures ─────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _clean_state():
    """每个测试重置全局内存态, 避免互相污染。"""
    with ia._sessions_lock:
        ia._sessions.clear()
    with ia._fails_lock:
        ia._account_fails.clear()
        ia._ip_fails.clear()
    ia._DUMMY_HASH = None
    yield


def _make_user(user_id: int = 1, name: str = "zhuange", roles=("admin",), password: str = "Pass123") -> ia.IdentityUser:
    return ia.IdentityUser(
        user_id=user_id,
        user_name=name,
        nick_name="专哥",
        roles=roles,
        password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=ia._BCRYPT_ROUNDS)).decode(),
    )


# ── 登录 ─────────────────────────────────────────────────────────
class TestLogin:
    @pytest.mark.asyncio
    async def test_login_success(self):
        user = _make_user()
        with patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=user)):
            token = await ia.login("zhuange", "Pass123")
        assert token
        assert ia.is_valid_session(token)

    @pytest.mark.asyncio
    async def test_login_wrong_password(self):
        user = _make_user()
        with patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=user)):
            token = await ia.login("zhuange", "Wrong!")
        assert token is None

    @pytest.mark.asyncio
    async def test_login_unknown_user_dummy(self):
        """用户不存在: 执行 dummy bcrypt (防枚举) 并返回 None。"""
        with patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=None)):
            token = await ia.login("ghost", "whatever")
        assert token is None
        assert ia._DUMMY_HASH is not None  # dummy 哈希已生成

    @pytest.mark.asyncio
    async def test_login_identity_unavailable_raises(self):
        """身份库不可用: 抛 IdentityUnavailableError (路由转 503)。"""
        from app.identity.dao import IdentityUnavailableError

        with (
            patch(
                "app.services.identity_auth.get_user_by_name",
                AsyncMock(side_effect=IdentityUnavailableError("down")),
            ),
            pytest.raises(IdentityUnavailableError),
        ):
            await ia.login("zhuange", "Pass123")

    @pytest.mark.asyncio
    async def test_login_no_role_rejected(self):
        """无有效角色(订阅未开通/已过期): 拒绝登录 (v2.3 §3.4 / P1 验收 7)。

        即使密码正确也不发会话; 且执行 dummy bcrypt 防枚举 (不泄露「无角色」差异)。
        """
        user = _make_user(roles=())
        with patch("app.services.identity_auth.get_user_by_name", AsyncMock(return_value=user)):
            token = await ia.login("zhuange", "Pass123")
        assert token is None
        assert ia._DUMMY_HASH is not None  # dummy 哈希已生成 (防枚举)


# ── 会话 ─────────────────────────────────────────────────────────
class TestSession:
    def test_create_and_get(self):
        token = ia._create_session(_make_user())
        s = ia._get_session(token)
        assert s is not None
        assert s["user_id"] == 1
        assert ia.get_identity(token)["roles"] == ("admin",)

    def test_get_identity_none_for_bad_token(self):
        assert ia.get_identity("bogus") is None

    def test_revoke(self):
        token = ia._create_session(_make_user())
        ia.revoke_session(token)
        assert ia._get_session(token) is None

    def test_expired_session_invalid(self):
        token = ia._create_session(_make_user())
        with ia._sessions_lock:
            ia._sessions[ia._hash_token(token)]["expires_at"] = time.time() - 1
        assert ia.is_valid_session(token) is False

    def test_session_limit_evicts_oldest(self, monkeypatch):
        # 用小的会话上限模拟驱逐逻辑 (避免 5000 次写盘拖慢测试)
        monkeypatch.setattr(ia, "SESSIONS_LIMIT", 3)
        # 填满到上限
        for i in range(4):
            u = _make_user(user_id=i + 100, name=f"u{i}")
            ia._create_session(u)
        assert len(ia._sessions) <= 3
        # 最早创建的 (user_id=100) 被驱逐
        assert all(s["user_id"] != 100 for s in ia._sessions.values())

    def test_identity_hard_cap_invalidates(self):
        """快照超 MAX_AGE 未刷新 → 强制重登。"""
        token = ia._create_session(_make_user())
        with ia._sessions_lock:
            ia._sessions[ia._hash_token(token)]["last_refresh"] = time.time() - ia.IDENTITY_MAX_AGE - 1
        assert ia.is_valid_session(token) is False
        assert ia._get_session(token) is None  # 已注销


# ── 刷新 ─────────────────────────────────────────────────────────
class TestRefresh:
    @pytest.mark.asyncio
    async def test_refresh_updates_roles(self):
        token = ia._create_session(_make_user(roles=("common",)))
        # 制造陈旧快照
        with ia._sessions_lock:
            ia._sessions[ia._hash_token(token)]["last_refresh"] = time.time() - ia.SNAPSHOT_TTL - 1
        new_user = _make_user(roles=("premium",))
        with patch("app.services.identity_auth.get_user_by_id", AsyncMock(return_value=new_user)):
            ok = await ia.refresh_session(token)
        assert ok is True
        assert ia.get_identity(token)["roles"] == ("premium",)

    @pytest.mark.asyncio
    async def test_refresh_skip_within_ttl(self):
        token = ia._create_session(_make_user())
        with patch("app.services.identity_auth.get_user_by_id", AsyncMock(return_value=None)) as m:
            ok = await ia.refresh_session(token)
        assert ok is True
        m.assert_not_called()  # 快照未过期, 不查库

    @pytest.mark.asyncio
    async def test_refresh_db_down_keeps_session(self):
        """DB 不可用: 保留陈旧快照, 不清会话。"""
        from app.identity.dao import IdentityUnavailableError

        token = ia._create_session(_make_user())
        with ia._sessions_lock:
            ia._sessions[ia._hash_token(token)]["last_refresh"] = time.time() - ia.SNAPSHOT_TTL - 1
        with patch(
            "app.services.identity_auth.get_user_by_id",
            AsyncMock(side_effect=IdentityUnavailableError("down")),
        ):
            ok = await ia.refresh_session(token)
        assert ok is True
        assert ia.is_valid_session(token) is True  # 会话保留

    @pytest.mark.asyncio
    async def test_refresh_user_deleted_invalidates(self):
        token = ia._create_session(_make_user())
        with ia._sessions_lock:
            ia._sessions[ia._hash_token(token)]["last_refresh"] = time.time() - ia.SNAPSHOT_TTL - 1
        with patch("app.services.identity_auth.get_user_by_id", AsyncMock(return_value=None)):
            ok = await ia.refresh_session(token)
        assert ok is False
        assert ia._get_session(token) is None


# ── 双层限流 ─────────────────────────────────────────────────────
class TestRateLimit:
    def test_account_lock_after_5_fails(self):
        for _ in range(5):
            ia.record_login_fail("zhuange", "1.2.3.4")
        with pytest.raises(ia._RateLimitError):
            ia.check_login_rate_limit("zhuange", "9.9.9.9")  # 换 IP 也锁账号
        # 但不同账号不受影响
        ia.check_login_rate_limit("other", "9.9.9.9")

    def test_ip_lock_after_10_fails(self):
        for _ in range(10):
            ia.record_login_fail("a", "1.2.3.4")
            ia.record_login_fail("b", "1.2.3.4")
        with pytest.raises(ia._RateLimitError):
            ia.check_login_rate_limit("c", "1.2.3.4")

    def test_lock_expires(self):
        for _ in range(5):
            ia.record_login_fail("alice", "5.6.7.8")
        with ia._fails_lock:
            ia._account_fails["u:alice"] = (5, time.time() - 1)
            ia._ip_fails["ip:5.6.7.8"] = (10, time.time() - 1)
        ia.check_login_rate_limit("alice", "5.6.7.8")  # 过期后不抛

    def test_clear_on_success(self):
        for _ in range(3):
            ia.record_login_fail("bob", "2.2.2.2")
        ia.clear_login_fails("bob", "2.2.2.2")
        ia.check_login_rate_limit("bob", "2.2.2.2")  # 清空后不锁