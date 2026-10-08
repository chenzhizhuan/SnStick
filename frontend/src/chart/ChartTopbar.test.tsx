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
          activeIndicators={['macd', 'rsi']}
          onChange={onChange}
        />
      </QueryClientProvider>,
    )
  })
}

it('指标按钮只有 MACD 与 RSI (成交量/KDJ/OBV/CCI/BOLL 已移除)', async () => {
  const patches: ChartTopbarPatch[] = []
  renderTopbar(p => patches.push(p))

  const labels = [...document.querySelectorAll('button')].map(b => b.textContent?.trim())
  expect(labels).toContain('MACD')
  expect(labels).toContain('RSI')
  for (const gone of ['成交量', 'KDJ', 'OBV', 'CCI', 'BOLL', 'RSI零轴']) {
    expect(labels).not.toContain(gone)
  }

  // 点击 RSI 关闭 → toggleIndicator patch
  const rsiBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'RSI')
  await act(async () => { rsiBtn!.click() })
  expect(patches.some(p => p.toggleIndicator === 'rsi')).toBe(true)
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