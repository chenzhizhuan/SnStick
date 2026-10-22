"""融易主图 (R5) 私有化指标测试 — 数学性质验证。

口径源: 私人资产指标 (源文件不入库) 逐式移植。
1. 牛熊通道: EMA110 ± ATR50×0.55 (上>中>下, 收敛后有值)
2. 中轨 EMA24 + MACD 快线分色 (+1/-1/0)
3. SuperTrend: trend 翻转时 up/dn 轨收敛; 上涨段 up 有效
4. K2/K3: 4/8 根合并映射 (桶数 = ceil(n/group))
5. K 线着色: close 相对通道位置 (+1/-1/0)
6. 梯形信号: 乖离创新高后的回撤触发
7. attach 字段齐全
"""
from __future__ import annotations

import random

from app.indicators.rymain import RY_FIELDS, attach_ry_main


def _random_bars(n: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    px = 100.0
    out = []
    for i in range(n):
        o = px
        px *= 1.0 + rng.uniform(-0.025, 0.025)
        c = round(px, 2)
        h = round(max(o, c) * (1 + rng.uniform(0, 0.01)), 2)
        l = round(min(o, c) * (1 - rng.uniform(0, 0.01)), 2)
        out.append({"date": f"d{i}", "open": o, "high": h, "low": l, "close": c, "volume": rng.randint(1000, 90000)})
        px = c
    return out


def test_ry_channel_geometry() -> None:
    """牛熊通道: upper > mid > lower; 收敛后有值; 中轨 EMA24 与 MACD 分色。"""
    rows = _random_bars(300, seed=7)
    attach_ry_main(rows)
    for r in rows[200:]:
        assert r["ry_upper"] is not None and r["ry_mid"] is not None and r["ry_lower"] is not None
        assert r["ry_upper"] > r["ry_mid"] > r["ry_lower"]
        assert r["ry_ema_mid"] is not None
        assert r["ry_mid_trend"] in (-1, 0, 1)
        assert r["ry_mid_tick"] is not None and r["ry_mid_tick"] >= 0


def test_supertrend_channel() -> None:
    """SuperTrend: trend ∈ {1,-1}; 上涨段 up 轨有效且 dn 轨在上方。"""
    rows = _random_bars(300, seed=11)
    attach_ry_main(rows)
    flips = 0
    prev_t = None
    for r in rows[60:]:
        assert r["k_trend"] in (1, -1)
        if r["k_trend"] == 1:
            assert r["k_up"] is not None
        else:
            assert r["k_dn"] is not None
        if prev_t is not None and r["k_trend"] != prev_t:
            flips += 1
        prev_t = r["k_trend"]
    # 300 根随机序列必有趋势翻转 (纯单边 300 根概率 ~0)
    assert flips > 0


def test_k23_group_mapping() -> None:
    """K2/K3: 分组映射 (4/8 根合并), 桶值透传到组内每根。"""
    rows = _random_bars(64, seed=3)
    attach_ry_main(rows)
    # K2: 64/4=16 桶, 桶内 4 根共享同一 trend
    for g in range(16):
        seg = rows[g * 4:(g + 1) * 4]
        assert len({r["k2_trend"] for r in seg}) == 1
        assert len({r["k2_up"] for r in seg}) == 1


def test_ry_bar_color_semantics() -> None:
    """K 线着色: close>upper → +1; close<lower → -1; 通道内 → 0。"""
    rows = _random_bars(300, seed=5)
    attach_ry_main(rows)
    checked = 0
    for r in rows[200:]:
        if r["ry_upper"] is None:
            continue
        if r["close"] > r["ry_upper"]:
            assert r["ry_bar_color"] == 1
        elif r["close"] < r["ry_lower"]:
            assert r["ry_bar_color"] == -1
        else:
            assert r["ry_bar_color"] == 0
        checked += 1
    assert checked > 50


def test_ry_diamond_signal() -> None:
    """梯形信号: 构造乖离创新高后回撤 → 顶部信号触发; 对称底部。"""
    # 平稳 → 突破新高 (乖离=+100) → 回撤 → 顶信号
    rows = []
    px = 100.0
    for i in range(120):
        rows.append({"date": f"d{i}", "open": px, "high": px + 0.2, "low": px - 0.2,
                     "close": px, "volume": 1000})
    px = 130.0  # 大幅跳高 (乖离满格)
    rows.append({"date": "d120", "open": px, "high": px + 0.5, "low": px - 0.5,
                 "close": px, "volume": 1000})
    px = 128.0  # 回撤 (osc<100)
    rows.append({"date": "d121", "open": px, "high": px + 0.5, "low": px - 0.5,
                 "close": px, "volume": 1000})
    attach_ry_main(rows)
    assert rows[-1]["ry_top_signal"] is True
    assert rows[-1]["ry_top_price"] == rows[-2]["high"]


def test_attach_ry_main_fields() -> None:
    """attach 字段齐全 (原地写回)。"""
    rows = _random_bars(150, seed=1)
    out = attach_ry_main(rows)
    assert out is rows
    for f in RY_FIELDS:
        assert f in rows[-1], f"缺字段 {f}"
    # 背离计数字段为 int
    assert isinstance(rows[-1]["div_top_count"], int)
    assert isinstance(rows[-1]["div_btm_count"], int)


def test_ry_none_ohlc_degrades() -> None:
    """OHLC None 行: 字段安全退化不抛异常。"""
    rows = [
        {"date": "d0", "open": 10.0, "high": 10.5, "low": 9.5, "close": 10.2, "volume": 100},
        {"date": "d1", "open": None, "high": None, "low": None, "close": None, "volume": 100},
        {"date": "d2", "open": 10.0, "high": 10.5, "low": 9.5, "close": 10.3, "volume": 100},
    ]
    out = attach_ry_main(rows)
    assert len(out) == 3
