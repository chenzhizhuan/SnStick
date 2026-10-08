import { describe, expect, it } from 'vitest'
import { PANE_INDICATORS, defaultPane, normalizeWorkspace } from './useChartLayout'

describe('PANE_INDICATORS', () => {
  it('工作台指标白名单只有 MACD/RSI', () => {
    expect([...PANE_INDICATORS]).toEqual(['macd', 'rsi'])
  })
})

describe('defaultPane', () => {
  it('默认激活 MACD + RSI 副图', () => {
    expect(defaultPane('pane-1').activeIndicators).toEqual(['macd', 'rsi'])
  })
})

describe('normalizeWorkspace', () => {
  it('旧持久化里的已废弃指标 (vol/kdj/obv/cci/boll) 被过滤, 只留白名单 key', () => {
    const ws = normalizeWorkspace({
      v: 1,
      template: '2h',
      panes: [
        { symbol: '600519.SH', period: '1d', chartStyle: 'candle', activeIndicators: ['vol', 'macd', 'kdj'] },
        { symbol: '600519.SH', period: '60m', chartStyle: 'candle', activeIndicators: ['boll', 'obv', 'cci', 'rsi', 'rsi'] },
      ],
      sync: {},
      drawTool: 'cursor',
      splitRatio: 0.5,
    })
    expect(ws.panes[0].activeIndicators).toEqual(['macd'])
    expect(ws.panes[1].activeIndicators).toEqual(['rsi'])
  })

  it('activeIndicators 非法类型回落默认 (macd+rsi)', () => {
    const ws = normalizeWorkspace({
      v: 1,
      template: '1',
      panes: [{ symbol: '600519.SH', period: '1d', chartStyle: 'candle', activeIndicators: 'oops' }],
      sync: {},
    })
    expect(ws.panes[0].activeIndicators).toEqual(['macd', 'rsi'])
  })

  it('空 blob 回落默认工作区 (贵州茅台 横2 左60m右4h)', () => {
    const ws = normalizeWorkspace(null)
    expect(ws.template).toBe('2h')
    expect(ws.panes.map(p => p.symbol)).toEqual(['600519.SH', '600519.SH'])
    expect(ws.panes.map(p => p.period)).toEqual(['60m', '4h'])
    expect(ws.panes.every(p => p.activeIndicators.includes('macd') && p.activeIndicators.includes('rsi'))).toBe(true)
  })
})