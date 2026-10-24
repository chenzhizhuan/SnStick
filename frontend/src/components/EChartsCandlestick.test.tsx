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

it('鼠标移出图表后信息栏回落到最新 K 线 (TV 行为), 不残留悬停 bar', async () => {
  await act(async () => root.render(
    <EChartsCandlestick data={rows(10)} symbol="600000" height={400} visibleBars="all" />,
  ))
  const surface = host.firstElementChild as HTMLElement
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseenter')) })
  await hoverCandle(5)
  expect(host.textContent).toContain(DAYS[5])   // 悬停中: 显示悬停 bar

  // 移出图表区: 信息栏回落到最新一根 (残留 DAYS[5] 即为 Bug)
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseleave')) })
  expect(host.textContent).not.toContain(DAYS[5])
  expect(host.textContent).toContain(DAYS[DAYS.length - 1])
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

it('无 markers 时 ry 菱形/背离方块 markPoint 仍回填到主 K 线系列', async () => {
  // 回归: mainMarkExtras 在主 K 线创建时求值, 无 markers → markPoint 固化为 undefined,
  // 其后 ry 叠加段 push 的菱形/背离方块丢失 → 需在 ry 段后回填
  const data: OHLC[] = rows(20).map((r, i) => ({
    ...r,
    ry_mid: 10,           // hasRyMain 门槛: 任一行有 ry_mid/k_up 才启用 ry 叠加
    ...(i === 5 ? { ry_top_signal: true, ry_top_price: 11 } : {}),
    ...(i === 8 ? { ry_btm_signal: true, ry_btm_price: 9 } : {}),
    ...(i === 12 ? { div_top_count: 2 } : {}),
    ...(i === 15 ? { div_btm_count: 3 } : {}),
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={500} visibleBars="all" activeIndicators={['ry_channel', 'ry_mid', 'ry_k', 'ry_k2', 'ry_k3', 'macd_plus', 'rsi_plus']} />,
  ))
  const mp = lastMarkPoint()
  expect(mp).toContain('ryT')
  expect(mp).toContain('ryB')
  expect(mp).toContain('dvT')
  expect(mp).toContain('dvB')
  expect(mp).toContain('diamond')
})

it('showMA=false 不渲染 MA 序列 (工作台 1:1: TV 融易主图布局无均线, Pine showmas=false)', async () => {
  // 有 MA 数据但开关关 → 不画 (ChartPane 传 showMA={false})
  const data: OHLC[] = rows(20).map((r, i) => ({ ...r, ma5: 10 + i, ma10: 10, ma20: 10, ma60: 10 }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600000" height={400} visibleBars="all" showMA={false} />,
  ))
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const names = (option?.series ?? []).map((s: any) => s.name)
  expect(names).not.toContain('MA5')
  expect(names).not.toContain('MA10')
  expect(names).not.toContain('MA20')
  expect(names).not.toContain('MA60')
})

it('showMA 默认 true (其他页面) 仍渲染 MA 序列 — 回归保护', async () => {
  const data: OHLC[] = rows(20).map((r, i) => ({ ...r, ma5: 10 + i, ma10: 10, ma20: 10, ma60: 10 }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600000" height={400} visibleBars="all" />,
  ))
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const names = (option?.series ?? []).map((s: any) => s.name)
  expect(names).toContain('MA5')
  expect(names).toContain('MA60')
})

it('MACD+ 能量柱五色配色矩阵 (Pine 附图 line 146 一比一: 增长/回落 × RSI28快线 50 阈)', async () => {
  // 构造 9 根 (首根裸行 = prev na) 覆盖五色全分支; prev=na 首根走回落色 (Pine na 比较恒 false)
  const hists = [1, 2, 2.5, 2, -1, -0.5, -0.4, -1.2]
  const vfs = [60, 60, 40, 60, 40, 40, 60, 60]
  const data: OHLC[] = makeRows(9).map((r, i) => i === 0 ? r : ({
    ...r,
    macd_plus_dif: 1, macd_plus_dea: 1,
    macd_plus_hist: hists[i - 1],
    volume_rsi_fast: vfs[i - 1],
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600000" height={400} visibleBars="all"
      activeIndicators={['macd_plus']} showMA={false} />,
  ))
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const macdBar = (option?.series ?? []).find((s: any) => s.name === 'MACD+')
  expect(macdBar).toBeTruthy()
  // 首根无 hist → '-' 占位 (不参与配色)
  expect(macdBar.data[0]).toBe('-')
  const colors = macdBar.data.slice(1).map((d: any) => d?.itemStyle?.color)
  // 期望矩阵 (与 hists 逐项对齐):
  //  h0 hist=1     vf=60 prev=na    → 正柱回落 vf≥50 → 浅绿 #C7E4B3
  //  h1 hist=2     vf=60 增长       → 正柱增长 vf≥50 → 绿 #75BD42
  //  h2 hist=2.5   vf=40 增长       → 正柱增长 vf<50 → 灰 #AEAAAA
  //  h3 hist=2     vf=60 回落       → 正柱回落 vf≥50 → 浅绿 #C7E4B3
  //  h4 hist=-1    vf=40 回落(更深) → 负柱下探 vf<50 → 红 #C71C31
  //  h5 hist=-0.5  vf=40 增长       → 负柱回升 vf<50 → 浅红 #F4B7BE
  //  h6 hist=-0.4  vf=60 增长       → 负柱回升 vf≥50 → 浅灰 #E7E6E6
  //  h7 hist=-1.2  vf=60 回落       → 负柱下探 vf≥50 → 灰 #AEAAAA
  expect(colors).toEqual([
    '#C7E4B3', '#75BD42', '#AEAAAA', '#C7E4B3',
    '#C71C31', '#F4B7BE', '#E7E6E6', '#AEAAAA',
  ])
})

it('FVG 活跃区间渲染 (末行 fvg_list → FVG custom series)', async () => {
  const data: OHLC[] = makeRows(20).map((r, i) => ({
    ...r,
    ry_mid: 10,   // hasRyMain 门槛
    ...(i === 19 ? {
      fvg_list: [
        { start: DAYS[5], min: 9.0, max: 11.0, is_bull: true, combined: false, high_vol: 300, low_vol: 100, total_vol: 400 },
        { start: DAYS[10], min: 8.0, max: 9.5, is_bull: false, combined: true, high_vol: 0, low_vol: 0, total_vol: 0 },
      ],
    } : {}),
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={500} visibleBars="all"
      activeIndicators={['ry_k']} showMA={false} />,
  ))
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const fvg = (option?.series ?? []).find((s: any) => s.name === 'FVG')
  expect(fvg).toBeTruthy()
  expect(fvg.data).toHaveLength(2)
  // x 占位 = 末根索引 (19), 不是盒子索引 0 — ECharts 按 dataZoom 窗口剔除窗口外
  // 数据项 (renderItem 不触发), 盒子索引会被默认右侧窗口整批剔除 → 灰盒不渲染
  expect(fvg.data[0][0]).toBe(19)
  expect(fvg.data[1][0]).toBe(19)
  // y 维占位 '-' (不参与 Y 轴 extent — 防 0 拉爆)
  expect(fvg.data[0][1]).toBe('-')
})

it('无 fvg_list 时不渲染 FVG series', async () => {
  const data: OHLC[] = makeRows(20).map(r => ({ ...r, ry_mid: 10 }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={500} visibleBars="all"
      activeIndicators={['ry_k']} showMA={false} />,
  ))
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const names = (option?.series ?? []).map((s: any) => s.name)
  expect(names).not.toContain('FVG')
})
