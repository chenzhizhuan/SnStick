"""私有化指标 (MACD+/RSI+) 克隆口径测试 — 与原版 pipeline 逐位对拍。

plus.py 声称「原版克隆」: 同参同公式。本测试用随机序列驱动两套实现
(polars compute_indicators vs 纯 Python plus), 断言逐位一致 (浮点容差内),
保证克隆期用户在图表上看到的 MACD+/RSI+ 与原版 MACD/RSI 数值相同。
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


def test_macd_plus_matches_pipeline() -> None:
    closes = _random_closes(300, seed=42)
    df = compute_indicators(
        pl.DataFrame({"symbol": ["X"] * len(closes), "date": list(range(len(closes))), "close": closes}),
        needed={"macd_dif", "macd_dea", "macd_hist"},
        assume_sorted=True,
    )
    got = compute_macd_plus(closes)
    pairs = [
        ("macd_plus_dif", "macd_dif"),
        ("macd_plus_dea", "macd_dea"),
        ("macd_plus_hist", "macd_hist"),
    ]
    for plus_col, ref_col in pairs:
        ref = df[ref_col].to_list()
        mine = got[plus_col]
        assert len(ref) == len(mine)
        for a, b in zip(ref, mine):
            assert a is not None and b is not None
            assert math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12), f"{plus_col} 偏离: {a} vs {b}"


def test_rsi_plus_matches_pipeline() -> None:
    closes = _random_closes(300, seed=7)
    df = compute_indicators(
        pl.DataFrame({"symbol": ["X"] * len(closes), "date": list(range(len(closes))), "close": closes}),
        needed={"rsi_6", "rsi_14", "rsi_24"},
        assume_sorted=True,
    )
    for n in (6, 14, 24):
        ref = df[f"rsi_{n}"].to_list()
        mine = compute_rsi_plus(closes, n)
        assert len(ref) == len(mine)
        for a, b in zip(ref, mine):
            assert a is not None and b is not None
            assert math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12), f"rsi_plus_{n} 偏离: {a} vs {b}"


def test_attach_plus_indicators_fields() -> None:
    closes = _random_closes(50, seed=1)
    rows = [{"date": f"d{i}", "close": c} for i, c in enumerate(closes)]
    out = attach_plus_indicators(rows)
    assert out is rows  # 原地写回
    for r in out:
        for f in (*MACD_PLUS_FIELDS, *RSI_PLUS_FIELDS):
            assert f in r and r[f] is not None


def test_plus_handles_none_close() -> None:
    closes: list[float | None] = [10.0, None, 11.0, 12.0]
    got = compute_macd_plus(closes)
    assert got["macd_plus_dif"][1] is None
    # None 之后递推重启 (与 polars ewm ignore_nulls=False 口径: 中断即断)
    rsi = compute_rsi_plus(closes, 6)
    assert rsi[1] is None
    assert rsi[3] is not None


def test_attach_plus_warmup_aligns_full_series() -> None:
    """带 warmup 的窗口附着 = 全序列计算 (API 窗口口径 vs enriched 全历史落盘口径)。"""
    closes = _random_closes(300, seed=99)
    # 全序列基准
    base_rows = [{"close": c} for c in closes]
    attach_plus_indicators(base_rows)
    # 窗口 = 末 50 行, warmup = 前 250 行 (模拟 kline API 裁剪窗口 + 预热)
    window = [{"close": c} for c in closes[-50:]]
    attach_plus_indicators(window, warmup_closes=closes[:-50])
    for i, (b, w) in enumerate(zip(base_rows[-50:], window)):
        for f in (*MACD_PLUS_FIELDS, *RSI_PLUS_FIELDS):
            assert math.isclose(b[f], w[f], rel_tol=1e-6, abs_tol=1e-9), (
                f"warmup 偏离 idx={i} {f}: {b[f]} vs {w[f]}"
            )
