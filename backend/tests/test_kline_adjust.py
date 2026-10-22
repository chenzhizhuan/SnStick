"""不复权 (adjust=raw) 显示模式的口径锁死测试。

背景 (2026-10-23 对拍实证): 用户 TV 布局显示的是不复权 (raw) 序列 —
本地 raw_close 与 TV 日线收盘完全一致 (前复权口径差 ~33 元)。
raw 模式: OHLC 换回原始价 (close/high/low 直取 raw 列, open 行级比例反推),
私有指标 (MACD+/RSI+/融易主图) 在 raw 序列上重算, warmup 历史同口径换算。
"""

from datetime import date, datetime, timedelta
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import HTTPException

from app.api import kline as kline_api
from app.market_time import cn_today

# 窗口内日期 (相对今天 — get_daily 默认 end=北京今天/days=120, 必须落在窗口内
# 才走 enriched 本地路径; 固定日期会随时间漂出窗口误触发 live 拉取)
_D0 = cn_today() - timedelta(days=3)
_D1 = cn_today() - timedelta(days=2)


# ── _to_raw_ohlcv 换算数学 ──────────────────────────────────────


def test_to_raw_ohlcv_math():
    """close/high/low 直取 raw 列; open 按行级比例 (raw_close/close) 反推;
    volume/amount 与其他字段原样保留 (原地改写)。"""
    rows = [{
        "date": "2026-04-07", "open": 1000.0, "high": 1450.0, "low": 990.0, "close": 1406.73,
        "raw_close": 1440.02, "raw_high": 1483.5, "raw_low": 1014.0,
        "volume": 50000, "amount": 7.2e9, "ma5": 1380.0,
    }]
    out = kline_api._to_raw_ohlcv(rows)
    assert out[0]["close"] == 1440.02
    assert out[0]["high"] == 1483.5
    assert out[0]["low"] == 1014.0
    # open = 1000 × (1440.02 / 1406.73)
    assert out[0]["open"] == pytest.approx(1023.66, rel=1e-4)
    assert out[0]["volume"] == 50000 and out[0]["amount"] == 7.2e9
    assert out[0]["ma5"] == 1380.0  # 非价格列不动 (后续附着才重算指标)


def test_to_raw_ohlcv_missing_raw_stays():
    """无 raw_close (当日实时行 ratio=1) / raw_close=None / close=0 → 该行保持原值。"""
    rows = [
        {"date": "2026-10-23", "open": 1500.0, "close": 1501.0},  # 实时行无 raw 列
        {"date": "2026-10-22", "open": 10.0, "close": 10.0, "raw_close": None},
        {"date": "2026-10-21", "open": 5.0, "close": 0, "raw_close": 5.1},
    ]
    out = kline_api._to_raw_ohlcv(rows)
    assert out[0]["close"] == 1501.0
    assert out[1]["close"] == 10.0
    assert out[2]["close"] == 0


def test_to_raw_ohlcv_partial_raw_columns():
    """raw_high/raw_low 缺失时 close 仍换算 (直取可用列, 缺列保持 qfq 值兜底)。"""
    rows = [{"date": "2026-04-07", "open": 1000.0, "high": 1450.0, "low": 990.0,
             "close": 1406.73, "raw_close": 1440.02}]
    out = kline_api._to_raw_ohlcv(rows)
    assert out[0]["close"] == 1440.02
    assert out[0]["high"] == 1450.0 and out[0]["low"] == 990.0
    assert out[0]["open"] == pytest.approx(1023.66, rel=1e-4)


# ── /daily 端点: raw 模式行换算 + warmup 同口径 ─────────────────


def _raw_frame() -> pl.DataFrame:
    """两行 enriched 窗口行: qfq OHLC + raw 三列 (ratio=1.0237, 模拟 600519 除权)。"""
    return pl.DataFrame({
        "symbol": ["600000.SH"] * 2,
        "date": [_D0, _D1],
        "open": [1000.0, 1000.0], "high": [1450.0, 1450.0],
        "low": [990.0, 990.0], "close": [1400.0, 1406.73],
        "raw_close": [1433.18, 1440.02], "raw_high": [1484.0, 1484.0], "raw_low": [1013.3, 1013.3],
        "volume": [50000.0, 50000.0],
    })


class _RawRepo:
    """记录 get_daily_asset 的 columns/start 请求 (验证 warmup raw 列 + 全历史起点)。"""

    def __init__(self, frame, raw_columns_ok: bool = True):
        self._frame = frame
        self._raw_columns_ok = raw_columns_ok
        self.columns_seen: list[list[str] | None] = []
        self.starts_seen: list[date] = []

    def resolve_asset_type(self, symbol: str) -> str:
        return "stock"

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["600000.SH"], "name": ["浦发银行"],
            "total_shares": [1.0], "float_shares": [1.0],
        })

    def get_daily_asset(self, asset_type, symbol, start, end, columns=None):
        self.columns_seen.append(list(columns) if columns else None)
        self.starts_seen.append(start)
        # 缺 raw 列兜底测试: 请求含 raw 列 → 抛错 (模拟指数/ETF 无 raw 列的表)
        if columns and "raw_close" in columns and not self._raw_columns_ok:
            raise pl.exceptions.ColumnNotFoundError("raw_close")
        df = self._frame.filter((pl.col("date") >= start) & (pl.col("date") <= end))
        if columns:
            df = df.select([c for c in columns if c in df.columns])
        return df.sort("date")


def _request(repo):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        repo=repo, quote_service=None, capabilities=None,
    )))


def test_daily_raw_returns_raw_prices():
    """adjust=raw: 返回行 close/high/low=raw 列值, open=比例反推; 指标在 raw 序列附着。"""
    resp = kline_api.get_daily(
        _request(_RawRepo(_raw_frame())), symbol="600000.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
        adjust="raw",
    )
    last = resp["rows"][-1]
    assert last["close"] == 1440.02 and last["high"] == 1484.0 and last["low"] == 1013.3
    assert last["open"] == pytest.approx(1023.66, rel=1e-4)
    # 私有指标已在 (raw) 序列上附着 — 字段齐全
    assert "ry_upper" in last and "macd_plus_hist" in last and "rsi_plus" in last


def test_daily_qfq_default_unchanged():
    """默认 (未传 adjust) 行保持前复权值 — 非 raw 模式行为不变 (回归锁)。"""
    resp = kline_api.get_daily(
        _request(_RawRepo(_raw_frame())), symbol="600000.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
    )
    last = resp["rows"][-1]
    assert last["close"] == 1406.73 and last["open"] == 1000.0


def test_daily_raw_warmup_reads_raw_columns():
    """raw 模式 warmup 历史读取追加 raw_close/raw_high/raw_low 列 (递推同口径)。"""
    repo = _RawRepo(_raw_frame())
    kline_api.get_daily(
        _request(repo), symbol="600000.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
        adjust="raw",
    )
    warmup_reads = [c for c in repo.columns_seen if c and "raw_close" in c]
    assert warmup_reads, "raw 模式 warmup 读取应请求 raw 列"
    # qfq 模式对照: 不请求 raw 列
    repo2 = _RawRepo(_raw_frame())
    kline_api.get_daily(
        _request(repo2), symbol="600000.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
        adjust="qfq",
    )
    assert not [c for c in repo2.columns_seen if c and "raw_close" in c]


def test_daily_raw_warmup_fallback_when_raw_columns_missing():
    """标的表缺 raw 列 (指数/ETF 等无复权概念): warmup 退回 qfq 列读取,
    不因 raw 模式丢失 warmup (端点仍 200 返回行)。"""
    resp = kline_api.get_daily(
        _request(_RawRepo(_raw_frame(), raw_columns_ok=False)),
        symbol="600000.SH", days=120, start_date=None, end_date=None, ext_columns=None,
        adjust="raw",
    )
    assert resp["rows"]  # 不炸, 行仍在
    assert resp["rows"][-1]["close"] == 1440.02  # 窗口行仍完成 raw 换算


def test_daily_adjust_invalid_rejected():
    """非法 adjust → 400。"""
    with pytest.raises(HTTPException) as ei:
        kline_api.get_daily(
            _request(_RawRepo(_raw_frame())), symbol="600000.SH", days=120,
            start_date=None, end_date=None, ext_columns=None,
            adjust="hfq",
        )
    assert ei.value.status_code == 400


def test_daily_direct_call_query_default_sanitized():
    """直调端点 (测试/内部调用) 时 FastAPI Query 默认对象会漏进 adjust 形参 —
    净化后视为未传 → qfq (不得误判非法值拆 400)。"""
    resp = kline_api.get_daily(
        _request(_RawRepo(_raw_frame())), symbol="600000.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
        adjust=kline_api.Query(None),
    )
    assert resp["rows"][-1]["close"] == 1406.73


def test_daily_ry_warmup_reads_full_history():
    """/daily 主端点 ry warmup 读全历史 (1990 起) — K2/K3 的 "4D" 连续交易日桶
    从序列起点计数, 550 天暖机桶相位偏离 TV 全历史对齐 (600519 实测日线
    K2 1179.26 vs 全历史 1166.73); plus warmup 仍 250 天 (EMA 收敛快)。"""
    repo = _RawRepo(_raw_frame())
    kline_api.get_daily(
        _request(repo), symbol="600000.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
    )
    # ry warmup 读 (OHLCV 6 列) 起点 = 1990-01-01; plus warmup (2 列) 起点 = 窗口首日-250 天
    ohlcv_reads = [s for s, c in zip(repo.starts_seen, repo.columns_seen)
                   if c and "high" in c]
    close_reads = [s for s, c in zip(repo.starts_seen, repo.columns_seen)
                   if c and "high" not in c]
    assert ohlcv_reads and all(s == date(1990, 1, 1) for s in ohlcv_reads), ohlcv_reads
    assert close_reads and all(s == _D0 - timedelta(days=250) for s in close_reads), close_reads


def test_attach_warmup_default_uses_550d_not_full_history():
    """默认 (未传 ry_full_history, /daily/latest 高频路径) ry warmup 仍 550 天。"""
    repo = _RawRepo(_raw_frame())
    rows = _raw_frame().to_dicts()
    kline_api._attach_plus_with_warmup(repo, "stock", "600000.SH", rows)
    ohlcv_reads = [s for s, c in zip(repo.starts_seen, repo.columns_seen)
                   if c and "high" in c]
    assert ohlcv_reads and all(s == _D0 - timedelta(days=550) for s in ohlcv_reads), ohlcv_reads


# ── /intraday 端点: raw 跳过分钟复权投影 ────────────────────────


def _minute_frame() -> pl.DataFrame:
    base = datetime(2026, 10, 20, 9, 31)  # 结束时刻语义 (读取时 +1min 换回开始时刻)
    return pl.DataFrame({
        "symbol": ["600000.SH"] * 6,
        "datetime": [base + timedelta(minutes=i) for i in range(6)],
        "open": [10.0] * 6, "high": [10.5] * 6, "low": [9.5] * 6, "close": [10.2] * 6,
        "volume": [100.0] * 6, "amount": [1020.0] * 6,
    })


class _IntradayRepo:
    def __init__(self, frame):
        self._frame = frame
        self.apply_adjust_calls: list[bool] = []

    def resolve_asset_type(self, symbol: str) -> str:
        return "stock"

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["600000.SH"], "name": ["浦发银行"],
            "total_shares": [1.0], "float_shares": [1.0],
        })

    def get_minute_range(self, symbols, start, end, asset_type="stock", apply_adjust=True):
        self.apply_adjust_calls.append(apply_adjust)
        return self._frame


def test_intraday_raw_skips_minute_adjust_projection():
    """adjust=raw → repo.get_minute_range(apply_adjust=False) 跳过读取时复权投影。"""
    repo = _IntradayRepo(_minute_frame())
    kline_api.get_intraday(
        _request(repo), symbol="600000.SH", period="15m", days=60, adjust="raw",
    )
    assert repo.apply_adjust_calls == [False]


def test_intraday_default_applies_projection():
    """默认 (qfq) → apply_adjust=True (投影行为不变, 回归锁)。"""
    repo = _IntradayRepo(_minute_frame())
    kline_api.get_intraday(
        _request(repo), symbol="600000.SH", period="15m", days=60,
    )
    assert repo.apply_adjust_calls == [True]


def test_intraday_adjust_invalid_rejected():
    """非法 adjust → 400。"""
    with pytest.raises(HTTPException) as ei:
        kline_api.get_intraday(
            _request(_IntradayRepo(_minute_frame())), symbol="600000.SH",
            period="15m", days=60, adjust="hfq",
        )
    assert ei.value.status_code == 400


def test_intraday_raw_converts_minute_prices_by_daily_ratio():
    """raw 模式: 分钟存储为 qfq 基准 → 按同日日K raw_close/close 比例反推原始价;
    qfq 模式 (默认) 不换算。"""

    class _RatioRepo(_IntradayRepo):
        def get_daily_asset(self, asset_type, symbol, start, end, columns=None):
            return pl.DataFrame({
                "date": [date(2026, 10, 20)],
                "close": [100.0], "raw_close": [102.37],
            })

    resp = kline_api.get_intraday(
        _request(_RatioRepo(_minute_frame())), symbol="600000.SH",
        period="15m", days=60, adjust="raw",
    )
    bar = resp["bars"][0]
    # 10.2 × (102.37/100) = 10.4417
    assert bar["close"] == pytest.approx(10.2 * 1.0237, rel=1e-6)
    assert bar["open"] == pytest.approx(10.0 * 1.0237, rel=1e-6)

    resp_q = kline_api.get_intraday(
        _request(_IntradayRepo(_minute_frame())), symbol="600000.SH",
        period="15m", days=60,
    )
    assert resp_q["bars"][0]["close"] == pytest.approx(10.2, rel=1e-6)


def test_intraday_raw_ratio_missing_keeps_prices():
    """日K比例表不可用 (无 get_daily_asset / 缺 raw 列) → 分钟价格保持原值不炸。"""
    resp = kline_api.get_intraday(
        _request(_IntradayRepo(_minute_frame())), symbol="600000.SH",
        period="15m", days=60, adjust="raw",
    )
    assert resp["bars"][0]["close"] == pytest.approx(10.2, rel=1e-6)
