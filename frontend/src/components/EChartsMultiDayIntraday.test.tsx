// @vitest-environment jsdom
/**
 * EChartsMultiDayIntraday 收盘点补值测试 — 分钟语义换算后 (末根 14:59 = 收盘根):
 * 15:00 槽补收盘价 (曲线横住) 但量柱为 null (防双柱); 11:30 午休槽保持 null (断线语义)。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EChartsMultiDayIntraday } from './EChartsMultiDayIntraday'

const chart = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  on: vi.fn(), off: vi.fn(), setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
  getZr: () => ({ on: vi.fn(), off: vi.fn(), trigger: vi.fn() }),
  getOption: vi.fn(() => ({})),
}))
vi.mock('echarts', () => ({ init: () => chart }))
vi.mock('@/lib/theme', () => ({ useChartTheme: () => ({}) }))

let cleanup = async () => {}
afterEach(async () => { await cleanup(); vi.unstubAllGlobals() })

// 换算后语义的单日数据: 09:30 合并根 / 11:29 上午收盘 / 13:00 / 14:59 收盘根
const day = (date: string, close: number): any => ({
  date,
  prev_close: close - 1,
  rows: [
    { datetime: `${date} 09:30:00`, open: close, high: close, low: close, close, volume: 100, amount: 100 * close },
    { datetime: `${date} 11:29:00`, open: close, high: close + 0.1, low: close - 0.1, close, volume: 50, amount: 50 * close },
    { datetime: `${date} 13:00:00`, open: close, high: close + 0.1, low: close, close, volume: 30, amount: 30 * close },
    { datetime: `${date} 14:59:00`, open: close, high: close + 0.2, low: close, close, volume: 200, amount: 200 * close },
  ],
})

it('close carry: 15:00 slot price carried (volume null), 11:30 stays empty', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  chart.on.mockImplementation((name: string, cb: (e?: any) => void) => { chart.handlers[name] = cb })
  const host = document.createElement('div')
  const root = createRoot(host)
  cleanup = async () => { await act(async () => root.unmount()) }
  await act(async () => root.render(<EChartsMultiDayIntraday sessions={[day('2026-09-29', 10)]} />))
  const call = chart.setOption.mock.calls.at(-1)
  const series: any[] = call?.[0]?.series ?? []
  const cats: string[] = call?.[0]?.xAxis?.[0]?.data ?? []
  // 价格线: buildOption 里 dayRanges 的 values 塞进 line series data
  const priceSeries = series.find(s => s.type === 'line')
  const vol = series.find(s => s.type === 'bar')
  const data = priceSeries?.data ?? []
  const vols = vol?.data ?? []
  const i1130 = cats.findIndex(c => c.endsWith('11:30'))
  const i1459 = cats.findIndex(c => c.endsWith('14:59'))
  const i1500 = cats.findIndex(c => c.endsWith('15:00'))
  expect(i1500).toBeGreaterThan(0)
  // 15:00 补收盘价 (与 14:59 同值), 量柱 null
  expect(data[i1500]).toBe(10)
  expect(data[i1459]).toBe(10)
  expect(vols[i1500]).toBeNull()
  expect(vols[i1459]?.value).toBe(200)
  // 11:30 午休槽保持 null
  expect(data[i1130]).toBeNull()
  expect(vols[i1130]).toBeNull()
})
