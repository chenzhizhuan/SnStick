"""rymain K2/K3 TV 高周期桶语义锁死测试 (Pine request.security 口径)。

Pine 主图 (R5 经典版): K2_MULT=4 / K3_MULT=8, 周期分钟×倍数经
f_resolveDynamicTimeframe 解析为 TV 标准高周期串, request.security 取数:
- 日线 (1440min): K2 = "4D" (连续 4 交易日桶); K3 = "1W" (自然周 ISO)
- 周线 (10080min): K2 = "4W" (4 自然周, epoch 周一锚); K3 = "2M" (2 自然月)
- 月线 (43200min): K2 = "4M"; K3 = "8M"
修正前旧实现统一"连续 4/8 根合并桶" — 与 TV 自然历法桶边界错位,
SuperTrend 翻转点不同 → 轨道值数十元偏差 (raw 序列周线 K3 877 vs TV 1881)。
"""

from datetime import date

from app.indicators.rymain import (
    _group_bars_by_tvtf,
    _resolve_tv_timeframe,
    _tv_tf_bucket_key,
    attach_ry_main,
)


def test_resolve_tv_timeframe_pine_parity():
    """f_resolveDynamicTimeframe 一比一: 分钟×倍数 → TV 周期串。"""
    # 日线
    assert _resolve_tv_timeframe(1440 * 4) == "4D"     # K2 日线
    assert _resolve_tv_timeframe(1440 * 8) == "1W"     # K3 日线 (11520→round(1.143)=1W)
    # 周线
    assert _resolve_tv_timeframe(10080 * 4) == "4W"    # K2 周线 (40320 < 43830)
    assert _resolve_tv_timeframe(10080 * 8) == "2M"    # K3 周线 (80640 → round(1.839)=2)
    # 月线
    assert _resolve_tv_timeframe(43200 * 4) == "4M"    # K2 月线 (172800 → round(3.94)=4)
    assert _resolve_tv_timeframe(43200 * 8) == "8M"    # K3 月线 (345600 → round(7.88)=8)
    # 2d/4d agg
    assert _resolve_tv_timeframe(2880 * 4) == "1W"
    assert _resolve_tv_timeframe(2880 * 8) == "2W"
    assert _resolve_tv_timeframe(5760 * 4) == "2W"
    assert _resolve_tv_timeframe(5760 * 8) == "1M"


def test_tv_tf_bucket_key_week_epoch_alignment():
    """NW 桶: epoch 周一 (1970-01-05) 锚定 + 半周期偏移 (N≥2, TV 实证相位)。

    4W 桶边界在周序 ≡ 2 (mod 4): 1970-01-05 后第 2 周 (1970-01-19) 起新桶。
    """
    from datetime import timedelta
    # 1W: 纯自然周无偏移 — 同周同桶、下周换桶
    assert _tv_tf_bucket_key(date(2026, 10, 19), "1W") == _tv_tf_bucket_key(date(2026, 10, 23), "1W")
    assert _tv_tf_bucket_key(date(2026, 10, 19), "1W") != _tv_tf_bucket_key(date(2026, 10, 26), "1W")
    # 4W 偏移 2 周: epoch 周一后第 0/1 周同桶 (1970-01-05 与 01-12), 第 2 周 (01-19) 新桶
    assert _tv_tf_bucket_key(date(1970, 1, 5), "4W") == _tv_tf_bucket_key(date(1970, 1, 12), "4W")
    assert _tv_tf_bucket_key(date(1970, 1, 12), "4W") != _tv_tf_bucket_key(date(1970, 1, 19), "4W")
    # 4 周间隔同相位 (差 1 桶)
    assert _tv_tf_bucket_key(date(2026, 10, 19), "4W") != _tv_tf_bucket_key(date(2026, 11, 16), "4W")


def test_tv_tf_bucket_key_month_alignment():
    """NM 桶: 月份 index + 半周期偏移 (N≥2, TV 实证相位 — 2M 桶边界在偶数月初)。

    2M 桶 = (12月~次年1月)(2-3月)(4-5月)… — 1 月与上年 12 月同桶 (跨年桶),
    1 月与 2 月不同桶, 2 月与 3 月同桶。
    """
    assert _tv_tf_bucket_key(date(2026, 2, 1), "2M") == _tv_tf_bucket_key(date(2026, 3, 31), "2M")
    assert _tv_tf_bucket_key(date(2026, 1, 5), "2M") != _tv_tf_bucket_key(date(2026, 2, 1), "2M")
    assert _tv_tf_bucket_key(date(2025, 12, 1), "2M") == _tv_tf_bucket_key(date(2026, 1, 31), "2M")
    assert _tv_tf_bucket_key(date(2026, 11, 30), "2M") != _tv_tf_bucket_key(date(2026, 12, 1), "2M")
    # 8M 偏移 4 月: 2026-01~04 同桶, 2026-01 与 2026-05 不同桶
    assert _tv_tf_bucket_key(date(2026, 1, 5), "8M") == _tv_tf_bucket_key(date(2026, 4, 30), "8M")
    assert _tv_tf_bucket_key(date(2026, 1, 5), "8M") != _tv_tf_bucket_key(date(2026, 5, 1), "8M")
    # 1M: 纯自然月无偏移
    assert _tv_tf_bucket_key(date(2026, 1, 5), "1M") != _tv_tf_bucket_key(date(2026, 2, 1), "1M")


def _mk_rows(dates, base=10.0):
    return [
        {"date": d, "open": base, "high": base + 1, "low": base - 1, "close": base + 0.5, "volume": 100}
        for d in dates
    ]


def test_group_bars_by_tvtf_iso_week():
    """1W 自然周分桶: 周一~周日归一桶 (跨周末同桶, 周一新桶)。"""
    rows = _mk_rows([
        date(2026, 10, 19),  # 周一
        date(2026, 10, 21),  # 周三
        date(2026, 10, 25),  # 周日
        date(2026, 10, 26),  # 下周一
    ])
    gbars, owner = _group_bars_by_tvtf(rows, "1W")
    assert len(gbars) == 2
    assert owner == [0, 0, 0, 1]
    assert gbars[0]["open"] == 10.0 and gbars[0]["close"] == 10.5  # 首 open / 末 close
    assert gbars[0]["high"] == 11.0 and gbars[0]["low"] == 9.0


def test_group_bars_by_tvtf_two_months():
    """2M 分桶 (偏移 1 月): 2-3 月一桶、4-5 月一桶。"""
    rows = _mk_rows([date(2026, 2, 5), date(2026, 3, 27), date(2026, 4, 2)])
    gbars, owner = _group_bars_by_tvtf(rows, "2M")
    assert len(gbars) == 2
    assert owner == [0, 0, 1]


def test_attach_ry_main_tf_minutes_daily_k3_iso_week():
    """日线 tf_minutes=1440: K3 用自然周桶 (与连续 8 根不同 — 回归锁)。

    构造 ~8 个月交易日 (跳过周末, ~170 根 → ISO 周 ~35 桶 / 连续 8 根 ~21 桶,
    两者桶边界错位 → 桶级 SuperTrend 翻转点不同 → K3 轨道必有差异)。
    K2="4D" 与旧连续 4 根桶语义等价 → 轨道不变。
    """
    from datetime import timedelta
    d0 = date(2025, 6, 2)
    dates = []
    d = d0
    while d <= date(2026, 10, 23):
        if d.weekday() < 5:  # 跳过周末
            dates.append(d)
        d += timedelta(days=1)
    assert len(dates) > 120
    rows = [
        {"date": dt, "open": 100.0, "high": 100.0 + (i % 7), "low": 100.0 - (i % 5),
         "close": 100.0 + (i % 11) - 5, "volume": 100}
        for i, dt in enumerate(dates)
    ]
    # tf_minutes 路径 (K3 = 1W 自然周)
    r_new = [{**r} for r in rows]
    attach_ry_main(r_new, warmup_rows=[], tf_minutes=1440)
    # 旧路径 (K3 = 连续 8 根)
    r_old = [{**r} for r in rows]
    attach_ry_main(r_old, warmup_rows=[], bar_minutes=None)
    # 两种 K3 轨道应有差异 (分桶边界不同; ATR10 桶级有值 → 轨道非 None)
    k3_old = [(a["k3_up"], a["k3_dn"], a["k3_trend"]) for a in r_old]
    k3_new = [(b["k3_up"], b["k3_dn"], b["k3_trend"]) for b in r_new]
    assert any(v is not None for v in k3_new[-1]), "桶级 ATR10 应有值 (数据足够长)"
    assert k3_old != k3_new, "tf_minutes=1440 应改变 K3 桶语义 (自然周 vs 连续 8 根)"
    # K2 = "4D" 连续 4 交易日桶 — 与旧连续 4 根一致
    k2_same = all(
        (a["k2_up"] or 0) == (b["k2_up"] or 0) and (a["k2_dn"] or 0) == (b["k2_dn"] or 0)
        for a, b in zip(r_old, r_new)
    )
    assert k2_same, "日线 K2=\"4D\" 与旧连续 4 根桶语义等价"


def test_attach_ry_main_tf_minutes_none_keeps_legacy():
    """tf_minutes=None → 完全走旧路径 (bar_minutes 分钟逻辑/4/8 根) — 兼容锁。"""
    from datetime import timedelta
    d0 = date(2026, 10, 5)
    dates = [d0 + timedelta(days=k) for k in range(12)]
    rows = _mk_rows(dates, base=50.0)
    r_legacy = [{**r} for r in rows]
    attach_ry_main(r_legacy, warmup_rows=[], bar_minutes=None, tf_minutes=None)
    r_default = [{**r} for r in rows]
    attach_ry_main(r_default, warmup_rows=[], bar_minutes=None)
    assert r_legacy == r_default
