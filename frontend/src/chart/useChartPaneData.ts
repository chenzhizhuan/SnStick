/**
 * 图表工作台 pane 数据 hook — 周期路由 + 指标装配。
 *
 * 私有化收口 (2026-10-14): MACD+/RSI+ 全部由服务端计算 —
 * - 1d/2d/4d/1w/1M: api.klineDaily (后端 plus.py 附着 50 档, 指标字段透传)
 * - 15m/60m: api.klineIntraday (后端 intraday.py 聚合 + 附着, bars 含 plus 字段),
 *           前端现场只算公开指标 (MA/MACD/RSI 原版)
 * - 4h:      api.klineDaily?plus_lookback=160 (A股全天 240 分钟 = 每天 1 根 4h 桶,
 *           与日K行 OHLCV 等价; 独立缓存与 1d 的 50 档互不污染)
 *
 * 实时性:
 * - 15m/60m: 盘中 15s 轮询 intraday 接口 (本地分钟K按 ≥60s 轮次落盘);
 * - 日K/4h: 不进轮询 (staleTime Infinity), 由全局 SSE quotes_updated 推送 +
 *          klineDailyLatest 单行增量合并 (见 useQuoteStream 的 chart 窗格注册表),
 *          末根实时价自动覆盖 (4h 用 160 档 latest, 合并进 4h 专用缓存)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type KlineRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { chartMinuteRangeRefetchInterval } from '@/lib/kline'
import type { OHLC } from '@/components/EChartsCandlestick'
import { DEFAULT_PERIOD, periodDef, type Period } from './periods'
import type { ResampledBar } from './minuteResample'
import { resampleDaily } from './dailyResample'
import { enrichChartIndicators } from './indicators'

/** 分钟K轮询间隔 (盘中 15s; 盘后服务端返回不变数据, 成本低可接受, 后续可加停表)。 */
const MINUTE_REFRESH_MS = 15_000

/** 日K历史条数 (后端 daily 上限 2000, 取 500 ≈ 两年)。 */
const DAILY_FETCH_DAYS = 500

/** 4h 周期私有指标量级缩放窗口 (Pine 周期预设表 4h 档)。 */
const PLUS_LOOKBACK_4H = 160

/** 「往左加载更多」每次向前扩取的交易日数 (与 DAILY_FETCH_DAYS 同量级, 视野连续)。 */
const EXTRA_HISTORY_DAYS = 500

/** 日K行合并去重 (按日期升序)。额外历史 (更早) 在前, 基础 (最近) 在后, 同日期保留最新一份。 */
export function mergeDailyRows(base: KlineRow[], extra: KlineRow[]): KlineRow[] {
  const map = new Map<string, KlineRow>()
  for (const r of extra) map.set(r.date, r)
  for (const r of base) map.set(r.date, r)
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 4h 周期专用: 日K行 → 与分钟聚合等价的 240 分钟 bars。
 *  A 股全天交易 = 240 分钟 = 恰好 1 根 4h 桶, 日K行 OHLCV 与分钟聚合桶逐字段
 *  等价 (open=首根 open / close=末根 close / high·low=全天极值 / volume=全量和)。
 *  plus 指标由 /api/kline/daily?plus_lookback=160 服务端附着 (能量柱 SMA160
 *  窗口需 ≥160 根, 分钟源仅 60 根 4h bars 不够 — 见历史修复记录)。
 *  date 标签拼 " 09:30" 保持分钟周期标签格式 (跨周期字典序对齐不断)。 */
export function dailyRowsTo4hBars(rows: KlineRow[]): ResampledBar[] {
  return rows.map(r => ({
    date: `${r.date} 09:30`,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume ?? 0,
    amount: (r['amount'] as number | null | undefined) ?? null,
  }))
}

/** 日期串加减 N 天 ("YYYY-MM-DD", 正=向后/负=向前)。 */
export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** KlineRow (日K) → OHLC: 后端附着指标字段直接透传 (含私有 MACD+/RSI+)。
 * rsi_6/24 不在 KlineRow 显式字段里, 走索引签名取值。
 * (原版 MACD/RSI 按钮已从工作台移除, 字段保留供信号检测; kdj/boll/obv/cci 不再透传) */
function mapDailyRow(r: KlineRow): OHLC {
  return {
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    ma5: r.ma5 ?? null,
    ma10: r.ma10 ?? null,
    ma20: r.ma20 ?? null,
    ma60: r.ma60 ?? null,
    macd_dif: r.macd_dif ?? null,
    macd_dea: r.macd_dea ?? null,
    macd_hist: r.macd_hist ?? null,
    rsi_6: (r['rsi_6'] as number | null | undefined) ?? null,
    rsi_14: r.rsi_14 ?? null,
    rsi_24: (r['rsi_24'] as number | null | undefined) ?? null,
    // 私有化指标线路: 服务端 indicators/plus.py 附着 (4h 走 160 档)
    macd_plus_dif: (r['macd_plus_dif'] as number | null | undefined) ?? null,
    macd_plus_dea: (r['macd_plus_dea'] as number | null | undefined) ?? null,
    macd_plus_hist: (r['macd_plus_hist'] as number | null | undefined) ?? null,
    rsi_plus: (r['rsi_plus'] as number | null | undefined) ?? null,
    is_live: r.is_live === true,
  }
}

export interface ChartPaneData {
  data: OHLC[]
  name?: string
}

/** 日K源窗格的共享装配: 基础 + 额外历史合并 → 去重升序。
 *  基础 daily 查询与 extra 区间查询按 plusLookback 区分 (1d=默认/4h=160)。 */
function useDailySourced(symbol: string, enabled: boolean, plusLookback: number | undefined) {
  const daily = useQuery({
    enabled: enabled && !!symbol,
    queryKey: plusLookback
      ? QK.chartKlineDaily4h(symbol)
      : QK.chartKlineDaily(symbol, DAILY_FETCH_DAYS),
    queryFn: () => api.klineDaily(symbol, DAILY_FETCH_DAYS, undefined, undefined, plusLookback),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })

  // ── 「往左加载更多」: 日K路径额外历史区间 (更早数据, 每次向前翻 EXTRA_HISTORY_DAYS) ──
  // extraRanges 累积已请求区间 (query key 只对应最新区间, 历史区间数据靠累积 state 保留)
  const [extraRanges, setExtraRanges] = useState<{ start: string; end: string }[]>([])
  const lastRange = extraRanges.length > 0 ? extraRanges[extraRanges.length - 1] : null
  const extra = useQuery({
    enabled: enabled && !!symbol && !!lastRange,
    queryKey: plusLookback
      ? QK.chartKlineDaily4hExtra(symbol, lastRange?.start ?? '', lastRange?.end ?? '')
      : QK.chartKlineDailyExtra(symbol, lastRange?.start ?? '', lastRange?.end ?? ''),
    queryFn: () => api.klineDaily(symbol, 0, { start: lastRange!.start, end: lastRange!.end }, undefined, plusLookback),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })

  // 每次额外区间返回后累积进 state (mergeDailyRows 同时按日期去重)
  const [extraRowsState, setExtraRowsState] = useState<KlineRow[]>([])
  const prevExtraKeyRef = useRef<string>('')
  useEffect(() => {
    const key = lastRange ? `${lastRange.start}|${lastRange.end}` : ''
    const rows = extra.data?.rows
    if (!key || !rows || key === prevExtraKeyRef.current) return
    prevExtraKeyRef.current = key
    setExtraRowsState(prev => mergeDailyRows(prev, rows))
  }, [extra.data, lastRange])

  // 合并后的日K行 (基础 + 额外累积, 按日期升序去重); ref 供 loadMore 计算下一次区间
  const mergedRows = useMemo(
    () => mergeDailyRows(daily.data?.rows ?? [], extraRowsState),
    [daily.data, extraRowsState],
  )
  const mergedRowsRef = useRef(mergedRows)
  mergedRowsRef.current = mergedRows

  /** 触发「往左加载更多」: 以当前最早日期为锚, 再向前拉 EXTRA_HISTORY_DAYS 天。 */
  const loadMore = useCallback(() => {
    const rows = mergedRowsRef.current
    if (rows.length === 0) return
    const earliest = rows[0].date
    const endDate = shiftDate(earliest, -1)
    const startDate = shiftDate(endDate, -(EXTRA_HISTORY_DAYS - 1))
    setExtraRanges(prev => {
      // 已覆盖到该区间则跳过 (重复触发保护)
      if (prev.some(r => r.start <= startDate && r.end >= endDate)) return prev
      return [...prev, { start: startDate, end: endDate }]
    })
  }, [])

  return {
    mergedRows,
    isLoading: daily.isLoading,
    error: daily.error,
    name: daily.data?.name,
    canLoadMore: mergedRows.length > 0 && !extra.isFetching,
    isLoadingMore: extra.isFetching,
    loadMore,
  }
}

export function useChartPaneData(symbol: string, period: Period) {
  const def = periodDef(period)
  // 分钟级 (15m/60m) 走服务端聚合接口; 日级以上走日K; 4h (minutes=240) 走日K 160 档
  const isMinute = def.minutes === 15 || def.minutes === 60
  const is4h = def.minutes === 240
  const dailyAgg = def.dailyAgg
  const intradayPeriod = def.minutes === 15 ? '15m' : def.minutes === 60 ? '60m' : null

  // 日K源 (1d/2d/4d/1w/1M + 4h): 4h 用独立缓存 + 160 档私有指标
  const dailySourced = useDailySourced(symbol, !isMinute || is4h, is4h ? PLUS_LOOKBACK_4H : undefined)

  // 分钟聚合周期 (15m/60m): 服务端聚合 + 私有指标附着
  const intraday = useQuery({
    enabled: isMinute && !!symbol,
    queryKey: QK.chartIntraday(symbol, intradayPeriod ?? ''),
    queryFn: () => api.klineIntraday(symbol, intradayPeriod as '15m' | '60m'),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    // 盘中 15s 重拉 (服务端读本地分钟K, 末根随落库轮次更新);
    // 盘后/周末/节假日由停表函数自动停或降为 5 分钟心跳, 开盘后自动恢复实时
    refetchInterval: chartMinuteRangeRefetchInterval(MINUTE_REFRESH_MS),
  })

  const data = useMemo<OHLC[] | undefined>(() => {
    if (isMinute) {
      const bars = intraday.data?.bars
      if (!bars) return undefined
      if (bars.length === 0) return []
      // 公开指标 (MA/原版 MACD/RSI) 前端现场算; 私有 plus 字段透传
      return enrichChartIndicators(bars)
    }
    const rows = dailySourced.mergedRows
    if (rows.length === 0 && !dailySourced.isLoading) return []
    if (rows.length === 0) return undefined
    // 4h: 日K行 (160 档 plus 附着) → 240 分钟等价 bars (date 标签对齐分钟周期格式);
    // 指标字段全部透传 (4h 桶与日K行 OHLCV/口径一一等价), volume 兜底 0
    if (is4h) {
      const bars4h = dailyRowsTo4hBars(rows)
      const mapped = rows.map(mapDailyRow)
      return mapped.map((d, i) => ({ ...d, date: bars4h[i].date, volume: bars4h[i].volume }))
    }
    // 1d 原生透传; 2d/4d/1w/1M 按交易日聚合后, 指标取桶内末值透传
    const mapped = rows.map(mapDailyRow)
    const agged = dailyAgg ? resampleDaily(mapped, dailyAgg) : mapped
    return agged
  }, [isMinute, is4h, dailySourced.isLoading, dailySourced.mergedRows, dailyAgg, intraday.data])

  return {
    data,
    name: isMinute ? intraday.data?.name : dailySourced.name,
    isLoading: isMinute ? intraday.isLoading : dailySourced.isLoading,
    error: isMinute ? intraday.error : dailySourced.error,
    loadMore: dailySourced.loadMore,
    canLoadMore: isMinute ? false : dailySourced.canLoadMore,
    isLoadingMore: isMinute ? false : dailySourced.isLoadingMore,
  }
}

export { DEFAULT_PERIOD }
