import { describe, expect, it } from 'vitest'
import { RANGES, rangeBars, zoomForBars } from './ranges'

describe('rangeBars', () => {
  it('全部档 → "all" 特殊值', () => {
    expect(rangeBars('all', '1d')).toBe('all')
  })

  it('按周期换算: 交易日 × 每日根数', () => {
    expect(rangeBars('1d', '1d')).toBe(1)
    expect(rangeBars('5d', '1d')).toBe(5)
    expect(rangeBars('1m', '1d')).toBe(22)
    expect(rangeBars('3m', '1d')).toBe(66)
    expect(rangeBars('6m', '1d')).toBe(132)
    expect(rangeBars('1y', '1d')).toBe(250)
    // 分钟周期: 66 交易日 × 16 根/日
    expect(rangeBars('3m', '15m')).toBe(66 * 16)
    expect(rangeBars('1d', '15m')).toBe(16)
    // 4h = 全天 1 根/日, 1天范围 → 1 根
    expect(rangeBars('1d', '4h')).toBe(1)
    // 聚合周期: 2天 每 2 个交易日 1 根 → 5天范围 ≈ 3 根
    expect(rangeBars('5d', '2d')).toBe(Math.max(1, Math.round(5 * (1 / 2))))
    expect(rangeBars('1m', '1w')).toBe(Math.max(1, Math.round(22 * (1 / 5))))
  })

  it('ytd 按当年已过交易日估算 (dayOfYear × 5/7)', () => {
    const now = new Date(2026, 5, 15) // 第 31+28+31+30+31+15 = 166 天
    expect(rangeBars('ytd', '1d', now)).toBe(Math.ceil((166 * 5) / 7))
    // 年初第一天 → 至少 1
    expect(rangeBars('ytd', '1d', new Date(2026, 0, 1))).toBe(1)
  })

  it('无效/缺失 key → 默认 60 根最佳窗口 (首次加载不全量, 与双击重置同口径)', () => {
    expect(rangeBars('unknown', '1d')).toBe(60)
    expect(rangeBars(null, '1d')).toBe(60)
    expect(rangeBars(undefined, '1d')).toBe(60)
    expect(rangeBars(null, '15m')).toBe(60)
  })

  it('9 档定义完整且 key 唯一', () => {
    expect(RANGES.length).toBe(9)
    expect(new Set(RANGES.map(r => r.key)).size).toBe(9)
    expect(RANGES.map(r => r.label)).toEqual(
      ['1天', '5天', '1月', '3月', '6月', 'YTD', '1年', '5年', '全部'],
    )
  })
})

describe('zoomForBars', () => {
  it('尾部对齐: end 固定 100, start 按根数反算', () => {
    // 回归锚: 可见 60 根 / 全量 254 → start=76.37795275590551 (曾作为幽灵窗口来源)
    expect(zoomForBars(60, 254)).toEqual({ start: 76.37795275590551, end: 100 })
  })

  it('目标根数超过总量时 clamp 到全量', () => {
    expect(zoomForBars(500, 254)).toEqual({ start: 0, end: 100 })
  })

  it('非法输入 (根数<=0/总量<=0) → 全量兜底', () => {
    expect(zoomForBars(0, 100)).toEqual({ start: 0, end: 100 })
    expect(zoomForBars(-5, 100)).toEqual({ start: 0, end: 100 })
    expect(zoomForBars(60, 0)).toEqual({ start: 0, end: 100 })
    expect(zoomForBars(NaN, 100)).toEqual({ start: 0, end: 100 })
  })
})
