"""agg 聚合周期 (2d/4d/1w/1M) 的 /api/kline/daily 口径锁死测试。

Pine 周期语义: 指标永远画在当前周期 K 上 — 聚合后私有指标在聚合 K 上重算
(warmup 同口径聚合, _attach_plus_with_warmup agg=...), 公开指标由前端
enrichChartIndicators 现场重算。量级标尺按附图 f_getPresetLookback 预设档:
<1分钟=300 / <1小时=200 / <1天=160 / <1周=50 / <1月=10 / ≥1月=3
→ 2d/4d=50, 1w=10, 1M=3。
"""

from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import HTTPException

from app.api import kline as kline_api


def _rows_frame(dates, opens, highs, lows, closes, volumes, amounts=None, is_lives=None):
    data = {
        "symbol": ["600000.SH"] * len(dates),
        "date": list(dates),
        "open": list(opens), "high": list(highs), "low": list(lows), "close": list(closes),
        "volume": list(volumes),
    }
    if amounts is not None:
        data["amount"] = list(amounts)
    if is_lives is not None:
        data["is_live"] = list(is_lives)
    return pl.DataFrame(data)


class _Repo:
    def __init__(self, frame):
        self._frame = frame

    def resolve_asset_type(self, symbol: str) -> str:
        return "stock"

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["600000.SH"], "name": ["浦发银行"],
            "total_shares": [1.0], "float_shares": [1.0],
        })

    def get_daily_asset(self, asset_type, symbol, start, end, columns=None):
        return self._frame


def _request(frame):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        repo=_Repo(frame), quote_service=None, capabilities=None,
    )))


# ── _resample_daily_rows 分组口径 ──────────────────────────────


def test_resample_2d_counts_by_trading_days():
    """2d: 每 2 交易日一桶 (计数分组); open=首根 / close=末根 / high·low=极值 / volume·amount 求和。"""
    d = [f"2026-09-{x:02d}" for x in (14, 15, 16, 17, 18)]  # 周一~周五
    rows = _rows_frame(
        d, [1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [0.5, 1.5, 2.5, 3.5, 4.5],
        [1.5, 2.5, 3.5, 4.5, 5.5], [100, 200, 300, 400, 500],
        amounts=[1000, 2000, 3000, 4000, 5000],
    ).to_dicts()
    out = kline_api._resample_daily_rows(rows, "2d")
    assert [r["date"] for r in out] == ["2026-09-14", "2026-09-16", "2026-09-18"]
    # 桶 1: 09-14/15
    assert out[0]["open"] == 1 and out[0]["close"] == 2.5
    assert out[0]["high"] == 3 and out[0]["low"] == 0.5
    assert out[0]["volume"] == 300 and out[0]["amount"] == 3000
    # 桶 2: 09-16/17
    assert out[1]["open"] == 3 and out[1]["close"] == 4.5
    assert out[1]["high"] == 5 and out[1]["low"] == 2.5
    # 桶 3: 09-18 (余数单独成桶)
    assert out[2]["open"] == 5 and out[2]["close"] == 5.5


def test_resample_1w_iso_natural_week():
    """1w: ISO 自然周分组 (周一~周日), date 取桶首根; 跨月不混桶。"""
    # 2026-09-28(一)~10-02(五) 同 ISO 周; 10-05(一) 新周
    d = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"]
    rows = _rows_frame(
        d, [1, 2, 3, 4, 5, 6], [2, 3, 4, 5, 6, 7], [0.5, 1.5, 2.5, 3.5, 4.5, 5.5],
        [1.5, 2.5, 3.5, 4.5, 5.5, 6.5], [100] * 6,
    ).to_dicts()
    out = kline_api._resample_daily_rows(rows, "1w")
    assert [r["date"] for r in out] == ["2026-09-28", "2026-10-05"]
    assert out[0]["close"] == 5.5  # 10-02 收盘
    assert out[0]["high"] == 6 and out[0]["low"] == 0.5
    assert out[0]["volume"] == 500


def test_resample_1m_natural_month():
    """1M: 自然月分组, 跨年不混桶。"""
    d = ["2026-12-30", "2026-12-31", "2027-01-04"]
    rows = _rows_frame(
        d, [1, 2, 3], [2, 3, 4], [0.5, 1.5, 2.5], [1.5, 2.5, 3.5], [100] * 3,
    ).to_dicts()
    out = kline_api._resample_daily_rows(rows, "1M")
    assert [r["date"] for r in out] == ["2026-12-30", "2027-01-04"]
    assert out[0]["close"] == 2.5 and out[1]["open"] == 3


def test_resample_inherits_is_live():
    """实时标记继承: 末行 is_live=True → 所在桶 is_live=True (末根活动桶保留实时徽记语义);
    无实时行的桶 is_live=False。"""
    d = ["2026-09-14", "2026-09-15", "2026-09-16"]
    rows = _rows_frame(
        d, [1, 2, 3], [2, 3, 4], [0.5, 1.5, 2.5], [1.5, 2.5, 3.5], [100] * 3,
        is_lives=[False, False, True],
    ).to_dicts()
    out = kline_api._resample_daily_rows(rows, "2d")
    assert [r["is_live"] for r in out] == [False, True]

    rows_plain = _rows_frame(
        d, [1, 2, 3], [2, 3, 4], [0.5, 1.5, 2.5], [1.5, 2.5, 3.5], [100] * 3,
    ).to_dicts()
    out_plain = kline_api._resample_daily_rows(rows_plain, "2d")
    assert [r["is_live"] for r in out_plain] == [False, False]


def test_resample_unknown_agg_passthrough():
    """未知 agg 原样透传 (端点层已挡非法值, 聚合函数自身兜底不炸)。"""
    d = ["2026-09-14", "2026-09-15"]
    rows = _rows_frame(d, [1, 2], [2, 3], [0.5, 1.5], [1.5, 2.5], [100, 200]).to_dicts()
    assert kline_api._resample_daily_rows(rows, "3w") is rows


# ── 端点: lookback 按 Pine 预设档推导 + agg 透传 ───────────────


def _capture_attach(monkeypatch) -> dict:
    captured: dict = {}

    def _fake_attach(repo, asset_type, symbol, rows, lookback=50, ry_bar_minutes=None, agg=None):
        captured["lookback"] = lookback
        captured["ry_bar_minutes"] = ry_bar_minutes
        captured["agg"] = agg
        return rows

    monkeypatch.setattr(kline_api, "_attach_plus_with_warmup", _fake_attach)
    return captured


def test_daily_agg_derives_preset_lookback(monkeypatch):
    """agg 模式 lookback 未显式传时按 f_getPresetLookback 预设档推导:
    1w=10 / 1M=3 / 2d=4d=50; ry_bar_minutes 强制 None (K2/K3 桶=聚合周期本身)。"""
    captured = _capture_attach(monkeypatch)
    frame = _rows_frame(["2026-09-14", "2026-09-15"], [1, 2], [2, 3], [0.5, 1.5], [1.5, 2.5], [100, 200])
    req = _request(frame)
    for agg, expected in (("1w", 10), ("1M", 3), ("2d", 50), ("4d", 50)):
        kline_api.get_daily(
            req, symbol="600000.SH", days=120, start_date=None, end_date=None,
            ext_columns=None, plus_lookback=None, ry_bar_minutes=None, agg=agg,
        )
        assert captured["lookback"] == expected, f"agg={agg}"
        assert captured["ry_bar_minutes"] is None, f"agg={agg}"
        assert captured["agg"] == agg


def test_daily_agg_explicit_lookback_wins(monkeypatch):
    """显式传 plus_lookback 时不被预设档覆盖 (4h 等专档调用方不受影响)。"""
    captured = _capture_attach(monkeypatch)
    frame = _rows_frame(["2026-09-14"], [1], [2], [0.5], [1.5], [100])
    kline_api.get_daily(
        _request(frame), symbol="600000.SH", days=120, start_date=None, end_date=None,
        ext_columns=None, plus_lookback=160, ry_bar_minutes=None, agg="1w",
    )
    assert captured["lookback"] == 160


def test_daily_agg_rows_are_aggregated(monkeypatch):
    """agg 模式返回行已是聚合 K (私有指标附着在聚合 K 上, 而非日K值透传)。"""
    monkeypatch.setattr(kline_api, "_attach_plus_with_warmup", lambda repo, a, s, rows, **kw: rows)
    d = ["2026-09-14", "2026-09-15", "2026-09-16"]
    frame = _rows_frame(d, [1, 2, 3], [2, 3, 4], [0.5, 1.5, 2.5], [1.5, 2.5, 3.5], [100, 200, 300])
    resp = kline_api.get_daily(
        _request(frame), symbol="600000.SH", days=120, start_date=None, end_date=None,
        ext_columns=None, plus_lookback=None, ry_bar_minutes=None, agg="2d",
    )
    dates = [r["date"] for r in resp["rows"]]
    assert dates == ["2026-09-14", "2026-09-16"]


def test_daily_agg_rejects_unknown():
    """非法 agg → 400。"""
    frame = _rows_frame(["2026-09-14"], [1], [2], [0.5], [1.5], [100])
    with pytest.raises(HTTPException) as ei:
        kline_api.get_daily(
            _request(frame), symbol="600000.SH", days=120, start_date=None, end_date=None,
            ext_columns=None, plus_lookback=None, ry_bar_minutes=None, agg="3w",
        )
    assert ei.value.status_code == 400


def test_daily_no_agg_direct_call_does_not_explode(monkeypatch):
    """直调端点 (测试/内部调用) 时 FastAPI Query 默认对象会漏进 agg 形参 —
    净化后必须视为未传, 不得误判为非法 agg 抛 400 (回归锁: 修复前
    test_get_daily_default_end_is_beijing_today 因 Query(None) is not None 而炸)。"""
    captured = _capture_attach(monkeypatch)
    frame = _rows_frame(["2026-09-14"], [1], [2], [0.5], [1.5], [100])
    # 不传 plus_lookback / ry_bar_minutes / agg → 直调时均为 Query 默认对象
    kline_api.get_daily(
        _request(frame), symbol="600000.SH", days=120, start_date=None, end_date=None,
        ext_columns=None,
    )
    assert captured["lookback"] == 50  # 未显式传 → 默认日K档
    assert captured["agg"] is None
