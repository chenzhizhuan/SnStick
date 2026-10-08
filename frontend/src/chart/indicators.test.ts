import { describe, expect, it } from 'vitest'
import { enrichChartIndicators } from './indicators'
import type { ResampledBar } from './minuteResample'

const bar = (o: Partial<ResampledBar>): ResampledBar => ({
  date: '2026-09-29 09:30', open: 0, high: 0, low: 0, close: 0, volume: 0, amount: null,
  ...o,
})

describe('enrichChartIndicators', () => {
  it('MA5 窗口不足为 null, 第 5 根起为均值', () => {
    const bars = Array.from({ length: 6 }, (_, i) => bar({ close: i + 1 }))
    const out = enrichChartIndicators(bars)
    expect(out[3].ma5).toBeNull()
    expect(out[4].ma5).toBeCloseTo((1 + 2 + 3 + 4 + 5) / 5, 10)
    expect(out[5].ma5).toBeCloseTo((2 + 3 + 4 + 5 + 6) / 5, 10)
  })

  it('MACD 首行 dif/dea/hist 均为 0 (adjust=False 首值起步)', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar({ close: 10 + i }))
    const out = enrichChartIndicators(bars)
    expect(out[0].macd_dif).toBe(0)
    expect(out[0].macd_dea).toBe(0)
    expect(out[0].macd_hist).toBe(0)
    // 单调上涨 DIF > 0
    expect(out[9].macd_dif).toBeGreaterThan(0)
  })

  it('全涨序列 RSI 趋近 100', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar({ close: i + 1 }))
    const out = enrichChartIndicators(bars)
    expect(out[20].rsi_14).toBeGreaterThan(99.9)
    expect(out[20].rsi_6).toBeGreaterThan(99.9)
  })

  it('常数序列 MA20 = 常数, 原字段保持', () => {
    const flat = Array.from({ length: 25 }, () => bar({ date: 'x', high: 5, low: 5, close: 5, open: 5, volume: 1 }))
    const out = enrichChartIndicators(flat)
    expect(out[24].ma20).toBe(5)
    expect(out[0].date).toBe('x')
    expect(out[0].volume).toBe(1)
  })

  it('工作台指标精简后不再输出 kdj/boll/obv/cci 字段', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar({ close: i + 1, volume: 1 }))
    const out = enrichChartIndicators(bars)
    for (const o of out) {
      expect(o).not.toHaveProperty('kdj_k')
      expect(o).not.toHaveProperty('boll_upper')
      expect(o).not.toHaveProperty('obv')
      expect(o).not.toHaveProperty('cci')
    }
  })
})