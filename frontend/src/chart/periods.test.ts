import { describe, expect, it } from 'vitest'
import { BARS_PER_DAY } from './ranges'
import { DEFAULT_PERIOD, MINUTE_FETCH_DAYS, PERIODS, isDailyPeriod, isMinutePeriod, periodDef } from './periods'

describe('periods', () => {
  it('八档周期定义齐全', () => {
    expect(PERIODS.map(p => p.key)).toEqual(['15m', '60m', '4h', '1d', '2d', '4d', '1w', '1M'])
    expect(PERIODS.map(p => p.label)).toEqual(['15分', '1小时', '4小时', '天', '2天', '4天', '周', '月'])
  })

  it('分钟级聚合周期带 minutes, 日级以上带 dailyAgg 或两者皆无', () => {
    expect(periodDef('15m').minutes).toBe(15)
    expect(periodDef('60m').minutes).toBe(60)
    expect(periodDef('4h').minutes).toBe(240)
    expect(periodDef('1d').minutes).toBeUndefined()
    expect(periodDef('1d').dailyAgg).toBeUndefined()
    expect(periodDef('2d').dailyAgg).toBe(2)
    expect(periodDef('4d').dailyAgg).toBe(4)
    expect(periodDef('1w').dailyAgg).toBe(5)
    expect(periodDef('1M').dailyAgg).toBe(22)
  })

  it('periodDef 非法值回退 15m', () => {
    expect(periodDef('nonsense' as any).key).toBe('15m')
  })

  it('默认周期为 15 分', () => {
    expect(DEFAULT_PERIOD).toBe('15m')
  })

  it('MINUTE_FETCH_DAYS 为正数 (env 覆盖为 20 时仍可工作)', () => {
    expect(Number.isFinite(MINUTE_FETCH_DAYS)).toBe(true)
    expect(MINUTE_FETCH_DAYS).toBeGreaterThan(0)
  })

  it('分钟级/日级以上分流正确', () => {
    expect(isMinutePeriod('15m')).toBe(true)
    expect(isMinutePeriod('4h')).toBe(true)
    expect(isMinutePeriod('1d')).toBe(false)
    expect(isDailyPeriod('1d')).toBe(true)
    expect(isDailyPeriod('1M')).toBe(true)
    expect(isDailyPeriod('60m')).toBe(false)
  })

  it('BARS_PER_DAY 与 A 股时段一致 (15m=16/日, 4h=1/日, 聚合周期按根数折算)', () => {
    expect(BARS_PER_DAY['15m']).toBe(16)
    expect(BARS_PER_DAY['60m']).toBe(4)
    expect(BARS_PER_DAY['4h']).toBe(1)
    expect(BARS_PER_DAY['1d']).toBe(1)
    expect(BARS_PER_DAY['2d']).toBe(1 / 2)
    expect(BARS_PER_DAY['4d']).toBe(1 / 4)
    expect(BARS_PER_DAY['1w']).toBe(1 / 5)
    expect(BARS_PER_DAY['1M']).toBe(1 / 22)
  })
})