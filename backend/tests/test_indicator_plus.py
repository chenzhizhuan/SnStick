"""私有化指标 (MACD+/RSI+) R5 经典版附图口径测试。

口径源: 私人资产指标 (源文件不入库) 逐式移植。本测试验证移植的数学性质:

1. DIF/DEA 与原版 MACD 相同 (EMA12/26 → DIF, EMA9(DIF) → DEA)
2. Wilder RSI 参考值 (RMA 首值=SMA(n) 起步, 手工推演硬编码基准)
3. 能量柱量级: SMA|hist| ≈ SMA|DIF| (量级缩放到快线量纲)
4. fund_rsi: ±1 量程; (RSI14-50)/50 线性映射
5. fund 状态机: 背景保持/轨道追踪/穿零复位/交叉事件 (逐转移路径)
6. warmup 窗口附着 = 全序列计算
7. attach 字段齐全 (含 fund 信号与动能双腿)
"""
from __future__ import annotations

import math
import random

import polars as pl

from app.indicators.pipeline import compute_indicators
from app.indicators.plus import (
    FUND_SIGNAL_FIELDS,
    MACD_PLUS_FIELDS,
    PLUS_FIELDS,
    RSI_PLUS_FIELDS,
    attach_plus_indicators,
    compute_fund_signals,
    compute_macd_plus,
    compute_rsi_plus,
)
from app.indicators.plus import _wilder_rsi_series


def _random_closes(n: int, seed: int) -> list[float]:
    rng = random.Random(seed)
    out: list[float] = []
    px = 100.0
    for _ in range(n):
        px *= 1.0 + rng.uniform(-0.03, 0.03)
        out.append(round(px, 2))
    return out


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


# ── Wilder RSI 基准 (手工推演) ────────────────────────────────────
# closes = [10, 11, 12, 11, 12, 13], n=3:
#   change = [na, +1, +1, -1, +1, +1] → up=[na,1,1,0,1,1], dn=[na,0,0,1,0,0]
#   rma(3) 首值=SMA: rau[3]=(1+1+0)/3=2/3, rau[4]=2/3+1/3*(1-2/3)=7/9, rau[5]=7/9+1/3*(1-7/9)=64/81? → 0.8519
#   rdn[3]=1/3, rdn[4]=1/3+1/3*(0-1/3)=2/9, rdn[5]=2/9+1/3*(0-2/9)=0.1481
#   RSI[3]=100-100/(1+2)=66.667; RSI[4]=100-100/(1+3.5)=77.778; RSI[5]=100-100/(1+5.75)=85.185
def test_wilder_rsi_hand_reference() -> None:
    closes = [10.0, 11.0, 12.0, 11.0, 12.0, 13.0]
    rsi = _wilder_rsi_series(closes, 3)
    assert rsi[0] is None and rsi[1] is None and rsi[2] is None
    assert math.isclose(rsi[3], 100 - 100 / 3.0, rel_tol=1e-9)
    assert math.isclose(rsi[4], 100 - 100 / 4.5, rel_tol=1e-9)
    assert math.isclose(rsi[5], 100 - 100 / 6.75, rel_tol=1e-9)


def test_wilder_rsi_extremes() -> None:
    """全涨 → 100; 全跌 → 0 (收敛后)。"""
    up = [10.0 + i for i in range(40)]
    assert _wilder_rsi_series(up, 14)[-1] > 99.9
    down = [50.0 - i for i in range(40)]
    assert _wilder_rsi_series(down, 14)[-1] < 0.1


# ── MACD+ (能量场) ───────────────────────────────────────────────
def test_dif_dea_match_original_macd() -> None:
    """能量场 DIF/DEA 与原版 MACD 一致 (EMA 部分口径相同)。"""
    closes = _random_closes(300, seed=42)
    df = compute_indicators(
        pl.DataFrame({"symbol": ["X"] * len(closes), "date": list(range(len(closes))), "close": closes}),
        needed={"macd_dif", "macd_dea"},
        assume_sorted=True,
    )
    got = compute_macd_plus(closes)
    ref_dif = df["macd_dif"].to_list()
    ref_dea = df["macd_dea"].to_list()
    for i in range(150, len(closes)):  # 跳过收敛前缀
        assert math.isclose(got["macd_plus_dif"][i], ref_dif[i], rel_tol=1e-9, abs_tol=1e-12)
        assert math.isclose(got["macd_plus_dea"][i], ref_dea[i], rel_tol=1e-9, abs_tol=1e-12)


def test_hist_scale_calibrates_to_dif() -> None:
    """能量柱量级缩放: SMA|hist| ≈ SMA|DIF| (动能差被缩放到快线量纲)。"""
    closes = _random_closes(400, seed=7)
    got = compute_macd_plus(closes, lookback=50)
    dif, hist = got["macd_plus_dif"], got["macd_plus_hist"]
    tail = slice(250, 400)
    m_hist = _mean([abs(h) for h in hist[tail] if h is not None])
    m_dif = _mean([abs(d) for d in dif[tail] if d is not None])
    assert m_hist > 0 and m_dif > 0
    # 量级标尺按 50 根滚动窗口校准 → 全段均值同量级 (容忍 50% 波动带)
    assert 0.5 < m_hist / m_dif < 2.0, f"能量柱量级失配: {m_hist} vs {m_dif}"


def test_volume_rsi_legs_range() -> None:
    """动能双腿: RSI 的 EMA → 量程 (0, 100)。"""
    closes = _random_closes(300, seed=5)
    got = compute_macd_plus(closes)
    for f in ("volume_rsi_fast", "volume_rsi_slow"):
        for v in got[f][100:]:
            assert v is not None
            assert 0.0 <= v <= 100.0, f"{f} 超出 RSI 量程: {v}"


# ── RSI+ (资金流) ────────────────────────────────────────────────
def test_fund_rsi_linear_map() -> None:
    """fund = (RSI14 - 50)/50: ±1 量程, 线性映射 (手工基准对齐)。"""
    closes = [10.0, 11.0, 12.0, 11.0, 12.0, 13.0] * 5
    fund = compute_rsi_plus(closes)
    rsi = _wilder_rsi_series(closes, 14)
    for f, r in zip(fund, rsi):
        if r is None:
            assert f is None
            continue
        assert f is not None
        assert math.isclose(f, (r - 50.0) / 50.0, rel_tol=1e-12)
        assert -1.0 - 1e-9 <= f <= 1.0 + 1e-9


def test_fund_rsi_extremes() -> None:
    up = [10.0 + i for i in range(60)]
    assert compute_rsi_plus(up)[-1] > 0.99
    down = [60.0 - i for i in range(60)]
    assert compute_rsi_plus(down)[-1] < -0.99


# ── fund 信号状态机 (逐转移路径) ──────────────────────────────────
def test_fund_bg_state_machine() -> None:
    """背景状态: 超卖低位=1 / 超买高位=2 / 轨道内保持前值 (var 语义)。"""
    seq = [0.0, -0.5, -0.2, 0.0, 0.5, 0.2, 0.0]
    #           idx0  idx1↓below idx2 回轨道内 idx3 零轴 idx4↑above idx5 回轨道内 idx6
    sig = compute_fund_signals(seq)
    bg = sig["fund_bg_color"]
    assert bg[0] == 0        # 初始
    assert bg[1] == 1        # < -0.4 → 低位
    assert bg[2] == 1        # 轨道内保持
    assert bg[3] == 1        # 零轴仍在轨道内 (-0.4~0.4) → 保持
    assert bg[4] == 2        # > +0.4 → 高位
    assert bg[5] == 2        # 保持
    assert bg[6] == 2        # 保持


def test_fund_cross_events() -> None:
    """交叉事件: 上穿下轨=B 事件; 下穿上轨=S 事件; 轨道内/同向穿越不触发。"""
    seq = [-0.5, -0.3, 0.0, 0.3, 0.5, 0.3, 0.0, -0.3, -0.5, 0.5, -0.5]
    sig = compute_fund_signals(seq)
    cu = sig["fund_cross_up_lower"]
    cd = sig["fund_cross_down_upper"]
    # idx1: -0.5→-0.3 上穿下轨 → B
    assert cu[1] is True and cd[1] is False
    # idx3: 0.0→0.3 仍在轨道内, 无事件
    assert cu[3] is False and cd[3] is False
    # idx4: 0.3→0.5 上穿上轨 (非下穿上轨) → 无 S
    assert cd[4] is False
    # idx5: 0.5→0.3 下穿上轨 → S
    assert cd[5] is True and cu[5] is False
    # idx9: -0.5→0.5 单根跨全轨道 (上穿下轨与上穿上轨同时, 无下穿上轨) → B
    assert cu[9] is True and cd[9] is False
    # idx10: 0.5→-0.5 单根跨全轨道 → S (无上穿下轨)
    assert cd[10] is True and cu[10] is False


def test_fund_tracking_state_machine() -> None:
    """追踪状态机: 上穿上轨→3 / 下穿下轨→4 / 穿零轴或反向穿轨复位重判。"""
    # 路径: 轨道内上行 → 上穿上轨(3) → 回落(仍3) → 下穿上轨触发 3 态复位 → 多中(2)
    seq = [0.0, 0.2, 0.5, 0.45, 0.3, 0.1, -0.1, 0.3]
    sig = compute_fund_signals(seq)
    st = sig["fund_tracking_state"]
    assert st[2] == 3        # 0.2→0.5 上穿上轨 → 追踪态 3
    assert st[3] == 3        # 0.5→0.45 无事件保持
    # idx4: 0.45→0.3 下穿上轨且 prev_state==3 → 复位重判 fund≥0 → 2
    assert st[4] == 2
    assert st[5] == 2        # 0.3→0.1 无事件保持
    assert st[6] == 1        # 0.1→-0.1 穿零轴下 → 复位重判 fund<0 → 1
    assert st[7] == 2        # -0.1→0.3 穿零轴上 → 复位重判 fund≥0 → 2


def test_fund_signals_na_keeps_state() -> None:
    """na 行: 事件 False, var 状态保持。"""
    seq: list[float | None] = [0.5, None, 0.5, None]
    sig = compute_fund_signals(seq)
    assert sig["fund_bg_color"][0] == 2
    assert sig["fund_bg_color"][1] == 2   # na 保持
    assert sig["fund_bg_color"][2] == 2
    assert sig["fund_cross_down_upper"][1] is False
    assert sig["fund_tracking_state"][1] == sig["fund_tracking_state"][0]


# ── 附着与 warmup ────────────────────────────────────────────────
def test_attach_plus_warmup_aligns_full_series() -> None:
    """带 warmup 的窗口附着 = 全序列计算 (API 窗口口径 vs 全历史口径)。"""
    closes = _random_closes(400, seed=99)
    base_rows = [{"close": c} for c in closes]
    attach_plus_indicators(base_rows)
    window = [{"close": c} for c in closes[-60:]]
    attach_plus_indicators(window, warmup_closes=closes[:-60])
    for i, (b, w) in enumerate(zip(base_rows[-60:], window)):
        for f in PLUS_FIELDS:
            bv, wv = b[f], w[f]
            if bv is None or wv is None:
                assert bv is None and wv is None, f"warmup 空值不一致 idx={i} {f}"
                continue
            if isinstance(bv, bool) or isinstance(wv, bool):
                assert bv == wv, f"warmup 布尔不一致 idx={i} {f}"
                continue
            assert math.isclose(bv, wv, rel_tol=1e-9, abs_tol=1e-9), (
                f"warmup 偏离 idx={i} {f}: {bv} vs {wv}"
            )


def test_attach_plus_indicators_fields() -> None:
    closes = _random_closes(200, seed=1)
    rows = [{"date": f"d{i}", "close": c} for i, c in enumerate(closes)]
    out = attach_plus_indicators(rows)
    assert out is rows  # 原地写回
    # 收敛后段: 数值字段非 None; fund 事件字段为布尔
    for r in out[150:]:
        for f in (*MACD_PLUS_FIELDS, *RSI_PLUS_FIELDS, "volume_rsi_fast", "volume_rsi_slow"):
            assert f in r, f"缺字段 {f}"
            assert r[f] is not None, f"收敛后仍为 None: {f}"
        for f in ("fund_bg_color", "fund_tracking_state"):
            assert f in r and r[f] is not None
        for f in ("fund_cross_up_lower", "fund_cross_down_upper"):
            assert f in r and isinstance(r[f], bool)
    assert set(FUND_SIGNAL_FIELDS) == {
        "fund_bg_color", "fund_tracking_state", "fund_cross_up_lower", "fund_cross_down_upper",
    }


def test_plus_handles_none_close() -> None:
    closes: list[float | None] = [10.0, None, 11.0, 12.0]
    got = compute_macd_plus(closes)
    assert got["macd_plus_dif"][1] is None
    assert got["volume_rsi_fast"][1] is None
    rsi = compute_rsi_plus(closes)
    assert rsi[1] is None
    # None 后 EMA 重置为首值起步 (idx2=11): idx3 DIF = 2/13 - 2/27 (快慢 alpha 差 × 变化 1)
    assert math.isclose(got["macd_plus_dif"][3], 2.0 / 13.0 - 2.0 / 27.0, rel_tol=1e-9)
    # Wilder RSI14 需连续 14 个非 None 值起步 → 短序列全 None (窗口不足)
    assert rsi[3] is None
    sig = compute_fund_signals(rsi)
    assert sig["fund_bg_color"] == [0, 0, 0, 0]
    assert not any(sig["fund_cross_up_lower"])
