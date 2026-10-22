"""R5 融易主图/附图 — TradingView 实测黄金值对拍测试 (一比一复刻回归网)。

黄金值来源: 2026-10-22 TV 布局 hOG9CgMB (贵州茅台 双面板 1h/4h) 悬停实测,
fixture = 服务器导出的 60 交易日分钟K (minute_600519_60d.json, fuyao 源)。

已知差异根因 (容差依据, 分钟K存储仅 60~84 交易日):
  1. warmup 瞬态: EMA110(牛熊)/SuperTrend 棘轮从窗口起点递推 vs TV 全历史
     递推 — k 差 ~0.8 元, 牛熊差 ~2 元, k2/k3 轨差 ~6 元 (棘轮路径);
     分钟K扩深到 200+ 交易日后应收紧容差 (见 conftest 标记)。
  2. 数据源差: fuyao 分钟收盘 vs TV 分钟收盘 — 中轨 EMA24 (短周期已收敛)
     仍差 ~0.3 元; MACD+ DIF/能量柱差同源 + 量级缩放 SMA 窗口差。
  3. 数学口径 (无差): RSI+ / fund 状态机 / 桶语义 (60m k2==k3 1 天桶,
     240m k2==k3==k 当前级, 日K 4/8 天桶) — 精确一致项。

口径变更历史:
  2026-10-22  K2/K3 桶 TV 语义 (f_resolveDynamicTimeframe + 不跨 session)
  2026-10-22  intraday 全窗口 warmup 递推
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from app.indicators.intraday import (
    attach_intraday_plus,
    resample_minutes,
    to_minute_start_semantics,
)
from app.indicators.rymain import attach_ry_main
from app.indicators.plus import attach_plus_indicators

FIXTURES = Path(__file__).parent / "fixtures"


def _load_60m_bars() -> list[dict]:
    payload = json.loads((FIXTURES / "minute_600519_60d.json").read_text(encoding="utf-8"))
    rows = []
    for session in payload["sessions"]:
        for r in session["rows"]:
            rows.append({
                "datetime": datetime.fromisoformat(r["datetime"]),
                "open": r["open"], "high": r["high"], "low": r["low"],
                "close": r["close"], "volume": r["volume"], "amount": r["amount"],
            })
    rows.sort(key=lambda r: r["datetime"])
    return attach_intraday_plus(resample_minutes(to_minute_start_semantics(rows), 60), 60)


def _bar_at(bars: list[dict], date_prefix: str) -> dict:
    for b in bars:
        if str(b["date"]).startswith(date_prefix):
            return b
    raise AssertionError(f"bar not found: {date_prefix}")


# ═══ TV 黄金值: 1h 面板 2026-10-14 10:30 悬停实测 ═══
_TV_1014_1030 = {
    "ohlc": (1280.00, 1286.70, 1279.02, 1283.61),
    "k": 1254.95,          # 上涨波段 (当前级 SuperTrend up)
    "k2_dn": 1288.42,      # 趋势层空头轨 (k2_trend=-1)
    "k3_dn": 1288.42,      # 战略层空头轨 (60m: 1 天桶 → k2==k3)
    "bull": (1277.08, 1272.07, 1267.06),   # 融易牛/牛熊/熊
    "mid": 1268.55,        # 中轨 EMA24
    "rsi_plus": 0.20,
}


class TestTVGolden1h:
    """1h 面板黄金对拍 (warmup 瞬态容差, 分钟K扩深后收紧)。"""

    @pytest.fixture(scope="class")
    def bars60(self) -> list[dict]:
        return _load_60m_bars()

    def test_ohlc_matches_source(self, bars60):
        # 桶 OHLC 与 TV 悬停一致 (数据同源锚点, fuyao≈TV 分钟差 <0.7)
        b = _bar_at(bars60, "2026-10-14 10:30")
        assert b["open"] == pytest.approx(_TV_1014_1030["ohlc"][0], abs=0.7)
        assert b["close"] == pytest.approx(_TV_1014_1030["ohlc"][3], abs=0.7)

    def test_k_current_level(self, bars60):
        # k (当前级 SuperTrend): TV 1254.95, 本地 warmup 瞬态 ~0.8
        b = _bar_at(bars60, "2026-10-14 10:30")
        assert b["k_trend"] == 1
        assert b["k_up"] == pytest.approx(_TV_1014_1030["k"], abs=1.0)

    def test_k2_k3_one_day_bucket_semantics(self, bars60):
        # 60m 的 K2(4h)/K3(8h) 高周期 ≥ A股单日 session → 都解析为 1 天桶
        # (TV 实测 k2==k3); 空头段画 dn 轨
        b = _bar_at(bars60, "2026-10-14 10:30")
        assert b["k2_trend"] == -1
        assert b["k3_trend"] == -1
        assert b["k2_dn"] == pytest.approx(b["k3_dn"], abs=1e-9)
        # TV 1288.42; 本地棘轮路径差 ~6 元 (60 天起点递推, warmup 根因)
        assert b["k2_dn"] == pytest.approx(_TV_1014_1030["k2_dn"], abs=7.0)

    def test_bull_bear_channel(self, bars60):
        # 牛熊通道 EMA110±ATR50×0.55: TV 半幅 ~5 元; 本地 warmup 瞬态 ~2 元
        b = _bar_at(bars60, "2026-10-14 10:30")
        u, m, l = _TV_1014_1030["bull"]
        assert b["ry_upper"] == pytest.approx(u, abs=2.5)
        assert b["ry_mid"] == pytest.approx(m, abs=2.5)
        assert b["ry_lower"] == pytest.approx(l, abs=2.5)
        # 通道对称性 (数学口径: ±同一 ATR50×0.55)
        assert b["ry_upper"] - b["ry_mid"] == pytest.approx(b["ry_mid"] - b["ry_lower"], rel=1e-9)

    def test_mid_ema24(self, bars60):
        # 中轨 EMA24 (24 根已收敛): TV 1268.55; 差 ~0.3 为分钟数据源差
        b = _bar_at(bars60, "2026-10-14 10:30")
        assert b["ry_ema_mid"] == pytest.approx(_TV_1014_1030["mid"], abs=0.5)

    def test_rsi_plus_exact(self, bars60):
        # RSI+ (RSI14 归一化): 数学口径精确一致
        b = _bar_at(bars60, "2026-10-14 10:30")
        assert b["rsi_plus"] == pytest.approx(_TV_1014_1030["rsi_plus"], abs=0.01)


class TestBucketSemantics:
    """K2/K3 桶语义矩阵 (TV f_resolveDynamicTimeframe + 不跨 session)。"""

    def test_60m_k2_k3_same_one_day_bucket(self):
        bars = _load_60m_bars()
        # 全窗口 k2==k3 (同 1 天桶, 按日分组保证桶对齐)
        for b in bars[-40:]:
            assert b["k2_trend"] == b["k3_trend"]
            if b["k2_trend"] == 1:
                assert b["k2_up"] == pytest.approx(b["k3_up"], abs=1e-9)
            else:
                assert b["k2_dn"] == pytest.approx(b["k3_dn"], abs=1e-9)

    def test_4h_k2_k3_equals_current_level(self):
        # 240m: K2(16h)/K3(1D) 对 A 股均按天切 → 桶=当前级 → k2==k3==k
        payload = json.loads((FIXTURES / "daily_600519_260d.json").read_text(encoding="utf-8"))
        rows = payload["rows"]
        attach_ry_main(rows, warmup_rows=None, bar_minutes=240)
        for r in rows[-40:]:
            assert r["k2_trend"] == r["k3_trend"] == r["k_trend"]
            assert r["k2_up"] == pytest.approx(r["k3_up"], abs=1e-9)
            assert r["k2_up"] == pytest.approx(r["k_up"], abs=1e-9)

    def test_daily_default_4_8_day_buckets(self):
        # 日K (无 bar_minutes): K2=4 天桶, K3=8 天桶 → k2 != k3 (不同 SuperTrend)
        payload = json.loads((FIXTURES / "daily_600519_260d.json").read_text(encoding="utf-8"))
        rows = payload["rows"]
        attach_ry_main(rows, warmup_rows=None)
        r = rows[-1]
        assert r["k2_up"] != pytest.approx(r["k3_up"], abs=1.0)
        # 深度更深的 K3 轨应更远 (4h 面板 TV 实测: k2=k3=k 当前级 ≠ 此档)
        assert r["k3_up"] < r["k2_up"] < r["k_up"]

    def test_15m_k2_k3_different_buckets(self):
        payload = json.loads((FIXTURES / "minute_600519_60d.json").read_text(encoding="utf-8"))
        rows = []
        for session in payload["sessions"]:
            for rr in session["rows"]:
                rows.append({
                    "datetime": datetime.fromisoformat(rr["datetime"]),
                    "open": rr["open"], "high": rr["high"], "low": rr["low"],
                    "close": rr["close"], "volume": rr["volume"], "amount": rr["amount"],
                })
        rows.sort(key=lambda r: r["datetime"])
        bars = attach_intraday_plus(resample_minutes(to_minute_start_semantics(rows), 15), 15)
        b = bars[-1]
        # 15m: K2=1h(4根) K3=2h(8根) — 不同桶
        assert b["k2_up"] != pytest.approx(b["k3_up"], abs=1.0)


class TestSuperTrendPineSemantics:
    """SuperTrend 递推的 Pine 语义单元测试 (构造序列手算)。

    Pine 口径 (主图 K 段):
        basic_up = hl2 - 3×ATR10
        up := close[1] > prev_up ? max(basic_up, prev_up) : basic_up   (棘轮只升)
        trend: -1→1 当 close > prev_dn;  1→-1 当 close < prev_up
        (注意: 翻转比较用当前 close vs 前一根的轨道值)
    """

    def test_ratchet_and_flip(self):
        # 恒定 H/L 构造: hl2=11, TR=2 → ATR10=2 (Wilder 从首根收敛)
        # basic_up = 11-6 = 5; basic_dn = 11+6 = 17
        rows = [
            {"open": 10.0, "high": 12.0, "low": 10.0, "close": c}
            for c in (11.0, 11.0, 11.0, 11.0, 11.0, 11.0,
                      11.0, 11.0, 11.0, 11.0, 11.0, 11.0)
        ]
        out = attach_ry_main([dict(r) for r in rows])
        # 多头段: up 轨棘轮在 5 (basic) 保持; close 未跌破 → trend=1
        assert out[-1]["k_trend"] == 1
        assert out[-1]["k_up"] == pytest.approx(5.0, abs=1e-6)

        # close 跌破 up 轨 (5.0): 4.0 < 5.0 → 翻空, 画 dn 轨
        rows2 = rows[:-1] + [{"open": 10.0, "high": 12.0, "low": 10.0, "close": 4.0}]
        out2 = attach_ry_main([dict(r) for r in rows2])
        assert out2[-1]["k_trend"] == -1
        # 翻空后 dn = basic_dn = 17 (close[1]=11 < prev_dn → 不锁低)
        assert out2[-1]["k_dn"] == pytest.approx(17.0, abs=1e-6)

    def test_dn_ratchet_only_lowers(self):
        # 空头段 dn 轨棘轮只降: close[1] < prev_dn 时 dn=min(basic_dn, prev_dn)
        # 构造 L 与 close 同步阴跌 (hl2 递减 → basic_dn 递减, 翻空后 dn 只降不升)
        rows = []
        for i in range(16):
            lo = 10.0 - 0.3 * i
            hi = 11.0 - 0.3 * i
            c = 10.5 - 0.55 * i
            rows.append({"open": 10.2, "high": hi, "low": lo, "close": c})
        out = attach_ry_main([dict(r) for r in rows])
        # 末段 close 已远低于 up 轨 → 空头段
        assert out[-1]["k_trend"] == -1
        assert out[-1]["k_dn"] is not None
        # 空头段 dn 序列单调不增 (棘轮: 只降不升)
        dns = [r["k_dn"] for r in out if r["k_trend"] == -1 and r["k_dn"] is not None]
        assert len(dns) >= 2
        assert all(b <= a + 1e-9 for a, b in zip(dns, dns[1:])), dns
