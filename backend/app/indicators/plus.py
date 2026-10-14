"""私有化指标模块 (MACD+ / RSI+) — 前后端独立线路的后端部分。

设计意图 (私有化克隆):
- 原版 MACD/RSI 计算在 indicators/pipeline.py (polars, 落盘 enriched parquet),
  本模块是**完全独立**的私有克隆, 不改原版任何一行 —— 原版线路与数据不受影响。
- 输出字段: macd_plus_dif / macd_plus_dea / macd_plus_hist 与
  rsi_plus_6 / rsi_plus_14 / rsi_plus_24 (与原版字段平行, 前端副图独立渲染)。
- API 层附着 (kline.py get_daily / get_daily_latest): 不进 enriched 同步管线、
  不落盘 —— 历史数据无需回补, 私有算法升级后立即生效于全部历史。

┌─ 后续算法替换点 ─────────────────────────────────────────────┐
│ 只改 compute_macd_plus / compute_rsi_plus 两个函数体,        │
│ 保持函数签名与输出字段名不变, kline API 自动携带新算法结果。  │
│ (若算法口径变化, 前端分钟级克隆 chart/indicators.ts 的        │
│  computeMACDPlus / computeRSIPlus 需同步同口径)               │
└──────────────────────────────────────────────────────────────┘

当前算法 = 原版克隆 (口径与 indicators/pipeline.py 逐式一致):
- MACD: EMA(12), EMA(26) → DIF = EMA12-EMA26; DEA = EMA9(DIF); HIST = 2×(DIF-DEA)
        EMA 递推: prev + α×(x-prev), α=2/(n+1), 首值起步 (adjust=False 同义)
- RSI:  Wilder RMA (α=1/n) on gain/loss; 首行 delta 置 0;
        avgLoss=0 → 1e-12 兜底; RSI = 100 - 100/(1 + avgGain/avgLoss)
"""
from __future__ import annotations

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
RSI_PLUS_FIELDS = ("rsi_plus_6", "rsi_plus_14", "rsi_plus_24")
PLUS_FIELDS = MACD_PLUS_FIELDS + RSI_PLUS_FIELDS

_RSI_PLUS_WINDOWS = (6, 14, 24)


def _ema_series(values: list[float | None], alpha: float) -> list[float | None]:
    """EMA 递推 (首值起步): prev + α×(x-prev); None 输入中断递推 (后续输出 None)。

    与 polars ewm_mean(alpha, adjust=False) 同口径; 与前端 chart/indicators.ts
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


def compute_macd_plus(closes: list[float | None]) -> dict[str, list[float | None]]:
    """MACD+ 私有计算 — ★ 后续私有算法替换点 (当前为原版克隆)。

    输入: 收盘价序列 (升序时间; None 跳过并中断递推)。
    输出: {macd_plus_dif, macd_plus_dea, macd_plus_hist} 三个等长序列。
    """
    ema12 = _ema_series(closes, 2.0 / (12 + 1))
    ema26 = _ema_series(closes, 2.0 / (26 + 1))
    dif: list[float | None] = [
        None if (a is None or b is None) else a - b for a, b in zip(ema12, ema26)
    ]
    dea = _ema_series(dif, 2.0 / (9 + 1))
    hist: list[float | None] = [
        None if (d is None or e is None) else 2.0 * (d - e) for d, e in zip(dif, dea)
    ]
    return {"macd_plus_dif": dif, "macd_plus_dea": dea, "macd_plus_hist": hist}


def compute_rsi_plus(closes: list[float | None], n: int) -> list[float | None]:
    """RSI+ 私有计算 (Wilder) — ★ 后续私有算法替换点 (当前为原版克隆)。

    输入: 收盘价序列与窗口 n; 输出等长 RSI 序列。
    首行 delta 置 0 (与后端 polars `_gain/_loss` otherwise 0 口径一致)。
    """
    alpha = 1.0 / n
    gains: list[float | None] = [0.0]
    losses: list[float | None] = [0.0]
    for i in range(1, len(closes)):
        prev, cur = closes[i - 1], closes[i]
        if prev is None or cur is None:
            gains.append(None)
            losses.append(None)
            continue
        delta = cur - prev
        gains.append(delta if delta > 0 else 0.0)
        losses.append(-delta if delta < 0 else 0.0)
    avg_gain = _ema_series(gains, alpha)
    avg_loss = _ema_series(losses, alpha)
    out: list[float | None] = []
    for i in range(len(closes)):
        g, l = avg_gain[i], avg_loss[i]
        if g is None or l is None:
            out.append(None)
            continue
        out.append(100.0 - 100.0 / (1.0 + g / (l if l != 0 else 1e-12)))
    return out


def attach_plus_indicators(
    rows: list[dict[str, Any]],
    warmup_closes: list[float | None] | None = None,
) -> list[dict[str, Any]]:
    """对日K行序列附着 MACD+/RSI+ 字段 (原地写回并返回 rows)。

    kline API 输出前统一调用: enriched/live 两条路径与实时注入行均覆盖。
    rows 按时间升序; close 缺失行输出 None (前端按 '-' 渲染)。

    warmup_closes: 窗口之前的更早历史 close 序列 (升序) — EMA/RMA 是递推指标,
    只在返回窗口内递推会因 warmup 不足偏离全历史口径 (原版 enriched 落盘值);
    调用方 (kline.py) 取窗口前 250 日历日历史前置递推, 与原版对齐。
    """
    if not rows:
        return rows
    warmup = warmup_closes or []
    closes = [*warmup, *[r.get("close") for r in rows]]
    macd = compute_macd_plus(closes)
    rsi = {n: compute_rsi_plus(closes, n) for n in _RSI_PLUS_WINDOWS}
    off = len(warmup)
    for i, r in enumerate(rows):
        j = off + i
        r["macd_plus_dif"] = macd["macd_plus_dif"][j]
        r["macd_plus_dea"] = macd["macd_plus_dea"][j]
        r["macd_plus_hist"] = macd["macd_plus_hist"][j]
        for n in _RSI_PLUS_WINDOWS:
            r[f"rsi_plus_{n}"] = rsi[n][j]
    return rows
