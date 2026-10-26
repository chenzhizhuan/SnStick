// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChartSyncProvider,
  useChartSync,
  type ChartSyncApi,
  type PaneSyncHandle,
} from './ChartSyncContext'

/** 单调递增的伪时间标签 (nearestIndex 只依赖字典序/toNum, 格式无关)。 */
const fakeDates = (n: number) =>
  Array.from({ length: n }, (_, i) => `d${String(i).padStart(8, '0')}`)

const fullSync = {
  crosshair: true,
  zoom: true,
  symbol: true,
  drawings: true,
  reset: true,
}

function makePane(overrides: Partial<PaneSyncHandle> & { id: string }): PaneSyncHandle {
  return {
    sync: 'follow',
    symbol: '600519.SH',
    period: '60m',
    getChart: () => null,
    getDates: () => [],
    getVisibleRange: () => null,
    getSyncPoint: () => null,
    refreshDrawings: () => {},
    ...overrides,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

/** 挂载 Provider 并注册 panes, 把总线 api 抛给测试。 */
function setup(panes: PaneSyncHandle[]): ChartSyncApi {
  let api: ChartSyncApi | null = null
  const registered = new WeakMap<object, boolean>()
  const Harness = () => {
    const a = useChartSync()
    // 注册幂等 (重复 register 覆盖同 id), 收敛到首个 api 实例
    if (a && !registered.get(a)) {
      registered.set(a, true)
      panes.forEach(p => a.register(p))
    }
    if (a) api = a
    return null
  }
  act(() => {
    root.render(
      <ChartSyncProvider sync={fullSync}>
        <Harness />
      </ChartSyncProvider>,
    )
  })
  if (!api) throw new Error('sync api not ready')
  return api as ChartSyncApi
}

describe('ChartSyncContext 联动总线', () => {
  it('clamp 贴边: 悬停时间超出目标窗可见窗口时, 十字钳制到窗口边缘 dispatch (第 36 轮修复)', () => {
    const dates = fakeDates(237)
    // 模拟 60m(数据237根)+4h(窗口120根) 组合: 目标窗可见窗口 = [117, 236]
    const dispatchB = vi.fn()
    const target = makePane({
      id: 'b',
      getChart: () =>
        ({
          dispatchAction: dispatchB,
          convertFromPixel: () => [0, 100],
        }) as never,
      getDates: () => dates,
      getVisibleRange: () => [117, 236],
      // 真实语义: 窗口外 idx 像素出界 → null (旧行为下联动被整体丢弃)
      getSyncPoint: idx => (idx >= 117 && idx <= 236 ? [50, 50] : null),
    })
    const source = makePane({ id: 'a' })
    const api = setup([source, target])

    // dates[60] 在窗口 (117 起) 之外 → 旧行为: getSyncPoint(60)=null → 不 dispatch
    act(() => { api.broadcastCrosshair('a', dates[60]) })
    expect(dispatchB).toHaveBeenCalledTimes(1)
    const call = dispatchB.mock.calls[0][0] as { axesInfo: { value: number }[] }
    // 贴边: axesInfo.value = clamp(60 → 117), 目标窗十字画在窗口第一根
    expect(call.axesInfo[0].value).toBe(117)
  })

  it('clamp 上界: 悬停时间晚于目标窗数据末尾时钳制到窗口最后一根', () => {
    const dates = fakeDates(237)
    const dispatchB = vi.fn()
    const target = makePane({
      id: 'b',
      getChart: () =>
        ({
          dispatchAction: dispatchB,
          convertFromPixel: () => [0, 100],
        }) as never,
      getDates: () => dates,
      getVisibleRange: () => [0, 99], // 目标窗缩放到老区间, 只看前 100 根
      getSyncPoint: idx => (idx >= 0 && idx <= 99 ? [50, 50] : null),
    })
    const source = makePane({ id: 'a' })
    const api = setup([source, target])

    // 'd99999999' 超出目标数据 (nearestIndex 钳到 236) → 再被窗口钳到 99
    act(() => { api.broadcastCrosshair('a', 'd99999999') })
    expect(dispatchB).toHaveBeenCalledTimes(1)
    const call = dispatchB.mock.calls[0][0] as { axesInfo: { value: number }[] }
    expect(call.axesInfo[0].value).toBe(99)
  })

  it('窗口内 idx 联动行为不变 (回归锁: value 原样直传)', () => {
    const dates = fakeDates(237)
    const dispatchB = vi.fn()
    const target = makePane({
      id: 'b',
      getChart: () =>
        ({
          dispatchAction: dispatchB,
          convertFromPixel: () => [0, 100],
        }) as never,
      getDates: () => dates,
      getVisibleRange: () => [117, 236],
      getSyncPoint: () => [50, 50],
    })
    const source = makePane({ id: 'a' })
    const api = setup([source, target])

    act(() => { api.broadcastCrosshair('a', dates[150]) })
    expect(dispatchB).toHaveBeenCalledTimes(1)
    const call = dispatchB.mock.calls[0][0] as { axesInfo: { value: number }[] }
    expect(call.axesInfo[0].value).toBe(150)
  })

  it('getVisibleRange 不可用 (null) 时保持旧行为: 窗口外联动丢弃 (守卫锁)', () => {
    const dates = fakeDates(237)
    const dispatchB = vi.fn()
    const target = makePane({
      id: 'b',
      getChart: () =>
        ({
          dispatchAction: dispatchB,
          convertFromPixel: () => [0, 100],
        }) as never,
      getDates: () => dates,
      getVisibleRange: () => null,
      getSyncPoint: idx => (idx >= 117 && idx <= 236 ? [50, 50] : null),
    })
    const source = makePane({ id: 'a' })
    const api = setup([source, target])

    act(() => { api.broadcastCrosshair('a', dates[60]) })
    expect(dispatchB).not.toHaveBeenCalled()
  })
})
