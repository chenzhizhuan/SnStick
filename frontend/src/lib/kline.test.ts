/**
 * 图表工作台分钟轮询停表 — chartMinuteRangeRefetchInterval (minute-range/sessions
 * 结构) 与 chartIntradayRefetchInterval (intraday 聚合/bars 结构) 分支单测,
 * 及 mergeLiveIntoIntraday 分钟末根 SSE 实时叠加单测。
 *
 * cnToday/cnNowHHMM 按 Asia/Shanghai 取北京墙钟, 用例一律以 UTC 瞬间 setSystemTime
 * 换算到目标北京时刻, 避免测试机时区影响。
 * 参照日期: 2026-09-30 为周三, 2026-10-03 为周六。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chartIntradayRefetchInterval, chartMinuteRangeRefetchInterval, mergeLiveIntoIntraday } from './kline'
import type { IntradayPlusBar, KlineDailyLatestResponse, KlineIntradayResponse } from './api'

const MS = 15_000
const HEARTBEAT = 300_000

/** 构造 minute-range 响应的 query state mock (sessions 尾部为最新交易日)。 */
function rangeQuery(source: 'local' | 'none', sessions: { date: string; rows: { datetime: string }[] }[]) {
  return { state: { data: { source, sessions } } }
}

/** 北京时刻 → setSystemTime 的 UTC 瞬间。 */
function beijing(utc: string) {
  vi.setSystemTime(new Date(utc))
}

describe('chartMinuteRangeRefetchInterval 停表', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('数据未加载 → 按正常间隔轮询', () => {
    beijing('2026-09-30T02:30:00Z') // 周三 10:30 盘中
    const fn = chartMinuteRangeRefetchInterval(MS)
    expect(fn({ state: { data: undefined } })).toBe(MS)
  })

  it('source=none → 停', () => {
    beijing('2026-09-30T02:30:00Z')
    const fn = chartMinuteRangeRefetchInterval(MS)
    expect(fn(rangeQuery('none', []))).toBe(false)
  })

  it('sessions 为空 → 停 (无数据可轮询)', () => {
    beijing('2026-09-30T02:30:00Z')
    const fn = chartMinuteRangeRefetchInterval(MS)
    expect(fn(rangeQuery('local', []))).toBe(false)
  })

  it('周三盘中 + 当日数据无收盘根 → 正常 15s 轮询', () => {
    beijing('2026-09-30T02:30:00Z') // 周三 10:30
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-09-30', rows: [{ datetime: '2026-09-30 10:29:00' }] }])
    expect(fn(q)).toBe(MS)
  })

  it('周三盘后 + 当日收盘根已现且过 15:30 → 停 (当日定版)', () => {
    beijing('2026-09-30T08:00:00Z') // 周三 16:00
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-09-30', rows: [{ datetime: '2026-09-30 14:59:00' }] }])
    expect(fn(q)).toBe(false)
  })

  it('周三盘后但收盘根缺失 (数据源延迟) → 保守继续轮询', () => {
    beijing('2026-09-30T08:00:00Z') // 周三 16:00
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-09-30', rows: [{ datetime: '2026-09-30 14:58:00' }] }])
    expect(fn(q)).toBe(MS)
  })

  it('周三收盘前 (15:30 之前) 收盘根已现 → 仍轮询 (盘后成交窗口量可能更新)', () => {
    beijing('2026-09-30T07:10:00Z') // 周三 15:10
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-09-30', rows: [{ datetime: '2026-09-30 14:59:00' }] }])
    expect(fn(q)).toBe(MS)
  })

  it('周六盘中 + 最新 session 为周五 → 停 (确定非交易日)', () => {
    beijing('2026-10-03T02:00:00Z') // 周六 10:00
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-10-02', rows: [{ datetime: '2026-10-02 15:00:00' }] }])
    expect(fn(q)).toBe(false)
  })

  it('周三凌晨盘前 + 最新 session 为昨日 → 5 分钟心跳等开盘', () => {
    beijing('2026-09-29T20:00:00Z') // 北京 2026-09-30 周三 04:00
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-09-29', rows: [{ datetime: '2026-09-29 15:00:00' }] }])
    expect(fn(q)).toBe(HEARTBEAT)
  })

  it('周三尾盘后无当日数据 (节假日) → 5 分钟心跳探测', () => {
    beijing('2026-09-30T09:00:00Z') // 周三 17:00
    const fn = chartMinuteRangeRefetchInterval(MS)
    const q = rangeQuery('local', [{ date: '2026-09-29', rows: [{ datetime: '2026-09-29 15:00:00' }] }])
    expect(fn(q)).toBe(HEARTBEAT)
  })
})

describe('chartIntradayRefetchInterval 停表 (intraday 聚合响应 bars 结构)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 构造 intraday 聚合响应的 query state mock (api.klineIntraday: {bars, source})。 */
  function intradayQuery(source: 'local' | 'none', bars: { date: string }[]) {
    return { state: { data: { source, bars } } }
  }

  it('数据未加载 → 按正常间隔轮询', () => {
    beijing('2026-09-30T02:30:00Z') // 周三 10:30 盘中
    const fn = chartIntradayRefetchInterval(MS)
    expect(fn({ state: { data: undefined } })).toBe(MS)
  })

  it('source=none → 停', () => {
    beijing('2026-09-30T02:30:00Z')
    const fn = chartIntradayRefetchInterval(MS)
    expect(fn(intradayQuery('none', []))).toBe(false)
  })

  it('bars 为空 → 停 (无数据可轮询)', () => {
    beijing('2026-09-30T02:30:00Z')
    const fn = chartIntradayRefetchInterval(MS)
    expect(fn(intradayQuery('local', []))).toBe(false)
  })

  it('回归: 盘中 + intraday 响应 (无 sessions 字段) → 正常 15s 轮询 (旧错配 bug 此处停表)', () => {
    // 旧 bug: useChartPaneData 曾用 chartMinuteRangeRefetchInterval (读 sessions,
    // intraday 响应恒无) → lastSession=null → false 永久停表, 分钟窗格现价线
    // 停在页面加载时刻, 与 SSE 实时窗格分屏现价分叉。
    beijing('2026-09-30T02:30:00Z') // 周三 10:30 盘中
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-09-30 09:30' }, { date: '2026-09-30 10:30' }])
    const legacyFn = chartMinuteRangeRefetchInterval(MS)
    expect(fn(q)).toBe(MS)
    expect(legacyFn(q)).toBe(false) // 旧函数在此响应结构上确会错停 (对照固化)
  })

  it('周三盘中 + 当前小时根 (60m 当前 bar) → 正常轮询', () => {
    beijing('2026-10-15T02:30:00Z') // 周四 10:30 盘中
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-10-15 09:30' }])
    expect(fn(q)).toBe(MS)
  })

  it('周三盘后 + 当日收盘根 (60m 14:00) 已现且过 15:30 → 停 (当日定版)', () => {
    beijing('2026-09-30T08:00:00Z') // 周三 16:00
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-09-30 14:00' }])
    expect(fn(q)).toBe(false)
  })

  it('周三盘后 + 15m 收盘根 (14:45) 已现且过 15:30 → 停', () => {
    beijing('2026-09-30T08:00:00Z') // 周三 16:00
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-09-30 14:45' }])
    expect(fn(q)).toBe(false)
  })

  it('周三盘后但收盘根缺失 (数据源延迟, 最后根 13:00) → 保守继续轮询', () => {
    beijing('2026-09-30T08:00:00Z') // 周三 16:00
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-09-30 13:00' }])
    expect(fn(q)).toBe(MS)
  })

  it('周三收盘前 (15:30 之前) 收盘根已现 → 仍轮询 (盘后成交窗口量可能更新)', () => {
    beijing('2026-09-30T07:10:00Z') // 周三 15:10
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-09-30 14:00' }])
    expect(fn(q)).toBe(MS)
  })

  it('周六盘中 + 最后 bar 为昨日 (周五) → 停 (确定非交易日)', () => {
    beijing('2026-10-03T02:00:00Z') // 周六 10:00
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-10-02 14:00' }])
    expect(fn(q)).toBe(false)
  })

  it('周三凌晨盘前 + 最后 bar 为昨日 → 5 分钟心跳等开盘', () => {
    beijing('2026-09-29T20:00:00Z') // 北京 2026-09-30 周三 04:00
    const fn = chartIntradayRefetchInterval(MS)
    const q = intradayQuery('local', [{ date: '2026-09-29 14:00' }])
    expect(fn(q)).toBe(HEARTBEAT)
  })
})

describe('mergeLiveIntoIntraday 分钟末根实时叠加', () => {
  /** 构造 intraday 聚合 bar (在走的那根)。 */
  const bar = (over: Partial<IntradayPlusBar> = {}): IntradayPlusBar => ({
    date: '2026-10-15 10:30', open: 1300, high: 1310, low: 1295, close: 1305,
    volume: 1000, amount: null, macd_plus_dif: null, macd_plus_dea: null,
    macd_plus_hist: null, rsi_plus: null, ...over,
  })
  /** 构造 intraday 聚合响应。 */
  const resp = (bars: IntradayPlusBar[], symbol = '600519.SH') =>
    ({ symbol, name: '贵州茅台', asset_type: 'stock', period: '60m', requested_days: 60, bars, source: 'local' }) as KlineIntradayResponse
  /** 构造 klineDailyLatest 实时行响应。 */
  const latest = (close: number, date = '2026-10-15', symbol = '600519.SH') =>
    ({ symbol, row: { date, close } }) as unknown as KlineDailyLatestResponse

  it('同日末根: close 覆盖, high/low 吸收极值 (live 高于 high)', () => {
    const cur = resp([bar(), bar({ date: '2026-10-15 11:30' })])
    const out = mergeLiveIntoIntraday(cur, latest(1315))
    expect(out).not.toBe(cur)
    const last = out!.bars.at(-1)!
    expect(last.close).toBe(1315)
    expect(last.high).toBe(1315)
    expect(last.low).toBe(1295)
    // 前一根不动
    expect(out!.bars[0].close).toBe(1305)
  })

  it('live 低于 low: low 吸收下极值', () => {
    const cur = resp([bar()])
    const out = mergeLiveIntoIntraday(cur, latest(1290))
    const last = out!.bars.at(-1)!
    expect(last.close).toBe(1290)
    expect(last.low).toBe(1290)
    expect(last.high).toBe(1310)
  })

  it('live 在 high/low 区间内: high/low 不变', () => {
    const cur = resp([bar()])
    const out = mergeLiveIntoIntraday(cur, latest(1301))
    const last = out!.bars.at(-1)!
    expect(last.close).toBe(1301)
    expect(last.high).toBe(1310)
    expect(last.low).toBe(1295)
  })

  it('末根日期 ≠ 实时行日期 (盘前/隔夜分钟数据未到今日) → 原样返回', () => {
    const cur = resp([bar({ date: '2026-10-14 14:00', close: 1286 })])
    expect(mergeLiveIntoIntraday(cur, latest(1300))).toBe(cur)
  })

  it('latest.row 缺失 / symbol 不匹配 / 无 bars / 无效 close → 原样返回', () => {
    const cur = resp([bar()])
    const empty = resp([])
    expect(mergeLiveIntoIntraday(cur, { symbol: '600519.SH', row: null } as unknown as KlineDailyLatestResponse)).toBe(cur)
    expect(mergeLiveIntoIntraday(cur, latest(1300, '2026-10-15', '000001.SZ'))).toBe(cur)
    expect(mergeLiveIntoIntraday(empty, latest(1300))).toBe(empty)
    expect(mergeLiveIntoIntraday(undefined, latest(1300))).toBeUndefined()
    expect(mergeLiveIntoIntraday(cur, latest(Number.NaN))).toBe(cur)
  })

  it('不可变: 合并不修改输入响应', () => {
    const cur = resp([bar()])
    mergeLiveIntoIntraday(cur, latest(1315))
    expect(cur.bars.at(-1)!.close).toBe(1305)
    expect(cur.bars.at(-1)!.high).toBe(1310)
  })

  it('volume/私有指标字段不被实时行覆盖 (由 15s 轮询权威回填)', () => {
    const cur = resp([bar({ volume: 4321, rsi_plus: 55.7 })])
    const out = mergeLiveIntoIntraday(cur, latest(1301))
    const last = out!.bars.at(-1)!
    expect(last.volume).toBe(4321)
    expect(last.rsi_plus).toBe(55.7)
  })
})
