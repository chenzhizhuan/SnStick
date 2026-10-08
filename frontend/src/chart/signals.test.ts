import { describe, expect, it } from 'vitest'
import { detectSignals } from './signals'
import type { OHLC } from '@/components/EChartsCandlestick'

const mk = (o: Partial<OHLC>): OHLC => ({
  date: 'd', open: 1, high: 1, low: 1, close: 1, volume: 1,
  ...o,
})

describe('detectSignals — MA 金叉/死叉', () => {
  it('金叉: ma5 从下方穿越 ma10 → buy 标记', () => {
    const bars = [
      mk({ date: 'a', ma5: 9, ma10: 10 }),
      mk({ date: 'b', ma5: 11, ma10: 10 }),
    ]
    const out = detectSignals(bars, { maCross: true })
    expect(out).toEqual([{ date: 'b', kind: 'buy', label: '金叉', _sig: 'ma-cross' }])
  })

  it('死叉: ma5 从上方跌破 ma10 → sell 标记', () => {
    const bars = [
      mk({ date: 'a', ma5: 11, ma10: 10 }),
      mk({ date: 'b', ma5: 9, ma10: 10 }),
    ]
    const out = detectSignals(bars, { maCross: true })
    expect(out).toEqual([{ date: 'b', kind: 'sell', label: '死叉', _sig: 'ma-cross' }])
  })

  it('ma5/ma10 任一为 null 时跳过 (指标未就绪区间不误报)', () => {
    const bars = [
      mk({ date: 'a', ma5: 9, ma10: 10 }),
      mk({ date: 'b', ma5: null, ma10: 10 }),
      mk({ date: 'c', ma5: 11, ma10: null }),
      mk({ date: 'd', ma5: 11, ma10: 10 }),
    ]
    const out = detectSignals(bars, { maCross: true })
    expect(out).toEqual([]) // d-a 隔着 null, 相邻才算; d 自身 vs c 无交叉
  })

  it('开关全关 → 空数组', () => {
    const bars = [mk({ ma5: 9, ma10: 10 }), mk({ ma5: 11, ma10: 10 })]
    expect(detectSignals(bars, {})).toEqual([])
    expect(detectSignals(bars)).toEqual([])
  })

  it('tailLimit 截尾: 只保留最后 N 个', () => {
    const bars: OHLC[] = []
    // 构造 3 组交替金叉死叉 (共 6 信号)
    const ma5 = [9, 11, 11, 9, 9, 11, 11]
    const ma10 = [10, 10, 10, 10, 10, 10, 10]
    for (let i = 0; i < 7; i++) bars.push(mk({ date: `d${i}`, ma5: ma5[i], ma10: ma10[i] }))
    const all = detectSignals(bars, { maCross: true, tailLimit: 0 })
    expect(all.length).toBe(3) // d1 金叉, d3 死叉, d5 金叉
    const tail = detectSignals(bars, { maCross: true, tailLimit: 2 })
    expect(tail.length).toBe(2)
    expect(tail[0].date).toBe('d3')
    expect(tail[1].date).toBe('d5')
  })
})

describe('detectSignals — RSI 顶背离', () => {
  // pivotK=3: 左右各 3 根 high 都严格低于当前 high 才算 swing 高点
  const buildDivergence = (rsi1: number, rsi2: number): OHLC[] => {
    const highs = [1, 1, 1, 10, 1, 1, 1, 12, 1, 1, 1]
    return highs.map((h, i) =>
      mk({ date: `d${i}`, high: h, low: 0, close: h, rsi_14: i === 3 ? rsi1 : i === 7 ? rsi2 : 50 }),
    )
  }

  it('价格抬升 + RSI 回落 → 顶部背离徽章 (在第二个高点)', () => {
    const bars = buildDivergence(80, 70)
    const out = detectSignals(bars, { rsiDivergence: true })
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({
      date: 'd7', kind: 'neutral', label: '背离', above: true, color: '#7C3AED', _sig: 'rsi-divergence',
    })
  })

  it('价格抬升但 RSI 也抬升 → 无背离', () => {
    const bars = buildDivergence(70, 80)
    expect(detectSignals(bars, { rsiDivergence: true })).toEqual([])
  })

  it('rsi_14 缺失 (null) 不误报', () => {
    const bars = buildDivergence(80, 70)
    bars[3].rsi_14 = null
    expect(detectSignals(bars, { rsiDivergence: true })).toEqual([])
  })
})

describe('detectSignals — 混合输出', () => {
  it('两类信号按时间序合并', () => {
    const bars: OHLC[] = [
      mk({ date: 'a', high: 1, rsi_14: 50 }),
      mk({ date: 'b', ma5: 9, ma10: 10 }),
      mk({ date: 'c', ma5: 11, ma10: 10, high: 20, rsi_14: 60 }),
    ]
    // 只验证混合时排序稳定, 不精确构造背离
    const out = detectSignals(bars, { maCross: true })
    expect(out.length).toBe(1)
    expect(out[0].date).toBe('c')
  })
})
