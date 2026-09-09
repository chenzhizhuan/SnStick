"""权限判定单元测试 (零网络)。

验证:
  - role_map.yaml 加载与格式错误处理
  - 多角色并集 / admin 通配 / 段级通配
  - require_perm 依赖: 有权限放行 / 无权限 403 NO_PERM / 未登录 403
"""
from __future__ import annotations

from typing import ClassVar
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.identity import permissions as perm


# ── role_map 加载 ─────────────────────────────────────────────
class TestLoadRoleMap:
    def test_loads_all_roles(self):
        rm = perm.load_role_map()
        assert "admin" in rm
        assert "enterprise" in rm
        assert "mentor" in rm
        assert "agent" in rm
        assert "premium" in rm
        assert "standard" in rm
        assert "common" in rm

    def test_admin_wildcard(self):
        assert perm.load_role_map()["admin"] == {"*:*:*"}

    def test_common_minimal(self):
        perms = perm.load_role_map()["common"]
        assert "stick:watchlist:read" in perms
        assert "stick:kline:read" in perms
        assert "stick:backtest:run" not in perms

    def test_missing_file_raises(self):
        with patch.object(perm, "_role_map_path", return_value=__import__("pathlib").Path("nope.yaml")):
            perm.load_role_map.cache_clear()
            with pytest.raises(perm.RoleMapError):
                perm.load_role_map()
            perm.load_role_map.cache_clear()

    def test_bad_yaml_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text("roles: [not-a-dict", encoding="utf-8")
        with patch.object(perm, "_role_map_path", return_value=bad):
            perm.load_role_map.cache_clear()
            with pytest.raises(perm.RoleMapError):
                perm.load_role_map()
            perm.load_role_map.cache_clear()

    def test_empty_perms_raises(self, tmp_path):
        bad = tmp_path / "bad2.yaml"
        bad.write_text("roles:\n  admin:\n    perms: []\n", encoding="utf-8")
        with patch.object(perm, "_role_map_path", return_value=bad):
            perm.load_role_map.cache_clear()
            with pytest.raises(perm.RoleMapError):
                perm.load_role_map()
            perm.load_role_map.cache_clear()


# ── 判定 ──────────────────────────────────────────────────────
class TestHasPerm:
    def test_admin_any(self):
        assert perm.has_perm(("admin",), "stick:anything:any")

    def test_premium_has_backtest(self):
        assert perm.has_perm(("premium",), "stick:backtest:run")
        assert perm.has_perm(("premium",), "stick:mining:run")
        assert perm.has_perm(("premium",), "stick:intraday:read")
        assert perm.has_perm(("premium",), "stick:depth:read")

    def test_standard_no_backtest(self):
        assert not perm.has_perm(("standard",), "stick:backtest:run")
        assert perm.has_perm(("standard",), "stick:screener:run")

    def test_common_minimal(self):
        assert perm.has_perm(("common",), "stick:watchlist:read")
        assert not perm.has_perm(("common",), "stick:backtest:run")
        assert not perm.has_perm(("common",), "stick:screener:run")

    def test_union_multiple_roles(self):
        # standard + premium → 并集 = 有 backtest
        assert perm.has_perm(("standard", "premium"), "stick:backtest:run")

    def test_empty_roles(self):
        assert not perm.has_perm((), "stick:watchlist:read")

    def test_unknown_role(self):
        assert not perm.has_perm(("ghost_role",), "stick:watchlist:read")


# ── require_perm 依赖 ──────────────────────────────────────────
class TestRequirePerm:
    def test_single_password_mode_passes(self):
        """单密码模式 (互通未启用): 无身份也放行, 桌面版零改动。"""
        with patch("app.identity.pool.is_enabled", return_value=False):
            dep = perm.require_perm("stick:backtest:run")

            class State:
                identity = None

            class Req:
                state = State()

            dep(Req())  # 不抛 = 放行

    def test_permitted(self):
        with patch("app.identity.pool.is_enabled", return_value=True):
            class State:
                identity: ClassVar[dict] = {"roles": ("premium",)}

            class Req:
                state = State()

            dep = perm.require_perm("stick:backtest:run")
            dep(Req())  # 不抛 = 通过

    def test_denied_raises_403(self):
        with patch("app.identity.pool.is_enabled", return_value=True):
            class State:
                identity: ClassVar[dict] = {"roles": ("common",)}

            class Req:
                state = State()

            dep = perm.require_perm("stick:backtest:run")
            with pytest.raises(HTTPException) as ei:
                dep(Req())
            assert ei.value.status_code == 403
            assert ei.value.headers == {"X-Error-Code": "NO_PERM"}

    def test_no_identity_403(self):
        """互通启用但未登录 (无身份) → 403。"""
        with patch("app.identity.pool.is_enabled", return_value=True):
            class State:
                identity = None

            class Req:
                state = State()

            dep = perm.require_perm("stick:watchlist:read")
            with pytest.raises(HTTPException) as ei:
                dep(Req())
            assert ei.value.status_code == 403


# ── current_identity / current_roles ───────────────────────────
class TestCurrent:
    def test_current_roles(self):
        class State:
            identity: ClassVar[dict] = {"user_id": 1, "roles": ("admin",)}

        class Req:
            state = State()

        assert perm.current_roles(Req()) == ("admin",)
        assert perm.current_identity(Req())["user_id"] == 1

    def test_current_roles_none(self):
        class State:
            identity = None

        class Req:
            state = State()

        assert perm.current_roles(Req()) == ()