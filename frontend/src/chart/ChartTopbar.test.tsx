// @vitest-environment jsdom
/**
 * ChartTopbar 下拉回归 — 真实鼠标点击序列 (mousedown→mouseup→click) 必须能选中选项。
 *
 * 背景: SingleSelect 面板经 createPortal 挂在 document.body, 早期版本的外部点击判定
 * 只豁免触发按钮 — 选项的 mousedown 先被判「外部」关闭面板并卸载 portal, click 落在
 * 已卸载元素上永不触发, 真实用户点击下拉「只关不选」。合成 el.click() 不经过 mousedown,
 * 会掩盖该 bug, 因此本测试必须按真实事件三段序列 + act 分段刷新复现浏览器时序。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChartTopbar, type ChartTopbarPatch } from './ChartTopbar'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 真实用户点击: 三段事件分派, act 分段刷新让 React 在 mousedown 与 mouseup 之间
 *  完成 re-render (浏览器中两者是独立 task, 微任务间隙会刷新) — 否则 jsdom 单任务
 *  同步连发会跳过卸载, 测不出「面板先关 → click 丢失」的回归。 */
async function realClick(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
  await act(async () => { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })) })
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

function renderTopbar(onChange: (patch: ChartTopbarPatch) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <ChartTopbar
          symbol="600519.SH"
          name="贵州茅台"
          period="1d"
          chartStyle="candle"
          activeIndicators={['macd_plus', 'rsi_plus']}
          onChange={onChange}
        />
      </QueryClientProvider>,
    )
  })
}

it('指标按钮只有 MACD+ 与 RSI+ (图表模块特例: 原版 MACD/RSI 及其余指标已移除)', async () => {
  const patches: ChartTopbarPatch[] = []
  renderTopbar(p => patches.push(p))

  const labels = [...document.querySelectorAll('button')].map(b => b.textContent?.trim())
  expect(labels).toContain('MACD+')
  expect(labels).toContain('RSI+')
  for (const gone of ['MACD', 'RSI', '成交量', 'KDJ', 'OBV', 'CCI', 'BOLL', 'RSI零轴']) {
    // 严格相等判定 (MACD+ 不应误伤匹配 MACD)
    expect(labels.some(l => l === gone)).toBe(false)
  }

  // 点击 RSI+ 关闭 → toggleIndicator patch
  const rsiBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'RSI+')
  await act(async () => { rsiBtn!.click() })
  expect(patches.some(p => p.toggleIndicator === 'rsi_plus')).toBe(true)
})

it('真实鼠标点击能选中周期下拉选项 (portal 面板不被外部点击判定误关)', async () => {
  const patches: ChartTopbarPatch[] = []
  renderTopbar(p => patches.push(p))

  // 打开周期下拉 (触发按钮当前显示「天」)
  const trigger = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '天')
  expect(trigger).toBeTruthy()
  await realClick(trigger!)

  // 选项面板经 createPortal 挂在 document.body
  const option = [...document.querySelectorAll('body > div button')].find(b => b.textContent?.trim() === '周')
  expect(option).toBeTruthy()
  await realClick(option!)

  expect(patches.some(p => p.period === '1w')).toBe(true)
})

it('真实鼠标点击能选中范围下拉选项', async () => {
  const patches: ChartTopbarPatch[] = []
  renderTopbar(p => patches.push(p))

  const trigger = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '自定义')
  expect(trigger).toBeTruthy()
  await realClick(trigger!)

  const option = [...document.querySelectorAll('body > div button')].find(b => b.textContent?.trim() === '全部')
  expect(option).toBeTruthy()
  await realClick(option!)

  expect(patches.some(p => p.range === 'all')).toBe(true)
})

it('点击面板外部: 面板关闭且不触发选择', async () => {
  const patches: ChartTopbarPatch[] = []
  renderTopbar(p => patches.push(p))

  const trigger = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '天')
  await realClick(trigger!)
  let option = [...document.querySelectorAll('body > div button')].find(b => b.textContent?.trim() === '周')
  expect(option).toBeTruthy()

  // 点击 body (面板与触发按钮之外) → 关闭
  await realClick(document.body)
  option = [...document.querySelectorAll('body > div button')].find(b => b.textContent?.trim() === '周')
  expect(option).toBeFalsy()
  expect(patches).toHaveLength(0)
})

it('html zoom (tf-page-zoom) 下面板坐标按布局坐标写入: 显示坐标 ÷ zoom', async () => {
  // 背景: 面板 fixed 挂 body 处于 <html zoom> 树内, top/left 按布局坐标解释而
  // rect 返回显示坐标 — 不换算则面板渲染位置 = 目标 × zoom, 向左上偏移
  // (1-zoom)×视口距离 (线上实测: 按钮 left 459 → 面板显示 413.1)。
  // jsdom 无 CSS zoom: 注入 documentElement.zoom=0.9, 按钮 rect 给显示坐标。
  const origGCS = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pseudo?: string) => {
    if (el === document.documentElement) {
      return { zoom: '0.9' } as unknown as CSSStyleDeclaration
    }
    return origGCS(el, pseudo)
  }) as typeof window.getComputedStyle)

  const patches: ChartTopbarPatch[] = []
  renderTopbar(p => patches.push(p))

  const trigger = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '天')
  expect(trigger).toBeTruthy()
  // 显示坐标 (zoom 0.9 后): 按钮 left=459, bottom=121, 宽 58.8
  trigger!.getBoundingClientRect = () => ({
    x: 459, y: 95.9, left: 459, top: 95.9, right: 517.8, bottom: 121,
    width: 58.8, height: 25.2, toJSON: () => ({}),
  }) as DOMRect

  await realClick(trigger!)

  // 面板: body 直下带 fixed class 的 div
  const panel = [...document.body.children].find(
    el => el.tagName === 'DIV' && (el as HTMLElement).className.includes('fixed'),
  ) as HTMLElement | undefined
  expect(panel).toBeTruthy()

  // 期望 (布局坐标 = 显示坐标 ÷ 0.9): left=510, top=(121+4)/0.9≈138.89, minWidth=58.8/0.9≈65.33
  // 旧 bug (直接写显示坐标): left=459, top=125 → 渲染后显示 413.1/112.5, 向左上偏
  expect(parseFloat(panel!.style.left)).toBeCloseTo(510, 4)
  expect(parseFloat(panel!.style.top)).toBeCloseTo(125 / 0.9, 4)
  expect(parseFloat(panel!.style.minWidth)).toBeCloseTo(58.8 / 0.9, 4)
  expect(parseFloat(panel!.style.left)).not.toBe(459)
})