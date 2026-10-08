import { describe, expect, it } from 'vitest'
import { mergeDailyRows, shiftDate } from './useChartPaneData'
import type { KlineRow } from '@/lib/api'

const row = (date: string, close = 10): KlineRow => ({
  date, open: 10, high: 10, low: 10, close, volume: 100,
  ma5: null, ma10: null, ma20: null, ma60: null,
  macd_dif: null, macd_dea: null, macd_hist: null,
  rsi_6: null, rsi_14: null, rsi_24: null,
  is_live: false,
} as KlineRow)

describe('mergeDailyRows', () => {
  it('额外 (更早) + 基础 (最近) 合并后按日期升序', () => {
    const base = [row('2026-09-29'), row('2026-09-30')]
    const extra = [row('2026-09-25'), row('2026-09-28')]
    const out = mergeDailyRows(base, extra)
    expect(out.map(r => r.date)).toEqual(['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'])
  })

  it('重复日期保留后写的值 (基础最近优先)', () => {
    const base = [row('2026-09-28', 11)]
    const extra = [row('2026-09-28', 9)]
    const out = mergeDailyRows(base, extra)
    expect(out.length).toBe(1)
    expect(out[0].close).toBe(11)
  })

  it('多段额外区间连续加载不丢失', () => {
    const base = [row('2026-09-30')]
    const extra1 = [row('2026-09-20'), row('2026-09-25')]
    const extra2 = [row('2026-09-10'), row('2026-09-15')]
    const out = mergeDailyRows(mergeDailyRows(base, extra1), extra2)
    expect(out.map(r => r.date)).toEqual(['2026-09-10', '2026-09-15', '2026-09-20', '2026-09-25', '2026-09-30'])
  })
})

describe('shiftDate', () => {
  it('加减天数 (含跨月)', () => {
    expect(shiftDate('2026-09-30', -1)).toBe('2026-09-29')
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01')
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30')
  })

  it('跨年', () => {
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01')
  })
})