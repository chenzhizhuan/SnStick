"""私有化指标 (MACD+/RSI+) 泰坦 T5.0 口径测试。

算法源: 泰坦量化策略(天机版)-T5.0.pine f_optMacd / f_optRsi 逐式移植。
本测试验证移植的数学性质 (与 Pine 注释声明的一致性):

1. DIF/DEA 与原版 MACD 相同 (EMA12/26 → DIF, EMA9(DIF) → DEA)
2. 能量柱量级: SMA|hist| ≈ SMA|DIF-DEA| (量级标尺的缩放目标)
3. RSI 性质: RSI>0 ⟺ close>EMA26; |RSI|≤100; 乖离创 50 根新高时 ≈ ±100
4. RSI 前缀 (highest 窗口不足): Pine nz 口径 → 0.0
5. warmup 窗口附着 = 全序列计算
6. attach 字段齐全
"""
from __future__ import annotations

import math
import random

import polars as pl

from app.indicators.pipeline import compute_indicators
from app.indicators.plus import (
    MACD_PLUS_FIELDS,
    RSI_PLUS_FIELDS,
    attach_plus_indicators,
    compute_macd_plus,
    compute_rsi_plus,
)


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


def test_dif_dea_match_original_macd() -> None:
    """优化版MACD 的 DIF/DEA 与原版 MACD 一致 (EMA 部分口径相同)。"""
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


def test_hist_scale_calibrates_to_dif_dea() -> None:
    """能量柱量级标尺: SMA|hist| ≈ SMA|DIF-DEA| (缩放使能量柱与快慢线同量纲)。"""
    closes = _random_closes(400, seed=7)
    got = compute_macd_plus(closes, lookback=50)
    dif, dea, hist = got["macd_plus_dif"], got["macd_plus_dea"], got["macd_plus_hist"]
    tail = slice(200, 400)
    m_hist = _mean([abs(h) for h in hist[tail] if h is not None])
    m_dh = _mean([abs(d - e) for d, e in zip(dif[tail], dea[tail]) if d is not None and e is not None])
    assert m_hist > 0 and m_dh > 0
    # 量级标尺按 50 根滚动窗口校准 → 全段均值同量级 (容忍 50% 波动带)
    assert 0.5 < m_hist / m_dh < 2.0, f"能量柱量级失配: {m_hist} vs {m_dh}"


def test_rsi_plus_properties() -> None:
    """RSI+ 数学性质: 符号 ⟺ 价格在 EMA26 上方; 量程 ±100; 前缀 0 (Pine nz)。"""
    closes = _random_closes(300, seed=11)
    rsi = compute_rsi_plus(closes)
    # 手工基准 EMA26
    alpha = 2.0 / 27.0
    prev = None
    for i, c in enumerate(closes):
        prev = c if prev is None else prev + alpha * (c - prev)
        if i < 49:  # highest 窗口 50 → idx 0..48 为 na (Pine nz → 0), idx 49 起有值
            assert rsi[i] == 0.0, f"窗口不足应为 0 (Pine nz 口径), idx={i}"
            continue
        v = rsi[i]
        assert v is not None
        assert -100.0 - 1e-9 <= v <= 100.0 + 1e-9, f"RSI 超出 ±100: {v}"
        # 符号性质 (diff 非零时)
        diff = c - prev
        if abs(diff) > 1e-9:
            assert (v > 0) == (diff > 0), f"符号不一致 idx={i}: rsi={v} diff={diff}"


def test_rsi_plus_hit_extreme() -> None:
    """乖离创 50 根新高 → RSI ≈ +100 (满格)。"""
    # 构造: 平稳序列后突然大涨 → 正乖离创 50 根新高
    closes = [100.0 + (i % 5) * 0.1 for i in range(80)] + [110.0]
    rsi = compute_rsi_plus(closes)
    last = rsi[-1]
    assert last is not None
    assert last > 99.9, f"创新高应接近 +100, got {last}"


def test_attach_plus_warmup_aligns_full_series() -> None:
    """带 warmup 的窗口附着 = 全序列计算 (API 窗口口径 vs 全历史口径)。"""
    closes = _random_closes(400, seed=99)
    base_rows = [{"close": c} for c in closes]
    attach_plus_indicators(base_rows)
    window = [{"close": c} for c in closes[-60:]]
    attach_plus_indicators(window, warmup_closes=closes[:-60])
    for i, (b, w) in enumerate(zip(base_rows[-60:], window)):
        for f in (*MACD_PLUS_FIELDS, *RSI_PLUS_FIELDS):
            bv, wv = b[f], w[f]
            if bv is None or wv is None:
                assert bv is None and wv is None, f"warmup 空值不一致 idx={i} {f}"
                continue
            assert math.isclose(bv, wv, rel_tol=1e-9, abs_tol=1e-9), (
                f"warmup 偏离 idx={i} {f}: {bv} vs {wv}"
            )


def test_attach_plus_indicators_fields() -> None:
    closes = _random_closes(120, seed=1)
    rows = [{"date": f"d{i}", "close": c} for i, c in enumerate(closes)]
    out = attach_plus_indicators(rows)
    assert out is rows  # 原地写回
    # 前 60 行 (SMA50/RollMax50 收敛前) 允许 None; 后半段应有值
    for r in out[60:]:
        for f in (*MACD_PLUS_FIELDS, *RSI_PLUS_FIELDS):
            assert f in r, f"缺字段 {f}"
            assert r[f] is not None, f"收敛后仍为 None: {f}"


def test_plus_handles_none_close() -> None:
    closes: list[float | None] = [10.0, None, 11.0, 12.0]
    got = compute_macd_plus(closes)
    assert got["macd_plus_dif"][1] is None
    rsi = compute_rsi_plus(closes)
    assert rsi[1] is None
    assert rsi[3] is not None
