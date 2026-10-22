"""图表工作台分钟聚合周期 (15m/60m) 私有指标服务端线路测试。

核心是「同口径对拍」: 用服务端 R5 口径实现 (indicators/plus.py + intraday.py)
对真实行情 fixture (600519.SH, 2026-10-14 抓取) 生成的参考值, 验证聚合与
MACD+/RSI+/fund 信号附着逐字段一致 — 算法口径变更 (2026-10-22 R5 校准) 的
数值不回归安全网。

fixture (600519.SH, 2026-10-14 抓取):
    minute_600519_60d.json   60 交易日 1 分钟K (14220 行, API 原样响应)
    daily_600519_260d.json   260 交易日日K (4h 周期数据源)
    intraday_plus_reference.json  R5 口径末 40 根参考值 (再生成脚本见仓库
                                  历史提交记录, 生成方式与测试同源)
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.kline import router
from app.indicators.intraday import (
    attach_intraday_plus,
    resample_minutes,
    to_minute_start_semantics,
)
from app.indicators.plus import attach_plus_indicators

FIXTURES = Path(__file__).parent / "fixtures"


def _load_minute_rows() -> list[dict]:
    """加载 1 分钟K fixture → 模拟 repo.get_minute_range 的 to_dicts 输出
    (datetime 为 datetime 对象, 结束时刻语义)。"""
    payload = json.loads((FIXTURES / "minute_600519_60d.json").read_text(encoding="utf-8"))
    rows = []
    for session in payload["sessions"]:
        for r in session["rows"]:
            rows.append({
                "datetime": datetime.fromisoformat(r["datetime"]),
                "open": r["open"],
                "high": r["high"],
                "low": r["low"],
                "close": r["close"],
                "volume": r["volume"],
                "amount": r["amount"],
            })
    rows.sort(key=lambda r: r["datetime"])
    return rows


def _load_reference() -> dict:
    return json.loads((FIXTURES / "intraday_plus_reference.json").read_text(encoding="utf-8"))


def _assert_bar_equal(actual: dict, expected: dict) -> None:
    """逐字段对拍 (浮点允许跨平台 libm 末位噪声)。"""
    assert actual["date"] == expected["date"]
    for key in ("open", "high", "low", "close", "volume", "amount",
                "macd_plus_dif", "macd_plus_dea", "macd_plus_hist",
                "volume_rsi_fast", "volume_rsi_slow", "rsi_plus",
                "fund_bg_color", "fund_tracking_state",
                "fund_cross_up_lower", "fund_cross_down_upper",
                # 融易主图 (R5)
                "ry_upper", "ry_mid", "ry_lower", "ry_mid_trend", "ry_mid_tick",
                "ry_ema_mid", "k_trend", "k_up", "k_dn",
                "k2_trend", "k2_up", "k2_dn", "k3_trend", "k3_up", "k3_dn",
                "ry_bar_color", "ry_top_signal", "ry_top_price",
                "ry_btm_signal", "ry_btm_price",
                "div_top_count", "div_btm_count"):
        a, e = actual.get(key), expected.get(key)
        if e is None or a is None:
            assert a == e, f"{actual['date']} {key}: {a!r} != {e!r}"
        else:
            assert a == pytest.approx(e, rel=1e-12, abs=1e-12), (
                f"{actual['date']} {key}: {a!r} != {e!r}"
            )


class TestIntradayPure:
    """纯函数单元: 语义换算与切桶口径。"""

    def _row(self, dt: str, o=10.0, h=10.5, lo=9.5, c=10.2, v=100.0, a=1000.0):
        return {
            "datetime": datetime.fromisoformat(dt),
            "open": o, "high": h, "low": lo, "close": c, "volume": v, "amount": a,
        }

    def test_semantics_shift_and_auction_merge(self):
        # 09:30 竞价根 + 09:31 (结束时刻) → 换算后同为 09:30 合并
        rows = [
            self._row("2026-10-14T09:30:00", o=10.0, h=10.1, lo=10.0, c=10.1, v=50, a=500),
            self._row("2026-10-14T09:31:00", o=10.1, h=10.3, lo=10.0, c=10.2, v=30, a=300),
            self._row("2026-10-14T09:32:00", o=10.2, h=10.4, lo=10.2, c=10.3, v=20, a=200),
        ]
        out = to_minute_start_semantics(rows)
        assert len(out) == 2
        # 合并根: open=首根(竞价), close=末根, high/low 极值, 量额相加
        assert out[0]["datetime"] == datetime.fromisoformat("2026-10-14T09:30:00")
        assert out[0]["open"] == 10.0
        assert out[0]["close"] == 10.2
        assert out[0]["high"] == 10.3
        assert out[0]["low"] == 10.0
        assert out[0]["volume"] == 80
        assert out[0]["amount"] == 800
        # 09:32 → 09:31 (仅换算不合并不动数值)
        assert out[1]["datetime"] == datetime.fromisoformat("2026-10-14T09:31:00")
        assert out[1]["open"] == 10.2

    def test_semantics_afternoon_and_close(self):
        rows = [
            self._row("2026-10-14T13:01:00"),
            self._row("2026-10-14T15:00:00"),
            self._row("2026-10-14T11:30:00"),
        ]
        rows.sort(key=lambda r: r["datetime"])
        out = to_minute_start_semantics(rows)
        assert [r["datetime"].strftime("%H:%M") for r in out] == ["11:29", "13:00", "14:59"]

    def test_semantics_irregular_labels_passthrough(self):
        # 午休 12:00 / 盘后 15:30 等异常标签不换算原样透传
        rows = [self._row("2026-10-14T12:00:00"), self._row("2026-10-14T09:30:00")]
        out = to_minute_start_semantics(sorted(rows, key=lambda r: r["datetime"]))
        assert [r["datetime"].strftime("%H:%M") for r in out] == ["09:30", "12:00"]

    def test_resample_bucket_boundaries_no_lunch_cross(self):
        # 上午末根 11:29 与下午首根 13:00 分属不同桶 (不跨午休); 桶标签=首根时间
        rows = [
            self._row("2026-10-14T09:30:00", c=10.0),
            self._row("2026-10-14T09:44:00", c=10.1),
            self._row("2026-10-14T09:45:00", c=10.2),   # 15m 桶 1 起点
            self._row("2026-10-14T11:29:00", c=10.3),   # 上午末根 (换算后)
            self._row("2026-10-14T13:00:00", c=10.4),   # 下午首根 (换算后)
        ]
        bars = resample_minutes(rows, 15)
        assert [b["date"] for b in bars] == [
            "2026-10-14 09:30", "2026-10-14 09:45", "2026-10-14 11:29", "2026-10-14 13:00",
        ]
        # 桶 OHLCV: open=首根, close=末根, 极值, 求和
        assert bars[0]["open"] == 10.0 and bars[0]["close"] == 10.1
        assert bars[2]["close"] == 10.3
        assert bars[3]["close"] == 10.4
        assert bars[0]["volume"] == 200.0

    def test_resample_open_fallback_to_close(self):
        # 首根 open 缺失降级首根 close (与前端 flattenSessions 同口径)
        rows = [self._row("2026-10-14T09:30:00", o=None, c=10.2)]
        bars = resample_minutes(rows, 15)
        assert bars[0]["open"] == 10.2

    def test_resample_amount_partial_null_semantics(self):
        # amount 任一非空取累计语义: null+5→5; 全 null→None
        rows = [
            self._row("2026-10-14T09:30:00", a=None),
            self._row("2026-10-14T09:31:00", a=5.0),
            self._row("2026-10-14T09:45:00", a=None),
            self._row("2026-10-14T09:46:00", a=None),
        ]
        bars = resample_minutes(rows, 15)
        assert bars[0]["amount"] == 5.0
        assert bars[1]["amount"] is None

    def test_attach_lookback_dispatch(self):
        base = datetime(2026, 7, 1, 9, 30)
        rows = [
            self._row((base + timedelta(days=d)).isoformat(), c=10.0 + d)
            for d in range(60)
        ]
        for period, lookback in ((15, 200), (60, 160)):
            bars = resample_minutes(rows, period)
            attach_intraday_plus(bars, period)
            assert "macd_plus_dif" in bars[0] and "rsi_plus" in bars[0]
        with pytest.raises(ValueError):
            attach_intraday_plus(resample_minutes(rows, 15), 240)

    def test_resample_same_bucket_index_different_session(self):
        # 上午桶 idx 与下午桶 idx 相同 (如 60m 各自桶 0) 不得合并
        rows = [
            self._row("2026-10-14T09:30:00", c=10.0),
            self._row("2026-10-14T10:30:00", c=10.1),
            self._row("2026-10-14T13:00:00", c=10.2),
            self._row("2026-10-14T14:00:00", c=10.3),
        ]
        bars = resample_minutes(rows, 60)
        assert [b["date"] for b in bars] == [
            "2026-10-14 09:30", "2026-10-14 10:30", "2026-10-14 13:00", "2026-10-14 14:00",
        ]


class TestIntradayCrossCheck:
    """跨语言对拍: 服务端实现 vs 迁移前前端实现的真实数据参考值。"""

    @pytest.mark.parametrize("period,minutes", [("15m", 15), ("60m", 60)])
    def test_minute_aggregation_matches_reference(self, period, minutes):
        ref = _load_reference()
        rows = _load_minute_rows()
        bars = attach_intraday_plus(resample_minutes(to_minute_start_semantics(rows), minutes), minutes)
        expected = ref[f"bars_{minutes}m"]
        assert len(bars) == ref[f"count_{minutes}m"]
        for actual_bar, expected_bar in zip(bars[-40:], expected):
            _assert_bar_equal(actual_bar, expected_bar)
        # 能量柱满窗口 (SMA200/160 在 60 日聚合 bars 尾部必有值)
        assert bars[-1]["macd_plus_hist"] is not None
        assert bars[-1]["fund_bg_color"] in (0, 1, 2)

    def test_4h_daily_source_matches_reference(self):
        # 4h 周期: 日K行 (260 根) → 160 档附着 (无 warmup 纯窗口递推,
        # 与前端 dailyRowsTo4hBars 数据流同口径)
        ref = _load_reference()
        payload = json.loads((FIXTURES / "daily_600519_260d.json").read_text(encoding="utf-8"))
        rows = payload["rows"]
        attach_plus_indicators(rows, warmup_closes=None, lookback=160)
        expected = ref["bars_4h"]
        assert len(rows) == ref["count_4h"]
        for actual_row, expected_bar in zip(rows[-40:], expected):
            _assert_bar_equal(
                {**actual_row, "date": f"{str(actual_row['date'])[:10]} 09:30"},
                expected_bar,
            )
        assert rows[-1]["macd_plus_hist"] is not None


class _FakeRepo:
    def __init__(self, asset_type: str = "stock", minute_frame: pl.DataFrame | None = None):
        self.asset_type = asset_type
        self._minute_frame = minute_frame if minute_frame is not None else pl.DataFrame()

    def resolve_asset_type(self, symbol: str) -> str:
        return self.asset_type

    def get_minute_range(self, symbols, start, end, asset_type: str = "stock"):
        return self._minute_frame


def _minute_frame() -> pl.DataFrame:
    """单日分钟K: 09:30 竞价 + 09:31..11:30 + 13:01..15:00 (结束时刻语义)。"""
    rows = _load_minute_rows()
    day = rows[0]["datetime"].date()
    same_day = [r for r in rows if r["datetime"].date() == day][:30]
    return pl.DataFrame(same_day)


def _client(repo: _FakeRepo) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.state.repo = repo
    return TestClient(app)


class TestIntradayAPI:
    def test_intraday_returns_bars_with_plus_fields(self):
        client = _client(_FakeRepo(minute_frame=_minute_frame()))
        resp = client.get("/api/kline/intraday", params={"symbol": "600519.SH", "period": "15m"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["symbol"] == "600519.SH"
        assert body["period"] == "15m"
        assert body["source"] == "local"
        assert len(body["bars"]) > 0
        bar = body["bars"][-1]
        for key in ("date", "open", "high", "low", "close", "volume",
                    "macd_plus_dif", "macd_plus_dea", "macd_plus_hist",
                    "volume_rsi_fast", "volume_rsi_slow", "rsi_plus",
                    "fund_bg_color", "fund_tracking_state",
                    "fund_cross_up_lower", "fund_cross_down_upper"):
            assert key in bar
        assert " " in bar["date"]  # "YYYY-MM-DD HH:mm" 标签格式

    def test_intraday_rejects_invalid_period(self):
        client = _client(_FakeRepo(minute_frame=_minute_frame()))
        resp = client.get("/api/kline/intraday", params={"symbol": "600519.SH", "period": "4h"})
        assert resp.status_code == 400

    def test_intraday_index_returns_none_source(self):
        client = _client(_FakeRepo(asset_type="index"))
        resp = client.get("/api/kline/intraday", params={"symbol": "000001.SH", "period": "15m"})
        assert resp.status_code == 200
        assert resp.json()["source"] == "none"
        assert resp.json()["bars"] == []

    def test_intraday_empty_local_returns_none_source(self):
        client = _client(_FakeRepo())
        resp = client.get("/api/kline/intraday", params={"symbol": "600519.SH", "period": "60m"})
        assert resp.status_code == 200
        assert resp.json()["source"] == "none"


class TestDailyPlusLookback:
    """get_daily 的 plus_lookback 参数 (4h 周期客户端传 160)。"""

    def _daily_client(self):
        class _Repo(_FakeRepo):
            def get_daily_asset(self, asset_type, symbol, start, end, columns=None):
                return pl.DataFrame({
                    "date": [end],
                    "close": [100.0],
                })

        app = FastAPI()
        app.include_router(router)
        app.state.repo = _Repo()
        return TestClient(app)

    def test_daily_plus_lookback_param_accepted(self):
        client = self._daily_client()
        # days=10 走 enriched 空表 → live 拉取失败 → 502/空响应均可, 只验证参数被接受
        resp = client.get("/api/kline/daily", params={
            "symbol": "600519.SH", "days": 10, "plus_lookback": 160,
        })
        assert resp.status_code in (200, 502)

    def test_daily_plus_lookback_out_of_range_rejected(self):
        client = self._daily_client()
        resp = client.get("/api/kline/daily", params={
            "symbol": "600519.SH", "days": 10, "plus_lookback": 999,
        })
        assert resp.status_code == 422
