"""权限门控集成测试 (零网络)。

复用真实 auth_middleware 的身份注入逻辑 + 真实 require_perm 依赖, 验证三种状态:
  1. 互通未启用 (单密码模式) → 放行 (桌面版/未互通部署零改动)
  2. 互通启用 + 无权限角色 → 403 NO_PERM
  3. 互通启用 + 有权限角色 → 通过
另外对真实业务端点 (backtest/run) 做一次无权限 403 验证, 确认挂载生效。
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.identity.permissions import P_BACKTEST_RUN, require_perm

# ── 隔离 mini app: 只挂一个受权限保护的探测端点 ──────────────────────
_probe = APIRouter(prefix="/api")


@_probe.post("/probe-run")
def probe_run(_: None = Depends(require_perm(P_BACKTEST_RUN))):
    return {"ok": True}


_mini_app = FastAPI()
_mini_app.include_router(_probe)


@_mini_app.middleware("http")
async def _mini_auth_middleware(request, call_next):
    """复刻 main.py auth_middleware 的身份分支 (不含单密码逻辑)。"""
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
    # 互通未启用: 放行 (单密码逻辑由真实中间件处理, 此处仅模拟依赖放行)
    return await call_next(request)


@pytest.fixture
def client():
    return TestClient(_mini_app)


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


class TestRequirePerm:
    def test_single_password_mode_passes(self, client):
        """互通未启用: 依赖直接放行 (桌面版/未互通部署零改动)。"""
        with patch("app.identity.pool.is_enabled", return_value=False):
            r = client.post("/api/probe-run")
        assert r.status_code == 200

    def test_unauthenticated_401(self, client):
        """互通启用 + 无会话: 中间件 401 (先于权限判定)。"""
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/probe-run")
        assert r.status_code == 401

    def test_denied_role_403(self, client):
        """互通启用 + 体验版 (common, 无回测权限): 403 NO_PERM。"""
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/probe-run", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_allowed_role_200(self, client):
        """互通启用 + 高级版 (premium, 有回测权限): 放行。"""
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/probe-run", cookies={"tf_session": token})
        assert r.status_code == 200

    def test_admin_wildcard_passes(self, client):
        """互通启用 + 超管: 通配 *:*:* 放行。"""
        token = _session_cookie(("admin",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/probe-run", cookies={"tf_session": token})
        assert r.status_code == 200


class TestRealEndpointMounted:
    """真实业务端点挂载验证: 无权限角色请求 /api/backtest/run → 403。

    只测拦截分支 (不依赖业务 app.state), 证明 require_perm 已真实挂载。
    """

    def test_backtest_run_denied_for_common(self):
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/backtest/run",
                json={"symbols": ["600000"]},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_analysis_menus_denied_for_common(self):
        """M3-4 兜底: /api/analysis-menus 挂了 stick:analysis:read (unknown 角色无权限 → 403)。

        200 分支依赖 app.state.repo (业务层), 不在此验; 拦截分支即证明挂载。
        """
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("unknown_role",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/analysis-menus", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_analysis_menus_denied_without_perm(self):
        """角色映射外的未知角色 (无 analysis:read) → 403 NO_PERM。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("unknown_role",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/analysis-menus", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_analysis_menu_write_denied_for_standard(self):
        """标准版 (无 stick:analysis:write) 写分析菜单 → 403。

        v2.4: standard 现含 stick:analysis:write (策略页内嵌分析菜单编辑),
        改用 common (确无该权限) 验证同一拦截路径。
        """
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/analysis-menus/test_menu",
                json={"label": "t", "data_source": "x"},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_data_clear_denied_for_premium(self):
        """v2.4: 高级版 (无 stick:data:write) 清空全部数据 → 403 NO_PERM。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/data/clear", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_kline_clear_minute_denied_for_premium(self):
        """v2.4: 高级版清空分钟K → 403 (挂载点: kline/clear_minute)。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/kline/clear_minute",
                json={"confirm": True},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_settings_switch_endpoint_denied_for_premium(self):
        """v2.4: 高级版切换数据源端点 → 403 (挂载点: settings/switch_endpoint)。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/settings/switch_endpoint",
                json={"url": "https://api.tickflow.org"},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_ext_data_write_denied_for_standard(self):
        """标准版 (无 stick:ext:write) 创建扩展数据配置 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("standard",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/ext-data",
                json={
                    "id": "t1",
                    "label": "t",
                    "mode": "snapshot",
                    "fields": [{"name": "f"}],
                },
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_ext_data_read_denied_for_unknown_role(self):
        """未知角色 (无 stick:ext:read) 读扩展数据列表 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("unknown_role",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/ext-data", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    # ── v2.5: 复盘 / 异动 / 数据治理 / 设置治理 全门禁 ──────────────────

    def test_market_recap_analyze_denied_for_common(self):
        """v2.5: 体验版 (无 stick:review:read) AI 大盘复盘 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/market-recap/analyze",
                json={"focus": ""},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_market_recap_reports_denied_for_common(self):
        """v2.5: 体验版读历史复盘列表 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/market-recap/reports", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_abnormal_intraday_denied_for_common(self):
        """v2.5: 体验版查异动监控 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/abnormal/intraday", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_abnormal_overview_denied_for_common(self):
        """v2.5: 体验版查异动边缘总览 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("common",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.get("/api/abnormal/overview", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_settings_tickflow_key_denied_for_premium(self):
        """v2.5: 高级版 (无 stick:settings:write) 保存 TickFlow Key → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/settings/tickflow-key",
                json={"api_key": "sk-test"},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_settings_ai_denied_for_premium(self):
        """v2.5: 高级版保存 AI 配置 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/settings/ai",
                json={"provider": "openai_compat"},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_settings_data_sources_save_denied_for_premium(self):
        """v2.5: 高级版新增自定义数据源 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post(
                "/api/settings/data-sources",
                json={"name": "t1", "type": "custom", "datasets": {}},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_settings_review_schedule_denied_for_premium(self):
        """v2.5: 高级版修改定时复盘调度 → 403。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.put(
                "/api/settings/preferences/review-schedule",
                json={"enabled": False, "hour": 15, "minute": 30},
                cookies={"tf_session": token},
            )
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_regime_recompute_denied_for_premium(self):
        """v2.5: 高级版触发 regime 全量重算 → 403 (挂载点: regime/recompute)。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/regime/recompute", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_index_sync_daily_denied_for_premium(self):
        """v2.5: 高级版同步指数日K → 403 (挂载点: index/sync_daily)。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/index/sync_daily", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"

    def test_intraday_refresh_denied_for_premium(self):
        """v2.5: 高级版手动刷新行情 → 403 (挂载点: intraday/refresh)。"""
        from app.main import app

        client = TestClient(app)
        token = _session_cookie(("premium",))
        with patch("app.identity.pool.is_enabled", return_value=True):
            r = client.post("/api/intraday/refresh", cookies={"tf_session": token})
        assert r.status_code == 403
        assert r.headers.get("X-Error-Code") == "NO_PERM"
