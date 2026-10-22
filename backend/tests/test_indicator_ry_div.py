"""融易主图 (R5) 多指标背离计数测试 — 逐式口径 + 遍历方向回归。

口径源: 私人资产指标 (源文件不入库) 逐式移植。
1. Pine pivot 遍历方向: array.unshift 头插后 for x=0..maxpp-1 从最新到最旧;
   跨度超限 break 只砍更旧的。若反向遍历 (旧→新), 最旧 pivot 先触发
   ln>maxbars break 会跳过全部更近 pivot — 60m/4h 背离全 0 的根因。
2. Regular 正/负背离可触发 (价格新低/新高 + 指标抬升/回落)。
"""
from __future__ import annotations

from app.indicators.rymain import _divergence_counts, _indicator_series


def _mk_rows(closes: list[float], vol: int = 1000) -> tuple[list, list, list, list]:
    """close 序列 → (h, l, c, v) 四列; o/h/l 以 close 为基微幅展开。"""
    h = [x + 0.2 for x in closes]
    l = [x - 0.2 for x in closes]
    v = [vol] * len(closes)
    return h, l, list(closes), v


def _saw_close(n_cycles: int, period: int = 44, hi: float = 100.0, lo: float = 90.0,
               start_phase_down: bool = True) -> list[float]:
    """规则锯齿: 每周期先跌后涨, 谷值 lo 峰值 hi (close 主导)。"""
    out: list[float] = []
    px = hi
    half = period // 2
    for _ in range(n_cycles):
        if start_phase_down:
            for k in range(half):
                px -= (hi - lo) / half
                out.append(round(px, 2))
            for k in range(half):
                px += (hi - lo) / half
                out.append(round(px, 2))
        else:
            for k in range(half):
                px += (hi - lo) / half
                out.append(round(px, 2))
            for k in range(half):
                px -= (hi - lo) / half
                out.append(round(px, 2))
    return out


def test_div_pos_traversal_direction_regression() -> None:
    """遍历方向回归: 前置 9 个远 pivot (距今>100) + 近 pivot 正背离场景。

    piv_lows[-10:] 的第一个 (最旧) 跨度远超 maxbars=100 — 反向遍历会在
    第一个 pivot 处 break, 近 pivot (真实触发源) 永不被检查 → btm 全 0。
    正确方向 (新→旧) 时近 pivot 被检查 → 正背离触发。
    """
    closes: list[float] = []
    # 阶段 A: 9 个完整锯齿周期 (44 根/周期, 谷 90) → 9 个远 pivot low
    closes += _saw_close(9)                     # 396 根, 尾部回到 100
    # 阶段 B: 40 根下跌 100 → 80 (谷 = 第 10 个 pivot, 相对触发 bar 跨度 ~41)
    for k in range(40):
        closes.append(round(100.0 - 20.0 * (k + 1) / 40, 2))   # 79.5 .. 80.0? k=39 → 80.0? 不: (k+1)/40=1 → 80.0
    # 阶段 C: 20 根反弹 80 → 95
    for k in range(20):
        closes.append(round(80.0 + 15.0 * (k + 1) / 20, 2))
    # 阶段 D: 20 根缓跌 95 → 78 (价格新低, 跌势比阶段 B 缓 → 指标抬升)
    for k in range(20):
        closes.append(round(95.0 - 17.0 * (k + 1) / 20, 2))
    # 阶段 E: 回升 1 根 (触发 bar: c[i] > c[i-1])
    closes.append(79.0)

    h, l, c, v = _mk_rows(closes)
    top, btm = _divergence_counts(h, l, c, v)

    n = len(closes)
    hits = [(i, btm[i]) for i in range(n) if btm[i] > 0]
    assert hits, "近 pivot 正背离未触发 — pivot 遍历方向回归 (旧→新 break 砍掉全部近 pivot)"
    # 触发点应落在阶段 D/E (指标抬升 + 价格新低), 不在阶段 A 锯齿内
    assert all(i >= 436 for i, _ in hits), f"触发位置异常: {hits}"
    # 顶部负背离不应出现 (全程无价格新高结构)
    assert all(top[i] == 0 for i in range(n))


def test_div_pos_golden_manual() -> None:
    """正背离手算: 单指标 (MOM10) 精确构造 — 价格新低 + 指标抬升 + 虚拟线通过。

    序列: 40 根深跌 (100→80, -0.5/根) → pivot low (确认 +10) → 反弹 10 根 (80→90)
    → 30 根缓跌 (90→79.5, -0.35/根, 新低且斜率更缓 → MOM10 抬升) → 回升 1 根触发。
    MOM10: mom[i-1] ≈ -3.5 (缓跌斜率×10) > mom[pivot] = -5.0 (深跌斜率×10) → 抬升;
    虚拟线 (80→79.5 缓降) 中间 close (81~90) 全部在线上。
    """
    closes: list[float] = []
    for k in range(40):                                  # 深跌段 -0.5/根
        closes.append(round(100.0 - 20.0 * (k + 1) / 40, 2))
    for k in range(10):                                  # 反弹段 80→90
        closes.append(round(80.0 + 10.0 * (k + 1) / 10, 2))
    for k in range(30):                                  # 缓跌段 90→79.5 (-0.35/根)
        closes.append(round(90.0 - 10.5 * (k + 1) / 30, 2))
    closes.append(80.5)                                  # 触发 bar (回升)

    h, l, c, v = _mk_rows(closes)
    ind = _indicator_series(h, l, c, v)
    mom = ind["mom"]
    n = len(closes)
    i = n - 1                                            # 触发 bar
    pos = 39                                             # pivot low 根 (深跌段末端)
    assert c[pos] == 80.0 or abs(c[pos] - 80.0) < 1e-9
    # 手算条件逐项断言 (Pine 逐式):
    assert c[i - 1] < c[pos]                             # 价格新低 (缓跌段末端 < 80)
    assert mom[i - 1] > mom[pos]                         # MOM10 抬升
    # 虚拟线无穿透: 中间 close 全部 ≥ 直线 (80 → c[i-1] 缓降)
    ln = i - pos
    slope = (c[i - 1] - c[pos]) / (ln - 1)
    vl = c[i - 1] - slope
    for k in range(2, ln):
        y = i - k
        assert c[y] >= vl, f"close 穿透虚拟线 @ y={y}"
        vl -= slope
    # 全量计数器也应触发 (至少 MOM10 计入)
    top, btm = _divergence_counts(h, l, c, v)
    assert btm[i] >= 1


def test_div_neg_traversal_direction_regression() -> None:
    """负背离遍历方向回归 (顶部对称): 远 pivot 峰 + 近 pivot 峰 + 价格新高回落。"""
    closes: list[float] = []
    # 阶段 A: 9 个倒锯齿 (先涨后跌, 峰 100) → 9 个远 pivot high
    closes += _saw_close(9, start_phase_down=False)      # 尾部回到 100
    # 阶段 B: 40 根上涨 100 → 120 (峰 = 第 10 个 pivot high)
    for k in range(40):
        closes.append(round(100.0 + 20.0 * (k + 1) / 40, 2))
    # 阶段 C: 20 根回落 120 → 105
    for k in range(20):
        closes.append(round(120.0 - 15.0 * (k + 1) / 20, 2))
    # 阶段 D: 20 根缓涨 105 → 121 (价格新高, 涨势比阶段 B 缓 → 指标回落)
    for k in range(20):
        closes.append(round(105.0 + 16.0 * (k + 1) / 20, 2))
    # 阶段 E: 回落 1 根 (触发 bar: c[i] < c[i-1])
    closes.append(120.0)

    h, l, c, v = _mk_rows(closes)
    top, btm = _divergence_counts(h, l, c, v)
    n = len(closes)
    hits = [(i, top[i]) for i in range(n) if top[i] > 0]
    assert hits, "近 pivot 负背离未触发 — pivot 遍历方向回归 (顶部)"
    assert all(i >= 436 for i, _ in hits), f"触发位置异常: {hits}"
    assert all(btm[i] == 0 for i in range(n))
