/**
 * 图间联动总线 — 十字光标 / 时间缩放 / symbol 三联动 (自研, 不用 echarts.connect)。
 *
 * 为什么不用 echarts.connect(): 它按 data index 同步, 跨周期图的 index 粒度不同
 * (1分 240根/日 vs 日K 1根/日), 十字光标会错位。本总线以「时间字符串」为唯一对齐键
 * (chart/periods.ts 保证各周期 date 标签字典序兼容, 字符串可直接比较):
 *
 *   crosshair: pane A updateAxisPointer → hover 的 date → 广播 →
 *              B 在自身 dates 二分找最近 index → convertToPixel → updateAxisPointer
 *   zoom:      pane A dataZoom → 可见首尾 bar 的 [t0, t1] → 广播 →
 *              B 二分定位 + clamp → 换算自己百分比 → dispatchAction dataZoom
 *   symbol:    换股联动不走本总线 (数据流层由 Chart.tsx 遍历 follow pane 更新)
 *   drawings:  绘图联动 — 图形库 per symbol 共享 (TV 同款语义, 同股窗格跨周期共享,
 *              含独立窗), 受联动全局开关 drawings 控制; 开关关 = 每窗独立库, 不广播
 *
 * 防回环: applyingRef — 收远端事件 dispatch 前把目标 pane 标记, 目标 pane 自己的
 * 广播 listener 见标记即跳过; 宏任务 (setTimeout 0) 清除, 保证事件派发完成后再放行。
 * 十字光标轻量直接同步; 缩放广播由 pane 端 rAF 节流 (一帧一次)。
 * 联动范围: 十字光标/缩放跨标的联动 (TV 同款纯时间轴对齐, 不同股的窗也对齐同一时刻);
 * symbol 联动是另一条通道 (换股拉齐标的), 两者独立开关、互不干扰。
 */
import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ECharts } from 'echarts'
import type { SyncSwitches } from './useChartLayout'

/** pane 向总线注册的联动句柄 (symbol / sync 模式变化时由 pane 调 updateHandle 刷新) */
export interface PaneSyncHandle {
  id: string
  sync: 'follow' | 'independent'
  symbol: string
  period: string
  getChart: () => ECharts | null
  /** 当前数据的时间标签数组 (升序, 供二分定位) */
  getDates: () => string[]
  /** 联动定位点 [px, py]: px 为 idx 像素, py 为落进主图 grid 的合法像素 (扫描绕开 grid 间隙) */
  getSyncPoint: (idx: number) => [number, number] | null
  /** 重载本窗 symbol 的图形库 (收到绘图联动广播时由总线回调) */
  refreshDrawings: () => void
}

export interface ChartSyncApi {
  register: (h: PaneSyncHandle) => void
  unregister: (id: string) => void
  updateHandle: (h: PaneSyncHandle) => void
  /** 本 pane 是否正在应用远端事件 (pane 的广播 listener 先查此标记防回环) */
  isApplying: (id: string) => boolean
  broadcastCrosshair: (fromId: string, date: string | null) => void
  broadcastZoom: (fromId: string, t0: string, t1: string) => void
  /** 绘图联动: 某窗图形库变更后, 同 symbol 的其他窗重载共享库即时显示 */
  broadcastDrawingsChanged: (fromId: string, symbol: string) => void
}

const ChartSyncContext = createContext<ChartSyncApi | null>(null)

/** dates 升序数组中找与 target 最近 (字典序) 的下标; 空数组 → -1。 */
function nearestIndex(dates: string[], target: string): number {
  if (dates.length === 0) return -1
  let lo = 0
  let hi = dates.length - 1
  if (target <= dates[lo]) return lo
  if (target >= dates[hi]) return hi
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid] < target) lo = mid + 1
    else hi = mid
  }
  // lo 是第一个 >= target 的位置; 与 lo-1 比谁更近
  // date 为等宽格式串, 去非数字后转数值做距离比较 (同格式下单调且成比例)
  const toNum = (s: string) => Number(s.replace(/\D/g, ''))
  const a = dates[lo - 1]
  const b = dates[lo]
  return toNum(target) - toNum(a) <= toNum(b) - toNum(target) ? lo - 1 : lo
}

export function ChartSyncProvider({
  sync,
  children,
}: {
  sync: SyncSwitches
  children: ReactNode
}) {
  const panesRef = useRef(new Map<string, PaneSyncHandle>())
  const applyingRef = useRef(new Set<string>())
  const syncRef = useRef(sync)
  useEffect(() => { syncRef.current = sync }, [sync])

  const api = useMemo<ChartSyncApi>(() => {
    /** 目标 pane 应用远端事件 (标记防回环) */
    const applyTo = (
      id: string,
      dispatch: (chart: ECharts) => void,
      chart: ECharts | null,
    ) => {
      if (!chart) return
      applyingRef.current.add(id)
      try {
        dispatch(chart)
      } finally {
        window.setTimeout(() => applyingRef.current.delete(id), 0)
      }
    }

    return {
      register: h => { panesRef.current.set(h.id, h) },
      unregister: id => { panesRef.current.delete(id); applyingRef.current.delete(id) },
      updateHandle: h => { panesRef.current.set(h.id, h) },
      isApplying: id => applyingRef.current.has(id),

      broadcastCrosshair: (fromId, date) => {
        if (!syncRef.current.crosshair) return
        const from = panesRef.current.get(fromId)
        if (!from || from.sync !== 'follow') return
        for (const [id, h] of panesRef.current) {
          if (id === fromId || h.sync !== 'follow') continue
          // 十字光标跨标的联动 (TV 同款: 纯时间轴对齐, 不限同股)
          const chart = h.getChart()
          const dates = h.getDates()
          if (!chart || dates.length === 0) continue
          if (date == null) {
            applyTo(id, c => c.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' }), chart)
            continue
          }
          const idx = nearestIndex(dates, date)
          if (idx < 0) continue
          // x/y + axesInfo 双保险, 缺一不可:
          // - x/y 必须是落在 grid 内的合法像素: axisTrigger 对非法点 (x/y 未传) 直接
          //   shouldHide, 传入的 axesInfo 会被整体忽略, 十字不画;
          //   且 y 不可用 getHeight()/2 — 主副图间的间隙会使 containPoint 全 false,
          //   由 pane 端 getSyncPoint 扫描出主图内的合法 y
          // - axesInfo.value 直传数据下标保证数据对齐: 即使像素有亚像素误差,
          //   axisTrigger 也直接用 value, 不走 pointToData 换算 (跨股/跨周期天然对齐)
          const point = h.getSyncPoint(idx)
          if (!point) continue
          applyTo(
            id,
            c => c.dispatchAction({
              type: 'updateAxisPointer',
              currTrigger: 'mousemove',
              x: point[0],
              y: point[1],
              axesInfo: [{ axisDim: 'x', axisIndex: 0, value: idx }],
            }),
            chart,
          )
        }
      },

      broadcastZoom: (fromId, t0, t1) => {
        if (!syncRef.current.zoom) return
        const from = panesRef.current.get(fromId)
        if (!from || from.sync !== 'follow') return
        for (const [id, h] of panesRef.current) {
          if (id === fromId || h.sync !== 'follow') continue
          // 缩放跨标的联动: 时间区间 [t0,t1] 对齐 (TV 同款, 不限同股)
          const chart = h.getChart()
          const dates = h.getDates()
          if (!chart || dates.length === 0) continue
          // t0/t1 超出目标图范围时 clamp (贴到首/尾, TV 同样行为)
          const i0 = nearestIndex(dates, t0)
          const i1 = nearestIndex(dates, t1)
          if (i0 < 0 || i1 < 0 || i1 <= i0) continue
          const start = (i0 / dates.length) * 100
          const end = ((i1 + 1) / dates.length) * 100
          // dataZoomIndex: 0 必须显式指定 — 不带 index 的 dataZoom dispatch 会把
          // start/end 同时打到全部 dataZoom 组件 (含每个 grid 的 Y 窗口), 对端价格
          // 窗口被设成时间窗口的百分比 → K 线整体跑出 Y 视野 ("联动后对端 K 线不见")
          applyTo(id, c => c.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start, end }), chart)
        }
      },

      broadcastDrawingsChanged: (fromId, symbol) => {
        // 绘图联动开关关闭时不广播 (pane 端已判, 此处双保险 —
        // 关 = 每窗独立库, 同 symbol 也不重载)
        if (!syncRef.current.drawings) return
        // 图形库跟 symbol 走 (数据语义, 不受十字/缩放/symbol 联动开关与独立模式影响):
        // 同 symbol 的其他窗 (含独立窗) 重载共享库 — 锚点日期不在其数据集的图形自动跳过
        for (const [id, h] of panesRef.current) {
          if (id === fromId || h.symbol !== symbol) continue
          h.refreshDrawings()
        }
      },
    }
  }, [])

  return <ChartSyncContext.Provider value={api}>{children}</ChartSyncContext.Provider>
}

/** pane 内取联动总线 (无 Provider 时返回 null, pane 退化为独立窗)。 */
export function useChartSync(): ChartSyncApi | null {
  return useContext(ChartSyncContext)
}
