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
    # date 列用真实 Date 类型 (repo 存储同款; get_daily_asset 窗口过滤需要可比较)
    return pl.DataFrame(data).with_columns(pl.col("date").str.to_date())


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
        # 真实 repo 同款: 按 [start, end] 窗口过滤 (warmup 全历史查询依赖此语义)
        df = self._frame.filter((pl.col("date") >= start) & (pl.col("date") <= end))
        if columns:
            df = df.select(columns)
        return df.sort("date")


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
    d = ["2026-09-14", "2026-09-15", "2026-09-16"]
    frame = _rows_frame(d, [1, 2, 3], [2, 3, 4], [0.5, 1.5, 2.5], [1.5, 2.5, 3.5], [100, 200, 300])
    resp = kline_api.get_daily(
        _request(frame), symbol="600000.SH", days=120, start_date=None, end_date=None,
        ext_columns=None, plus_lookback=None, ry_bar_minutes=None, agg="2d",
    )
    dates = [str(r["date"]) for r in resp["rows"]]
    assert dates == ["2026-09-14", "2026-09-16"]
    first = resp["rows"][0]
    assert first["open"] == 1 and first["close"] == 2.5
    assert first["high"] == 3 and first["volume"] == 300
    # 私有指标已在聚合 K 上附着 (字段存在; 2 根序列上数值本身不作为对数基准)
    assert "macd_plus_hist" in first and "ry_upper" in first and "k2_up" in first


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
    净化后必须视为未传, 不得误判为非法 agg 拆 400 (回归锁: 修复前
    test_get_daily_default_end_is_beijing_today 因 Query(None) is not None 而拆)。"""
    captured = _capture_attach(monkeypatch)
    frame = _rows_frame(["2026-09-14"], [1], [2], [0.5], [1.5], [100])
    # 不传 plus_lookback / ry_bar_minutes / agg → 直调时均为 Query 默认对象
    kline_api.get_daily(
        _request(frame), symbol="600000.SH", days=120, start_date=None, end_date=None,
        ext_columns=None,
    )
    assert captured["lookback"] == 50  # 未显式传 → 默认日K档
    assert captured["agg"] is None


def test_daily_agg_full_history_bucket_alignment(monkeypatch):
    """2d 桶边界从全历史起点连续计数 (修复窗口起点计数导致的跨页漂移):
    全历史 = 09-07~09-11 (5 交易日), 窗口 = 09-14~09-16 (3 交易日);
    从 09-07 起每 2 交易日一桶 → [07,08][09,10][11,14][15,16];
    窗口首日 09-14 所在桶 (跨界桶, 含窗口前 09-11) 起切出返回,
    指标在完整聚合序列上递推 — 主请求与「往左加载更多」桶边界一致。"""
    hist = _rows_frame(
        ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"],
        [1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [0.5, 1.5, 2.5, 3.5, 4.5],
        [1.5, 2.5, 3.5, 4.5, 5.5], [100] * 5,
    )
    window = _rows_frame(
        ["2026-09-14", "2026-09-15", "2026-09-16"],
        [6, 7, 8], [7, 8, 9], [5.5, 6.5, 7.5], [6.5, 7.5, 8.5], [100] * 3,
    )
    repo = _Repo(pl.concat([hist, window]))
    resp = kline_api.get_daily(
        SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
            repo=repo, quote_service=None, capabilities=None,
        ))), symbol="600000.SH", days=120, start_date="2026-09-14", end_date="2026-09-16",
        ext_columns=None, plus_lookback=None, ry_bar_minutes=None, agg="2d",
    )
    rows = resp["rows"]
    # 窗口首日所在桶 = 跨界桶 (桶首 09-11 < 窗口首日 09-14)
    assert [str(r["date"]) for r in rows] == ["2026-09-11", "2026-09-15"]
    # 跨界桶 OHLCV: open=09-11 的 open, close=09-14 的 close, volume=两日之和
    assert rows[0]["open"] == 5 and rows[0]["close"] == 6.5 and rows[0]["volume"] == 200
    # 第二桶 = 09-15/16
    assert rows[1]["open"] == 7 and rows[1]["close"] == 8.5 and rows[1]["volume"] == 200
    # 私有指标在完整聚合序列 (4 桶) 上递推后切窗口 — 字段齐全
    assert "ry_upper" in rows[0] and "macd_plus_hist" in rows[0]
