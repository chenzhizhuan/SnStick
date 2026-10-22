import { describe, expect, it } from 'vitest'
import { PANE_INDICATORS, defaultPane, normalizeWorkspace } from './useChartLayout'

describe('PANE_INDICATORS', () => {
  it('图表模块特例: 白名单为融易主图叠加 + 私有化线路 MACD+/RSI+ (原版 macd/rsi 已移除)', () => {
    expect([...PANE_INDICATORS]).toEqual(['ry', 'macd_plus', 'rsi_plus'])
  })
})

describe('defaultPane', () => {
  it('默认激活融易主图叠加 + MACD+ / RSI+ 副图', () => {
    expect(defaultPane('pane-1').activeIndicators).toEqual(['ry', 'macd_plus', 'rsi_plus'])
  })
})

describe('normalizeWorkspace', () => {
  it('旧持久化里的已废弃指标 (含原版 macd/rsi) 被过滤, 只留白名单 key', () => {
    const ws = normalizeWorkspace({
      v: 1,
      template: '2h',
      panes: [
        { symbol: '600519.SH', period: '1d', chartStyle: 'candle', activeIndicators: ['macd', 'macd_plus', 'vol'] },
        { symbol: '600519.SH', period: '60m', chartStyle: 'candle', activeIndicators: ['rsi', 'kdj', 'obv', 'rsi_plus'] },
      ],
      sync: {},
      drawTool: 'cursor',
      splitRatio: 0.5,
    })
    expect(ws.panes[0].activeIndicators).toEqual(['macd_plus'])
    expect(ws.panes[1].activeIndicators).toEqual(['rsi_plus'])
  })

  it('activeIndicators 非法类型回落默认 (ry+macd_plus+rsi_plus)', () => {
    const ws = normalizeWorkspace({
      v: 1,
      template: '1',
      panes: [{ symbol: '600519.SH', period: '1d', chartStyle: 'candle', activeIndicators: 'oops' }],
      sync: {},
    })
    expect(ws.panes[0].activeIndicators).toEqual(['ry', 'macd_plus', 'rsi_plus'])
  })

  it('空 blob 回落默认工作区 (贵州茅台 横2 左60m右4h)', () => {
    const ws = normalizeWorkspace(null)
    expect(ws.template).toBe('2h')
    expect(ws.panes.map(p => p.symbol)).toEqual(['600519.SH', '600519.SH'])
    expect(ws.panes.map(p => p.period)).toEqual(['60m', '4h'])
    expect(ws.panes.every(p => p.activeIndicators.includes('ry') && p.activeIndicators.includes('macd_plus') && p.activeIndicators.includes('rsi_plus'))).toBe(true)
  })
})
