"""私有化指标模块 (MACD+ / RSI+) — 前后端独立线路的后端部分。

算法来源 (2026-10-14 替换): 泰坦量化策略(天机版)-T5.0.pine 的
「优化版MACD」与「优化版RSI」, 逐式移植 (T5.0 参数默认值):

优化版MACD (f_optMacd):
    DIF  = EMA(close, 12) - EMA(close, 26)
    DEA  = EMA(DIF, 9)
    raw  = 子午线(K5) - 子午线(K61)          ← 子午线 = exp(DEMA(log(close), N))
                                                    DEMA(s,N) = 2·EMA(s,N) - EMA(EMA(s,N),N)
    ref  = SMA(|DIF-DEA|, lookback)          ← 量级标尺: 与快慢线同量纲
    mag  = SMA(|raw|, lookback)
    hist = raw × ref / max(mag, 1e-5)        ← 能量柱 (非标准 MACD 柱)
    lookback: 日K=50 (Pine 周期预设表 >=1D 档)

优化版RSI (f_optRsi, 归一化乖离振荡器):
    ma   = EMA(close, 26)                    ← 平滑方式 EMA (T5.0 默认, 动能版)
    diff = close - ma
    mx   = highest(|diff|, 50)               ← 近 50 根最大绝对乖离
    RSI  = mx 窗口不足(na→nz=0) 或 mx=0 ? 0 : diff / mx × 100   (±100 单值)
    性质: RSI > 0 ⟺ close > EMA26; |RSI| ≤ 100, 乖离创 50 根新高时 = ±100

输出字段 (kline API 行): macd_plus_dif / macd_plus_dea / macd_plus_hist(能量柱)
                        / rsi_plus (单一值, ±100)
API 层附着 (kline.py), 不进 enriched 同步管线不落盘 — 算法升级即时生效于全部历史。

前端平行克隆: frontend/src/chart/indicators.ts (分钟周期线路, 同口径)。
渲染颜色 (泰坦 T5.0 副图): 见 EChartsCandlestick SUB_CHARTS macd_plus/rsi_plus。
"""
from __future__ import annotations

import math
from typing import Any

__all__ = [
    "MACD_PLUS_FIELDS",
    "RSI_PLUS_FIELDS",
    "PLUS_FIELDS",
    "compute_macd_plus",
    "compute_rsi_plus",
    "attach_plus_indicators",
]

# 私有指标输出字段 (kline API 行上的最终 key)
MACD_PLUS_FIELDS = ("macd_plus_dif", "macd_plus_dea", "macd_plus_hist")
RSI_PLUS_FIELDS = ("rsi_plus",)
PLUS_FIELDS = MACD_PLUS_FIELDS + RSI_PLUS_FIELDS

# ── 泰坦 T5.0 参数默认值 (见 Pine input 定义) ─────────────────────
_T_FAST = 12            # MACD 快线长度 (DIF)
_T_SLOW = 26            # MACD 慢线长度 (DIF)
_T_SIGNAL = 9           # MACD 信号线长度 (DEA)
_T_K_FAST = 5           # 子午线快线长度 (K5)
_T_K_SLOW = 61          # 子午线慢线长度 (K61)
_T_LOOKBACK_DAILY = 50  # 量级缩放回看 (日K: Pine 预设表 >=1D 档)
_T_RSI_LEN = 26         # 优化版RSI 基准均线长度 (EMA, 动能版)
_T_RSI_MX_WIN = 50      # 乖离归一化回看 (highest 窗口)


def _ema_series(values: list[float | None], alpha: float) -> list[float | None]:
    """EMA 递推 (首值起步): prev + α×(x-prev); None 输入中断递推 (后续输出 None)。

    与 Pine ta.ema 同口径 (adjust=False 首值起步), 与前端 chart/indicators.ts
    的 rma() 逐式一致。
    """
    out: list[float | None] = []
    prev: float | None = None
    for x in values:
        if x is None:
            out.append(None)
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


def _rolling_max_series(values: list[float | None], n: int) -> list[float | None]:
    """滚动最大; 窗口不足 n 的前缀输出 None (Pine ta.highest 的 na 语义)。"""
    out: list[float | None] = []
    queue: list[float] = []
    for v in values:
        if v is None:
            out.append(None)
            queue.clear()
            continue
        queue.append(v)
        if len(queue) > n:
            queue.pop(0)
        out.append(max(queue) if len(queue) == n else None)
    return out


def _meridian_dema_log(closes: list[float | None], length: int) -> list[float | None]:
    """泰坦子午线: 对数刻度 DEMA — exp(DEMA(log(close), N))。

    DEMA(s, N) = 2·EMA(s,N) - EMA(EMA(s,N), N)  (Pine meridian_calcDema +
    f_meridian 的 meridianLog=true 默认路径)。close ≤ 0 的行输出 None。
    """
    logs: list[float | None] = [
        math.log(c) if c is not None and c > 0 else None for c in closes
    ]
    alpha = 2.0 / (length + 1)
    e1 = _ema_series(logs, alpha)
    e2 = _ema_series(e1, alpha)
    out: list[float | None] = []
    for a, b in zip(e1, e2):
        if a is None or b is None:
            out.append(None)
            continue
        dema = 2.0 * a - b
        out.append(math.exp(dema) if math.isfinite(dema) else None)
    return out


def compute_macd_plus(
    closes: list[float | None],
    lookback: int = _T_LOOKBACK_DAILY,
) -> dict[str, list[float | None]]:
    """优化版MACD (泰坦 T5.0 f_optMacd)。

    输入: 收盘价序列 (升序时间); lookback 为量级缩放回看 (日K=50)。
    输出: {macd_plus_dif, macd_plus_dea, macd_plus_hist(能量柱)} 三个等长序列。
    SMA 窗口不足的前缀输出 None (Pine na → 前端按 '-' 渲染)。
    """
    alpha_fast = 2.0 / (_T_FAST + 1)
    alpha_slow = 2.0 / (_T_SLOW + 1)
    ema_fast = _ema_series(closes, alpha_fast)
    ema_slow = _ema_series(closes, alpha_slow)
    dif: list[float | None] = [
        None if (a is None or b is None) else a - b for a, b in zip(ema_fast, ema_slow)
    ]
    dea = _ema_series(dif, 2.0 / (_T_SIGNAL + 1))

    m5 = _meridian_dema_log(closes, _T_K_FAST)
    m61 = _meridian_dema_log(closes, _T_K_SLOW)
    raw: list[float | None] = [
        None if (a is None or b is None) else a - b for a, b in zip(m5, m61)
    ]

    # 量级标尺: 能量柱按 (DIF-DEA) 的平均绝对幅度校准 (同副图可比)
    abs_dh: list[float | None] = [
        None if (d is None or e is None) else abs(d - e) for d, e in zip(dif, dea)
    ]
    abs_raw: list[float | None] = [None if v is None else abs(v) for v in raw]
    ref = _sma_series(abs_dh, lookback)
    mag = _sma_series(abs_raw, lookback)

    hist: list[float | None] = []
    for r, m, rf in zip(raw, mag, ref):
        if r is None or m is None or rf is None:
            hist.append(None)
            continue
        scale = rf / max(m, 1e-5)
        hist.append(r * scale)
    return {"macd_plus_dif": dif, "macd_plus_dea": dea, "macd_plus_hist": hist}


def compute_rsi_plus(closes: list[float | None]) -> list[float | None]:
    """优化版RSI (泰坦 T5.0 f_optRsi, 归一化乖离振荡器)。

    输出 ±100 单值; RSI>0 ⟺ close>EMA26; 乖离创近 50 根新高时 = ±100。
    Pine 口径: highest 窗口不足 (na) 或 mx=0 → nz 后为 0 → RSI=0.0。
    """
    ma = _ema_series(closes, 2.0 / (_T_RSI_LEN + 1))
    diff: list[float | None] = [
        None if (c is None or m is None) else c - m for c, m in zip(closes, ma)
    ]
    abs_diff: list[float | None] = [None if v is None else abs(v) for v in diff]
    mx = _rolling_max_series(abs_diff, _T_RSI_MX_WIN)

    out: list[float | None] = []
    for d, m in zip(diff, mx):
        if d is None:
            out.append(None)
            continue
        if m is None or m == 0:
            out.append(0.0)  # Pine: nz(_mx) != 0 ? ... : 0.0
            continue
        out.append(d / m * 100.0)
    return out


def attach_plus_indicators(
    rows: list[dict[str, Any]],
    warmup_closes: list[float | None] | None = None,
) -> list[dict[str, Any]]:
    """对日K行序列附着 MACD+/RSI+ 字段 (原地写回并返回 rows)。

    kline API 输出前统一调用: enriched/live 两条路径与实时注入行均覆盖。
    rows 按时间升序; close 缺失行输出 None (前端按 '-' 渲染)。

    warmup_closes: 窗口之前的更早历史 close 序列 (升序) — EMA/DEMA 是递推
    指标, 只在返回窗口内递推会因 warmup 不足偏离全历史口径; 调用方 (kline.py)
    取窗口前 300 日历日历史前置递推, 覆盖 DEMA61 递推深度 + 量级标尺 50 窗口。
    """
    if not rows:
        return rows
    warmup = warmup_closes or []
    closes = [*warmup, *[r.get("close") for r in rows]]
    macd = compute_macd_plus(closes)
    rsi = compute_rsi_plus(closes)
    off = len(warmup)
    for i, r in enumerate(rows):
        j = off + i
        r["macd_plus_dif"] = macd["macd_plus_dif"][j]
        r["macd_plus_dea"] = macd["macd_plus_dea"][j]
        r["macd_plus_hist"] = macd["macd_plus_hist"][j]
        r["rsi_plus"] = rsi[j]
    return rows
