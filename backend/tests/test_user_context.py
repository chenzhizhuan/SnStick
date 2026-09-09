"""用户数据命名空间测试 (v2.3 §5 分支阀门架构, 零网络)。

覆盖:
  1. user_root() 三分支: 未互通→原 data/user_data/ (桌面版零改动铁律);
     互通+登录→data/users/{user_id}/; 互通+无上下文→data/users/local/
  2. user_scope() 后台任务作用域 (嵌套/非法 id)
  3. iter_user_roots() 枚举 + local 排序最后
  4. 路径穿越/非法 user_id 防御
  5. preferences 双层: 桌面版单文件行为不变; 互通形态部署级/用户级键分流
  6. watchlist per-user 隔离 + _REVISION 按用户隔离
  7. 中间件 contextvar 注入 → services 层取到正确用户根
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.identity import user_context
from app.identity.user_context import (
    iter_user_roots,
    reset_context_user,
    set_context_user,
    user_root,
    user_root_for,
    user_scope,
)


# ── 基础 fixture: 每用例独立 data_dir + 清 contextvar ──────────────

@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    yield tmp_path


@pytest.fixture(autouse=True)
def _clean_context():
    yield
    # contextvar 恢复: 防跨用例泄漏 (token 不在手上时直接置空)
    user_context._current_user_id.set(None)
    user_context._scope_stack.set(())
    user_context._explicit_root.set(None)
    user_context.reset_production_roots()


def _enable_identity(monkeypatch, enabled: bool = True):
    return patch("app.identity.pool.is_enabled", return_value=enabled)


# ── user_root 三分支 ────────────────────────────────────────────

class TestUserRootBranches:
    def test_desktop_mode_returns_legacy_path(self, _isolated_data_dir):
        """未互通: 返回原 data/user_data/ (桌面版零改动铁律)。"""
        with _enable_identity(None, False):
            assert user_root() == _isolated_data_dir / "user_data"

    def test_identity_mode_logged_in(self, _isolated_data_dir):
        """互通 + 已登录: data/users/{user_id}/。"""
        token = set_context_user(105)
        try:
            with _enable_identity(None, True):
                assert user_root() == _isolated_data_dir / "users" / "105"
        finally:
            reset_context_user(token)

    def test_identity_mode_background_falls_back_local(self, _isolated_data_dir):
        """互通 + 无请求上下文 (启动期/后台未绑定): users/local/ 降级。"""
        with _enable_identity(None, True):
            assert user_root() == _isolated_data_dir / "users" / "local"

    def test_user_root_for_explicit(self, _isolated_data_dir):
        assert user_root_for(105) == _isolated_data_dir / "users" / "105"
        assert user_root_for("88") == _isolated_data_dir / "users" / "88"

    def test_invalid_user_id_rejected(self, _isolated_data_dir):
        with pytest.raises(ValueError):
            user_root_for("../etc")
        with pytest.raises(ValueError):
            user_root_for("local/../105")
        with pytest.raises(ValueError):
            user_root_for("")
        # set_context_user 非法 id: 不注入 (返回 None), 不抛
        assert set_context_user("../../x") is None

    def test_set_context_user_requires_positive_int(self, _isolated_data_dir):
        assert set_context_user(0) is None
        assert set_context_user(-1) is None
        token = set_context_user(1)
        assert token is not None
        reset_context_user(token)


# ── root_scope (worker 子进程显式根穿透) ──────────────────────

class TestRootScope:
    def test_explicit_root_overrides_everything(self, _isolated_data_dir):
        """root_scope 显式根优先级最高: 互通开关/contextvar 都不干扰。"""
        from app.identity.user_context import root_scope

        explicit = _isolated_data_dir / "users" / "999"
        with _enable_identity(None, True):
            token = set_context_user(105)
            try:
                with root_scope(explicit):
                    assert user_root() == explicit
            finally:
                reset_context_user(token)

    def test_scope_restores_on_exit(self, _isolated_data_dir):
        from app.identity.user_context import root_scope

        with _enable_identity(None, True):
            assert user_root() == _isolated_data_dir / "users" / "local"
            with root_scope(_isolated_data_dir / "users" / "105"):
                pass
            assert user_root() == _isolated_data_dir / "users" / "local"

    def test_nested_inner_wins(self, _isolated_data_dir):
        from app.identity.user_context import root_scope

        with root_scope(_isolated_data_dir / "users" / "1"):
            with root_scope(_isolated_data_dir / "users" / "2"):
                assert user_root().name == "2"
            assert user_root().name == "1"


# ── user_subdir / user_strategies_dir (领域模块兼容层) ─────────

class TestUserSubdirCompatLayer:
    """领域模块 data_dir 参数的三分支路由 (M3-3c 核心)。"""

    def test_production_data_dir_desktop(self, _isolated_data_dir):
        """桌面版: 生产 data_dir 传参 → user_data/ 子目录 (与历史完全一致)。"""
        from app.identity.user_context import user_subdir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "user_data")
        with _enable_identity(None, False):
            p = user_subdir(_isolated_data_dir, "monitor_rules")
            assert p == _isolated_data_dir / "user_data" / "monitor_rules"

    def test_production_data_dir_identity_logged_in(self, _isolated_data_dir):
        """互通+登录: 生产 data_dir 传参 → users/<uid>/monitor_rules。"""
        from app.identity.user_context import user_subdir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "users" / "local")
        token = set_context_user(105)
        try:
            with _enable_identity(None, True):
                p = user_subdir(_isolated_data_dir, "monitor_rules")
                assert p == _isolated_data_dir / "users" / "105" / "monitor_rules"
        finally:
            reset_context_user(token)

    def test_isolated_test_dir_untouched(self, _isolated_data_dir):
        """测试隔离目录 (≠ 生产根): 原样拼接 data_dir/user_data/<工件>。"""
        from app.identity.user_context import user_subdir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "user_data")
        isolated = _isolated_data_dir / "test_data"
        with _enable_identity(None, True):
            token = set_context_user(105)
            try:
                p = user_subdir(isolated, "lots")
                # 隔离目录不进用户命名空间 (存量测试零改动)
                assert p == isolated / "user_data" / "lots"
            finally:
                reset_context_user(token)

    def test_no_injection_falls_back_to_settings(self, _isolated_data_dir):
        """main.py 未注入 (worker 子进程): data_dir == settings.data_dir 时仍解析。"""
        from app.identity.user_context import user_subdir

        # 不 set_production_roots, settings.data_dir 已被 fixture 指向 tmp
        with _enable_identity(None, False):
            p = user_subdir(_isolated_data_dir, "custom_signals")
            assert p == _isolated_data_dir / "user_data" / "custom_signals"

    def test_user_root_arg_no_double_user_data(self, _isolated_data_dir):
        """参数本身已是用户根 (engine 反推路径): 不再叠 user_data/。"""
        from app.identity.user_context import user_subdir

        with _enable_identity(None, True):
            token = set_context_user(105)
            try:
                root = user_root()
                p = user_subdir(root, "custom_signals")
                assert p == root / "custom_signals"
            finally:
                reset_context_user(token)

    def test_empty_parts_returns_root(self, _isolated_data_dir):
        from app.identity.user_context import user_subdir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "user_data")
        with _enable_identity(None, False):
            assert user_subdir(_isolated_data_dir) == _isolated_data_dir / "user_data"


class TestUserStrategiesDir:
    def test_desktop_keeps_data_dir_strategies(self, _isolated_data_dir):
        """桌面版: strategies/ 历史在 data_dir 根下, 零改动铁律。"""
        from app.identity.user_context import user_strategies_dir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "user_data")
        with _enable_identity(None, False):
            assert user_strategies_dir(_isolated_data_dir) == _isolated_data_dir / "strategies"

    def test_identity_moves_to_user_root(self, _isolated_data_dir):
        """互通: strategies/ 迁用户根。"""
        from app.identity.user_context import user_strategies_dir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "users" / "local")
        token = set_context_user(105)
        try:
            with _enable_identity(None, True):
                p = user_strategies_dir(_isolated_data_dir)
                assert p == _isolated_data_dir / "users" / "105" / "strategies"
        finally:
            reset_context_user(token)

    def test_isolated_test_dir_untouched(self, _isolated_data_dir):
        """测试隔离目录: data_dir/strategies/ 原样 (存量 worker 测试零改动)。"""
        from app.identity.user_context import user_strategies_dir

        user_context.set_production_roots(_isolated_data_dir, _isolated_data_dir / "user_data")
        isolated = _isolated_data_dir / "test_data"
        with _enable_identity(None, True):
            assert user_strategies_dir(isolated) == isolated / "strategies"

    def test_root_scope_worker_subprocess(self, _isolated_data_dir):
        """worker 子进程: root_scope 显式根下 strategies 也跟随。"""
        from app.identity.user_context import root_scope, user_strategies_dir

        explicit = _isolated_data_dir / "users" / "105"
        with root_scope(explicit):
            # root_scope 下 user_root()==explicit; 但 strategies 判定仍要求
            # data_dir 参数为生产根 (task 传的是行情根 settings.data_dir)
            with _enable_identity(None, True):
                p = user_strategies_dir(_isolated_data_dir)
                assert p == explicit / "strategies"


# ── user_scope (后台任务) ──────────────────────────────────────

class TestUserScope:
    def test_scope_switches_root(self, _isolated_data_dir):
        with _enable_identity(None, True):
            assert user_root() == _isolated_data_dir / "users" / "local"
            with user_scope(105):
                assert user_root() == _isolated_data_dir / "users" / "105"
            assert user_root() == _isolated_data_dir / "users" / "local"

    def test_nested_scope_inner_wins(self, _isolated_data_dir):
        with _enable_identity(None, True):
            with user_scope(105):
                with user_scope(206):
                    assert user_root() == _isolated_data_dir / "users" / "206"
                assert user_root() == _isolated_data_dir / "users" / "105"

    def test_scope_invalid_id_raises(self, _isolated_data_dir):
        with pytest.raises(ValueError):
            with user_scope("abc"):
                pass

    def test_scope_overrides_request_context(self, _isolated_data_dir):
        """显式 scope 优先于请求 contextvar (后台任务逐用户执行语义)。"""
        token = set_context_user(105)
        try:
            with _enable_identity(None, True):
                with user_scope(206):
                    assert user_root() == _isolated_data_dir / "users" / "206"
        finally:
            reset_context_user(token)


# ── iter_user_roots ───────────────────────────────────────────

class TestIterUserRoots:
    def test_empty_when_no_users_dir(self, _isolated_data_dir):
        with _enable_identity(None, True):
            assert iter_user_roots() == []

    def test_enumerates_only_valid_dirs(self, _isolated_data_dir):
        users = _isolated_data_dir / "users"
        for name in ("105", "206", "local"):
            (users / name).mkdir(parents=True)
        # 垃圾目录/文件: 不出现
        (users / "cache.tmp").mkdir()
        (users / "0abc").mkdir()
        (users / "not-a-user").mkdir()
        (users / "99999999999999999999").mkdir()  # 超 19 位数字, 非法
        (users / "stray.txt").write_text("x", encoding="utf-8")

        with _enable_identity(None, True):
            roots = iter_user_roots()
        names = [p.name for p in roots]
        assert names == ["105", "206", "local"]  # 数字升序, local 最后

    def test_desktop_mode_returns_empty(self, _isolated_data_dir):
        """桌面版无遍历语义: 恒返回空列表。"""
        users = _isolated_data_dir / "users"
        (users / "105").mkdir(parents=True)
        with _enable_identity(None, False):
            assert iter_user_roots() == []


# ── preferences 双层 ──────────────────────────────────────────

class TestPreferencesLayers:
    @pytest.fixture(autouse=True)
    def _prefs_cache_clean(self):
        from app.services import preferences

        yield
        preferences._invalidate_cache()

    def test_desktop_single_file_behavior_unchanged(self, _isolated_data_dir):
        """未互通: 用户级+部署级键同文件, 行为与升级前一致。"""
        from app.services import preferences

        with _enable_identity(None, False):
            preferences.save({"nav_order": ["/a"], "minute_sync_days": 9})
            # 单文件包含两类键
            p = _isolated_data_dir / "user_data" / "preferences.json"
            data = json.loads(p.read_text(encoding="utf-8"))
            assert data["nav_order"] == ["/a"]
            assert data["minute_sync_days"] == 9
            # 合并视图读回
            assert preferences.get_nav_order() == ["/a"]
            assert preferences.get_minute_sync_days() == 9

    def test_identity_mode_splits_keys(self, _isolated_data_dir):
        """互通形态: 部署级键→全局层, 用户级键→用户层。"""
        from app.services import preferences

        token = set_context_user(105)
        try:
            with _enable_identity(None, True):
                preferences.save({
                    "nav_order": ["/watchlist"],
                    "daily_data_provider": "tickflow",
                    "feishu_webhook_url": "https://example.com/hook",
                    "watchlist_columns": [{"key": "symbol"}],
                })

            global_p = _isolated_data_dir / "user_data" / "preferences.json"
            user_p = _isolated_data_dir / "users" / "105" / "preferences.json"

            g = json.loads(global_p.read_text(encoding="utf-8"))
            u = json.loads(user_p.read_text(encoding="utf-8"))

            assert "daily_data_provider" in g
            assert "feishu_webhook_url" in g
            assert "nav_order" not in g
            assert "watchlist_columns" not in g

            assert "nav_order" in u
            assert "watchlist_columns" in u
            assert "daily_data_provider" not in u
        finally:
            reset_context_user(token)

    def test_identity_mode_merge_view_and_isolation(self, _isolated_data_dir):
        """互通形态: load() 返回合并视图; A/B 用户互不影响。"""
        from app.services import preferences

        token_a = set_context_user(105)
        try:
            with _enable_identity(None, True):
                preferences.save({"nav_order": ["/a"], "daily_data_provider": "tickflow"})
        finally:
            reset_context_user(token_a)

        token_b = set_context_user(206)
        try:
            with _enable_identity(None, True):
                # B 用户读: 部署级键可见 (全局层), 用户级键独立 (默认空)
                assert preferences.get_daily_data_provider() == "tickflow"
                assert preferences.get_nav_order() == []
                # B 写自己的偏好, 不影响 A
                preferences.save({"nav_order": ["/b"]})
        finally:
            reset_context_user(token_b)

        token_a = set_context_user(105)
        try:
            with _enable_identity(None, True):
                assert preferences.get_nav_order() == ["/a"]
                assert preferences.get_daily_data_provider() == "tickflow"
        finally:
            reset_context_user(token_a)

    def test_identity_mode_background_reads_deploy_layer(self, _isolated_data_dir):
        """互通 + 后台无上下文: 部署级键从全局层读到 (users/local/ 不落用户级键)。"""
        from app.services import preferences

        token = set_context_user(105)
        try:
            with _enable_identity(None, True):
                preferences.save({"minute_sync_days": 10})
        finally:
            reset_context_user(token)

        with _enable_identity(None, True):
            # 后台线程 (无用户上下文): user_root→users/local, 部署级键仍可见
            assert preferences.get_minute_sync_days() == 10
            # 用户级键在 local 桶读不到 (105 私有)
            token2 = set_context_user(105)
            try:
                assert preferences.get_nav_order() == []
            finally:
                reset_context_user(token2)


# ── watchlist per-user ────────────────────────────────────────

class TestWatchlistNamespace:
    def test_desktop_unchanged(self, _isolated_data_dir):
        """未互通: 仍写 data/user_data/watchlist.parquet。"""
        from app.services import watchlist

        with _enable_identity(None, False):
            watchlist.add("600000.SH")
        p = _isolated_data_dir / "user_data" / "watchlist.parquet"
        assert p.exists()

    def test_identity_mode_ab_isolation(self, _isolated_data_dir):
        """互通形态: A/B 用户自选股互不可见 (G3 验收项)。"""
        from app.services import watchlist

        with _enable_identity(None, True):
            token_a = set_context_user(105)
            try:
                watchlist.add("600000.SH")
                watchlist.add("000001.SZ")
            finally:
                reset_context_user(token_a)

            token_b = set_context_user(206)
            try:
                assert watchlist.list_symbols() == []  # B 看不到 A 的
                watchlist.add("300750.SZ")
            finally:
                reset_context_user(token_b)

            token_a = set_context_user(105)
            try:
                syms = {r["symbol"] for r in watchlist.list_symbols()}
                assert syms == {"600000.SH", "000001.SZ"}
            finally:
                reset_context_user(token_a)

    def test_revision_isolated_per_user(self, _isolated_data_dir):
        """版本号按用户隔离: A 写盘不 bump B 的 revision (监控引擎缓存语义)。"""
        from app.services import watchlist

        with _enable_identity(None, True):
            token_a = set_context_user(105)
            try:
                watchlist.add("600000.SH")
                rev_a_after = watchlist.revision()
                assert rev_a_after == 1
            finally:
                reset_context_user(token_a)

            token_b = set_context_user(206)
            try:
                assert watchlist.revision() == 0  # B 未写盘
            finally:
                reset_context_user(token_b)

            token_a = set_context_user(105)
            try:
                assert watchlist.revision() == 1
            finally:
                reset_context_user(token_a)


# ── 中间件 contextvar 注入 (端到端) ────────────────────────────

class TestMiddlewareInjection:
    def test_request_scoped_user_root_propagates(self, _isolated_data_dir):
        """中间件注入身份 → services 层 (经 user_root) 取到正确用户根。"""
        from app.api import auth as auth_api
        from app.services import identity_auth as ia

        probe = FastAPI()

        @probe.get("/api/whoami")
        def whoami():
            # 模拟 services 层取用户根 (不经 request 参数, 纯 contextvar)
            return {"root": str(user_root().name), "path": str(user_root())}

        @probe.middleware("http")
        async def _mini_auth(request, call_next):
            if not request.url.path.startswith("/api/"):
                return await call_next(request)
            from app.identity import pool as identity_pool

            if identity_pool.is_enabled():
                token = request.cookies.get(auth_api.COOKIE_NAME)
                if token and ia.is_valid_session(token):
                    identity = ia.get_identity(token)
                    if identity:
                        request.state.identity = identity
                        from app.identity.user_context import set_context_user, reset_context_user

                        ctx = set_context_user(identity.get("user_id"))
                        try:
                            return await call_next(request)
                        finally:
                            reset_context_user(ctx)
                from fastapi.responses import JSONResponse

                return JSONResponse(status_code=401, content={"detail": "未登录"})
            return await call_next(request)

        # 建会话 (user_id=105)
        from app.identity.models import IdentityUser

        user = IdentityUser(user_id=105, user_name="u", nick_name="U", roles=("premium",))
        token = ia._create_session(user)

        with _enable_identity(None, True):
            client = TestClient(probe)
            r = client.get("/api/whoami", cookies={"tf_session": token})
        assert r.status_code == 200
        assert r.json()["root"] == "105"
        # 请求结束后 contextvar 已复位 (下一请求不串用户)
        assert user_context.current_user_id() is None

        # 清理会话
        with ia._sessions_lock:
            ia._sessions.clear()
