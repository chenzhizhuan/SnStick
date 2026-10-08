// @vitest-environment jsdom
/**
 * AnalysisKChart 交互状态机测试 — mock echarts 捕获 setOption 与事件 handler:
 * ① 现价标签贴左轴 (position 'start', 价格标尺在左);
 * ② ECharts 内置缩放 (滚轮/slider 拖拽经 dataZoom 事件) 的窗口记入 xZoomRef —
 *    setOption 全量重建 (hover 价位线/数据更新触发) 时不弹回旧窗口;
 * ③ 换股 (symbol 变化) 清空 X/Y 用户窗口回默认, 同股数据更新不重置。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AnalysisKChart } from './AnalysisKChart'

const zr = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  on: vi.fn(), off: vi.fn(), trigger: vi.fn(),
}))
zr.on.mockImplementation((name: string, cb: (e?: any) => void) => { zr.handlers[name] = cb })
const chart = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  on: vi.fn(), off: vi.fn(), setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), dispatchAction: vi.fn(),
  getZr: () => zr,
  getOption: vi.fn(),
}))
vi.mock('echarts', () => ({ init: () => chart }))
vi.mock('@/lib/theme', () => ({
  chartTheme: () => ({ grid: '#333', text: '#ccc', tooltipBg: '#111', tooltipBorder: '#333', tooltipText: '#eee', crosshair: '#888', zoomFill: 'rgba(0,0,0,.2)', infoBarBg: '#222' }),
  getTheme: () => 'dark',
  useTheme: () => 'dark',
}))

/** 150 根日 K (data > 默认 120 根窗口, defaultZoom.start > 0 才能区分默认与全量)。 */
function makeRows(n = 150) {
  return Array.from({ length: n }, (_, i) => {
    const close = 10 + Math.sin(i / 20) * 2
    return { date: `2026-${String(3 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 1000 + i }
  })
}

let cleanup = async () => {}
afterEach(async () => { await cleanup(); vi.unstubAllGlobals() })

function setup(zoom0 = { start: 80, end: 100 }) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  chart.on.mockImplementation((name: string, cb: (e?: any) => void) => { chart.handlers[name] = cb })
  chart.getOption.mockReturnValue({ dataZoom: [zoom0, { ...zoom0 }, { start: 0, end: 100 }] })
  const host = document.createElement('div')
  const root = createRoot(host)
  cleanup = async () => { await act(async () => root.unmount()) }
  return { host, root }
}

function lastOption(): any {
  return chart.setOption.mock.calls.at(-1)?.[0]
}

it('现价标签 position=start (贴左侧价格轴, 价格标尺在左)', async () => {
  const { root } = setup()
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="600000.SH" />))
  const markLine = lastOption()?.series?.[0]?.markLine
  expect(markLine).toBeTruthy()
  expect(markLine.data[0].label.position).toBe('start')
})

it('内置缩放窗口经 dataZoom 事件入账 xZoomRef — setOption 重建不弹回', async () => {
  const rows = makeRows()
  const { root } = setup()
  await act(async () => root.render(<AnalysisKChart rows={rows} symbol="600000.SH" />))
  // 模拟用户滚轮缩放: ECharts 触发 dataZoom(空 params — 内置滚轮不带字段), getOption 窗口已变
  chart.getOption.mockReturnValue({ dataZoom: [{ start: 40, end: 60 }, { start: 40, end: 60 }, { start: 0, end: 100 }] })
  await act(async () => { chart.handlers.dataZoom?.({}) })
  // 触发全量重建 (rows 新引用 = 数据轮询更新)
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="600000.SH" />))
  const dz = lastOption()?.dataZoom
  // 重建恢复的是用户刚缩放的窗口 (40-60), 而非弹回默认 120 根
  expect(dz?.[0]?.start).toBe(40)
  expect(dz?.[0]?.end).toBe(60)
})

it('换股清空用户窗口回默认 120 根; Y 也归位', async () => {
  const { root } = setup()
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="600000.SH" />))
  // 用户缩放 (40-60) 入账 (空 params 的滚轮事件)
  chart.getOption.mockReturnValue({ dataZoom: [{ start: 40, end: 60 }, { start: 40, end: 60 }, { start: 20, end: 80 }] })
  await act(async () => { chart.handlers.dataZoom?.({}) })
  // 换股: symbol 变化 → 窗口清空回默认
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="000001.SZ" />))
  const dz = lastOption()?.dataZoom
  // 150 根数据默认 120 根窗口: start = (1-120/150)*100 = 20
  expect(dz?.[0]?.start).toBe(20)
  expect(dz?.[0]?.end).toBe(100)
  expect(dz?.[2]?.start).toBe(0)
  expect(dz?.[2]?.end).toBe(100)
})

it('双击重置: X 回默认窗口 + Y 归位 (zr dblclick)', async () => {
  const { root } = setup()
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="600000.SH" />))
  // 用户先缩放成 40-60 (经 dataZoom 事件入账)
  chart.getOption.mockReturnValue({ dataZoom: [{ start: 40, end: 60 }, { start: 40, end: 60 }, { start: 20, end: 80 }] })
  await act(async () => { chart.handlers.dataZoom?.({}) })
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="600000.SH" />))
  expect(lastOption()?.dataZoom?.[0]?.start).toBe(40)
  // 双击重置: zr dblclick → X 回默认 120 根 + Y 归位 dispatch
  await act(async () => { zr.handlers.dblclick?.() })
  // 重置后的窗口状态经重建恢复默认 (20-100 / 0-100)
  await act(async () => root.render(<AnalysisKChart rows={makeRows()} symbol="600000.SH" />))
  const dz = lastOption()?.dataZoom
  expect(dz?.[0]?.start).toBe(20)
  expect(dz?.[0]?.end).toBe(100)
  expect(dz?.[2]?.start).toBe(0)
  expect(dz?.[2]?.end).toBe(100)
})
