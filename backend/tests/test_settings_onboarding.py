"""引导页可见性策略 (settings._effective_onboarding) 单测。

2026-10-15 语义修正: 引导页是部署级一次性事件, 只面向管理员
(数据源/Key 配置是管理动作); 非管理员任何时候恒视为「已完成」,
不被引导页带去误操作配置。
"""
from __future__ import annotations

from starlette.requests import Request

from app.api.settings import _effective_onboarding


def _make_request(cookies: dict[str, str] | None = None) -> Request:
    """构造带 cookie 的最小 Request (settings 端点只需要读 cookie)。"""
    headers = []
    if cookies:
        raw = "; ".join(f"{k}={v}" for k, v in cookies.items())
        headers.append((b"cookie", raw.encode("latin-1")))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/settings",
        "headers": headers,
    }
    return Request(scope)


def _mock(monkeypatch, *, enabled: bool, identity: dict | None | Exception):
    monkeypatch.setattr(
        "app.identity.user_context.identity_enabled", lambda: enabled,
    )
    if isinstance(identity, Exception):
        monkeypatch.setattr(
            "app.services.identity_auth.get_identity",
            lambda token: (_ for _ in ()).throw(identity),
        )
    else:
        monkeypatch.setattr(
            "app.services.identity_auth.get_identity", lambda token: identity,
        )


# ── 非互通形态 (桌面版/单密码): 无角色概念, 原样返回存储值 ──

def test_desktop_mode_returns_stored_value(monkeypatch):
    _mock(monkeypatch, enabled=False, identity=None)
    assert _effective_onboarding(False, _make_request()) is False
    assert _effective_onboarding(True, _make_request()) is True


# ── 互通形态: 管理员看存储值 (全新部署 False → 首登引导) ──

def test_admin_gets_stored_value(monkeypatch):
    _mock(monkeypatch, enabled=True, identity={"roles": ["admin"]})
    req = _make_request({"tf_session": "tok"})
    assert _effective_onboarding(False, req) is False
    assert _effective_onboarding(True, req) is True


def test_admin_among_multiple_roles(monkeypatch):
    _mock(monkeypatch, enabled=True, identity={"roles": ["viewer", "admin"]})
    assert _effective_onboarding(False, _make_request({"tf_session": "tok"})) is False


# ── 互通形态: 非管理员恒视为已完成 (存储值是部署级的, 不针对个人) ──

def test_non_admin_always_completed(monkeypatch):
    _mock(monkeypatch, enabled=True, identity={"roles": ["viewer"]})
    req = _make_request({"tf_session": "tok"})
    assert _effective_onboarding(False, req) is True
    assert _effective_onboarding(True, req) is True


def test_roleless_identity_treated_as_non_admin(monkeypatch):
    # 会话快照存在但无 roles 字段 (旧快照/降级) → 按非管理员处理
    _mock(monkeypatch, enabled=True, identity={"user_id": 1})
    assert _effective_onboarding(False, _make_request({"tf_session": "tok"})) is True


# ── 会话缺失/身份判定异常: 保守方向 (不弹引导页 / 不阻断设置页) ──

def test_missing_session_treated_as_completed(monkeypatch):
    # 无 cookie (匿名/会话过期) — 引导页绝不向未认证会话暴露
    _mock(monkeypatch, enabled=True, identity=None)
    assert _effective_onboarding(False, _make_request()) is True


def test_identity_error_falls_back_to_stored(monkeypatch):
    # 身份判定抛异常 → 回落存储值 (见 docstring; 保守不阻断设置页)
    _mock(monkeypatch, enabled=True, identity=RuntimeError("pool down"))
    assert _effective_onboarding(False, _make_request({"tf_session": "tok"})) is False
    assert _effective_onboarding(True, _make_request({"tf_session": "tok"})) is True
