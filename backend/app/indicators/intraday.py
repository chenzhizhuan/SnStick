"""分钟K聚合 + 私有指标附着 (图表工作台 15m/60m 周期的服务端线路)。

2026-10-14 私有化收口: MACD+/RSI+ 算法从前端 (chart/indicators.ts 已删除)
全部收归服务端 — 前端 bundle 不再携带任何泰坦算法特征。

聚合口径与迁移前的前端实现 (minuteSemantics.ts + minuteResample.ts) 逐字段一致:
  1. 时间语义换算: 数据源"结束时刻"标签 → "开始时刻"
     (09:31..11:30 / 13:01..15:00 各 -1 分钟; 09:30 竞价根保留;
      换算后同标签合并 — open 取首根, close 取末根, high/low 极值, 量额相加);
  2. 切桶: 桶边界 = 交易日 × 交易时段 (09:30-11:30 / 13:00-15:00),
     不跨午休、不跨日; 桶序号 = floor((bar 时刻 - 时段开盘) / period);
  3. OHLCV: open=首根 open (缺失降级首根 close), close=末根 close,
     high/low=桶内极值, volume/amount=桶内求和
     (amount 缺失语义: 任一非空取非空, 全空为 None);
  4. date 标签 = 桶内首根时间 "YYYY-MM-DD HH:mm" (跨周期字典序对齐约定)。

私有指标附着: lookback 周期预设 (Pine util_getPresetLookback 分钟档):
  15m→200, 60m→160; 无 warmup — 与迁移前前端口径一致 (60 日聚合 bars 内
  递推, EMA26/DEMA61 收敛深度 << 数据量)。算法本体见 plus.py。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from .plus import attach_plus_indicators

__all__ = [
    "INTRADAY_PERIODS",
    "to_minute_start_semantics",
    "resample_minutes",
    "attach_intraday_plus",
]

# 支持的聚合周期 (分钟) → 泰坦量级缩放 lookback (Pine 周期预设表分钟档)
INTRADAY_PERIODS: dict[int, int] = {15: 200, 60: 160}

_SESSION_OPEN_MORNING = 570   # 09:30
_SESSION_OPEN_AFTERNOON = 780  # 13:00


def _is_shiftable(hh: int, mm: int) -> bool:
    """该分钟标签是否属于可换算域 [09:31,11:30] ∪ [13:01,15:00] (结束时刻语义)。"""
    if hh == 9:
        return mm >= 31
    if hh == 10:
        return True
    if hh == 11:
        return mm <= 30
    if hh == 13:
        return mm >= 1
    if hh == 14:
        return True
    if hh == 15:
        return mm == 0
    return False


def to_minute_start_semantics(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """结束时刻 → 开始时刻 (+ 竞价根合并)。输入按 datetime 升序。

    逐式复刻前端 minuteSemantics.toMinuteStartSemanticsRows:
    非换算域标签 (12:xx 午休 / 15:30 盘后等异常) 原样透传不换算。
    """
    out: list[dict[str, Any]] = []
    for r in rows:
        dt = r.get("datetime")
        if not isinstance(dt, datetime):
            out.append(dict(r))
            continue
        hh, mm = dt.hour, dt.minute
        if _is_shiftable(hh, mm):
            mm -= 1
            if mm < 0:
                mm = 59
                hh -= 1
        merged = dict(r)
        merged["datetime"] = dt.replace(hour=hh, minute=mm)
        last = out[-1] if out else None
        if last is not None and last.get("datetime") == merged["datetime"]:
            # 同标签合并 (竞价根 09:30 + 首分钟根 09:31→09:30):
            # open 取首根 (缺失逐级回退), close 取末根, high/low 极值, 量额相加
            open_px = last.get("open")
            if open_px is None:
                open_px = merged.get("open")
            if open_px is None:
                open_px = merged.get("close")
            merged["open"] = open_px
            merged["high"] = max(last["high"], merged["high"])
            merged["low"] = min(last["low"], merged["low"])
            merged["volume"] = (last.get("volume") or 0) + (merged.get("volume") or 0)
            la = last.get("amount")
            ra = merged.get("amount")
            merged["amount"] = la + ra if (la is not None and ra is not None) else (la if la is not None else ra)
            out[-1] = merged
        else:
            out.append(merged)
    return out


def resample_minutes(rows: list[dict[str, Any]], period: int) -> list[dict[str, Any]]:
    """A 股时段切桶聚合。输入升序 (已换算为开始时刻语义); period ∈ {15, 60}。

    复刻前端 minuteResample.resampleMinutes: 桶 key = (交易日, 时段, 桶序号)。
    """
    out: list[dict[str, Any]] = []
    cur_key: tuple | None = None
    cur: dict[str, Any] | None = None
    for r in rows:
        dt = r["datetime"]
        if not isinstance(dt, datetime):
            continue
        t = dt.hour * 60 + dt.minute
        if t >= _SESSION_OPEN_AFTERNOON:
            s_idx, session_open = 1, _SESSION_OPEN_AFTERNOON
        else:
            s_idx, session_open = 0, _SESSION_OPEN_MORNING
        bucket = (t - session_open) // period
        key = (dt.date(), s_idx, bucket)
        if cur is None or key != cur_key:
            if cur is not None:
                out.append(cur)
            open_px = r.get("open")
            if open_px is None:
                open_px = r.get("close")
            cur = {
                "date": dt.strftime("%Y-%m-%d %H:%M"),
                "open": open_px,
                "high": r["high"],
                "low": r["low"],
                "close": r["close"],
                "volume": r.get("volume") or 0,
                "amount": r.get("amount"),
            }
            cur_key = key
        else:
            cur["high"] = max(cur["high"], r["high"])
            cur["low"] = min(cur["low"], r["low"])
            cur["close"] = r["close"]
            cur["volume"] += r.get("volume") or 0
            ca = cur.get("amount")
            ra = r.get("amount")
            cur["amount"] = ca + ra if (ca is not None and ra is not None) else (ca if ca is not None else ra)
    if cur is not None:
        out.append(cur)
    return out


def attach_intraday_plus(bars: list[dict[str, Any]], period: int) -> list[dict[str, Any]]:
    """对聚合 bars 附着 MACD+/RSI+ (原地写回并返回)。period ∈ {15, 60}。"""
    lookback = INTRADAY_PERIODS.get(period)
    if lookback is None:
        raise ValueError(f"unsupported intraday period: {period}")
    attach_plus_indicators(bars, warmup_closes=None, lookback=lookback)
    return bars
