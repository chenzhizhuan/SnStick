import { describe, expect, it } from 'vitest'
import { resampleDaily } from './dailyResample'
import type { OHLC } from '@/components/EChartsCandlestick'

const bar = (date: string, o: Partial<OHLC> = {}): OHLC => ({
  date,
  open: 10, high: 10, low: 10, close: 10, volume: 100,
  ma5: null, ma10: null, ma20: null, ma60: null,
  macd_dif: null, macd_dea: null, macd_hist: null,
  rsi_6: null, rsi_14: null, rsi_24: null,
  is_live: false,
  ...o,
})

describe('resampleDaily', () => {
  it('period<=1 透传且返回副本 (调用方可安全 mutate)', () => {
    const bars = [bar('2026-09-29')]
    const out = resampleDaily(bars, 1)
    out[0].volume = 999
    expect(bars[0].volume).toBe(100)
  })

  it('2 天聚合: open=首根, close=末根, high/low=极值, volume 求和, 标签=桶首日', () => {
    const out = resampleDaily([
      bar('2026-09-28', { open: 10, high: 12, low: 9, close: 11, volume: 100 }),
      bar('2026-09-29', { open: 11, high: 13, low: 10, close: 12.5, volume: 150 }),
      bar('2026-09-30', { open: 12.5, high: 14, low: 11, close: 13, volume: 200 }),
    ], 2)
    expect(out.length).toBe(2)
    expect(out[0]).toMatchObject({
      date: '2026-09-28',
      open: 10, close: 12.5, high: 13, low: 9, volume: 250,
    })
    expect(out[1]).toMatchObject({ date: '2026-09-30', close: 13, volume: 200 })
  })

  it('周 (5 交易日) 聚合: 末根指标字段透传', () => {
    const out = resampleDaily([
      bar('2026-09-21', { close: 10, ma5: 1 }),
      bar('2026-09-22', { close: 11, ma5: 2 }),
      bar('2026-09-23', { close: 12, ma5: 3 }),
      bar('2026-09-24', { close: 13, ma5: 4 }),
      bar('2026-09-25', { close: 14, ma5: 5 }),
      bar('2026-09-28', { close: 15, ma5: 6 }),
    ], 5)
    expect(out.length).toBe(2)
    expect(out[0].close).toBe(14)
    expect(out[0].ma5).toBe(5)
    expect(out[1].close).toBe(15)
    expect(out[1].ma5).toBe(6)
  })
})