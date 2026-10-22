"""FVG (公平价值缺口) Pine 语义单元测试 — rymain._compute_fvg 手算对拍。

口径源: 私人资产指标主图 (源文件不入库) 1841-1952 模块逐式:
- Same Type: 构成 FVG 的三根 K 同阴或同阳
- Extreme 敏感度 (Average Range 法, 双重过滤):
  bar_sum×6 > ATR10/1.5 且 maxCODiff ≤ ATR10, 且 FVGSize×6 > ATR10
- bear 盒 [h_i, l_{i-2}] / bull 盒 [h_{i-2}, l_i]; 失效: Close 法
- 未触及: bull low≤max / bear high≥min 刷新 lastTouched; 超 360 根未触及删除
- 同向相交 (X: start~start+15, Y: min~max) 合并为并集 (combined=True)
- showInvalidated=false → 输出只含活跃区间; showLastXFVGs=125 上限
- 量能: bull high_vol=v+v1/low_vol=v2; bear low_vol=v+v1/high_vol=v2

统一注入常量 ATR10 序列, 每例边界值全部手算。
"""
from __future__ import annotations

from app.indicators.rymain import _compute_fvg


def _row(date: str, o: float, c: float, h: float, l: float, v: float = 100.0) -> dict:
    return {"date": date, "open": o, "close": c, "high": h, "low": l, "volume": v}


def _atr(n: int, val: float = 10.0) -> list:
    return [val] * n


# ── 检测 + 量能分配 ──────────────────────────────────────────────

def test_bear_fvg_detection_and_volume() -> None:
    """三连阴向下跳空: bear 盒 [h_i, l_{i-2}], low_vol=v+v1, high_vol=v2。"""
    rows = [
        _row("d0", 110, 100, 111, 99, 100),   # v2 (构成第二根的前一根 → high_vol)
        _row("d1", 95, 85, 96, 84, 200),      # v1
        _row("d2", 80, 70, 79, 69, 300),      # v  (当前)
    ]
    # i=2: same_type 阴×3 ✓; bar_sum=30→180>10/1.5 ✓; max_co=max(5,5)=5≤10 ✓;
    #      bear: h=79<l2=99 ✓, c1=85<99 ✓; size=|99-79|=20→120>10 ✓
    out = _compute_fvg(rows, _atr(3))
    assert len(out) == 1
    b = out[0]
    assert b["start"] == "d2"
    assert b["min"] == 79 and b["max"] == 99          # [h_i, l_{i-2}]
    assert b["is_bull"] is False and b["combined"] is False
    assert b["low_vol"] == 500                        # v+v1 = 300+200
    assert b["high_vol"] == 100                       # v2
    assert b["total_vol"] == 600


def test_bull_fvg_detection_and_volume() -> None:
    """三连阳向上跳空: bull 盒 [h_{i-2}, l_i], high_vol=v+v1, low_vol=v2。"""
    rows = [
        _row("d0", 100, 110, 111, 99, 100),
        _row("d1", 115, 125, 126, 114, 200),
        _row("d2", 130, 140, 141, 129, 300),
    ]
    # i=2: bull: l=129>h2=111 ✓, c1=125>111 ✓; size=18→108>10 ✓; max_co=5 ✓
    out = _compute_fvg(rows, _atr(3))
    assert len(out) == 1
    b = out[0]
    assert b["start"] == "d2"
    assert b["min"] == 111 and b["max"] == 129        # [h_{i-2}, l_i]
    assert b["is_bull"] is True and b["combined"] is False
    assert b["low_vol"] == 100                        # v2
    assert b["high_vol"] == 500                       # v+v1
    assert b["total_vol"] == 600


# ── Extreme 敏感度过滤 (Average Range 法) ────────────────────────

def test_filter_same_type() -> None:
    """跳空存在但三根 K 阴阳混杂 → 不检测 (fvgBars="Same Type")。"""
    rows = [
        _row("d0", 100, 105, 106, 99),    # 阳
        _row("d1", 120, 112, 121, 111),   # 阴
        _row("d2", 130, 140, 141, 129),   # 阳 (l=129 > h2=106, 跳空无疑)
    ]
    assert _compute_fvg(rows, _atr(3)) == []


def test_filter_gap_size_too_small() -> None:
    """size×6 ≤ ATR10 → 拒 (gap=1.5, 1.5×6=9 ≤ 10); 其余过滤均通过。"""
    rows = [
        _row("d0", 100, 105, 106, 99),
        _row("d1", 108, 112, 113, 107),
        _row("d2", 114, 118, 119, 107.5),  # gap = 107.5-106 = 1.5
    ]
    assert _compute_fvg(rows, _atr(3)) == []


def test_filter_bar_sum_too_small() -> None:
    """bar_sum×6 ≤ ATR/1.5 → 拒 (十字星三连, bar_sum=0.6→3.6 ≤ 6.67);
    gap=2.1 (size 过滤通过) → 仅 bar_sum 拒。"""
    rows = [
        _row("d0", 100.0, 100.2, 100.3, 99.9),
        _row("d1", 100.4, 100.6, 100.7, 100.3),
        _row("d2", 102.5, 102.7, 102.8, 102.4),
    ]
    assert _compute_fvg(rows, _atr(3)) == []


def test_filter_max_codiff_too_big() -> None:
    """maxCODiff > ATR10 → 拒 (c0→o1 跳 11 > 10); gap=11.5、bar_sum 均通过。"""
    rows = [
        _row("d0", 100, 101, 102, 99),
        _row("d1", 112, 113, 114, 111),
        _row("d2", 114.5, 116, 117, 113.5),
    ]
    assert _compute_fvg(rows, _atr(3)) == []


# ── 失效 (Close 法) ─────────────────────────────────────────────

def test_bull_fvg_invalidated_by_close_below_min() -> None:
    """bull 盒后续收盘跌破 min → 失效 → showInvalidated=false 不输出。"""
    rows = [
        _row("d0", 100, 110, 111, 99),
        _row("d1", 115, 125, 126, 114),
        _row("d2", 130, 140, 141, 129),   # FVG [111, 129]
        _row("d3", 95, 90, 96, 89),       # close 90 < 111 → 失效
    ]
    assert _compute_fvg(rows, _atr(4)) == []


def test_bear_fvg_invalidated_by_close_above_max() -> None:
    """bear 盒后续收盘上破 max → 失效 → 不输出。"""
    rows = [
        _row("d0", 110, 100, 111, 99),
        _row("d1", 95, 85, 96, 84),
        _row("d2", 80, 70, 79, 69),       # FVG [79, 99]
        _row("d3", 110, 120, 121, 109),   # close 120 > 99 → 失效
    ]
    assert _compute_fvg(rows, _atr(4)) == []


def test_bull_fvg_touch_keeps_alive() -> None:
    """low 回落触及盒 (≤max) 但收盘不破 min → 刷新 lastTouched, 存活。"""
    rows = [
        _row("d0", 100, 110, 111, 99),
        _row("d1", 115, 125, 126, 114),
        _row("d2", 130, 140, 141, 129),   # FVG [111, 129]
        _row("d3", 131, 133, 134, 125),   # l=125 ≤ 129 触及; c=133 > 111 存活
        _row("d4", 134, 135, 136, 126),   # l=126 触及; c=135 存活
    ]
    out = _compute_fvg(rows, _atr(5))
    assert len(out) == 1
    assert out[0]["min"] == 111 and out[0]["max"] == 129


# ── 未触及删除 (360 根边界) ──────────────────────────────────────

def _neutral_bars(k: int) -> list[dict]:
    # 恒定价格阶梯: l=152 始终在 FVG [111,129] 上方 → 不触及、不失效;
    # o=155 使过渡三元组 maxCODiff=|140-155|=15>10 → 拒掉 d2→n0 处的过渡检测
    return [_row(f"n{i}", 155, 156, 157, 152, 10) for i in range(k)]


def test_untouched_deleted_after_360_bars_boundary() -> None:
    """(i - lastTouched) ≤ 360 存活, 361 删除 — 两端各验一例。"""
    base = [
        _row("d0", 100, 110, 111, 99),
        _row("d1", 115, 125, 126, 114),
        _row("d2", 130, 140, 141, 129),   # FVG @i=2, lastTouched=2
    ]
    # 末根 i=362: 362-2=360 ≤ 360 → 存活 (仅原盒, 无合并)
    out_alive = _compute_fvg(base + _neutral_bars(360), _atr(363))
    assert len(out_alive) == 1
    assert out_alive[0]["start"] == "d2"
    assert out_alive[0]["min"] == 111 and out_alive[0]["max"] == 129
    assert out_alive[0]["combined"] is False
    # 末根 i=363: 363-2=361 > 360 → 删除
    out_gone = _compute_fvg(base + _neutral_bars(361), _atr(364))
    assert out_gone == []


# ── 合并 (同向相交 → 并集) ───────────────────────────────────────

def test_same_direction_overlap_merges_to_union() -> None:
    """相邻两 bull 盒 Y 向重叠 1 (109-108) → 合并为 [105,110] 并集,
    combined=True, 量能求和, start 取更早者。"""
    rows = [
        _row("d0", 100, 104, 105, 99, 10),
        _row("d1", 106, 107, 108, 105, 20),
        _row("d2", 109, 113, 114, 109, 30),   # A=[h0,l2]=[105,109] @i=2
        _row("d3", 115, 119, 120, 110, 40),   # B=[h1,l3]=[108,110] @i=3
    ]
    # A: gap=109-105=4→24>10 ✓; B: gap=110-108=2→12>10 ✓; max_co 均 2≤10 ✓
    out = _compute_fvg(rows, _atr(4))
    assert len(out) == 1
    b = out[0]
    assert b["combined"] is True
    assert b["start"] == "d2"                  # min(2,3) 更早者
    assert b["min"] == 105 and b["max"] == 110  # 并集
    assert b["is_bull"] is True
    assert b["low_vol"] == 30                  # A.low 10 + B.low 20
    assert b["high_vol"] == 120                # A.high 50 + B.high 70
    assert b["total_vol"] == 150


def test_opposite_direction_overlap_does_not_merge() -> None:
    """Y 向重叠但方向相反 (bull vs bear) → 各自独立输出 (头=最新)。"""
    rows = [
        _row("d0", 100, 104, 105, 99, 10),
        _row("d1", 106, 107, 108, 105, 20),
        _row("d2", 109, 113, 114, 109, 30),    # A bull [105,109] @i=2
        _row("d3", 120, 114, 121, 108, 50),    # 阴
        _row("d4", 112, 107, 113, 106, 60),    # 阴
        _row("d5", 105.6, 105.2, 105.8, 99, 70),  # 阴; h=105.8<l3=108, c4=107<108
    ]
    # B bear @i=5: [h5, l3]=[105.8, 108], size=2.2→13.2>10 ✓, max_co=2≤10 ✓
    # B∩A Y 重叠 (min(109,108)-max(105,105.8)=2.2>0) 但反向 → 不合并
    out = _compute_fvg(rows, _atr(6))
    assert len(out) == 2
    assert out[0]["is_bull"] is False           # 头 = 最新 (Pine unshift)
    assert out[0]["min"] == 105.8 and out[0]["max"] == 108
    assert out[0]["combined"] is False
    assert out[1]["is_bull"] is True
    assert out[1]["min"] == 105 and out[1]["max"] == 109
    assert out[1]["combined"] is False


# ── 前 2 根无检测 (负索引回绕回归) ───────────────────────────────

def test_no_detection_from_negative_index_wraparound() -> None:
    """i=0/1 不参与检测: 若误用 rows[-1]/rows[-2] 会把末尾 K 拼成假三连
    (本例构造了恰好通过全部过滤的回绕假象) → 必须为空。"""
    rows = [
        _row("d0", 100, 90, 91, 89),      # 阴; 若回绕: 与 d1/d2 拼 bear 三连
        _row("d1", 115, 105, 116, 112),   # 阴; 若回绕作 r2: h0=91<l1=112 ✓
        _row("d2", 106, 96, 107, 104),    # 阴; 若回绕作 r1: c2=96<112 ✓
    ]
    # 正常 i=2 检测: max_co=max(|90-115|,|105-106|)=25>10 → 无 FVG
    # 回绕 i=0 检测: same_type 阴×3, bar_sum=30, max_co=max(1,4)... 见断言
    out = _compute_fvg(rows, _atr(3))
    assert out == []


# ── showLastXFVGs=125 上限 (存活窗口 + 头=最新) ──────────────────

def test_max_keep_125_and_alive_window() -> None:
    """每根 K 产生一个互不重叠的 bull 盒 (阶梯: o=c_{k-1}+5, c=o+5,
    h=c+1, l=o-6 → 盒=[h_{k-2}, l_k]=[86+10k, 94+10k], 相邻盒 Y 差 2 不相交)。
    400 根: 检测 398 个 (i=2..399), 存活 (i≥399-360=39) 361 个 → 上限保留
    最新 125 个 (k=275..399), 全部 combined=False。"""
    rows = [
        _row(f"d{k}", 100 + 10 * k, 105 + 10 * k, 106 + 10 * k, 94 + 10 * k, 1)
        for k in range(400)
    ]
    out = _compute_fvg(rows, _atr(400, val=5.0))
    assert len(out) == 125
    assert all(b["is_bull"] is True for b in out)
    assert all(b["combined"] is False for b in out)
    # 头 = 最新 (k=399): [86+3990, 94+3990]
    assert out[0]["start"] == "d399"
    assert out[0]["min"] == 4076 and out[0]["max"] == 4084
    # 尾 = 保留的最旧 (k=275): [86+2750, 94+2750]
    assert out[-1]["start"] == "d275"
    assert out[-1]["min"] == 2836 and out[-1]["max"] == 2844
    # 头→尾 (新→旧) min 严格递减 10, 无合并、无遗漏
    mins = [b["min"] for b in out]
    assert all(b1 - b2 == 10 for b1, b2 in zip(mins, mins[1:]))
