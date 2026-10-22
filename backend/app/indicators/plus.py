"""私有化指标模块 (MACD+ / RSI+) — 前后端独立线路的后端部分。

算法口径 (2026-10-22 校准替换): R5 经典版附图口径 (私人资产源文件, 不入库,
逐式移植; 快线/慢线/能量柱 + 资金流信号三件套):

能量场 (MACD+ 副图数据):
    DIF  = EMA(close, 12) - EMA(close, 26)
    DEA  = EMA(DIF, 9)
    动能差 raw = EMA(RSI(close, 28), 5) - EMA(RSI(close, 28), 60)
    能量柱 hist = raw × SMA(|DIF|, L) / max(SMA(|raw|, L), 1e-5)
        —— 量级缩放: 把动能差缩放到 |DIF| 量纲 (与快慢线同副图可比)
        —— L 按周期预设档: 日K=50 / 4h=160 / 60m=160 / 15m=200
    RSI 为 Wilder 口径 (RMA, 首值=前 n 根 SMA; EMA 首值起步, 与 Pine 同)

资金流 (RSI+ 副图数据):
    fund_rsi = (RSI(close, 14) - 50) / 50          ← ±1 归一化
    上轨 +0.4 / 下轨 -0.4 (即 20/-50 档)
    fund_bg_color: 超卖低位(<-0.4)=1 / 超买高位(>0.4)=2 / 其余保持前值
    fund_tracking_state: 上下轨穿越追踪状态机 (0 无 / 1 空中 / 2 多中 /
        3 上穿上轨追踪 / 4 下穿下轨追踪; 穿零轴复位重判)
    fund_cross_up_lower: 上穿下轨 → B (买) 信号事件
    fund_cross_down_upper: 下穿上轨 → S (卖) 信号事件

输出字段 (kline API 行): macd_plus_dif / macd_plus_dea / macd_plus_hist(能量柱)
                        / rsi_plus (±1 单值)
                        / volume_rsi_fast / volume_rsi_slow (动能双腿, 供渲染语义)
                        / fund_bg_color / fund_tracking_state
                        / fund_cross_up_lower / fund_cross_down_upper (布尔事件)
API 层附着 (kline.py), 不进 enriched 同步管线不落盘 — 算法升级即时生效于全部历史。

前端分钟周期线路已收归本模块的服务端实现 (indicators/intraday.py),
前端 chart/indicators.ts 不再携带任何私有算法。
渲染颜色: 见 EChartsCandlestick SUB_CHARTS macd_plus/rsi_plus (平台规范配色)。
"""
from __future__ import annotations

import math
from typing import Any

__all__ = [
    "MACD_PLUS_FIELDS",
    "RSI_PLUS_FIELDS",
    "FUND_SIGNAL_FIELDS",
    "PLUS_FIELDS",
    "compute_macd_plus",
    "compute_rsi_plus",
    "compute_fund_signals",
    "attach_plus_indicators",
]

# 私有指标输出字段 (kline API 行上的最终 key)
MACD_PLUS_FIELDS = ("macd_plus_dif", "macd_plus_dea", "macd_plus_hist")
RSI_PLUS_FIELDS = ("rsi_plus",)
FUND_SIGNAL_FIELDS = (
    "fund_bg_color",
    "fund_tracking_state",
    "fund_cross_up_lower",
    "fund_cross_down_upper",
)
VOLUME_RSI_FIELDS = ("volume_rsi_fast", "volume_rsi_slow")
PLUS_FIELDS = MACD_PLUS_FIELDS + RSI_PLUS_FIELDS + FUND_SIGNAL_FIELDS + VOLUME_RSI_FIELDS

# ── R5 参数默认值 ──────────────────────────────────────────────────
_R5_FAST = 12            # 能量场快线长度 (DIF)
_R5_SLOW = 26            # 能量场慢线长度 (DIF)
_R5_SIGNAL = 9           # 信号线长度 (DEA)
_R5_VOL_RSI_LEN = 28     # 动能 RSI 周期 (能量柱源)
_R5_VOL_FAST = 5         # 动能快线 EMA 长度
_R5_VOL_SLOW = 60        # 动能慢线 EMA 长度
_R5_FUND_RSI_LEN = 14    # 资金流 RSI 周期
_R5_FUND_UPPER = 0.4     # 资金流上轨 (20/50 归一化)
_R5_FUND_LOWER = -0.4    # 资金流下轨 (-20/50 归一化)
_T_LOOKBACK_DAILY = 50   # 量级缩放回看 (日K档: 周期预设表 >=1D 档)


def _ema_series(values: list[float | None], alpha: float) -> list[float | None]:
    """EMA 递推 (首值起步): prev + α×(x-prev); None 输入重置递推 (后续重新首值起步)。

    与 Pine ta.ema 同口径 (首值起步而非 SMA 起步; na 输入输出 na 并复位)。
    """
    out: list[float | None] = []
    prev: float | None = None
    for x in values:
        if x is None:
            out.append(None)
            prev = None
            continue
        prev = x if prev is None else prev + alpha * (x - prev)
        out.append(prev)
    return out


def _sma_series(values: list[float | None], n: int) -> list[float | None]:
    """滚动均值; 窗口不足 n 的前缀输出 None (Pine ta.sma 的 na 语义)。"""
    out: list[float | None] = []
    queue: list[float] = []
    total = 0.0
    for v in values:
        if v is None:
            # 窗口内遇 na → SMA 输出 na (Pine ta.sma 对 na 传染), 重新积累
            out.append(None)
            queue.clear()
            total = 0.0
            continue
        queue.append(v)
        total += v
        if len(queue) > n:
            total -= queue.pop(0)
        out.append(total / len(queue) if len(queue) == n else None)
    return out


def _wilder_rma_series(values: list[float | None], n: int) -> list[float | None]:
    """Wilder RMA (Pine ta.rma): 首个连续 n 个非 None 窗口的 SMA 起步,
    之后 alpha=1/n 递推; None 输入重置 (从最近的非 None 段重新积累)。"""
    alpha = 1.0 / n
    out: list[float | None] = []
    acc: float | None = None
    win: list[float] = []
    for v in values:
        if v is None:
            acc = None
            win = []
            out.append(None)
            continue
        if acc is None:
            win.append(v)
            if len(win) == n:
                acc = sum(win) / n
                win = []
            out.append(acc)
            continue
        acc = alpha * v + (1.0 - alpha) * acc
        out.append(acc)
    return out


def _wilder_rsi_series(closes: list[float | None], n: int) -> list[float | None]:
    """Wilder RSI (Pine ta.rsi): up/dn = |change| 正负分离, RMA 平滑。

    change 首值 na; u>0,d=0 → 100; u=0,d>0 → 0; u=d=0 → na (None)。
    """
    up: list[float | None] = [None]
    dn: list[float | None] = [None]
    for prev, cur in zip(closes, closes[1:]):
        if prev is None or cur is None:
            up.append(None)
            dn.append(None)
            continue
        ch = cur - prev
        up.append(max(ch, 0.0))
        dn.append(max(-ch, 0.0))
    rau = _wilder_rma_series(up, n)
    rdn = _wilder_rma_series(dn, n)
    out: list[float | None] = []
    for u, d in zip(rau, rdn):
        if u is None or d is None:
            out.append(None)
            continue
        if d == 0.0:
            out.append(100.0 if u > 0 else None)
            continue
        out.append(100.0 - 100.0 / (1.0 + u / d))
    return out


def _diff_series(
    a: list[float | None], b: list[float | None]
) -> list[float | None]:
    return [None if (x is None or y is None) else x - y for x, y in zip(a, b)]


def compute_macd_plus(
    closes: list[float | None],
    lookback: int = _T_LOOKBACK_DAILY,
) -> dict[str, list[float | None]]:
    """能量场 (R5 天玑牛熊口径)。

    输入: 收盘价序列 (升序时间); lookback 为量级缩放回看 (日K=50 / 4h·60m=160 / 15m=200)。
    输出: {macd_plus_dif, macd_plus_dea, macd_plus_hist(能量柱),
           volume_rsi_fast, volume_rsi_slow} 五个等长序列。
    SMA 窗口不足的前缀输出 None (Pine na → 前端按 '-' 渲染)。
    """
    ema_fast = _ema_series(closes, 2.0 / (_R5_FAST + 1))
    ema_slow = _ema_series(closes, 2.0 / (_R5_SLOW + 1))
    dif = _diff_series(ema_fast, ema_slow)
    dea = _ema_series(dif, 2.0 / (_R5_SIGNAL + 1))

    # 动能双腿: RSI(close, 28) 的快慢 EMA 差 (能量柱原始值)
    vol_rsi = _wilder_rsi_series(closes, _R5_VOL_RSI_LEN)
    vol_fast = _ema_series(vol_rsi, 2.0 / (_R5_VOL_FAST + 1))
    vol_slow = _ema_series(vol_rsi, 2.0 / (_R5_VOL_SLOW + 1))
    raw_hist = _diff_series(vol_fast, vol_slow)

    # 量级缩放: 动能差 × (|DIF| 均值 / |动能差| 均值) → 与快慢线同量纲
    abs_dif = [None if v is None else abs(v) for v in dif]
    abs_raw = [None if v is None else abs(v) for v in raw_hist]
    ref = _sma_series(abs_dif, lookback)
    mag = _sma_series(abs_raw, lookback)

    hist: list[float | None] = []
    for r, m, rf in zip(raw_hist, mag, ref):
        if r is None or m is None or rf is None:
            hist.append(None)
            continue
        scale = rf / max(m, 1e-5)
        hist.append(r * scale)
    return {
        "macd_plus_dif": dif,
        "macd_plus_dea": dea,
        "macd_plus_hist": hist,
        "volume_rsi_fast": vol_fast,
        "volume_rsi_slow": vol_slow,
    }


def compute_rsi_plus(closes: list[float | None]) -> list[float | None]:
    """资金流 (R5): (RSI(close, 14) - 50) / 50 → ±1 归一化单值序列。

    fund>0 ⟺ 14 期 RSI > 50 (多头区间); |fund| ≤ 1; ±0.4 为多空轨道阈值。
    """
    rsi = _wilder_rsi_series(closes, _R5_FUND_RSI_LEN)
    return [None if v is None else (v - 50.0) / 50.0 for v in rsi]


def compute_fund_signals(fund_rsi: list[float | None]) -> dict[str, list[Any]]:
    """资金流信号 (R5 逐式): 轨道交叉事件 + 背景状态机 + 追踪状态机。

    - fund_bg_color: 1=超卖低位(<下轨) / 2=超买高位(>上轨) / 其保持前值 (var 语义)
    - fund_tracking_state: 3=上穿上轨追踪 / 4=下穿下轨追踪 / 穿零轴或反向穿轨
      复位重判 (fund<0→1 空中 / fund≥0→2 多中) / 0=初始
    - fund_cross_up_lower: 上穿下轨 (B 买信号事件, 布尔)
    - fund_cross_down_upper: 下穿上轨 (S 卖信号事件, 布尔)
    crossover/crossunder 的 na 语义: 任一侧 na → False。
    """
    upper, lower = _R5_FUND_UPPER, _R5_FUND_LOWER
    bg: list[int] = []
    state: list[int] = []
    cross_up_lower: list[bool] = []
    cross_down_upper: list[bool] = []
    prev_bg = 0
    prev_state = 0
    prev_v: float | None = None
    for v in fund_rsi:
        if v is None:
            # na 行: 事件 False, var 状态保持; prev 置 na (下一行交叉判定失效,
            # Pine crossover 对 na 前值返回 false)
            cross_up_lower.append(False)
            cross_down_upper.append(False)
            bg.append(prev_bg)
            state.append(prev_state)
            prev_v = None
            continue
        # 交叉事件需要前值; 首行 (prev na) 全 False (Pine crossover na 语义)
        if prev_v is None:
            cu_lower = cd_upper = cd_mid = cu_mid = cu_upper = cd_lower = False
        else:
            cu_lower = v > lower and prev_v <= lower
            cd_upper = v < upper and prev_v >= upper
            cd_mid = v < 0 and prev_v >= 0
            cu_mid = v > 0 and prev_v <= 0
            cu_upper = v > upper and prev_v <= upper
            cd_lower = v < lower and prev_v >= lower

        # 背景/追踪状态判定不依赖前值 (首行 above/below 照常生效)
        cur_bg = 1 if v < lower else (2 if v > upper else prev_bg)

        reset = (prev_state == 3 and cd_upper) or (prev_state == 4 and cu_lower) or cd_mid or cu_mid
        if cu_upper:
            cur_state = 3
        elif cd_lower:
            cur_state = 4
        elif reset:
            cur_state = 1 if v < 0 else 2
        else:
            cur_state = prev_state

        bg.append(cur_bg)
        state.append(cur_state)
        cross_up_lower.append(cu_lower)
        cross_down_upper.append(cd_upper)
        prev_bg, prev_state, prev_v = cur_bg, cur_state, v
    return {
        "fund_bg_color": bg,
        "fund_tracking_state": state,
        "fund_cross_up_lower": cross_up_lower,
        "fund_cross_down_upper": cross_down_upper,
    }


def attach_plus_indicators(
    rows: list[dict[str, Any]],
    warmup_closes: list[float | None] | None = None,
    lookback: int = _T_LOOKBACK_DAILY,
) -> list[dict[str, Any]]:
    """对K行序列附着 MACD+/RSI+ 全部字段 (原地写回并返回 rows)。

    kline API 输出前统一调用: enriched/live 两条路径与实时注入行均覆盖。
    rows 按时间升序; close 缺失行输出 None (前端按 '-' 渲染)。

    warmup_closes: 窗口之前的更早历史 close 序列 (升序) — EMA/RSI 是递推
    指标, 只在返回窗口内递推会因 warmup 不足偏离全历史口径; 调用方 (kline.py)
    取窗口前 300 日历日历史前置递推, 覆盖 EMA60+RSI28(RMA28) 递推深度与量级
    标尺 50 窗口; fund 状态机同样在 warmup 段预收敛。
    lookback: 量级缩放回看窗口 (日K=50; 分钟聚合周期 15m→200 / 60m→160,
    4h→160 — 周期预设档, 见 intraday.py)。
    """
    if not rows:
        return rows
    warmup = warmup_closes or []
    closes = [*warmup, *[r.get("close") for r in rows]]
    macd = compute_macd_plus(closes, lookback=lookback)
    fund_rsi = compute_rsi_plus(closes)
    sig = compute_fund_signals(fund_rsi)
    off = len(warmup)
    for i, r in enumerate(rows):
        j = off + i
        r["macd_plus_dif"] = macd["macd_plus_dif"][j]
        r["macd_plus_dea"] = macd["macd_plus_dea"][j]
        r["macd_plus_hist"] = macd["macd_plus_hist"][j]
        r["volume_rsi_fast"] = macd["volume_rsi_fast"][j]
        r["volume_rsi_slow"] = macd["volume_rsi_slow"][j]
        r["rsi_plus"] = fund_rsi[j]
        r["fund_bg_color"] = sig["fund_bg_color"][j]
        r["fund_tracking_state"] = sig["fund_tracking_state"][j]
        r["fund_cross_up_lower"] = sig["fund_cross_up_lower"][j]
        r["fund_cross_down_upper"] = sig["fund_cross_down_upper"][j]
    return rows
