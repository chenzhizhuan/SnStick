/**
 * 日K查询配置 — klineDaily 的唯一权威 options。
 *
 * StockDailyKChart(图表) 与 StockPanel(信息条) 各自 useQuery 共享同一 cache key,
 * React Query 按 key 去重只发一次请求; 邻近预取 prefetchQuery 也复用本配置, 三处不会漂移。
 *
 * placeholderData 内置"仅同 symbol 占位"守卫: 改日期范围/扩展字段时旧数据可暂显(不闪),
 * 切股时不透传上一只股票的数据(不误显示)。
 */
import { api, type KlineDailyLatestResponse, type KlineDailyResponse } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

/** 分时 tab 多日分时默认周期 (StockPanel 预取与弹窗存储回退共用, 避免魔数两处漂移) */
export const DEFAULT_INTRADAY_DAYS = 10

export function klineDailyQueryOptions(
  symbol: string,
  dateRange: { start: string; end: string },
  extColumns?: string,
) {
  return {
    queryKey: QK.kline(symbol, dateRange.start, dateRange.end, extColumns),
    queryFn: () => api.klineDaily(symbol, undefined, dateRange, extColumns),
    // 工厂无 TData 泛型, 参数用 any 以便 useQuery/prefetchQuery 共用
    placeholderData: (prev: any, prevQuery: any) => {
      const prevKey = prevQuery?.queryKey as readonly unknown[] | undefined
      return prevKey?.[1] === symbol ? prev : undefined
    },
  }
}

export function klineDailyLatestQueryOptions(symbol: string) {
  return {
    queryKey: QK.klineLatest(symbol),
    queryFn: () => api.klineDailyLatest(symbol),
  }
}

export function mergeLatestKlineRow(
  current: KlineDailyResponse | undefined,
  latest: KlineDailyLatestResponse,
): KlineDailyResponse | undefined {
  if (!current || !latest.row || current.symbol !== latest.symbol) return current

  const latestDate = String(latest.row.date).slice(0, 10)
  const last = current.rows.at(-1)
  if (!last) return { ...current, rows: [{ ...latest.row, date: latestDate }] }

  const lastDate = String(last.date).slice(0, 10)
  if (latestDate < lastDate) return current
  if (latestDate === lastDate) {
    return {
      ...current,
      rows: [...current.rows.slice(0, -1), { ...last, ...latest.row, date: latestDate }],
    }
  }
  return { ...current, rows: [...current.rows, { ...latest.row, date: latestDate }] }
}

/**
 * 单日分时查询配置 — 与 klineDailyQueryOptions 同风格的单源 options (date 为空 = 最新日内)。
 *
 * live 仅当日盘中生效: 传 true 时后端实时拉取最新K, 不被分钟增量落盘(≥60s 一轮)拖慢;
 * 历史日期后端自行忽略 live, 故多日图与预取恒传 true 亦不影响历史读取。
 */
export function klineMinuteQueryOptions(symbol: string, date?: string, live?: boolean) {
  return {
    queryKey: QK.klineMinute(symbol, date ?? ''),
    queryFn: () => api.klineMinute(symbol, date ?? undefined, live),
  }
}

/** 收盘分钟标签: 连续竞价全天最后一根分钟K的时间 (开始时刻语义 — 15:00 bar 覆盖
 * [14:59,15:00), 前端已统一把源"结束时刻"标签换算为"开始时刻", 见 minuteSemantics.ts)。 */
const CLOSE_MINUTE = '14:59'

/** 全天真正定版时刻: 15:00 收盘后仍可按收盘价成交 (盘后固定价) 至 15:30,
 * 其间成交量/额仍可能变化 —— 与后端 quote_service 定版重试窗口终点
 * (15:30) 同口径; 盘后管道默认 15:35 在此之后启动。 */
const MARKET_ALL_OVER = '15:30'

/** 北京时间今日 YYYY-MM-DD (与后端 cn_today 同口径; 不用 UTC toISOString, 避免傍晚错日)。 */
function cnToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

/** 北京时间此刻 'HH:MM'。 */
function cnNowHHMM(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
}

/** 行 datetime ('YYYY-MM-DD HH:MM:SS' 北京墙钟契约) → 'HH:MM'; 非常规格式返回 ''。 */
function rowMinute(r: { datetime?: string } | undefined): string {
  const s = String(r?.datetime ?? '')
  return s.length >= 16 ? s.slice(11, 16) : ''
}

/**
 * 分时轮询停表 — 数据不可变时停止, 消除无效请求 (周末/盘后/翻看历史日期)。
 *
 * - 未传间隔 → 不轮询 (调用方默认关闭)
 * - 无数据 (source=none) → 停
 * - 响应日期 < 北京今天 → 停: 历史日的本地分钟K不可变 (周末"最新"会被
 *   后端回退到上一交易日, 同样命中此规则)
 * - 当日: 收盘根 (≥14:59 的K) 已出现 **且** 已过 15:30 → 停。
 *   完整性**只认收盘根, 不按根数** —— 实测本系统全天 240 根 (首根 09:30
 *   竞价+首分钟合并根 + 14:59 收盘根, 换算后语义), 按根数阈值会在第 239 根 (14:58)
 *   到位时误停, 恰好错过 14:59 收盘根; 收盘根判据还天然兼容盘中缺根与部分交易日。
 *   而 14:59 收盘根出现后**不能立即停**: 盘后按收盘价成交可持续到 15:30,
 *   其间量/额仍可能更新 (数据源分钟K止于 15:00 结束时刻根, 换算后为 14:59, 此窗口为防御性保留,
 *   与后端"15:30 才允许定版/重建"的边界一致)。
 * - 其余 (当日 15:30 前) → 按间隔继续
 */
export function minuteRefetchInterval(ms?: number) {
  return (query: any): number | false => {
    if (ms == null) return false
    const d = query.state.data
    if (!d) return ms
    if (d.source === 'none') return false
    if (typeof d.date === 'string' && d.date < cnToday()) return false
    const closeBarArrived = (d.rows ?? []).some((r: { datetime?: string }) => rowMinute(r) >= CLOSE_MINUTE)
    if (closeBarArrived && cnNowHHMM() >= MARKET_ALL_OVER) return false
    return ms
  }
}

/** 多日分时查询配置 — 分时 tab 的 StockMultiDayIntradayChart 与 邻近预取 共用。
 * 内嵌「仅同 symbol 占位」守卫 (key 结构 ['kline-minute-range', symbol, days], index 1 为 symbol),
 * 与 klineDailyQueryOptions 同源, 调用点不再各自手写。 */
export function klineMinuteRangeQueryOptions(symbol: string, days: number) {
  return {
    queryKey: QK.klineMinuteRange(symbol, days),
    queryFn: () => api.klineMinuteRange(symbol, days),
    placeholderData: (prev: any, prevQuery: any) => {
      const prevKey = prevQuery?.queryKey as readonly unknown[] | undefined
      return prevKey?.[1] === symbol ? prev : undefined
    },
  }
}

// ===== 图表工作台分钟 range 轮询停表 (P3 实时优化) =====
// 与 minuteRefetchInterval 同口径的"数据不可变即停", 适配 minute-range 响应结构
// (sessions 多日数组)。停表后跨开盘的唤醒由低频心跳兜底 (周中盘前 5 分钟一跳)。

/** 北京时间星期几 (0=周日..6=周六)。cnToday 已是北京墙钟日期, 直接按 UTC 日历日解析
 * 取星期 — 纯日历运算, 不涉时区偏移 (用 +08:00 解析再 getUTCDay 会退到 UTC 日出错)。 */
function cnDayOfWeek(): number {
  return new Date(`${cnToday()}T00:00:00Z`).getUTCDay()
}

/** 盘前/节假日心跳间隔: 停表场景中仍保留低频探测, 开盘后 5 分钟内自动恢复实时。 */
const IDLE_POLL_MS = 300_000

/**
 * 图表工作台分钟 range 轮询停表 — 数据不可变时停或降频, 消除无效请求:
 *
 * - source=none → 停 (无数据源)
 * - 最新 session 日期 < 北京今天 (数据不含当日):
 *   - 周六/周日 → 停 (确定非交易日)
 *   - 周中 → 5 分钟心跳 (盘前等开盘 / 节假日探测, 开盘后自动恢复 15s 实时)
 * - 最新 session 日期 = 今天:
 *   - 收盘根(≥14:59)已出现且已过 15:30 → 停 (当日完整定版)
 *   - 其余 (盘中/午休/收盘前) → 按 ms 正常轮询
 */
export function chartMinuteRangeRefetchInterval(ms: number) {
  return (query: any): number | false => {
    const d = query.state.data
    if (!d) return ms
    if (d.source === 'none') return false
    const sessions = (d.sessions ?? []) as { date?: string; rows?: { datetime?: string }[] }[]
    const lastSession = sessions[sessions.length - 1]
    if (!lastSession) return false
    const sessionDate = String(lastSession.date ?? '').slice(0, 10)
    const today = cnToday()
    const now = cnNowHHMM()
    if (sessionDate < today) {
      if ([0, 6].includes(cnDayOfWeek())) return false
      return IDLE_POLL_MS
    }
    const closeBarArrived = (lastSession.rows ?? []).some(r => rowMinute(r) >= CLOSE_MINUTE)
    if (closeBarArrived && now >= MARKET_ALL_OVER) return false
    return ms
  }
}
