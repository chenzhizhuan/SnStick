# -*- coding: utf-8 -*-
"""v2.3 用户隔离改造 (M3-3c 监控引擎缺口修复) 专项回归。

背景: 监控引擎在后台线程评估 (无请求上下文), 原单例引擎模式下规则/告警
写入 users/local (降级目录) 与用户查询路径错位, 超管/用户都看不到告警。

改造后契约:
  1. _evaluate_monitors 互通形态遍历 app.state.monitor_engines {uid: engine},
     逐用户 user_scope 内评估 (告警写入该用户目录);
  2. 桌面形态 (monitor_engines 缺失/非 dict) 回退单引擎, 原逻辑零改动;
  3. QuoteSubscriber 绑定 user_id, _broadcast_alerts 按用户过滤 SSE;
  4. 惰性构建: 新用户首存规则时 get_monitor_engine_for 动态注册引擎。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import threading

import polars as pl

from app.services.quote_service import QuoteService


def _make_qs(monkeypatch, *, daily_date):
    from datetime import date

    qs = QuoteService.__new__(QuoteService)
    qs._repo = MagicMock()
    qs._lock = threading.RLock()
    qs._subscribers = set()
    qs._symbol_count = 0
    monkeypatch.setattr(QuoteService, "_is_continuous_trading", lambda self: True)
    monkeypatch.setattr(
        QuoteService, "get_enriched_today",
        lambda self: (
            pl.DataFrame({"symbol": ["600000.SH"], "close": [10.0], "change_pct": [0.05]}),
            daily_date,
        ),
    )
    monkeypatch.setattr(
        "app.services.quote_service.cn_today", lambda: daily_date,
    )
    monkeypatch.setattr(
        QuoteService, "_inject_intraday_signals",
        lambda self, df, engine, at: df,
    )
    monkeypatch.setattr(
        QuoteService, "_maybe_send_system_notifications", lambda self, alerts: None,
    )
    monkeypatch.setattr(
        QuoteService, "_maybe_send_webhook", lambda self, events, engine: None,
    )
    monkeypatch.setattr(
        QuoteService, "_enrich_alerts_ext", lambda self, alerts: None,
    )
    # 广播改为 spy: 记录调用时的过滤用户
    qs._broadcast_alerts = MagicMock()
    return qs


def _make_engine(*, with_stock_rule: bool = True):
    eng = MagicMock()
    eng.rule_count = 1 if with_stock_rule else 0
    eng.has_rule_type.return_value = False
    eng.has_asset_rules.return_value = False
    if with_stock_rule:
        eng.evaluate.return_value = [{
            "source": "price", "type": "price", "rule_id": "r1",
            "rule_name": "测试", "symbol": "600000.SH", "name": "浦发银行",
            "message": "触发", "price": 10.0, "change_pct": 0.05,
            "signals": [], "severity": "info",
        }]
    return eng


# ── 1. 互通形态: 逐用户评估 + user_scope 包裹 ──────────────

def test_multi_user_engines_each_evaluated_in_scope(monkeypatch):
    """monitor_engines dict 存在时, 每个用户引擎都被评估, 且各自 user_scope。"""
    from datetime import date
    from datetime import datetime  # noqa: F401

    import contextlib

    qs = _make_qs(monkeypatch, daily_date=date(2026, 9, 14))
    eng_a = _make_engine()
    eng_b = _make_engine()
    state = SimpleNamespace(
        monitor_engines={"101": eng_a, "102": eng_b},
        monitor_engine=None,
        repo=qs._repo,
    )
    qs._app_state = state

    seen_scopes: list[str] = []

    from app.identity.user_context import user_scope as _real_scope

    @contextlib.contextmanager
    def spy_scope(uid):
        seen_scopes.append(str(uid))
        with _real_scope(uid):
            yield

    with patch("app.identity.user_context.user_scope", spy_scope):
        qs._evaluate_monitors(pl.DataFrame(), None)

    # 两个引擎都被评估
    eng_a.evaluate.assert_called()
    eng_b.evaluate.assert_called()
    # 两个用户作用域都被进入 (顺序无关)
    assert sorted(seen_scopes) == ["101", "102"]


def test_multi_user_alerts_persisted_under_user_scope(monkeypatch, tmp_path):
    """评估产生的告警在 user_scope 内落盘 → alert_store 按当前用户写。"""
    from datetime import date

    from app.services import alert_store

    qs = _make_qs(monkeypatch, daily_date=date(2026, 9, 14))
    eng = _make_engine()
    state = SimpleNamespace(
        monitor_engines={"101": eng}, monitor_engine=None, repo=qs._repo,
    )
    qs._app_state = state
    qs._app_state.repo.store.data_dir = tmp_path

    captured_dirs: list = []
    real_append = alert_store.append_many

    def spy_append(data_dir, events):
        from app.identity.user_context import current_user_id
        captured_dirs.append((str(data_dir), current_user_id(), len(events)))
        return real_append(data_dir, events)

    with patch.object(alert_store, "append_many", spy_append):
        qs._evaluate_monitors(pl.DataFrame(), None)

    # 恰一次落盘, 且落盘时上下文用户是 101 (用户隔离写入)
    assert len(captured_dirs) == 1
    assert captured_dirs[0][1] == "101"
    assert captured_dirs[0][2] == 1  # 一条告警


# ── 2. 桌面形态回退: 单引擎原逻辑 ──────────────────────

def test_desktop_fallback_single_engine(monkeypatch, tmp_path):
    """monitor_engines 缺失时回退 monitor_engine 单引擎 (无 user_scope 包裹)。"""
    from datetime import date

    qs = _make_qs(monkeypatch, daily_date=date(2026, 9, 14))
    eng = _make_engine()
    state = SimpleNamespace(
        monitor_engine=eng, monitor_engines=None, repo=qs._repo,
    )
    qs._app_state = state
    qs._app_state.repo.store.data_dir = tmp_path  # 真实临时目录, 告警落盘不污染仓库

    with patch("app.identity.user_context.user_scope") as scope_mock:
        qs._evaluate_monitors(pl.DataFrame(), None)

    eng.evaluate.assert_called()
    scope_mock.assert_not_called()  # 单用户形态不进入用户作用域


def test_magic_mock_state_not_misread_as_multi(monkeypatch, tmp_path):
    """MagicMock state (旧测试常用) 不被误判为多用户 dict (isinstance 门控)。"""
    from datetime import date

    qs = _make_qs(monkeypatch, daily_date=date(2026, 9, 14))
    eng = _make_engine(with_stock_rule=False)  # 无告警产出, 避免 MagicMock 落盘
    eng.rule_count = 1
    eng.evaluate.return_value = []
    state = MagicMock()
    state.monitor_engine = eng
    state.repo.store.data_dir = tmp_path  # 真实路径, 防止 MagicMock 路径污染仓库
    qs._app_state = state

    with patch("app.identity.user_context.user_scope") as scope_mock:
        qs._evaluate_monitors(pl.DataFrame(), None)

    eng.evaluate.assert_called()
    scope_mock.assert_not_called()


# ── 3. SSE 订阅者按用户过滤 ─────────────────────────

def test_broadcast_alerts_filters_by_user():
    """_broadcast_alerts: 显式 uid 只推给该用户订阅者; None 广播全部。"""
    from app.services.quote_service import QuoteService, QuoteSubscriber

    qs = QuoteService.__new__(QuoteService)
    qs._subscribers = set()
    sub_admin = QuoteSubscriber(user_id="1")
    sub_user = QuoteSubscriber(user_id="101")

    def _snap():
        return [sub_admin, sub_user]

    qs._snapshot_subscribers = _snap
    sub_admin.push_alerts = MagicMock()
    sub_user.push_alerts = MagicMock()

    alerts = [{"source": "price", "message": "x"}]

    # 显式 uid=101: 只有 101 的订阅者收到
    qs._broadcast_alerts(alerts, user_id="101")
    sub_user.push_alerts.assert_called_once()
    sub_admin.push_alerts.assert_not_called()

    # 显式 None: 全部订阅者收到 (全局通知, 如情绪周期切换)
    sub_admin.push_alerts.reset_mock()
    sub_user.push_alerts.reset_mock()
    qs._broadcast_alerts(alerts, user_id=None)
    sub_admin.push_alerts.assert_called_once()
    sub_user.push_alerts.assert_called_once()

    # 未绑定 user 的订阅者 (桌面形态) 任何情况下都收到
    sub_anon = QuoteSubscriber(user_id=None)
    sub_anon.push_alerts = MagicMock()
    qs._snapshot_subscribers = lambda: [sub_anon]
    qs._broadcast_alerts(alerts, user_id="101")
    sub_anon.push_alerts.assert_called_once()


def test_subscribe_binds_user_from_context(monkeypatch):
    """subscribe() 默认从请求上下文取用户绑定到订阅者。"""
    import threading

    from app.services.quote_service import QuoteService

    from app.identity.user_context import user_scope

    qs = QuoteService.__new__(QuoteService)
    qs._lock = threading.RLock()
    qs._subscribers = set()

    with user_scope(101):
        sub = qs.subscribe()
    assert sub.user_id == "101"

    # 无上下文 (桌面形态): user_id 为 None → 不过滤
    sub2 = qs.subscribe()
    assert sub2.user_id is None


# ── 4. 惰性构建入口契约 ─────────────────────────────

def test_current_engine_lazy_create_called(monkeypatch):
    """_current_engine(create=True): 引擎缺失时调用 app.state.get_monitor_engine_for。"""
    from fastapi import Request

    from app.api.monitor_rules import _current_engine

    built = MagicMock()
    app = SimpleNamespace(
        state=SimpleNamespace(
            monitor_engines={"101": MagicMock()},
            get_monitor_engine_for=MagicMock(return_value=built),
            monitor_engine=None,
        ),
    )
    request = Request.__new__(Request)
    request._state = None
    object.__setattr__(request, "scope", {"app": app, "type": "http"})

    from app.identity.user_context import user_scope

    # 已存在用户: 直接返回, 不构建
    with user_scope(101):
        got = _current_engine(request)
    assert got is app.state.monitor_engines["101"]
    app.state.get_monitor_engine_for.assert_not_called()

    # 不存在的用户 205: 惰性构建
    with user_scope(205):
        got = _current_engine(request, create=True)
    assert got is built
    app.state.get_monitor_engine_for.assert_called_once_with("205")

    # create=False 时不构建, 返回 None
    app.state.get_monitor_engine_for.reset_mock()
    with user_scope(206):
        got = _current_engine(request, create=False)
    assert got is None
    app.state.get_monitor_engine_for.assert_not_called()
