// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EChartsCandlestick, type OHLC } from './EChartsCandlestick'

const chart = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  zrHandlers: {} as Record<string, (event?: any) => void>,
  setOption: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dispatchAction: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  getZr: () => ({
    on: (name: string, cb: (event?: any) => void) => { chart.zrHandlers[name] = cb },
    off: vi.fn(),
  }),
  getOption: () => ({ dataZoom: [
    { start: chart.__zoom.start, end: chart.__zoom.end },
    { start: chart.__yZoom.start, end: chart.__yZoom.end },
    { start: chart.__yZoom2.start, end: chart.__yZoom2.end },
  ] }),
  containPixel: () => false,
  convertFromPixel: () => [0, 0],
  getWidth: () => 900,
  // Y 轴缩放的 getModel: grid 组件 rect 定位 (刻度带/图区命中) + Y 轴 extent (副图
  // pad 首次进入读自动定界基准; 走 grid.coordinateSystem.getAxis('y', idx) — 与真实
  // ECharts 同路径, SSR 实测: 第二参 = 轴全局 componentIndex, 副图轴在 axesMap[g])
  getModel: () => ({
    getComponent: (type: string, idx: number) => {
      if (type === 'grid') return {
        coordinateSystem: {
          getRect: () => (chart.__gridRects ?? [chart.__gridRect])[idx ?? 0] ?? chart.__gridRect,
          getAxis: (dim: string, axisIndex: number) => dim === 'y'
            ? { scale: { getExtent: () => chart.__yAxisExtents?.[axisIndex ?? idx ?? 0] ?? [9, 11] } }
            : undefined,
        },
      }
      if (type === 'yAxis') return {
        coordinateSystem: { getAxis: () => ({ scale: { getExtent: () => chart.__yAxisExtents?.[idx ?? 0] ?? [9, 11] } }) },
      }
      return {}
    },
  }),
  __zoom: { start: 0, end: 100 },
  __yZoom: { start: 0, end: 100 },
  __yZoom2: { start: 0, end: 100 },
  __gridRect: { x: 46, y: 8, width: 780, height: 400 },
  // 双 grid 布局 (副图测试用): grid 0/1 各自 rect; 未设 → 全部回落 __gridRect
  __gridRects: undefined as { x: number; y: number; width: number; height: number }[] | undefined,
  // 各 grid Y 轴自动定界 extent (副图 pad 基准); 未设 → [9, 11]
  __yAxisExtents: undefined as [number, number][] | undefined,
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
  chart.zrHandlers = {}
  chart.setOption.mockClear()
  chart.dispatchAction.mockClear()
  chart.__zoom = { start: 0, end: 100 }
  chart.__yZoom = { start: 0, end: 100 }
  chart.__yZoom2 = { start: 0, end: 100 }
  chart.__gridRects = undefined
  chart.__yAxisExtents = undefined
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

/** 最后一次 setOption 里现价标签 (markLine 末根收盘价项) 的 label */
function lastPriceLabel(): { formatter: string; bg: string } | null {
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const k = option?.series?.find((s: any) => s.name === 'K')
  const data = k?.markLine?.data as any[] | undefined
  const item = (data ?? []).find((d: any) => d?.yAxis != null && d?.label?.show === true)
  if (!item) return null
  return { formatter: String(item.label.formatter ?? ''), bg: String(item.label.backgroundColor ?? '') }
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

it('MACD+ 能量柱五色配色矩阵 (A 股红涨绿跌: 正柱红系/负柱绿系; 增长/回落 × RSI28快线 50 阈)', async () => {
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
  // 期望矩阵 (与 hists 逐项对齐; 平台色板: 正柱红系/负柱绿系):
  //  h0 hist=1     vf=60 prev=na    → 正柱回落 vf≥50 → 浅红 #E9B3B3
  //  h1 hist=2     vf=60 增长       → 正柱增长 vf≥50 → 平台红 #C74040
  //  h2 hist=2.5   vf=40 增长       → 正柱增长 vf<50 → 灰 #AEAAAA
  //  h3 hist=2     vf=60 回落       → 正柱回落 vf≥50 → 浅红 #E9B3B3
  //  h4 hist=-1    vf=40 回落(更深) → 负柱下探 vf<50 → 平台绿 #2D9B65
  //  h5 hist=-0.5  vf=40 增长       → 负柱回升 vf<50 → 浅绿 #ABD7C1
  //  h6 hist=-0.4  vf=60 增长       → 负柱回升 vf≥50 → 浅灰 #E7E6E6
  //  h7 hist=-1.2  vf=60 回落       → 负柱下探 vf≥50 → 灰 #AEAAAA
  expect(colors).toEqual([
    '#E9B3B3', '#C74040', '#AEAAAA', '#E9B3B3',
    '#2D9B65', '#ABD7C1', '#E7E6E6', '#AEAAAA',
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

// ── 第 32 轮 superpowers 纪律调优 (TDD): 十字线可见性 + 第 31 轮改动补测 ──

/** option.tooltip.axisPointer.crossStyle.color 的 alpha 值 (0~1) */
function crosshairAlpha(): number | null {
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const color = option?.tooltip?.axisPointer?.crossStyle?.color as string | undefined
  if (!color) return null
  const m = /rgba?\([^)]*,\s*([\d.]+)\s*\)\s*$/.exec(color)
  return m ? Number(m[1]) : null
}

it('十字线可见性: crossStyle alpha ≥ 0.5 (水平线 1px 虚线在深底上须可辨)', async () => {
  // 回归背景: 第 27 轮补联动水平线后, 主题 alpha 0.35 → canvas 有效亮度 ~0.09,
  // 视觉模型两次读漏 (用户视角即"没有水平线")。提亮阈值 0.5 (0.35*255=89 亦不满足
  // e2e T5 的 alpha>100 断言, 双重动机)。
  await act(async () => root.render(
    <EChartsCandlestick data={rows(10)} symbol="600000" height={400} visibleBars="all" />,
  ))
  const alpha = crosshairAlpha()
  expect(alpha).not.toBeNull()
  expect(alpha as number).toBeGreaterThanOrEqual(0.5)
})

it('Y 轴默认半高 (第 37 轮): 轴范围 = 窗口数据 ± 50% 数据范围, 价格序列居中占一半高度', async () => {
  await act(async () => root.render(
    <EChartsCandlestick data={rows(10)} symbol="600000" height={400} visibleBars="all" showMA={false} />,
  ))
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const y0 = option?.yAxis?.[0]
  expect(typeof y0?.min).toBe('function')
  // 窗口数据 {100,110} → 半高 95/115 (第 33 轮贴身 100/110 废除 — 用户「K线没必要拉高
  // 直接正常显示会更好, 貌似调矮一半」: 贴身把价格序列拉伸到填满主图高度)
  expect(y0.min({ min: 100, max: 110 })).toBe(95)
  expect(y0.max({ min: 100, max: 110 })).toBe(115)
  const yZoom = (option?.dataZoom ?? []).find((z: any) => z.yAxisIndex != null)
  expect(yZoom.start).toBe(0)
  expect(yZoom.end).toBe(100)
})

it('Y 轴滚轮缩放: 刻度带下滚无限缩小 (pad 扩展无上限) / 上滚放大先消 pad 再收窗口 / 同锚往返回贴身', async () => {
  await act(async () => root.render(
    <EChartsCandlestick data={rows(10)} symbol="600000" height={400} visibleBars="all" showMA={false} />,
  ))
  const y0 = () => (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[0]
  // 轴范围双态读取: 函数式 (pad 空, buildOption/归零后) 调用 min/max 函数;
  // 数值式 (pad 段 setOption 覆盖) 直读数字 — 两种形态的轴语义等价
  const rangeOf = () => {
    const y = y0()
    const ev = { min: 9, max: 11 }
    return typeof y.min === 'function'
      ? { lo: y.min(ev) as number, hi: y.max(ev) as number }
      : { lo: y.min as number, hi: y.max as number }
  }
  const wheel = async (delta: number) => {
    await act(async () => chart.zrHandlers.mousewheel?.({
      offsetX: 840, offsetY: 200, wheelDelta: delta, preventDefault: vi.fn(),
    }))
  }
  // 初始半高 (rows(10): H=11 L=9, span 2 → pad 0.5 → 8/12)
  expect(rangeOf()).toEqual({ lo: 8, hi: 12 })
  // 下滚 ×3 (缩小): pad 段轴范围以鼠标锚扩展, 无上限
  await wheel(-1); await wheel(-1); await wheel(-1)
  const minOut = rangeOf().lo
  const maxOut = rangeOf().hi
  expect(minOut).toBeLessThan(9)
  expect(maxOut).toBeGreaterThan(11)
  // 继续缩小: pad 基于组件状态自洽累积, 无上限 (不依赖 ECharts 内部 extent)
  await wheel(-1)
  expect(rangeOf().lo).toBeLessThan(minOut)
  expect(rangeOf().hi).toBeGreaterThan(maxOut)
  // 同锚上滚放大: clamp 到贴身后 pad 归零 → 恢复函数式 (X 平移自适应回归)
  await wheel(1)
  expect(rangeOf().lo).toBeCloseTo(9, 6)
  expect(rangeOf().hi).toBeCloseTo(11, 6)
  // 贴身后继续上滚 → 窗口段: dataZoom 窗口收窄 (filter 模式, 轴=窗口内数据)
  const dzBefore = chart.dispatchAction.mock.calls.filter((c: any[]) => c[0]?.dataZoomIndex === 1).length
  await wheel(1)
  const dzCalls = chart.dispatchAction.mock.calls.filter((c: any[]) => c[0]?.dataZoomIndex === 1)
  const last = dzCalls.at(-1)?.[0] as any
  expect(dzCalls.length).toBeGreaterThan(dzBefore)
  expect(last.start).toBeGreaterThan(0)
  expect(last.end).toBeLessThan(100)
})

it('换股保留 Y 轴 pad (TV 同款: 换标的保持缩放状态; 换股只清 Y dataZoom 窗口)', async () => {
  // 换股流程: _symbol effect 清 yZoomByGridRef (旧窗口对新标的无意义), yPadRef 保留;
  // 重建后函数式轴 (axisMinFn) 读 pad → 新标的轴 = 新窗口数据 ± pad, 而非回贴身。
  const render = async (symbol: string) => {
    await act(async () => root.render(
      <EChartsCandlestick data={rows(10)} symbol={symbol} height={400} visibleBars="all" showMA={false} />,
    ))
  }
  const wheel = async (delta: number) => {
    await act(async () => chart.zrHandlers.mousewheel?.({
      offsetX: 840, offsetY: 200, wheelDelta: delta, preventDefault: vi.fn(),
    }))
  }
  const lastAxis = () => (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[0]
  const ev = { min: 9, max: 11 }
  await render('600519.SH')
  await wheel(-1)
  // pad 已激活: 数值式 setOption 后 (或函数式读 pad), 轴范围扩展
  const padAxis = lastAxis()
  const padLo = typeof padAxis.min === 'function' ? padAxis.min(ev) : (padAxis.min as number)
  const padHi = typeof padAxis.max === 'function' ? padAxis.max(ev) : (padAxis.max as number)
  expect(padLo).toBeLessThan(9)
  expect(padHi).toBeGreaterThan(11)
  // 换股: 重建后轴函数仍读到同一 pad (pad 保留)
  await render('000783.SZ')
  const y = lastAxis()
  expect(typeof y.min).toBe('function')
  expect(y.min(ev)).toBeCloseTo(padLo, 6)
  expect(y.max(ev)).toBeCloseTo(padHi, 6)
})

it('副图 Y 轴双向缩放 (第 34 轮): 满窗口缩小 = pad 扩展无上限; 放大先消 pad 再落窗口段', async () => {
  // 用户复测实锤: 副图 (MACD+/RSI+) 刻度带滚轮只能放大 (窗口段满窗口缩小 no-op)。
  // 修复: 副图 pad (绝对范围, TV 同款 — X 平移时手动范围保持), 数值式 setOption 写入。
  chart.__gridRects = [
    { x: 46, y: 8, width: 780, height: 200 },
    { x: 46, y: 220, width: 780, height: 180 },
  ]
  chart.__yAxisExtents = [[9, 11], [0, 1]]
  const data: OHLC[] = rows(10).map((r, i) => i === 0 ? r : ({
    ...r, macd_plus_dif: 1, macd_plus_dea: 1, macd_plus_hist: i % 2 ? 0.5 : -0.5,
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={400} visibleBars="all"
      activeIndicators={['macd_plus']} showMA={false} />,
  ))
  const wheel = async (delta: number) => {
    await act(async () => chart.zrHandlers.mousewheel?.({
      offsetX: 840, offsetY: 300, wheelDelta: delta, preventDefault: vi.fn(),
    }))
  }
  const subAxis = () => (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[1]
  // 满窗口缩小: 副图 grid 1 → pad 扩展 (mock 轴 extent [0,1] = 自动定界基准)
  await wheel(-1)
  let y1 = subAxis()
  expect(y1).toBeTruthy()
  expect(y1.min).toBeLessThan(0)
  expect(y1.max).toBeGreaterThan(1)
  const padMin = y1.min as number, padMax = y1.max as number
  // 继续缩小: pad 自洽累积无上限 (不依赖 ECharts extent)
  await wheel(-1)
  y1 = subAxis()
  expect(y1.min).toBeLessThan(padMin)
  expect(y1.max).toBeGreaterThan(padMax)
  // 放大: 收 pad clamp 到 base [0,1]; 归零 → min:null 恢复自动定界 + 落窗口段收窄
  const dz2Before = chart.dispatchAction.mock.calls.filter((c: any[]) => c[0]?.dataZoomIndex === 2).length
  for (let i = 0; i < 8; i++) await wheel(1)
  y1 = subAxis()
  expect(y1.min).toBeNull()
  expect(y1.max).toBeNull()
  const dz2Calls = chart.dispatchAction.mock.calls.filter((c: any[]) => c[0]?.dataZoomIndex === 2)
  expect(dz2Calls.length).toBeGreaterThan(dz2Before)
})

it('换股清副图 pad (绝对范围随股无意义) + 重建后 setOption 恢复自动定界', async () => {
  chart.__gridRects = [
    { x: 46, y: 8, width: 780, height: 200 },
    { x: 46, y: 220, width: 780, height: 180 },
  ]
  chart.__yAxisExtents = [[9, 11], [0, 1]]
  const mkData = () => rows(10).map((r, i) => i === 0 ? r : ({
    ...r, macd_plus_dif: 1, macd_plus_dea: 1, macd_plus_hist: i % 2 ? 0.5 : -0.5,
  }))
  const render = async (symbol: string) => {
    await act(async () => root.render(
      <EChartsCandlestick data={mkData()} symbol={symbol} height={400} visibleBars="all"
        activeIndicators={['macd_plus']} showMA={false} />,
    ))
  }
  await render('600519.SH')
  await act(async () => chart.zrHandlers.mousewheel?.({
    offsetX: 840, offsetY: 300, wheelDelta: -1, preventDefault: vi.fn(),
  }))
  const y1 = (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[1]
  expect(y1?.min).toBeLessThan(0)   // pad 激活
  // 换股: subYPadRef 清 (指标值域随股变), 重建后 setOption 尾部幂等恢复 min:null
  await render('000783.SZ')
  const after = (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[1]
  expect(after?.min).toBeNull()
  expect(after?.max).toBeNull()
})

it('刻度带按住拖拽缩放复用滚轮状态机 (第 34 轮): 副图向下拖 = pad 扩展 (双向), 主图同走 pad', async () => {
  // 用户复测: 「只修复了鼠标滚轮? 上下拖动, 还不能满足」 — 拖拽缩放旧实现是纯
  // dataZoom 窗口计算, 满窗口向下拖 clamp no-op; 应增量复用 scaleYWindow (pad 段)。
  chart.__gridRects = [
    { x: 46, y: 8, width: 780, height: 200 },
    { x: 46, y: 220, width: 780, height: 180 },
  ]
  chart.__yAxisExtents = [[9, 11], [0, 1]]
  const data: OHLC[] = rows(10).map((r, i) => i === 0 ? r : ({
    ...r, macd_plus_dif: 1, macd_plus_dea: 1, macd_plus_hist: i % 2 ? 0.5 : -0.5,
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={400} visibleBars="all"
      activeIndicators={['macd_plus']} showMA={false} />,
  ))
  const subAxis = () => (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[1]
  // 副图刻度带 mousedown (offsetX 840 = 右带, offsetY 300 = grid 1) + 向下拖 80px (缩小)
  await act(async () => chart.zrHandlers.mousedown?.({ offsetX: 840, offsetY: 300 }))
  await act(async () => chart.zrHandlers.mousemove?.({ offsetX: 840, offsetY: 380 }))
  await act(async () => chart.zrHandlers.mouseup?.({}))
  const y1 = subAxis()
  expect(y1).toBeTruthy()
  expect(y1.min).toBeLessThan(0)      // pad 扩展 (拖拽缩小生效)
  expect(y1.max).toBeGreaterThan(1)
  // 再向上拖 (放大): 收 pad, 8 倍拖距必归零 → min:null 恢复自动定界
  await act(async () => chart.zrHandlers.mousedown?.({ offsetX: 840, offsetY: 300 }))
  for (let i = 1; i <= 4; i++) {
    await act(async () => chart.zrHandlers.mousemove?.({ offsetX: 840, offsetY: 300 - i * 60 }))
  }
  await act(async () => chart.zrHandlers.mouseup?.({}))
  expect(subAxis().min).toBeNull()
})

it('pad 段图区内上下拖拽平移 (第 34 轮): 副图绝对范围跟手平移; 主图方向跟手 (旧实现反向)', async () => {
  chart.__gridRects = [
    { x: 46, y: 8, width: 780, height: 200 },
    { x: 46, y: 220, width: 780, height: 180 },
  ]
  chart.__yAxisExtents = [[9, 11], [0, 1]]
  const data: OHLC[] = rows(10).map((r, i) => i === 0 ? r : ({
    ...r, macd_plus_dif: 1, macd_plus_dea: 1, macd_plus_hist: i % 2 ? 0.5 : -0.5,
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={400} visibleBars="all"
      activeIndicators={['macd_plus']} showMA={false} />,
  ))
  // 副图缩小激活 pad
  await act(async () => chart.zrHandlers.mousewheel?.({
    offsetX: 840, offsetY: 300, wheelDelta: -1, preventDefault: vi.fn(),
  }))
  const y1 = () => (chart.setOption.mock.calls.at(-1)?.[0] as any)?.yAxis?.[1]
  const before = { min: y1().min as number, max: y1().max as number }
  // 图区内下拖 (dy>0): 内容跟手下移 → 轴范围上移 → min/max 增大
  await act(async () => chart.zrHandlers.mousedown?.({ offsetX: 400, offsetY: 300 }))
  await act(async () => chart.zrHandlers.mousemove?.({ offsetX: 400, offsetY: 350 }))
  await act(async () => chart.zrHandlers.mouseup?.({}))
  const after = { min: y1().min as number, max: y1().max as number }
  expect(after.min).toBeGreaterThan(before.min)   // 跟手: 下拖范围上移
  expect(after.max).toBeGreaterThan(before.max)
})

it('主图信息栏文案「牛熊:」(第 31 轮 ②, 不残留旧「牛:」前缀)', async () => {
  const data: OHLC[] = rows(20).map((r, i) => ({
    ...r,
    ry_upper: 11, ry_mid: 10, ry_lower: 9, ry_ema_mid: 10,
    k_trend: 1, k_up: 10, k2_trend: 1, k2_up: 10, k3_trend: 1, k3_up: 10,
    ...(i === 19 ? {} : {}),
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} symbol="600519.SH" height={400} visibleBars="all"
      activeIndicators={['ry_channel', 'ry_mid', 'ry_k', 'ry_k2', 'ry_k3']} showMA={false} />,
  ))
  const text = host.textContent ?? ''
  expect(text).toContain('牛熊:')
  expect(text).not.toMatch(/牛:\d/)
})

it('RSI+ 值显示精简: 仅 RSI+ 数值, 高位/低位/S/B 提示全部去除 (第 31 轮 ③ + 第 34 轮复测)', async () => {
  // 第 34 轮用户复测: 「检索低位: 关键词, 明显还在」— 第 31 轮只去了高位与 S/B,
  // 低位:超卖残留; 本轮状态提示全部去除, 值显示只剩 RSI+ 数值。
  const subValText = () => {
    const option = chart.setOption.mock.calls.at(-1)?.[0] as any
    const g = (option?.graphic ?? []).find((x: any) => x?.id === 'sub-val-rsi_plus')
    return String(g?.style?.text ?? '')
  }
  // fund_bg_color=2 (超买高位) → 仅 RSI+ 数值
  const dataHigh: OHLC[] = rows(20).map(r => ({ ...r, rsi_plus: 0.25, fund_bg_color: 2 }))
  await act(async () => root.render(
    <EChartsCandlestick data={dataHigh} symbol="600519.SH" height={400} visibleBars="all"
      activeIndicators={['rsi_plus']} showMA={false} />,
  ))
  const t1 = subValText()
  expect(t1).toContain('RSI+:0.25')
  expect(t1).not.toContain('高位')
  expect(t1).not.toMatch(/[SB]:/)

  // fund_bg_color=1 (超卖低位) → 低位:超卖 同样去除 (第 34 轮)
  const dataLow: OHLC[] = rows(20).map(r => ({ ...r, rsi_plus: -0.3, fund_bg_color: 1 }))
  await act(async () => root.render(
    <EChartsCandlestick data={dataLow} symbol="600519.SH" height={400} visibleBars="all"
      activeIndicators={['rsi_plus']} showMA={false} />,
  ))
  const t2 = subValText()
  expect(t2).toContain('RSI+:-0.30')
  expect(t2).not.toContain('低位')
  expect(t2).not.toContain('超卖')
})

it('现价标签只显示价格 + ● 徽记交易时段门控 (第 37 轮: 收盘后 stale is_live 兜底隐藏)', async () => {
  // 旧双段式 {c|600519}{p|1335.00} 对齐 TV; 用户反馈窗格顶部已有标的, 轴区
  // 带代码冗余 → 纯价格单色块。实时行 (is_live) 前缀 ● 徽记保留。
  const mkData = (isLive?: boolean) => rows(10).map((r, i) => (
    i === 61 ? { ...r, is_live: isLive } : r   // rows 恒 62 根; is_live 加末根
  ))
  await act(async () => root.render(
    <EChartsCandlestick data={mkData()} symbol="600519.SH" height={400} visibleBars="all" showMA={false} />,
  ))
  let label = lastPriceLabel()
  expect(label).not.toBeNull()
  // rows(10) 末根 close=10 → "10.00"; 无代码段
  expect(label!.formatter).toBe('10.00')
  expect(label!.formatter).not.toContain('600519')
  // 涨跌配色: 末根 close(10) >= 前根(10) → 平台红
  expect(label!.bg).toBe('#C74040')
  // 实时行 ● 徽记: 钟控门控 (第 37 轮) — 用 fake clock 固定在盘中 (周二 10:00)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 9, 27, 10, 0)) // 2026-10-27 周二 10:00 盘中
    await act(async () => root.render(
      <EChartsCandlestick data={mkData(true)} symbol="600519.SH" height={400} visibleBars="all" showMA={false} />,
    ))
    label = lastPriceLabel()
    expect(label!.formatter).toBe('●10.00')
    expect(label!.formatter).not.toContain('600519')
    // 收盘后 (15:30): 同样的 stale is_live 数据 → ● 隐藏 (服务端已不标, 此处兜底
    // 盘中加载页面留到收盘后、日K源窗格无轮询不重渲染的缓存)
    vi.setSystemTime(new Date(2026, 9, 27, 15, 30))
    await act(async () => root.render(
      <EChartsCandlestick data={mkData(true)} symbol="600519.SH" height={400} visibleBars="all" showMA={false} />,
    ))
    label = lastPriceLabel()
    expect(label!.formatter).toBe('10.00')
    // 周末: 同样隐藏
    vi.setSystemTime(new Date(2026, 9, 31, 10, 0)) // 2026-10-31 周六
    await act(async () => root.render(
      <EChartsCandlestick data={mkData(true)} symbol="600519.SH" height={400} visibleBars="all" showMA={false} />,
    ))
    label = lastPriceLabel()
    expect(label!.formatter).toBe('10.00')
  } finally {
    vi.useRealTimers()
  }
})
