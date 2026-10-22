"""融易主图 (R5 经典版口径) 私有化指标 — 后端算法模块。

算法口径 (2026-10-22 逐式移植, 私人资产源文件不入库):

牛熊分界通道 (3 条黄线):
    mid   = EMA(close, 110)
    band  = ATR(50) × 0.55           ← Wilder ATR
    upper / lower = mid ± band

中轨:
    EMA(close, 24), 线色按 MACD 快线 (EMA12-EMA26) 正负分色;
    中轨刻度竖线半幅 = |MACD 快线| × 0.125

K 波段/趋势通道 (SuperTrend 族: ATR10 × 3, hl2 基准):
    K  = 当前周期;  K2/K3 = TV f_resolveDynamicTimeframe(周期×4/×8) 的高周期桶
    (A股 intraday 不跨 session: ≥单日时长按天切一根 — 60m: K2=K3=1天桶;
     240m: K2=K3=1天桶=当前级; 日K: K2=4天、K3=8天; 15m: 1h/2h 桶)
    上涨段画 up 轨 (多头色), 下跌段画 dn 轨 (空头色);
    ohlc4 与轨道之间按趋势色渐变填充 (K 层)

K 线着色 (通道位置语义):
    close > upper → 多头色;  close < lower → 空头色;  通道内 → 灰

梯形信号 (归一化乖离极值反转, 50 根窗口):
    osc = (close - EMA110) / highest(|close-EMA110|, 50) × 100
    顶部: osc 前值=100 且现值<100 且 close<=high[前] → 菱形 (锚 high[前])
    底部: osc 前值=-100 且现值>-100 且 close>=low[前]  → 菱形 (锚 low[前])

多指标背离计数 (Regular 常规背离, 10 指标, pivot ±10 确认):
    指标: MACD / MACD柱 / RSI14 / Stoch(14,3) / CCI10 / MOM10 /
          OBV / VWMACD(12,26) / CMF21 / MFI14
    价格新低+指标抬升 = 正背离 (底部标签计数); 价格新高+指标回落 = 负背离 (顶部标签计数)
    中间线性插值无穿透校验 (虚拟线)

输出字段 (kline API 行): ry_upper / ry_mid / ry_lower / ry_mid_trend / ry_mid_tick,
    k_trend / k_up / k_dn, k2_* / k3_*, ry_bar_color,
    ry_top_signal / ry_top_price, ry_btm_signal / ry_btm_price,
    div_top_count, div_btm_count
API 层附着 (kline.py), 不落盘 — 与 plus.py 同一条私有化独立线路。
渲染: 见 EChartsCandlestick 主图叠加 OVERLAY_INDICATORS 'ry'。
"""
from __future__ import annotations

from typing import Any

from .plus import _ema_series, _wilder_rma_series, _wilder_rsi_series

__all__ = ["RY_FIELDS", "attach_ry_main"]


def _rolling_max_series(values: list, n: int) -> list:
    """滚动最大; 窗口不足 n 前缀输出 None; na 重置。"""
    out: list = []
    queue: list = []
    for v in values:
        if v is None:
            out.append(None)
            queue = []
            continue
        queue.append(v)
        if len(queue) > n:
            queue.pop(0)
        out.append(max(queue) if len(queue) == n else None)
    return out

RY_FIELDS = (
    "ry_upper", "ry_mid", "ry_lower", "ry_mid_trend", "ry_mid_tick", "ry_ema_mid",
    "k_trend", "k_up", "k_dn",
    "k2_trend", "k2_up", "k2_dn",
    "k3_trend", "k3_up", "k3_dn",
    "ry_bar_color",
    "ry_top_signal", "ry_top_price", "ry_btm_signal", "ry_btm_price",
    "div_top_count", "div_btm_count",
)

# ── 参数 (R5 默认值) ──────────────────────────────────────────────
_RY_MID_LEN = 110     # 牛熊通道均线周期 (EMA)
_RY_ATR_LEN = 50      # 牛熊通道 ATR 周期
_RY_BAND_MULT = 0.55  # 牛熊通道波幅倍率
_RY_EMA_MID = 24      # 中轨 EMA 周期
_K_ATR_LEN = 10       # SuperTrend ATR 周期
_K_MULT = 3.0         # SuperTrend ATR 倍率
_K2_GROUP = 4         # K2 合并根数 (日K/默认: 4× 周期)
_K3_GROUP = 8         # K3 合并根数 (日K/默认: 8× 周期)
_SESSION_MIN = 240    # A股单日交易分钟数 (intraday 高周期桶不跨 session)
_DIV_PRD = 10         # 背离 pivot 确认窗口
_DIV_MAXPP = 10       # 背离回溯 pivot 数
_DIV_MAXBARS = 100    # 背离最大跨度

# ── FVG (公平价值缺口, Pine 主图最后一模块) 参数 — 逐常量一比一 ──
_FVG_SENS = 6.0          # fvgSensitivityText="Extreme" → 6
_FVG_MAX_KEEP = 125      # showLastXFVGs
_FVG_DELETE_BARS = 360   # deleteUntouchedAfterXBars (f_get_dynamic_bars 线性设计恒 360)
_FVG_EXTEND_X = 15       # extendZonesBy (bar_time 单位, 视觉宽度≈0)


def _compute_fvg(rows: list[dict[str, Any]], atr10: list) -> list[dict[str, Any]]:
    """FVG 模块逐式 (Pine 1841-1952): 检测(Same Type + Extreme 敏感度) →
    失效(Close 法) → 未触及删除(360 根) → 同向相交合并 → 输出活跃区间。

    - Same Type: 构成 FVG 的三根 K 线同阴或同阳 (fvgBars="Same Type")
    - 敏感度 (Average Range 法): barSizeSum×6 > ATR10/1.5 且 maxCODiff ≤ ATR10,
      且 FVGSize×6 > ATR10 (双重 Extreme 过滤); allowGaps=false
    - 失效: bull 收盘跌破 min / bear 收盘破 max (fvgEndMethod="Close")
    - 未触及: bull low≤max / bear high≥min 更新 lastTouched
    - 合并 (islast): 同向且 X(start~end|start+15)×Y(min~max) 相交 → 并集
      (活跃区间 X 宽度≈15 时间单位 → 合并几乎仅同起点重叠时触发, 忠实照搬)
    - 输出: showInvalidated=false → 只返回未失效区间; extendLastFVGs 实际
      口径为全量延伸 (循环条件 ≤360) → 前端全部画到末根
    """
    n = len(rows)
    if n < 3:
        return []
    fvgs: list[dict[str, Any]] = []  # 头 = 最新 (Pine unshift)
    # Pine 前 2 根历史为 na → 不检测; 从 i=2 起 (避免 i<2 负索引回绕到末尾 K 线
    # 伪造三连 — warmup 下 atr10[0] 非空时该路径可触发)
    for i in range(2, n):
        r, r1, r2 = rows[i], rows[i - 1], rows[i - 2]
        o, c, h, l = r.get("open"), r.get("close"), r.get("high"), r.get("low")
        o1, c1 = r1.get("open"), r1.get("close")
        o2, c2 = r2.get("open"), r2.get("close")
        h2, l2 = r2.get("high"), r2.get("low")
        v, v1, v2 = r.get("volume") or 0, r1.get("volume") or 0, r2.get("volume") or 0
        atr = atr10[i]
        if None in (o, c, h, l, o1, c1, o2, c2, h2, l2) or atr is None or atr <= 0:
            continue
        same_type = (o > c and o1 > c1 and o2 > c2) or (o <= c and o1 <= c1 and o2 <= c2)
        if same_type:
            bar_sum = abs(o - c) + abs(o1 - c1) + abs(o2 - c2)
            max_co = max(abs(c2 - o1), abs(c1 - o))
            cond = (bar_sum * _FVG_SENS > atr / 1.5) and (max_co <= atr)
            bear = cond and h < l2 and c1 < l2
            bull = cond and l > h2 and c1 > h2
            if bear or bull:
                size = abs(l2 - h) if bear else abs(l - h2)
                if size * _FVG_SENS > atr:
                    total_v = v + v1 + v2
                    if bear:
                        fvg: dict[str, Any] = {"max": l2, "min": h, "is_bull": False,
                                               "low_vol": v + v1, "high_vol": v2}
                    else:
                        fvg = {"max": l, "min": h2, "is_bull": True,
                               "low_vol": v2, "high_vol": v + v1}
                    fvg.update({"start_i": i, "end_i": None, "disabled": False,
                                "combined": False, "total_vol": total_v, "last_touch": i})
                    fvgs.insert(0, fvg)
                    if len(fvgs) > _FVG_MAX_KEEP:
                        fvgs.pop()
        # 失效/触及 (Close 法; 含新入列区间)
        for f in fvgs:
            if f["end_i"] is not None:
                continue
            if f["is_bull"] and l <= f["max"]:
                f["last_touch"] = i
            if (not f["is_bull"]) and h >= f["min"]:
                f["last_touch"] = i
            if f["is_bull"] and c < f["min"]:
                f["end_i"] = i
            if (not f["is_bull"]) and c > f["max"]:
                f["end_i"] = i
        # 无效删除: 失效 (showInvalidated=false) / 禁用 / 未触及超 360 根
        fvgs = [
            f for f in fvgs
            if not f["disabled"] and f["end_i"] is None
            and (i - f["last_touch"]) <= _FVG_DELETE_BARS
        ]

    # 合并 (islast): 同向相交 → 并集 (循环至稳)
    while True:
        merged = False
        for a_i in range(len(fvgs)):
            for b_i in range(len(fvgs)):
                if a_i == b_i:
                    continue
                a, b = fvgs[a_i], fvgs[b_i]
                if a["is_bull"] != b["is_bull"]:
                    continue
                ax2 = a["end_i"] if a["end_i"] is not None else a["start_i"] + _FVG_EXTEND_X
                bx2 = b["end_i"] if b["end_i"] is not None else b["start_i"] + _FVG_EXTEND_X
                if (min(ax2, bx2) - max(a["start_i"], b["start_i"])) > 0 \
                        and (min(a["max"], b["max"]) - max(a["min"], b["min"])) > 0:
                    nf = {
                        "max": max(a["max"], b["max"]), "min": min(a["min"], b["min"]),
                        "is_bull": a["is_bull"],
                        "start_i": min(a["start_i"], b["start_i"]),
                        "end_i": max(a["end_i"] or 0, b["end_i"] or 0) or None,
                        "disabled": False, "combined": True,
                        "total_vol": a["total_vol"] + b["total_vol"],
                        "low_vol": a["low_vol"] + b["low_vol"],
                        "high_vol": a["high_vol"] + b["high_vol"],
                        "last_touch": max(a["last_touch"], b["last_touch"]),
                    }
                    fvgs = [f for j, f in enumerate(fvgs) if j not in (a_i, b_i)]
                    fvgs.insert(0, nf)
                    merged = True
                    break
            if merged:
                break
        if not merged:
            break

    # 输出: 活跃区间 (未失效/未禁用), start 为起始 bar 的 date 标签
    return [
        {"start": str(rows[f["start_i"]].get("date", ""))[:32],
         "min": f["min"], "max": f["max"], "is_bull": f["is_bull"],
         "combined": f["combined"],
         "high_vol": f["high_vol"], "low_vol": f["low_vol"], "total_vol": f["total_vol"]}
        for f in fvgs if f["end_i"] is None and not f["disabled"]
    ]


def _cols(rows: list[dict[str, Any]]) -> tuple[list, list, list, list]:
    o = [r.get("open") for r in rows]
    h = [r.get("high") for r in rows]
    l = [r.get("low") for r in rows]
    c = [r.get("close") for r in rows]
    return o, h, l, c


def _wilder_atr(h: list, l: list, c: list, n: int) -> list:
    """TR → Wilder RMA。首行 TR 无前收 → None。"""
    tr: list = [None]
    for i in range(1, len(c)):
        if h[i] is None or l[i] is None or c[i] is None or c[i - 1] is None:
            tr.append(None)
            continue
        tr.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    return _wilder_rma_series(tr, n)


def _supertrend(h: list, l: list, c: list, atr_len: int = _K_ATR_LEN, mult: float = _K_MULT):
    """SuperTrend: up/dn 轨 + trend (+1/-1)。Pine var 初值 1, na 段保持。"""
    n = len(c)
    atr = _wilder_atr(h, l, c, atr_len)
    up: list = [None] * n
    dn: list = [None] * n
    trend: list = [1] * n
    for i in range(n):
        if atr[i] is None or h[i] is None or l[i] is None or c[i] is None:
            trend[i] = trend[i - 1] if i > 0 else 1
            continue
        hl2 = (h[i] + l[i]) / 2
        basic_up = hl2 - mult * atr[i]
        basic_dn = hl2 + mult * atr[i]
        prev_up = up[i - 1] if i > 0 and up[i - 1] is not None else basic_up
        prev_dn = dn[i - 1] if i > 0 and dn[i - 1] is not None else basic_dn
        cprev = c[i - 1] if i > 0 else None
        up[i] = max(basic_up, prev_up) if (cprev is not None and cprev > prev_up) else basic_up
        dn[i] = min(basic_dn, prev_dn) if (cprev is not None and cprev < prev_dn) else basic_dn
        pt = trend[i - 1] if i > 0 else 1
        if pt == -1 and cprev is not None and c[i] > prev_dn:
            trend[i] = 1
        elif pt == 1 and cprev is not None and c[i] < prev_up:
            trend[i] = -1
        else:
            trend[i] = pt
    return up, dn, trend


def _resolve_bucket(bar_minutes: int, mult: int) -> int:
    """TV f_resolveDynamicTimeframe 语义的高周期桶根数 (A股, intraday 不跨 session)。

    实测校准 (2026-10-22 TV 对拍): 4h 图 k2==k3 (16h/1D 都=1天桶),
    60m 图 k2(4h)=k3(8h)=1天桶=4根 — 高周期 ≥ 单日 session 时按天切一根。
    - bar ≥ 日线: 桶 = mult 根 (N 天)
    - 高周期 ≥ 1440min (解析为 "ND"): N 天 × 每天 bar 数
    - 否则: min(tf_min, 240) // bar_minutes (≥session 时 = 每天一根)
    """
    if bar_minutes >= 1440:
        return mult
    tf_min = bar_minutes * mult
    if tf_min >= 1440:
        days = max(1, int(round(tf_min / 1440)))
        return days * max(1, _SESSION_MIN // bar_minutes)
    return max(1, min(tf_min, _SESSION_MIN) // bar_minutes)


def _group_bars(rows: list[dict], group: int, by_day: bool = False) -> tuple[list[dict], list[int]]:
    """合并高周期桶: 每 group 根一桶 (open=首 close=末 极值/求和);
    by_day=True 时按交易日分组 (60m 的 1 天桶 = 自然日对齐, 免相位错位)。
    返回 (桶序列, 每根输入 bar 所属桶索引 owner)。"""
    out: list[dict] = []
    owner: list[int] = []
    if by_day:
        cur_key: str | None = None
        for i, r in enumerate(rows):
            key = str(r.get("date", ""))[:10]
            if key != cur_key:
                out.append({
                    "open": r.get("open"),
                    "high": r.get("high"),
                    "low": r.get("low"),
                    "close": r.get("close"),
                })
                cur_key = key
            else:
                b = out[-1]
                hi, lo = r.get("high"), r.get("low")
                if hi is not None:
                    b["high"] = hi if b["high"] is None else max(b["high"], hi)
                if lo is not None:
                    b["low"] = lo if b["low"] is None else min(b["low"], lo)
                b["close"] = r.get("close")
            owner.append(len(out) - 1)
        return out, owner
    for i in range(0, len(rows), group):
        chunk = rows[i:i + group]
        out.append({
            "open": chunk[0].get("open"),
            "high": max((r.get("high") for r in chunk if r.get("high") is not None), default=None),
            "low": min((r.get("low") for r in chunk if r.get("low") is not None), default=None),
            "close": chunk[-1].get("close"),
        })
    owner = [min(i // group, len(out) - 1) for i in range(len(rows))]
    return out, owner


def _map_group_to_bars(group_vals: list, owner: list[int]) -> list:
    """桶级序列值映射回低周期每根 bar (owner 为每根 bar 的桶索引)。"""
    out: list = []
    for j in owner:
        out.append(group_vals[j] if j is not None and 0 <= j < len(group_vals) else None)
    return out


# ── 背离指标序列 (10 指标) ────────────────────────────────────────
def _indicator_series(h: list, l: list, c: list, v: list) -> dict[str, list]:
    """10 个背离检测指标序列 (Pine 口径)。"""
    n = len(c)
    out: dict[str, list] = {}

    ema12 = _ema_series(c, 2.0 / 13.0)
    ema26 = _ema_series(c, 2.0 / 27.0)
    macd = [None if (a is None or b is None) else a - b for a, b in zip(ema12, ema26)]
    sig = _ema_series(macd, 2.0 / 10.0)
    out["macd"] = macd
    out["hist"] = [None if (a is None or b is None) else a - b for a, b in zip(macd, sig)]
    out["rsi"] = _wilder_rsi_series(c, 14)

    # Stoch(14) → SMA3
    raw: list = [None] * n
    for i in range(n):
        if any(x is None for x in c[i:i + 1]) or i < 13:
            continue
        window_l = l[max(0, i - 13):i + 1]
        window_h = h[max(0, i - 13):i + 1]
        if any(x is None for x in window_l + window_h) or c[i] is None:
            continue
        lo, hi = min(window_l), max(window_h)
        raw[i] = 50.0 if hi == lo else (c[i] - lo) / (hi - lo) * 100.0
    sma3 = [None] * n
    acc: list = []
    for i in range(n):
        if raw[i] is None:
            acc = []
            continue
        acc.append(raw[i])
        if len(acc) > 3:
            acc = acc[-3:]
        if len(acc) == 3:
            sma3[i] = sum(acc) / 3
    out["stoch"] = sma3

    # CCI10
    tp = [None if (hh is None or ll is None or cc is None) else (hh + ll + cc) / 3
          for hh, ll, cc in zip(h, l, c)]
    cci: list = [None] * n
    for i in range(n):
        win = [x for x in tp[max(0, i - 9):i + 1] if x is not None]
        if len(win) == 10 and tp[i] is not None:
            m = sum(win) / 10
            mad = sum(abs(x - m) for x in win) / 10
            cci[i] = (tp[i] - m) / (0.015 * mad) if mad != 0 else 0.0
    out["cci"] = cci

    # MOM10
    mom: list = [None] * n
    for i in range(10, n):
        if c[i] is not None and c[i - 10] is not None:
            mom[i] = c[i] - c[i - 10]
    out["mom"] = mom

    # OBV
    obv: list = [0.0]
    for i in range(1, n):
        if c[i] is None or c[i - 1] is None or v[i] is None:
            obv.append(obv[-1])
            continue
        d = c[i] - c[i - 1]
        obv.append(obv[-1] + (v[i] if d > 0 else -v[i] if d < 0 else 0.0))
    out["obv"] = obv

    # VWMACD (vwma12 - vwma26)
    def _vwma(length: int) -> list:
        res: list = [None] * n
        for i in range(length - 1, n):
            seg_c = c[i - length + 1:i + 1]
            seg_v = v[i - length + 1:i + 1]
            if any(x is None for x in seg_c + seg_v):
                continue
            sv = sum(seg_v)
            res[i] = sum(a * b for a, b in zip(seg_c, seg_v)) / sv if sv != 0 else None
        return res

    vw12, vw26 = _vwma(12), _vwma(26)
    out["vwmacd"] = [None if (a is None or b is None) else a - b for a, b in zip(vw12, vw26)]

    # CMF21
    cmf: list = [None] * n
    for i in range(n):
        win = range(max(0, i - 20), i + 1)
        mfv, vol = [], []
        ok = True
        for j in win:
            if c[j] is None or h[j] is None or l[j] is None or v[j] is None or h[j] == l[j]:
                ok = False
                break
            mfv.append(((c[j] - l[j]) - (h[j] - c[j])) / (h[j] - l[j]) * v[j])
            vol.append(v[j])
        if ok and sum(vol) != 0:
            cmf[i] = sum(mfv) / sum(vol)
    out["cmf"] = cmf

    # MFI14 (窗口重算, 简单直接)
    mfi: list = [None] * n
    for i in range(14, n):
        seg = list(range(i - 13, i + 1))
        if any(tp[j] is None or v[j] is None or tp[j - 1] is None for j in seg):
            continue
        pos_f = 0.0
        neg_f = 0.0
        for j in seg:
            flow = tp[j] * v[j]
            if tp[j] > tp[j - 1]:
                pos_f += flow
            else:
                neg_f += flow
        mfi[i] = 100.0 - 100.0 / (1.0 + pos_f / neg_f) if neg_f != 0 else 100.0
    out["mfi"] = mfi
    return out


def _divergence_counts(h: list, l: list, c: list, v: list) -> tuple[list, list]:
    """每根 bar 的 (顶部负背离计数, 底部正背离计数)。pivot 基于 close, ±prd 确认。"""
    n = len(c)
    ind = _indicator_series(h, l, c, v)

    # pivot lows/highs (基于 close, 确认于 pos+prd)
    piv_low_at: dict[int, float] = {}
    piv_high_at: dict[int, float] = {}
    for i in range(_DIV_PRD, n - _DIV_PRD):
        if c[i] is None:
            continue
        win = c[i - _DIV_PRD:i + _DIV_PRD + 1]
        if any(x is None for x in win):
            continue
        if c[i] == min(win):
            piv_low_at[i] = c[i]
        if c[i] == max(win):
            piv_high_at[i] = c[i]

    top_counts = [0] * n
    btm_counts = [0] * n
    piv_lows: list[tuple[int, float]] = []    # 按确认时间递增 (确认根 = pos+prd)
    piv_highs: list[tuple[int, float]] = []

    def _detect_pos(src: list, i: int) -> bool:
        """正背离: 价格低于前 pivot low, 指标抬升。
        Pine 口径: pivot 列表存确认根位置 (pos+prd), len = i - 确认根 + prd
        = i - pivot根; src[len] 即 pivot 根的指标值。"""
        if i < 1 or src[i] is None or src[i - 1] is None or c[i] is None or c[i - 1] is None:
            return False
        if not (src[i] > src[i - 1] or c[i] > c[i - 1]):
            return False
        for pos, val in piv_lows[-_DIV_MAXPP:]:
            ln = i - pos
            if pos == 0 or ln > _DIV_MAXBARS:
                break
            if ln <= 5:
                continue
            if src[i - ln] is None:
                continue
            if src[i - 1] > src[i - ln] and c[i - 1] < val:
                slope1 = (src[i - 1] - src[i - ln]) / (ln - 1)
                slope2 = (c[i - 1] - c[i - ln]) / (ln - 1)
                vl1 = src[i - 1] - slope1
                vl2 = c[i - 1] - slope2
                arrived = True
                for k in range(2, ln):
                    y = i - k
                    if src[y] is None or c[y] is None:
                        arrived = False
                        break
                    if src[y] < vl1 or c[y] < vl2:
                        arrived = False
                        break
                    vl1 -= slope1
                    vl2 -= slope2
                if arrived:
                    return True
        return False

    def _detect_neg(src: list, i: int) -> bool:
        """负背离: 价格高于前 pivot high, 指标回落 (同正背离对称口径)。"""
        if i < 1 or src[i] is None or src[i - 1] is None or c[i] is None or c[i - 1] is None:
            return False
        if not (src[i] < src[i - 1] or c[i] < c[i - 1]):
            return False
        for pos, val in piv_highs[-_DIV_MAXPP:]:
            ln = i - pos
            if pos == 0 or ln > _DIV_MAXBARS:
                break
            if ln <= 5:
                continue
            if src[i - ln] is None:
                continue
            if src[i - 1] < src[i - ln] and c[i - 1] > val:
                slope1 = (src[i - 1] - src[i - ln]) / (ln - 1)
                slope2 = (c[i - 1] - c[i - ln]) / (ln - 1)
                vl1 = src[i - 1] - slope1
                vl2 = c[i - 1] - slope2
                arrived = True
                for k in range(2, ln):
                    y = i - k
                    if src[y] is None or c[y] is None:
                        arrived = False
                        break
                    if src[y] > vl1 or c[y] > vl2:
                        arrived = False
                        break
                    vl1 -= slope1
                    vl2 -= slope2
                if arrived:
                    return True
        return False

    for i in range(n):
        # 增量确认 pivot (确认根 = pos+prd = i)
        val = piv_low_at.pop(i - _DIV_PRD, None)
        if val is not None:
            piv_lows.append((i - _DIV_PRD, val))
        val = piv_high_at.pop(i - _DIV_PRD, None)
        if val is not None:
            piv_highs.append((i - _DIV_PRD, val))

        if i < 2:
            continue
        btm = sum(1 for src in ind.values() if _detect_pos(src, i))
        top = sum(1 for src in ind.values() if _detect_neg(src, i))
        btm_counts[i] = btm
        top_counts[i] = top

    # showlimit=1: 全部计数 < 1 时清零 (任一背离即显示)
    total = sum(1 for i in range(n) if top_counts[i] > 0 or btm_counts[i] > 0)
    if total < 1:
        top_counts = [0] * n
        btm_counts = [0] * n
    return top_counts, btm_counts


def attach_ry_main(
    rows: list[dict[str, Any]],
    warmup_rows: list[dict[str, Any]] | None = None,
    bar_minutes: int | None = None,
) -> list[dict[str, Any]]:
    """对K行序列附着融易主图全部字段 (原地写回并返回 rows)。

    rows 按时间升序, 须含 open/high/low/close (volume 可选, 背离指标用)。
    warmup_rows: 窗口前更早的 OHLC 行 (升序) — EMA110/ATR50 递推深度长,
    日K路径需要 warmup 对齐全历史口径; 分钟周期可不传 (窗口内递推)。
    K2/K3 桶根数按 TV f_resolveDynamicTimeframe 语义 (见 _resolve_bucket):
    bar_minutes=None/≥1440 → 4/8 根 (起点除法); 60m → 1 天桶 (按日分组);
    240m(4h) → 桶=1 (k2==k3==k, TV 实测 16h/1D 对 A 股均按天切)。
    """
    if not rows:
        return rows
    warmup = warmup_rows or []
    all_rows = [*warmup, *rows]
    n_all = len(all_rows)
    o, h, l, c = _cols(all_rows)
    v = [r.get("volume") or 0 for r in all_rows]
    off = len(warmup)

    # ── 牛熊通道 (EMA110 ± ATR50×0.55) ──
    mid = _ema_series(c, 2.0 / (_RY_MID_LEN + 1))
    atr50 = _wilder_atr(h, l, c, _RY_ATR_LEN)
    upper = [None if (m is None or a is None) else m + a * _RY_BAND_MULT for m, a in zip(mid, atr50)]
    lower = [None if (m is None or a is None) else m - a * _RY_BAND_MULT for m, a in zip(mid, atr50)]

    # ── 中轨 EMA24 + MACD 快线分色 + 刻度半幅 ──
    ema24 = _ema_series(c, 2.0 / (_RY_EMA_MID + 1))
    ema12 = _ema_series(c, 2.0 / 13.0)
    ema26 = _ema_series(c, 2.0 / 27.0)
    macd_fast = [None if (a is None or b is None) else a - b for a, b in zip(ema12, ema26)]
    mid_trend = [0 if f is None else (1 if f > 0 else -1 if f < 0 else 0) for f in macd_fast]
    mid_tick = [None if f is None else abs(f) * 0.125 for f in macd_fast]

    # ── K/K2/K3 SuperTrend 通道 ──
    k_up, k_dn, k_tr = _supertrend(h, l, c)

    def _group_st(group: int, by_day: bool = False):
        if group <= 1:
            return k_up, k_dn, k_tr
        gbars, owner = _group_bars(all_rows, group, by_day=by_day)
        gh = [b["high"] for b in gbars]
        gl = [b["low"] for b in gbars]
        gc = [b["close"] for b in gbars]
        gu, gd, gt = _supertrend(gh, gl, gc)
        return (_map_group_to_bars(gu, owner),
                _map_group_to_bars(gd, owner),
                _map_group_to_bars(gt, owner))

    if bar_minutes is None or bar_minutes >= 1440:
        g2, g3, day2, day3 = _K2_GROUP, _K3_GROUP, False, False
    else:
        g2 = _resolve_bucket(bar_minutes, 4)
        g3 = _resolve_bucket(bar_minutes, 8)
        per_day = _SESSION_MIN // bar_minutes if bar_minutes and _SESSION_MIN % bar_minutes == 0 else 0
        day2 = day3 = per_day > 0 and g2 == per_day and g3 == per_day
    k2_up, k2_dn, k2_tr = _group_st(g2, by_day=day2)
    k3_up, k3_dn, k3_tr = _group_st(g3, by_day=day3)

    # ── K 线通道位置着色 (+1 上轨外多头 / -1 下轨外空头 / 0 通道内灰) ──
    bar_color: list = []
    for i in range(n_all):
        if c[i] is None or upper[i] is None or lower[i] is None:
            bar_color.append(0)
            continue
        if c[i] > upper[i]:
            bar_color.append(1)
        elif c[i] < lower[i]:
            bar_color.append(-1)
        else:
            bar_color.append(0)

    # ── 梯形信号 (归一化乖离 osc, 50 根窗口) ──
    diff = [None if (cc is None or m is None) else cc - m for cc, m in zip(c, mid)]
    abs_diff = [None if x is None else abs(x) for x in diff]
    mx = _rolling_max_series(abs_diff, 50)
    osc = []
    for d, m in zip(diff, mx):
        if d is None:
            osc.append(None)
        elif m is None or m == 0:
            osc.append(0.0)
        else:
            osc.append(d / m * 100.0)
    top_signal: list = []
    top_price: list = []
    btm_signal: list = []
    btm_price: list = []
    for i in range(n_all):
        top_signal.append(False)
        btm_signal.append(False)
        top_price.append(None)
        btm_price.append(None)
        if i < 1 or osc[i] is None or osc[i - 1] is None or h[i - 1] is None or l[i - 1] is None:
            continue
        if osc[i - 1] == 100.0 and osc[i] < 100.0 and c[i] is not None and h[i - 1] is not None:
            if c[i] <= h[i - 1]:
                top_signal[i] = True
                top_price[i] = h[i - 1]
        if osc[i - 1] == -100.0 and osc[i] > -100.0 and c[i] is not None and l[i - 1] is not None:
            if c[i] >= l[i - 1]:
                btm_signal[i] = True
                btm_price[i] = l[i - 1]

    # ── 多指标背离计数 ──
    div_top, div_btm = _divergence_counts(h, l, c, v)

    # ── FVG (公平价值缺口, Pine 主图最后模块): 全历史口径 (含 warmup) ──
    atr10 = _wilder_atr(h, l, c, _K_ATR_LEN)
    fvg_list = _compute_fvg(all_rows, atr10)

    # ── 写回窗口行 ──
    for i, r in enumerate(rows):
        j = off + i
        r["ry_upper"] = upper[j]
        r["ry_mid"] = mid[j]
        r["ry_lower"] = lower[j]
        r["ry_mid_trend"] = mid_trend[j]
        r["ry_mid_tick"] = mid_tick[j]
        r["ry_ema_mid"] = ema24[j]
        r["k_trend"] = k_tr[j]
        r["k_up"] = k_up[j]
        r["k_dn"] = k_dn[j]
        r["k2_trend"] = k2_tr[j]
        r["k2_up"] = k2_up[j]
        r["k2_dn"] = k2_dn[j]
        r["k3_trend"] = k3_tr[j]
        r["k3_up"] = k3_up[j]
        r["k3_dn"] = k3_dn[j]
        r["ry_bar_color"] = bar_color[j]
        r["ry_top_signal"] = top_signal[j]
        r["ry_top_price"] = top_price[j]
        r["ry_btm_signal"] = btm_signal[j]
        r["ry_btm_price"] = btm_price[j]
        r["div_top_count"] = div_top[j]
        r["div_btm_count"] = div_btm[j]
    # FVG 活跃区间只挂末行 (区间型字段, 非每行单值; 前端取末行渲染盒子)
    if fvg_list and rows:
        rows[-1]["fvg_list"] = fvg_list
    return rows
