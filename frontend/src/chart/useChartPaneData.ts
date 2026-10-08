/**
 * 图表工作台 pane 数据 hook — 周期路由 + 指标装配。
 *
 * - 1d:   api.klineDaily (后端 enriched 指标字段透传; 工作台只用 MA/MACD/RSI)
 * - 1m~60m: api.klineMinuteRange 拉 1 分钟原始K (按 symbol+days 缓存, 多周期共用),
 *           flatten → resample(周期) → enrichChartIndicators (前端现场算指标)
 *
 * 实时性 (P3 一期):
 * - 分钟K: 盘中 15s 轮询 range 接口 (后端在请求时实时拉当日分钟合并), 末根 K 随行情更新;
 * - 日K:   不进轮询 (staleTime Infinity), 由全局 SSE quotes_updated 推送 + klineDailyLatest
 *          单行增量合并 (见 useQuoteStream 的 chart 窗格注册表), 末根实时价自动覆盖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type KlineRow, type MinuteKlineSession } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { chartMinuteRangeRefetchInterval } from '@/lib/kline'
import type { OHLC } from '@/components/EChartsCandlestick'
import { DEFAULT_PERIOD, MINUTE_FETCH_DAYS, periodDef, type Period } from './periods'
import { flattenSessions, resampleMinutes } from './minuteResample'
import { resampleDaily } from './dailyResample'
import { enrichChartIndicators } from './indicators'

/** 分钟K轮询间隔 (盘中 15s; 盘后后端返回不变数据, 成本低可接受, 后续可加停表)。 */
const MINUTE_REFRESH_MS = 15_000

/** 日K历史条数 (后端 daily 上限 2000, 取 500 ≈ 两年)。 */
const DAILY_FETCH_DAYS = 500

/** 「往左加载更多」每次向前扩取的交易日数 (与 DAILY_FETCH_DAYS 同量级, 视野连续)。 */
const EXTRA_HISTORY_DAYS = 500

/** 日K行合并去重 (按日期升序)。额外历史 (更早) 在前, 基础 (最近) 在后, 同日期保留最新一份。 */
export function mergeDailyRows(base: KlineRow[], extra: KlineRow[]): KlineRow[] {
  const map = new Map<string, KlineRow>()
  for (const r of extra) map.set(r.date, r)
  for (const r of base) map.set(r.date, r)
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 日期串加减 N 天 ("YYYY-MM-DD", 正=向后/负=向前)。 */
export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** KlineRow (日K) → OHLC: 后端 enriched 指标字段直接透传, 与个股分析页同源。
 * rsi_6/24 不在 KlineRow 显式字段里, 走索引签名取值。
 * (工作台只展示 MACD/RSI, kdj/boll/obv/cci 字段不再透传) */
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
    is_live: r.is_live === true,
  }
}

export interface ChartPaneData {
  data: OHLC[]
  name?: string
}

export function useChartPaneData(symbol: string, period: Period) {
  const def = periodDef(period)
  // 分钟级 (15m/60m/4h) 走 1 分钟K → resampleMinutes; 日级以上走日K → resampleDaily
  const isMinute = def.minutes !== undefined
  const dailyAgg = def.dailyAgg

  const daily = useQuery({
    enabled: !isMinute && !!symbol,
    queryKey: QK.chartKlineDaily(symbol, DAILY_FETCH_DAYS),
    queryFn: () => api.klineDaily(symbol, DAILY_FETCH_DAYS),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })

  // ── 「往左加载更多」: 日K路径额外历史区间 (更早数据, 每次向前翻 EXTRA_HISTORY_DAYS) ──
  // extraRanges 累积已请求区间 (query key 只对应最新区间, 历史区间数据靠累积 state 保留)
  const [extraRanges, setExtraRanges] = useState<{ start: string; end: string }[]>([])
  const lastRange = extraRanges.length > 0 ? extraRanges[extraRanges.length - 1] : null
  const extra = useQuery({
    enabled: !isMinute && !!symbol && !!lastRange,
    queryKey: QK.chartKlineDailyExtra(symbol, lastRange?.start ?? '', lastRange?.end ?? ''),
    queryFn: () => api.klineDaily(symbol, 0, { start: lastRange!.start, end: lastRange!.end }),
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

  const minute = useQuery({
    enabled: isMinute && !!symbol,
    queryKey: QK.chartMinuteRange(symbol, MINUTE_FETCH_DAYS),
    queryFn: () => api.klineMinuteRange(symbol, MINUTE_FETCH_DAYS),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    // P3 实时: 盘中 15s 重拉 (后端请求时实时合并当日最新分钟K → 末根随行情跳动);
    // 盘后/周末/节假日由停表函数自动停或降为 5 分钟心跳, 开盘后自动恢复实时
    refetchInterval: chartMinuteRangeRefetchInterval(MINUTE_REFRESH_MS),
  })

  const data = useMemo<OHLC[] | undefined>(() => {
    if (!isMinute) {
      if (mergedRows.length === 0 && !daily.isLoading) return []
      if (mergedRows.length === 0) return undefined
      // 1d 原生透传; 2d/4d/1w/1M 按交易日聚合后, 指标取桶内末值透传
      const mapped = mergedRows.map(mapDailyRow)
      const agged = dailyAgg ? resampleDaily(mapped, dailyAgg) : mapped
      return agged
    }
    const sessions = minute.data?.sessions as MinuteKlineSession[] | undefined
    if (!sessions) return undefined
    const flat = flattenSessions(sessions)
    if (flat.length === 0) return []
    const resampled = resampleMinutes(flat, def.minutes!)
    return enrichChartIndicators(resampled)
    // PERF(backlog B): 盘中轮询只有末根 K 变化, 此处却每 15s 全量
    // flatten(~4800 根 1 分K)→resample→7 类指标全序列重算 (O(n), 当前 ~几 ms)。
    // 触发线: 分钟K 放开到 60+ 天 (1 分K ~14400 根) 或 Profiler 实测 >50ms。
    // 优化思路: 缓存上次输入+输出, diff 定位变化起点只重算末段
    // (MA60 warm-up 往前 60 根即可); 需把 useMemo 引用比较改为自建可变缓冲。
    // 当前数据量无感知, 按渐进式原则等真实卡顿信号再动 (重构数据流有引入
    // 新 bug 的风险, 参见本轮修复的交互层闭包类问题)。
  }, [isMinute, daily.isLoading, mergedRows, dailyAgg, minute.data, def.minutes])

  // 能否继续加载: 日K路径 + 有数据 + 额外查询未进行中 (防止拖拽连续触发重复请求)
  const canLoadMore = !isMinute && mergedRows.length > 0 && !extra.isFetching
  const isLoadingMore = !isMinute && extra.isFetching

  /** 触发「往左加载更多」: 以当前最早日期为锚, 再向前拉 EXTRA_HISTORY_DAYS 天。 */
  const loadMore = useCallback(() => {
    if (isMinute) return
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
  }, [isMinute])

  return {
    data,
    name: !isMinute ? daily.data?.name : minute.data?.name,
    isLoading: !isMinute ? daily.isLoading : minute.isLoading,
    error: !isMinute ? daily.error : minute.error,
    loadMore,
    canLoadMore,
    isLoadingMore,
  }
}

export { DEFAULT_PERIOD }
