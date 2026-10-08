/**
 * 图表工作台分钟 range 轮询停表 — chartMinuteRangeRefetchInterval 分支单测。
 *
 * cnToday/cnNowHHMM 按 Asia/Shanghai 取北京墙钟, 用例一律以 UTC 瞬间 setSystemTime
 * 换算到目标北京时刻, 避免测试机时区影响。
 * 参照日期: 2026-09-30 为周三, 2026-10-03 为周六。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chartMinuteRangeRefetchInterval } from './kline'

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
