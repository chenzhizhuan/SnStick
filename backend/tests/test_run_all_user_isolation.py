"""run_all 渐进路径 (单飞 worker 线程) 的用户缓存落地隔离测试 (v2.3 M3-3c)。

修复前两个问题:
  1. job 在 worker 线程执行, 新线程不继承请求 contextvar → write_cache 落
     users/local/ 降级目录, 用户策略页永远读不到批量结果;
  2. 单飞 key 不含 uid → 不同用户同参数搭车同一执行, 结果写进先发用户的目录。

修复后: 请求线程捕获 uid, job 内 user_scope(uid) 显式绑定;
单飞 key 加 uid, 不同用户各自独立执行、各落各目录。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from app.api import screener as screener_api
from app.config import settings
from app.identity import user_context as uc
from app.identity.user_context import reset_production_roots, user_scope
from app.services import strategy_cache

AS_OF = "2026-09-14"


@dataclass
class _FakeResult:
    total: int = 1
    rows: list = field(default_factory=lambda: [{"symbol": "000001.SZ", "close": 1.0}])
    as_of: str = AS_OF


class _FakeEngine:
    def __init__(self, delays: dict[str, float]):
        self._delays = delays
        self.executed: list[str] = []

    def has(self, sid: str) -> bool:
        return sid in self._delays

    def get(self, sid: str):
        return SimpleNamespace(meta={})

    def run_all(self, context, params_map=None, overrides_map=None, *, strategy_ids=None, parallel=True):
        out = {}
        for sid in strategy_ids or []:
            self.executed.append(sid)
            time.sleep(self._delays[sid])
            out[sid] = _FakeResult()
        return out


class _FakeService:
    def __init__(self, repo, asset_type="stock"):
        pass

    def latest_date(self):
        return date.fromisoformat(AS_OF)

    def build_strategy_context(self, *args, **kwargs):
        return SimpleNamespace()


def _request(tmp_path: Path, engine):
    repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    state = SimpleNamespace(repo=repo, strategy_engine=engine, monitor_engine=None)
    return SimpleNamespace(app=SimpleNamespace(state=state))


def _setup_production(monkeypatch, tmp_path: Path) -> None:
    """互通生产形态: identity 开启 + 生产 roots 注入 + 首返 0.4s。"""
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    uc.set_production_roots(tmp_path, tmp_path / "users" / "local")
    monkeypatch.setattr(uc, "identity_enabled", lambda: True)
    monkeypatch.setattr(settings, "strategy_run_all_first_return_s", 0.4)


def _wait_user_cache(tmp_path: Path, uid: int, want_ids, timeout=8.0) -> dict:
    """在指定用户 scope 下轮询缓存, 直到 want_ids 全部出现 (超时返回现状)。"""
    deadline = time.time() + timeout
    with user_scope(uid):
        while time.time() < deadline:
            results = (strategy_cache.read_cache(tmp_path) or {}).get("results") or {}
            if all(i in results for i in want_ids):
                return results
            time.sleep(0.05)
        return (strategy_cache.read_cache(tmp_path) or {}).get("results") or {}


def test_background_job_lands_cache_in_request_user_dir(monkeypatch, tmp_path):
    """互通形态: 登录用户触发 run_all, 后台 job 的缓存必须落本人目录
    (users/<uid>/), 而非 users/local/ 降级目录或全局 user_data/。"""
    _setup_production(monkeypatch, tmp_path)
    monkeypatch.setattr(screener_api, "ScreenerService", _FakeService)

    engine = _FakeEngine({"fast_a": 0.01, "slow_c": 0.5})
    try:
        with user_scope(1):
            resp = screener_api.run_all(
                _request(tmp_path, engine),
                {
                    "as_of": AS_OF,
                    "strategy_ids": ["fast_a", "slow_c"],
                    "asset_type": "stock",
                    "timeframe": "1d",
                    "summary_only": True,
                },
            )
        # 快策略随首返返回, 慢策略转后台
        assert set(resp["results"]) == {"fast_a"}
        assert resp["pending"] == ["slow_c"]

        # 后台算完: 缓存落在用户 1 的目录
        results = _wait_user_cache(tmp_path, 1, ["fast_a", "slow_c"])
        assert set(results) == {"fast_a", "slow_c"}

        # 落点断言: users/1/ 有, users/local/ 与全局 user_data/ 都没有
        assert (tmp_path / "users" / "1" / "strategy_cache.json").exists()
        assert not (tmp_path / "users" / "local" / "strategy_cache.json").exists()
        assert not (tmp_path / "user_data" / "strategy_cache.json").exists()

        # 他人视角读不到
        with user_scope(101):
            assert strategy_cache.read_cache(tmp_path) is None
    finally:
        reset_production_roots()


def test_same_params_different_users_run_independently(monkeypatch, tmp_path):
    """单飞 key 含 uid: 两个用户同参数请求不搭车, 各自执行、各落各目录。"""
    _setup_production(monkeypatch, tmp_path)
    monkeypatch.setattr(screener_api, "ScreenerService", _FakeService)

    engine = _FakeEngine({"s1": 0.01})
    body = {
        "as_of": AS_OF,
        "strategy_ids": ["s1"],
        "asset_type": "stock",
        "timeframe": "1d",
        "summary_only": True,
    }
    try:
        with user_scope(1):
            resp1 = screener_api.run_all(_request(tmp_path, engine), body)
        with user_scope(2):
            resp2 = screener_api.run_all(_request(tmp_path, engine), body)

        # 不搭车: 两次独立执行 (修复前同 key 会拿到同一 handle)
        assert resp2["started_at"] != resp1["started_at"]
        assert engine.executed.count("s1") == 2

        # 各自缓存各自目录, 互不可见
        assert set(_wait_user_cache(tmp_path, 1, ["s1"])) == {"s1"}
        assert set(_wait_user_cache(tmp_path, 2, ["s1"])) == {"s1"}
        assert (tmp_path / "users" / "1" / "strategy_cache.json").exists()
        assert (tmp_path / "users" / "2" / "strategy_cache.json").exists()
        assert not (tmp_path / "users" / "local" / "strategy_cache.json").exists()
    finally:
        reset_production_roots()
