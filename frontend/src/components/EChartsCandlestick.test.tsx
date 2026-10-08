// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EChartsCandlestick, type OHLC } from './EChartsCandlestick'

const chart = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  setOption: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dispatchAction: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  getZr: () => ({ on: vi.fn(), off: vi.fn() }),
  getOption: () => ({ dataZoom: [{ start: chart.__zoom.start, end: chart.__zoom.end }] }),
  containPixel: () => false,
  convertFromPixel: () => [0, 0],
  __zoom: { start: 0, end: 100 },
}))

vi.mock('echarts', () => ({ init: () => chart }))

// 超过 COMPACT_THRESHOLD(60): 切标的后 dataZoom 一响就会走紧凑态转换, 进而重写 markPoint
const DAYS = Array.from({ length: 62 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10))
const rows = (base: number): OHLC[] =>
  DAYS.map(date => ({ date, open: base, high: base + 1, low: base - 1, close: base, volume: 1 }))

/** 生成 n 根日 K, 从 startDate (含) 起每天一根, 用于前插检测测试 */
const makeRows = (n: number, startDate = '2024-01-01'): OHLC[] => {
  const base = new Date(`${startDate}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base.getTime() + i * 86_400_000)
    return { date: d.toISOString().slice(0, 10), open: 10, high: 11, low: 9, close: 10, volume: 1 }
  })
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  chart.handlers = {}
  chart.setOption.mockClear()
  chart.__zoom = { start: 0, end: 100 }
  chart.on.mockImplementation((name: string, callback: (event?: any) => void) => {
    chart.handlers[name] = callback
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** 最后一次 setOption 里 K 线的 markPoint (买卖箭头来源) */
function lastMarkPoint(): string {
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const k = option?.series?.find((s: any) => s.name === 'K')
  return JSON.stringify(k?.markPoint ?? null)
}

/** 模拟竖虚线命中某根 K 线 (鼠标在数据区内移动时 echarts 派发的事件) */
async function hoverCandle(index: number) {
  await act(async () => { chart.handlers.updateAxisPointer?.({ axesInfo: [{ value: index }] }) })
}

it('切标的后响应 dataZoom 仍用当前标的的买卖标记, 不回退到上一只', async () => {
  const render = async (symbol: string, data: OHLC[], markerLabel: string, markerDate: string) => {
    await act(async () => root.render(
      <EChartsCandlestick
        data={data}
        markers={[{ date: markerDate, kind: 'buy', label: markerLabel }]}
        symbol={symbol}
        height={400}
        showInfoBar={false}
        visibleBars="all"
        activeIndicators={['vol']}
      />,
    ))
  }

  await render('600000', rows(10), 'A-BUY', DAYS[10])
  await render('000001', rows(100), 'B-SELL', DAYS[20])

  // 切换标的后图表实例被复用, dataZoom 监听仍是最初注册的那个; 首次 setOption 已是当前标的
  expect(lastMarkPoint()).toContain('B-SELL')

  await act(async () => { chart.handlers.dataZoom?.() })

  expect(lastMarkPoint()).toContain('B-SELL')
  expect(lastMarkPoint()).not.toContain('A-BUY')
})

it('切股后鼠标未离开图表, 竖虚线重新命中即恢复「至今/周期」', async () => {
  const render = async (symbol: string) => {
    await act(async () => root.render(
      <EChartsCandlestick data={rows(10)} symbol={symbol} height={400} visibleBars="all" />,
    ))
  }

  await render('600000')
  const surface = host.firstElementChild as HTMLElement
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseenter')) })
  await hoverCandle(30)
  expect(host.textContent).toContain('至今')

  // 切股: 上一只的悬停上下文作废, 清掉「至今/周期」
  await render('000001')
  expect(host.textContent).not.toContain('至今')

  // 鼠标没离开图表区 (只是切股), 竖虚线重新命中即恢复, 不靠 mouseenter
  await hoverCandle(20)
  expect(host.textContent).toContain('至今')
  expect(host.textContent).toContain('周期')

  // 移出图表区 → 重新收起
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseleave')) })
  expect(host.textContent).not.toContain('至今')
})

it('拖到 X 最左边界 (start ≤ 0.5) 触发 onLoadMoreLeft 回调', async () => {
  const onLoadMoreLeft = vi.fn()
  await act(async () => root.render(
    <EChartsCandlestick
      data={rows(10)}
      symbol="600000"
      height={400}
      visibleBars="all"
      onLoadMoreLeft={onLoadMoreLeft}
    />,
  ))
  chart.__zoom = { start: 0, end: 100 }
  await act(async () => { chart.handlers.dataZoom?.() })
  expect(onLoadMoreLeft).toHaveBeenCalledTimes(1)
})

it('未贴到最左边界 (start > 0.5) 不触发 onLoadMoreLeft', async () => {
  const onLoadMoreLeft = vi.fn()
  await act(async () => root.render(
    <EChartsCandlestick
      data={rows(10)}
      symbol="600000"
      height={400}
      visibleBars="all"
      onLoadMoreLeft={onLoadMoreLeft}
    />,
  ))
  chart.__zoom = { start: 10, end: 100 }
  await act(async () => { chart.handlers.dataZoom?.() })
  expect(onLoadMoreLeft).not.toHaveBeenCalled()
})

it('「往左加载更多」前插后视野右移, 保持用户看到的日期段不变', async () => {
  const oldData = makeRows(60, '2024-01-01')
  const frontData = makeRows(50, '2023-11-12') // 50 根更早历史, 末根 2023-12-31
  const newData = [...frontData, ...oldData]   // 110 根, data[50] === oldData[0]

  await act(async () => root.render(
    <EChartsCandlestick
      data={oldData}
      symbol="600000"
      height={400}
      visibleBars="all"
    />,
  ))
  // 用户原本看末尾 10 根: start = (60-10)/60*100 = 83.333...
  chart.__zoom = { start: 83.33333, end: 100 }
  await act(async () => { chart.handlers.dataZoom?.() })

  // 前插 50 根更早历史 (触发「往左加载更多」后的数据合并结果)
  await act(async () => root.render(
    <EChartsCandlestick
      data={newData}
      symbol="600000"
      height={400}
      visibleBars="all"
    />,
  ))

  // 前插检测: 旧视野索引段整体右移 inserted=50 根
  // startIdx = 83.333/100 * 60 = 50, endIdx = 60
  // new start = (50+50)/110*100 ≈ 90.91, end = (60+50)/110*100 = 100
  // 前插检测: 旧视野索引段整体右移 inserted=50 根
  // startIdx = 83.333/100 * 60 = 50, endIdx = 60
  // new start = (50+50)/110*100 ≈ 90.91, end = (60+50)/110*100 = 100
  const xDispatch = chart.dispatchAction.mock.calls
    .filter((c: any[]) => c[0]?.dataZoomIndex === 0)
    .at(-1) as any[]
  expect(xDispatch[0].start).toBeCloseTo(90.9, 1)
  expect(xDispatch[0].end).toBe(100)
})
