/**
 * 图表工作台单 pane 封装 — 顶栏 + 数据 + 图表 + 信号 + 范围 + 联动 + 绘图。
 *
 * 职责边界:
 * - ChartTopbar 的语义化 patch (toggleIndicator/toggleSignal 等) 在这里转译为 PaneConfig 更新;
 * - 信号检测 (detectSignals) 只在有开关且数据就绪时执行, 产出 markers 直接喂给图表;
 * - 可见范围快捷栏: range key → 该周期目标根数 → dataZoom dispatch;
 * - 图间联动 (P1): chartReady 拿实例后注册 ChartSync 总线 — updateAxisPointer/dataZoom
 *   事件广播 (isApplying 防回环, 缩放 rAF 节流), 收端由总线 dispatch;
 * - 绘图工具 (P2 前半): workspace 级 drawTool 非 cursor 时本 pane 进入绘制态 —
 *   zr mousedown 起锚 / mousemove 预览 / mouseup 落定, convertFromPixel 换算数据坐标,
 *   持久化 per symbol (联动开 = 同股窗格共享库; 关 = 每窗独立库),
 *   落笔走读-改-写 (库最新态 + append, 防旧快照覆盖他窗图形),
 *   渲染经 externalDrawings 数据坐标锚定;
 * - 高度自适应: ResizeObserver 实测图表区容器。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ECharts } from 'echarts'
import { AlertCircle, Eraser, Link2, Loader2, Search, Unlink } from 'lucide-react'
import { EChartsCandlestick } from '@/components/EChartsCandlestick'
import { ChartTopbar, type ChartTopbarPatch } from './ChartTopbar'
import { useChartPaneData } from './useChartPaneData'
import { detectSignals } from './signals'
import { rangeBars, zoomForBars } from './ranges'
import { useChartSync } from './ChartSyncContext'
import { DEFAULT_DRAW_STYLE, loadDrawings, paneDrawingsStorageKey, saveDrawings, type DrawPoint, type DrawTool, type DrawingObject } from './drawings'
import type { PaneConfig } from './useChartLayout'

interface Props {
  pane: PaneConfig
  /** workspace 级当前绘图工具 (cursor = 非绘制态) */
  drawTool: DrawTool
  /** 绘图图形库共享开关 (开 = per-symbol 共享库 + 跨窗同步; 关 = 本窗独立库) */
  syncDrawings: boolean
  onChange: (patch: Partial<PaneConfig>) => void
  /** 键盘快捷键作用窗: 多窗时仅激活窗响应 ←→↑↓ 平移缩放 (点击窗格激活) */
  isActive?: boolean
  /** 点击本窗任意位置 → 设为激活窗格 */
  onActivate?: () => void
  /** 绘图工具快捷键回调 (Alt+T/H/F/R/C, Esc → cursor); 切的是 workspace 级工具 */
  onDrawTool?: (tool: DrawTool) => void
  /** 双击重置协调信号 (Chart 层按「重置联动」开关派发): 值递增 = 本窗执行一次重置 */
  resetSignal?: number
  /** 双击重置请求上报 (EChartsCandlestick → 本窗 → Chart 层按开关决定联动范围) */
  onResetRequest?: () => void
}

/** 容器高度自适应: ResizeObserver 实测 clientHeight (0 = 未挂载/隐藏)。 */
function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  return [ref, height] as const
}

/** 图形 id: 时间戳 + 随机段, 避免依赖 crypto.randomUUID 兼容性。 */
function nextDrawId(): string {
  return `d${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function ChartPane({ pane, drawTool, syncDrawings, onChange, isActive = false, onActivate, onDrawTool, resetSignal, onResetRequest }: Props) {
  const { data, isLoading, error, loadMore, canLoadMore, isLoadingMore } = useChartPaneData(pane.symbol, pane.period)
  const syncApi = useChartSync()

  // ── 图表实例与数据快照 (联动/绘图的命令式层都走 ref, 不触发 re-render) ──
  const chartRef = useRef<ECharts | null>(null)
  const datesRef = useRef<string[]>([])
  const dates = useMemo(() => (data ? data.map(d => d.date) : []), [data])
  datesRef.current = dates
  // dataZoom 监听器闭包需要实时取 range/period (handleChartReady 的 useCallback deps 不含二者)
  const rangeKeyRef = useRef(pane.range)
  rangeKeyRef.current = pane.range
  const periodRef = useRef(pane.period)
  periodRef.current = pane.period
  // 联动监听器闭包防固化: zr/chart 事件只在 chartReady 时挂一次, 实例不重建就不重挂,
  // 后续 sync 模式/symbol 变化必须经 ref 取最新值 (否则切独立后仍广播、后选股不绘制)
  const paneSyncRef = useRef(pane.sync)
  paneSyncRef.current = pane.sync
  // dataZoom 监听里的 range 高亮清除经 ref 取最新 onChange (监听器只随 chartReady 重挂)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // 双击重置协调: 本窗收到重置信号 (开 = 全窗一起, 关 = 仅本窗) 时, EChartsCandlestick
  // 的 performReset 带 __snSuppressXZoom 抑制计数 (监听器豁免不清高亮), 需在此同步清除
  // 范围栏高亮 — 与手动缩放偏离档位后的行为同语义 (窗口已是 60 根, 任何档位都不匹配)。
  const prevResetSignalRef = useRef(resetSignal)
  useEffect(() => {
    if (resetSignal === prevResetSignalRef.current) return
    prevResetSignalRef.current = resetSignal
    onChangeRef.current?.({ range: null })
  }, [resetSignal])  // 键盘快捷键回调经 ref 取最新值 (keydown effect 只随 isActive 重挂)
  const onDrawToolRef = useRef(onDrawTool)
  onDrawToolRef.current = onDrawTool

  // ── 信号标记: 开关全关或数据未就绪时不产出 ──
  const anySignal = !!(pane.signals.maCross || pane.signals.rsiDivergence)
  const markers = useMemo(() => {
    if (!anySignal || !data || data.length === 0) return undefined
    return detectSignals(data, {
      maCross: pane.signals.maCross,
      rsiDivergence: pane.signals.rsiDivergence,
    })
  }, [anySignal, data, pane.signals.maCross, pane.signals.rsiDivergence])

  // ── 可见范围快捷栏: range key → 目标根数 → dataZoom ──
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !pane.range || !data || data.length === 0) return
    const bars = rangeBars(pane.range, pane.period)
    const zoom = bars === 'all' ? { start: 0, end: 100 } : zoomForBars(bars, data.length)
    // __snSuppressXZoom: 程序设置的窗口 — 监听器在抑制期间不清高亮不广播
    // (EChartsCandlestick 重建恢复旧窗口/setOption 瞬时 {0,100} 都不得误判成用户缩放)
    ;(chart as any).__snSuppressXZoom = ((chart as any).__snSuppressXZoom ?? 0) + 1
    window.setTimeout(() => {
      const c = chart as any
      c.__snSuppressXZoom = Math.max(0, (c.__snSuppressXZoom ?? 1) - 1)
    }, 0)
    // dataZoomIndex: 0 只动 X 轴窗口 — 不带 index 会同时打到全部 Y 窗口打飞价格视野
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: zoom.start, end: zoom.end })
  }, [pane.range, pane.period, data])

  // ── 绘图: 状态 + per symbol+period 持久化 + 绘制中草稿 ──
  const [drawings, setDrawings] = useState<DrawingObject[]>([])
  const [pending, setPending] = useState<DrawingObject | null>(null)
  const drawToolRef = useRef<DrawTool>(drawTool)
  drawToolRef.current = drawTool
  const draftRef = useRef<DrawingObject | null>(null)

  useEffect(() => {
    // symbol / pane / 绘图联动开关切换 → 重载对应库
    // (开 = per-symbol 共享库, 同股窗格跨周期共享; 关 = 本窗独立库)
    setDrawings(loadDrawings(pane.symbol, syncDrawings ? undefined : paneDrawingsStorageKey(pane.id, pane.symbol)))
    draftRef.current = null
    setPending(null)
  }, [pane.id, pane.symbol, syncDrawings])

  // 绘图库路由: 联动开 = 共享库 (storeKey undefined → drawings.ts 默认 key);
  // 关 = 本窗独立库。zr 监听器闭包不随 render 重挂, 经 ref 取最新路由。
  const syncDrawingsRef = useRef(syncDrawings)
  syncDrawingsRef.current = syncDrawings
  const drawingsStoreKeyRef = useRef<string | undefined>(undefined)
  drawingsStoreKeyRef.current = syncDrawings
    ? undefined
    : paneDrawingsStorageKey(pane.id, pane.symbol)

  // 绘图落库按 symbol (图形库跟标的走); ref 保证总线回调里取最新 symbol
  const paneSymbolRef = useRef(pane.symbol)
  paneSymbolRef.current = pane.symbol

  const commitDrawing = useCallback((obj: DrawingObject) => {
    const symbol = paneSymbolRef.current
    const storeKey = drawingsStoreKeyRef.current
    // 读-改-写: 落笔时从存储取库最新态再追加 — 本地 state 可能落后于库
    // (他窗落笔的广播 refresh 偶发未达), 用旧快照整库覆盖会丢他窗图形
    const next = [...loadDrawings(symbol, storeKey), obj]
    saveDrawings(symbol, next, storeKey)
    setDrawings(next)
    // 绘图联动: 同 symbol 其他窗重载共享库即时显示 (关 = 独立库, 不广播)
    if (syncDrawingsRef.current) syncApi?.broadcastDrawingsChanged(pane.id, symbol)
  }, [syncApi, pane.id])

  const clearDrawings = useCallback(() => {
    const symbol = paneSymbolRef.current
    const storeKey = drawingsStoreKeyRef.current
    draftRef.current = null
    setPending(null)
    setDrawings([])
    saveDrawings(symbol, [], storeKey)
    if (syncDrawingsRef.current) syncApi?.broadcastDrawingsChanged(pane.id, symbol)
  }, [syncApi, pane.id])

  /** 总线绘图联动回调: 同 symbol 其他窗落笔/清空 → 重载共享库 */
  const refreshDrawings = useCallback(() => {
    setDrawings(loadDrawings(paneSymbolRef.current, drawingsStoreKeyRef.current))
  }, [])

  const externalDrawings = useMemo(
    () => (pending ? [...drawings, pending] : drawings),
    [drawings, pending],
    // PERF(backlog C): pending 是拖拽预览草稿, mousemove 每秒几十次 setPending →
    // 本数组每次变化 → EChartsCandlestick 的 setOption effect 触发
    // chart.setOption(option, true) notMerge 全量重建整张图 (K线+MA×4+全部副图
    // +BOLL带+markPoint, 单次 ~3-10ms), 即"预览只是一条线在动, 却每帧重建全图"。
    // 触发线: 拖拽画线肉眼掉帧 / Performance 面板出现 long task。
    // 优化思路: 预览线摘出 option 数据流 — zr graphic 命令式画临时线 (零 setOption),
    // 落笔时才走一次正式渲染; 或退而只对 markLine 增量 merge。
    // 当前实测跟手, 按渐进式原则等真实掉帧信号再动 (命令式改造有回归风险)。
  )

  /** 像素 → 数据坐标锚点 (仅 grid 0 主图区内有效; 类目轴四舍五入取整到最近 K 线)。 */
  const pixelToAnchor = useCallback((chart: ECharts, x: number, y: number): DrawPoint | null => {
    if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null
    const coord = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, y])
    const idx = Math.round(Number(Array.isArray(coord) ? coord[0] : NaN))
    const price = Number(Array.isArray(coord) ? coord[1] : NaN)
    const ds = datesRef.current
    if (!Number.isFinite(idx) || idx < 0 || idx >= ds.length || !Number.isFinite(price)) return null
    return { date: ds[idx], price }
  }, [])

  /** 联动定位点: x 为 idx 像素, y 从上往下扫描出主图 grid 内的第一个合法像素。
 *  axisTrigger 要求 x/y 落在 grid 内才处理 axesInfo; 主副图间的间隙 (信息栏/间距)
 *  会使 getHeight()/2 之类取点失手, containPixel 扫描步进 4px 微秒级、稳定命中。 */
  const getSyncPoint = useCallback((idx: number): [number, number] | null => {
    const chart = chartRef.current
    if (!chart) return null
    const px = chart.convertToPixel({ xAxisIndex: 0 }, idx)
    if (!Number.isFinite(px)) return null
    const h = chart.getHeight()
    for (let y = 4; y < h; y += 4) {
      if (chart.containPixel({ gridIndex: 0 }, [px, y])) return [px, y]
    }
    return null
  }, [])

  // ── 联动 + 绘制: chartReady 时统一挂监听 (实例重建后自动重挂) ──
  const zoomRafRef = useRef(0)
  const handleChartReady = useCallback((chart: ECharts | null) => {
    chartRef.current = chart
    if (!chart) return

    // 缩放广播 + range 高亮维护: 只关心 X 轴窗口 (dataZoom index 0) —
    // Y 组件 (1+g) 的滚轮/拖拽/dispatch 也触发本事件, 带 dataZoomIndex>0 直接跳过
    chart.on('dataZoom', (params: any) => {
      if (typeof params?.dataZoomIndex === 'number' && params.dataZoomIndex > 0) return
      const ds = datesRef.current
      const opt = chart.getOption() as any
      const z = opt?.dataZoom?.[0]
      if (!z || ds.length === 0) return
      // 程序窗口操作期间 (setOption 重建 / 范围栏切档 dispatch 抑制计数):
      // 一切 X 事件豁免 — 不清高亮不广播 (恢复窗口与 setOption 瞬时 {0,100} 都非用户缩放)
      if (((chart as any).__snSuppressXZoom ?? 0) > 0) return
      // 程序设置窗口 (范围栏切档 / 组件初始 initialZoom 恢复) 与本 pane 的 range
      // 期望一致时不广播 — 「范围栏不联动」是既定设计, 用户手动缩放偏离期望窗口才联动。
      // (初始加载的 initialZoom dispatch 若不抑制, 会把幽灵窗口广播给对端互相污染)
      const bars = rangeBars(rangeKeyRef.current, periodRef.current)
      const expected = bars === 'all'
        ? { start: 0, end: 100 }
        : zoomForBars(bars, ds.length)
      const matchesExpected = Math.abs(z.start - expected.start) < 0.01 && Math.abs(z.end - expected.end) < 0.01
      // 实际窗口偏离 range 档位期望 (手动滚轮/键盘缩放/双击重置/联动跟随) → 清范围栏高亮:
      // 高亮只在「实际窗口 = 档位期望」时保留, 与 TV 时间轴范围指示同语义;
      // 阈值 0.5 容忍程序 dispatch 的浮点尾差, 不与广播抑制 (0.01) 混用
      if (rangeKeyRef.current && !matchesExpected
        && (Math.abs(z.start - expected.start) >= 0.5 || Math.abs(z.end - expected.end) >= 0.5)) {
        onChangeRef.current?.({ range: null })
      }
      if (!syncApi || syncApi.isApplying(pane.id) || paneSyncRef.current !== 'follow') return
      if (matchesExpected) return
      const i0 = Math.max(0, Math.floor((ds.length * z.start) / 100))
      const i1 = Math.min(ds.length - 1, Math.ceil((ds.length * z.end) / 100) - 1)
      if (i1 <= i0) return
      const t0 = ds[i0]
      const t1 = ds[i1]
      if (!zoomRafRef.current) {
        zoomRafRef.current = window.requestAnimationFrame(() => {
          zoomRafRef.current = 0
          syncApi.broadcastZoom(pane.id, t0, t1)
        })
      }
    })

    // 十字光标广播: hover 的 date → 总线 (轻量, 不节流)
    chart.on('updateAxisPointer', (event: any) => {
      if (!syncApi || syncApi.isApplying(pane.id) || paneSyncRef.current !== 'follow') return
      const ds = datesRef.current
      const axesInfo = event?.axesInfo
      let foundIdx = -1
      if (axesInfo) {
        for (const info of Object.values(axesInfo)) {
          const v = (info as any)?.value
          if (v == null) continue
          const idx = typeof v === 'number' ? v : ds.indexOf(v)
          if (idx >= 0 && idx < ds.length) { foundIdx = idx; break }
        }
      }
      if (foundIdx < 0) return
      syncApi.broadcastCrosshair(pane.id, ds[foundIdx])
    })

    // 鼠标离开本 pane → 广播清除各窗十字光标
    chart.getZr().on('globalout', () => {
      if (!syncApi || paneSyncRef.current !== 'follow') return
      syncApi.broadcastCrosshair(pane.id, null)
    })

    // 绘制交互: tool 非 cursor 时接管 (永久挂载, handler 内查 ref, 实例重建后不丢)
    const zr = chart.getZr()
    zr.on('mousedown', (e: { offsetX: number; offsetY: number }) => {
      const tool = drawToolRef.current
      if (tool === 'cursor' || !paneSymbolRef.current || datesRef.current.length === 0) return
      const a = pixelToAnchor(chart, e.offsetX, e.offsetY)
      if (!a) return
      if (tool === 'hline') {
        // 水平线: 单点即时落定
        commitDrawing({ id: nextDrawId(), tool, points: [a], style: { ...DEFAULT_DRAW_STYLE } })
        return
      }
      const draft: DrawingObject = { id: nextDrawId(), tool, points: [a, a], style: { ...DEFAULT_DRAW_STYLE } }
      draftRef.current = draft
      setPending(draft)
    })
    zr.on('mousemove', (e: { offsetX: number; offsetY: number }) => {
      const draft = draftRef.current
      if (!draft) return
      const b = pixelToAnchor(chart, e.offsetX, e.offsetY)
      if (!b) return
      draft.points = [draft.points[0], b]
      setPending({ ...draft, points: [draft.points[0], b] })
    })
    zr.on('mouseup', (e: { offsetX: number; offsetY: number }) => {
      const draft = draftRef.current
      draftRef.current = null
      if (!draft) return
      const b = pixelToAnchor(chart, e.offsetX, e.offsetY)
      if (b) draft.points = [draft.points[0], b]
      const [p0, p1] = draft.points
      // 无效图形 (两点重合: 线无长度 / 矩形无面积 / 斐波无高低) → 丢弃
      if (p0.date === p1.date && p0.price === p1.price) {
        setPending(null)
        return
      }
      commitDrawing(draft)
      setPending(null)
    })
  }, [syncApi, pane.id, commitDrawing, pixelToAnchor])

  useEffect(() => () => { if (zoomRafRef.current) window.cancelAnimationFrame(zoomRafRef.current) }, [])

  // ── 键盘快捷键 (仅激活窗; TV 同款): ←→ 平移 / ↑↓ 缩放 / Alt+T/H/F/R/C 绘图工具 / Esc 光标 ──
  // 输入框聚焦时全部跳过 (搜索/快捷键互不干扰); 平移缩放直 dispatch 本窗 dataZoom[0],
  // 缩放联动开着时自然随事件广播到跟随窗 (与滚轮缩放同一条链路)。
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // 绘图工具: Alt+字母 (e.code 免键盘布局差异); Esc / Alt+C 回光标
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const toolMap: Record<string, DrawTool> = {
          KeyT: 'trendline', KeyH: 'hline', KeyF: 'fib', KeyR: 'rect', KeyC: 'cursor',
        }
        const tool = toolMap[e.code]
        if (tool) {
          e.preventDefault()
          onDrawToolRef.current?.(tool)
          return
        }
      }
      if (e.key === 'Escape') {
        onDrawToolRef.current?.('cursor')
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const chart = chartRef.current
      if (!chart) return
      const opt = chart.getOption() as any
      const z = opt?.dataZoom?.[0]
      if (!z) return
      const s = Number(z.start ?? 0)
      const en = Number(z.end ?? 100)
      const w = en - s
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // 平移: 每次按键挪 1/10 可见窗口 (TV 同量级), 边界夹住不越界
        e.preventDefault()
        const step = Math.max(w * 0.1, 0.5)
        const ns = Math.max(0, Math.min(100 - w, e.key === 'ArrowLeft' ? s + step : s - step))
        // dataZoomIndex: 0 只动 X — 不带 index 会打飞全部 Y 窗口 (K 线出视野)
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: ns, end: ns + w })
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // 缩放: ↑ 放大 (窗口收窄 0.8x), ↓ 缩小 (放宽 1.25x), 以可见窗口中心为锚
        e.preventDefault()
        const nw = Math.max(0.5, Math.min(100, w * (e.key === 'ArrowUp' ? 0.8 : 1.25)))
        const c = (s + en) / 2
        let ns = c - nw / 2
        if (ns < 0) ns = 0
        if (ns + nw > 100) ns = 100 - nw
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: ns, end: ns + nw })
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive])

  // ── 联动注册: symbol / sync 变化时刷新总线句柄 ──
  useEffect(() => {
    if (!syncApi) return
    syncApi.register({
      id: pane.id,
      sync: pane.sync,
      symbol: pane.symbol,
      period: pane.period,
      getChart: () => chartRef.current,
      getDates: () => datesRef.current,
      getSyncPoint,
      refreshDrawings,
    })
    return () => syncApi.unregister(pane.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncApi])

  useEffect(() => {
    syncApi?.updateHandle({
      id: pane.id,
      sync: pane.sync,
      symbol: pane.symbol,
      period: pane.period,
      getChart: () => chartRef.current,
      getDates: () => datesRef.current,
      getSyncPoint,
      refreshDrawings,
    })
  }, [syncApi, pane.id, pane.sync, pane.symbol, pane.period])

  // ── 顶栏 patch → PaneConfig 更新转译 ──
  const handleTopbarChange = useCallback((patch: ChartTopbarPatch) => {
    if (patch.symbol !== undefined) {
      onChange({ symbol: patch.symbol, name: patch.name, range: pane.range })
      return
    }
    const next: Partial<PaneConfig> = {}
    if (patch.period) next.period = patch.period
    if (patch.chartStyle) next.chartStyle = patch.chartStyle
    if (patch.range !== undefined) next.range = patch.range
    if (patch.toggleIndicator) {
      next.activeIndicators = pane.activeIndicators.includes(patch.toggleIndicator)
        ? pane.activeIndicators.filter(k => k !== patch.toggleIndicator)
        : [...pane.activeIndicators, patch.toggleIndicator]
    }
    if (patch.toggleSignal) {
      next.signals = { ...pane.signals, [patch.toggleSignal]: !pane.signals[patch.toggleSignal] }
    }
    if (Object.keys(next).length > 0) onChange(next)
  }, [onChange, pane.activeIndicators, pane.range, pane.signals])

  // 图表区高度自适应
  const [chartBoxRef, chartBoxH] = useElementHeight<HTMLDivElement>()
  const hasData = data != null && data.length > 0
  const drawing = drawTool !== 'cursor' && !!pane.symbol

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border transition-colors ${
        isActive ? 'border-accent/50' : 'border-border/60'
      } bg-surface`}
      onPointerDown={onActivate}
    >
      <ChartTopbar
        symbol={pane.symbol}
        name={pane.name}
        period={pane.period}
        chartStyle={pane.chartStyle}
        activeIndicators={pane.activeIndicators}
        range={pane.range}
        signals={pane.signals}
        onChange={handleTopbarChange}
      />

      {/* pane 角落操作: 联动模式切换 + 清空图形 */}
      <div className="absolute right-1.5 top-11 z-10 flex items-center gap-1">
        <button
          type="button"
          title={pane.sync === 'follow' ? '跟随联动 (点击切独立)' : '独立窗 (点击切跟随)'}
          className={`
            rounded-md border border-border/60 bg-surface/90 p-1 text-secondary transition-colors
            hover:border-accent/50 hover:text-accent
            ${pane.sync === 'follow' ? 'text-accent' : ''}
          `}
          onClick={() => onChange({ sync: pane.sync === 'follow' ? 'independent' : 'follow' })}
        >
          {pane.sync === 'follow' ? <Link2 size={13} /> : <Unlink size={13} />}
        </button>
        {drawings.length > 0 && (
          <button
            type="button"
            title="清空本窗图形"
            className="rounded-md border border-border/60 bg-surface/90 p-1 text-secondary transition-colors hover:border-danger/50 hover:text-danger"
            onClick={clearDrawings}
          >
            <Eraser size={13} />
          </button>
        )}
      </div>

      <div
        ref={chartBoxRef}
        // 分屏兼容: 副图多而窗格矮时 canvas 会按最小需求撑高 (EChartsCandlestick
        // 内部 Math.max), 改为纵向可滚 — 超出部分拖滚动条查看, 不再被直接裁掉
        className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${drawing ? 'cursor-crosshair' : ''}`}
      >
        {!pane.symbol ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <Search className="h-6 w-6 opacity-50" />
            <div className="text-xs">在上方搜索框输入代码 / 名称选择标的</div>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <AlertCircle className="h-6 w-6 text-danger/70" />
            <div className="text-xs">行情数据加载失败</div>
            <div className="font-mono text-[10px] opacity-70">{String((error as Error)?.message ?? error)}</div>
          </div>
        ) : isLoading || !hasData || chartBoxH <= 0 ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 className="h-5 w-5 animate-spin opacity-70" />
          </div>
        ) : (
          <EChartsCandlestick
            data={data}
            markers={markers}
            height={chartBoxH}
            showMA
            chartStyle={pane.chartStyle}
            // RSI 副图固定零轴震荡形态 (RSI-50, ±50) — 工作台既定形态, 无开关
            rsiZeroAxis
            activeIndicators={pane.activeIndicators}
            externalDrawings={externalDrawings}
            chartReady={handleChartReady}
            // symbol 必传: 组件内 [_symbol, data.length] 重置效应 (Y 轴缩放/悬停上下文)
            // 依赖它 — 不传则切股到同长度邻股 (如都取满 500 根日K) 时旧状态残留
            symbol={pane.symbol}
            // 初始窗口与范围栏语义一致 (rangeBars: 无档位 → 默认 60 根「最佳窗口」,
            // 与双击重置同口径; 显式「全部」档才全量) — 不传组件默认也是 60 根
            visibleBars={rangeBars(pane.range, pane.period)}
            // 绘图模式下图内拖拽让位给画线 (禁用 Y 平移)
            panEnabled={drawTool === 'cursor'}
            // 双击重置协调: 双击只上报 → Chart 层按开关派发 resetSignal 统一驱动重置
            resetSignal={resetSignal}
            onResetZoom={onResetRequest}
            // 「往左加载更多」: 拖到 X 左边界触发 (日K路径); 防重复由 canLoadMore/isLoadingMore 控制
            onLoadMoreLeft={() => { if (canLoadMore && !isLoadingMore) loadMore() }}
          />
        )}
      </div>
    </div>
  )
}
