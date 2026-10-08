// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DRAW_STYLE, DRAW_TOOLS, drawingsStorageKey, drawingsToMarks,
  loadDrawings, paneDrawingsStorageKey, saveDrawings, type DrawingObject,
} from './drawings'

const obj = (tool: DrawingObject['tool'], points: DrawingObject['points'], id = 'x1'): DrawingObject => ({
  id, tool, points, style: { ...DEFAULT_DRAW_STYLE },
})

afterEach(() => localStorage.clear())

describe('drawingsStorageKey', () => {
  it('per symbol 命名空间 (图形库跟标的走, 同股窗格共享)', () => {
    expect(drawingsStorageKey('300917.SZ')).toBe('stick.chart-drawings.300917.SZ')
  })
})

describe('loadDrawings / saveDrawings', () => {
  it('存取 round-trip', () => {
    const list = [obj('trendline', [{ date: '2026-01-01', price: 10 }, { date: '2026-02-01', price: 12 }])]
    saveDrawings('000001.SZ', list)
    expect(loadDrawings('000001.SZ')).toEqual(list)
  })

  it('旧版 per symbol+period 图形首次访问时自动迁移合并 (按 id 去重)', () => {
    const a = obj('trendline', [{ date: '2026-01-01', price: 10 }, { date: '2026-02-01', price: 12 }], 'id-a')
    const b = obj('hline', [{ date: '2026-03-01', price: 8 }], 'id-b')
    // 旧 key: 两个 period 各存一部分
    localStorage.setItem('stick.chart-drawings.000001.SZ.1d', JSON.stringify([a]))
    localStorage.setItem('stick.chart-drawings.000001.SZ.15m', JSON.stringify([b, { ...a }])) // a 重复 → 去重
    const out = loadDrawings('000001.SZ')
    expect(out.length).toBe(2) // a + b, a 不重复
    expect(out.map(d => d.id).sort()).toEqual(['id-a', 'id-b'])
    // 迁移结果已写入 per-symbol 新 key (下次直读, 不再重复迁移)
    expect(localStorage.getItem('stick.chart-drawings.000001.SZ')).toBeTruthy()
  })

  it('新库已存在时不再迁移 (清空过的空库不会被旧数据复活)', () => {
    localStorage.setItem('stick.chart-drawings.000002.SZ.1d', JSON.stringify([obj('hline', [{ date: 'd', price: 1 }], 'old')]))
    localStorage.setItem('stick.chart-drawings.000002.SZ', '[]')
    expect(loadDrawings('000002.SZ')).toEqual([])
  })

  it('损坏 JSON / 非数组 → 空数组', () => {
    localStorage.setItem(drawingsStorageKey('a'), '{bad json')
    expect(loadDrawings('a')).toEqual([])
    localStorage.setItem(drawingsStorageKey('a'), '{"k":1}')
    expect(loadDrawings('a')).toEqual([])
  })

  it('独立库 (storeKey): pane 独立 key 与共享库互不干扰', () => {
    const shared = [obj('trendline', [{ date: 'd1', price: 1 }, { date: 'd2', price: 2 }], 'shared-1')]
    const own = [obj('hline', [{ date: 'd1', price: 9 }], 'own-1')]
    saveDrawings('000001.SZ', shared)
    const paneKey = paneDrawingsStorageKey('pane-2', '000001.SZ')
    expect(paneKey).toBe('stick.chart-drawings.pane.pane-2.000001.SZ')
    saveDrawings('000001.SZ', own, paneKey)
    // 各读各的: 共享库不含独立库图形, 反之亦然
    expect(loadDrawings('000001.SZ')).toEqual(shared)
    expect(loadDrawings('000001.SZ', paneKey)).toEqual(own)
    // 清空独立库不影响共享库
    saveDrawings('000001.SZ', [], paneKey)
    expect(loadDrawings('000001.SZ', paneKey)).toEqual([])
    expect(loadDrawings('000001.SZ')).toEqual(shared)
  })

  it('独立库 (storeKey): 缺失时不触发旧版 period key 迁移', () => {
    localStorage.setItem('stick.chart-drawings.000003.SZ.1d', JSON.stringify([obj('hline', [{ date: 'd', price: 1 }], 'legacy')]))
    const paneKey = paneDrawingsStorageKey('pane-1', '000003.SZ')
    expect(loadDrawings('000003.SZ', paneKey)).toEqual([])
    expect(localStorage.getItem(paneKey)).toBeNull() // 不回写迁移结果
  })

  it('非法结构项被过滤 (tool 不合法 / points 空 / price 非有限数)', () => {
    localStorage.setItem(drawingsStorageKey('a'), JSON.stringify([
      obj('trendline', [{ date: 'd1', price: 1 }, { date: 'd2', price: 2 }]), // 合法
      obj('nonsense' as any, [{ date: 'd1', price: 1 }]), // tool 非法
      obj('hline', []), // points 空
      obj('hline', [{ date: 'd', price: NaN }]), // price 非法
      { id: 'no-points' }, // 缺字段
    ]))
    const out = loadDrawings('a')
    expect(out.length).toBe(1)
    expect(out[0].tool).toBe('trendline')
  })
})

describe('drawingsToMarks', () => {
  const dates = ['d1', 'd2', 'd3']
  const dateIndexMap = new Map([
    ['d1', 0], ['d2', 1], ['d3', 2],
  ])

  it('trendline → 两点 coord 锚定的 markLine', () => {
    const { markLine, markArea } = drawingsToMarks(
      [obj('trendline', [{ date: 'd1', price: 10 }, { date: 'd3', price: 20 }])],
      dateIndexMap,
      dates,
    )
    expect(markArea).toEqual([])
    expect(markLine.length).toBe(1)
    const seg = markLine[0] as any[]
    expect(seg[0].coord).toEqual(['d1', 10])
    expect(seg[1].coord).toEqual(['d3', 20])
  })

  it('hline → 单点 price 的全宽 yAxis markLine', () => {
    const { markLine } = drawingsToMarks(
      [obj('hline', [{ date: 'd1', price: 15.5 }])],
      dateIndexMap,
      dates,
    )
    expect(markLine.length).toBe(1)
    expect((markLine[0] as any).yAxis).toBe(15.5)
  })

  it('fib → 6 档水平线 + 区间填充', () => {
    const { markLine, markArea } = drawingsToMarks(
      [obj('fib', [{ date: 'd1', price: 20 }, { date: 'd3', price: 10 }])],
      dateIndexMap,
      dates,
    )
    expect(markLine.length).toBe(6)
    expect(markArea.length).toBe(1)
    // 0% 档 = 高点 price, 100% 档 = 低点 price
    expect((markLine[0] as any).yAxis).toBe(20)
    expect((markLine[5] as any).yAxis).toBe(10)
  })

  it('rect → markArea 归一化 (x 前小后大, y 取低高)', () => {
    const { markLine, markArea } = drawingsToMarks(
      [obj('rect', [{ date: 'd3', price: 20 }, { date: 'd1', price: 10 }])],
      dateIndexMap,
      dates,
    )
    expect(markLine).toEqual([])
    const area = markArea[0] as any[]
    expect(area[0].coord).toEqual(['d1', 10])
    expect(area[1].coord).toEqual(['d3', 20])
  })

  it('锚点日期不在当前数据集时跳过渲染 (换周期不炸, 回原周期自动恢复)', () => {
    const { markLine, markArea } = drawingsToMarks(
      [
        obj('trendline', [{ date: 'gone', price: 1 }, { date: 'd1', price: 2 }]), // 缺一跳过
        obj('hline', [{ date: 'gone', price: 3 }]), // 缺锚跳过
        obj('trendline', [{ date: 'd1', price: 4 }, { date: 'd2', price: 5 }]), // 完整保留
      ],
      dateIndexMap,
      dates,
    )
    expect(markLine.length).toBe(1)
    expect(markArea.length).toBe(0)
  })

  it('跨周期降级: 日K 锚点命中分钟集该日首根 (渲染锚替换为实际标签)', () => {
    const line = obj('trendline', [{ date: '2026-09-17', price: 10 }, { date: '2026-09-20', price: 12 }])
    const minuteDates = ['2026-09-17 09:30', '2026-09-17 10:30', '2026-09-20 09:30', '2026-09-20 10:30']
    const minuteMap = new Map(minuteDates.map((d, i) => [d, i] as const))
    const { markLine } = drawingsToMarks([line], minuteMap, minuteDates)
    expect(markLine.length).toBe(1)
    const seg = markLine[0] as any[]
    expect(seg[0].coord[0]).toBe('2026-09-17 09:30')
    expect(seg[1].coord[0]).toBe('2026-09-20 09:30')
  })

  it('跨周期降级: 分钟锚点命中日K当日', () => {
    const line = obj('trendline', [{ date: '2026-09-17 10:30', price: 10 }, { date: '2026-09-20 09:30', price: 12 }])
    const dailyDates = ['2026-09-16', '2026-09-17', '2026-09-20']
    const dailyMap = new Map(dailyDates.map((d, i) => [d, i] as const))
    const { markLine } = drawingsToMarks([line], dailyMap, dailyDates)
    expect(markLine.length).toBe(1)
    const seg = markLine[0] as any[]
    expect(seg[0].coord[0]).toBe('2026-09-17')
    expect(seg[1].coord[0]).toBe('2026-09-20')
  })
})

describe('DRAW_TOOLS', () => {
  it('光标 + 绘图四件套, key 唯一', () => {
    expect(DRAW_TOOLS.map(t => t.key)).toEqual(['cursor', 'trendline', 'hline', 'fib', 'rect'])
    expect(new Set(DRAW_TOOLS.map(t => t.key)).size).toBe(5)
  })
})
