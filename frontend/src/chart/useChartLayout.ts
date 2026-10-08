/**
 * 图表工作台布局模型与持久化 — pane 配置的唯一权威。
 *
 * P0: 单图工作区, localStorage 持久化 (key: stick.chart-workspace.v1, 800ms 防抖);
 * P1: 接入后端 preferences.chart_workspace (照抄 saveDashboardLayout 模式) + 分屏模板渲染。
 *
 * normalizeWorkspace 是外部数据 (localStorage / 后端 blob) 进入渲染前的唯一入口:
 * 模板枚举校验、pane 数量对齐 (缩位丢尾部 / 扩位克隆已有配置)、字段逐项兜底。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PERIODS, DEFAULT_PERIOD, type Period } from './periods'
import type { ChartStyle } from './ChartTopbar'
import type { DrawTool } from './drawings'

const DRAW_TOOL_KEYS = ['cursor', 'trendline', 'hline', 'fib', 'rect'] as const

/** 工作台可用的副图指标 (只保留 MACD/RSI)。
 *  EChartsCandlestick SUB_CHARTS 里的其余指标 (vol/kdj/obv/cci) 与 BOLL 叠加
 *  供其他页面 (个股弹窗/指数页) 使用, 工作台层不再暴露; 旧持久化里的
 *  已废弃 key 由 normalizePane 过滤, 避免无按钮可关的幽灵副图。 */
export const PANE_INDICATORS: readonly string[] = ['macd', 'rsi']

/** 信号开关 (默认全关, TV 同款按需开启) */
export interface PaneSignals {
  /** MA5×MA10 金叉/死叉标记 */
  maCross?: boolean
  /** RSI(14) 顶背离徽章 */
  rsiDivergence?: boolean
}

export interface PaneConfig {
  id: string
  symbol: string
  name?: string
  period: Period
  chartStyle: ChartStyle
  /** 已激活副图 key 列表 (工作台仅 macd/rsi) */
  activeIndicators: string[]
  /** 当前可见范围 key; 手动缩放后置 null (高亮清除) */
  range?: string | null
  signals: PaneSignals
  /** P1: 联动模式 (follow 参与 symbol/十字光标/缩放联动) */
  sync: 'follow' | 'independent'
}

/** 分屏模板 — TV 式固定模板 */
export type SplitTemplate = '1' | '2h' | '2v' | '4' | '1+3'

/** 图间联动全局开关 (仅 sync='follow' 的 pane 参与; 绘图为数据共享语义另见字段) */
export interface SyncSwitches {
  crosshair: boolean
  zoom: boolean
  symbol: boolean
  /** 绘图图形库共享: 开 = 同股窗格共享图形并实时同步; 关 = 每窗独立存储 */
  drawings: boolean
  /** 双击重置联动: 开 = 双击任一窗全部窗格一起重置(各自最佳窗口+Y归位); 关 = 只重置当前窗 */
  reset: boolean
}

export interface ChartWorkspace {
  v: 1
  template: SplitTemplate
  panes: PaneConfig[]
  /** 图间联动全局开关 */
  sync: SyncSwitches
  /** 当前选中的绘图工具 (cursor = 非绘制态) */
  drawTool: DrawTool
  /** 双窗模板 (横2/竖2) 的分隔比例: 首窗占比 0.2-0.8, 默认 0.5; 切模板时重置 */
  splitRatio: number
}

const STORAGE_KEY = 'stick.chart-workspace.v1'

const CHART_STYLES: readonly ChartStyle[] = ['candle', 'hollow', 'line', 'area']
const TEMPLATES: readonly SplitTemplate[] = ['1', '2h', '2v', '4', '1+3']

/** 模板对应 pane 数量: 1 / 横2 / 竖2 / 2×2 / 1+3。 */
export function templatePanes(t: SplitTemplate): number {
  return t === '1' ? 1 : t === '2h' || t === '2v' ? 2 : 4
}

export function defaultPane(id: string, opts: { symbol?: string; name?: string; period?: Period } = {}): PaneConfig {
  return {
    id,
    symbol: opts.symbol ?? '',
    name: opts.name,
    period: opts.period ?? DEFAULT_PERIOD,
    chartStyle: 'candle',
    activeIndicators: ['macd', 'rsi'],
    range: null,
    signals: {},
    sync: 'follow',
  }
}

/** 首次进入的默认工作区: 贵州茅台 横2分屏, 左 1小时 / 右 4小时。 */
export function defaultWorkspace(): ChartWorkspace {
  return {
    v: 1,
    template: '2h',
    panes: [
      defaultPane('pane-1', { symbol: '600519.SH', name: '贵州茅台', period: '60m' }),
      defaultPane('pane-2', { symbol: '600519.SH', name: '贵州茅台', period: '4h' }),
    ],
    sync: { crosshair: true, zoom: true, symbol: true, drawings: true, reset: true },
    drawTool: 'cursor',
    splitRatio: 0.5,
  }
}

/** 单 pane blob 规范化: 字段逐项兜底, 非法值回落默认。 */
function normalizePane(raw: unknown, id: string): PaneConfig {
  const base = defaultPane(id)
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  const period = typeof r.period === 'string' && PERIODS.some(p => p.key === r.period)
    ? (r.period as Period)
    : base.period
  const chartStyle = CHART_STYLES.includes(r.chartStyle as ChartStyle)
    ? (r.chartStyle as ChartStyle)
    : base.chartStyle
  return {
    id,
    symbol: typeof r.symbol === 'string' ? r.symbol : '',
    name: typeof r.name === 'string' ? r.name : undefined,
    period,
    chartStyle,
    activeIndicators: Array.isArray(r.activeIndicators)
      // 过滤白名单 + 去重 (手改 localStorage 的重复 key 会渲染出重复副图)
      ? Array.from(new Set(
          r.activeIndicators.filter(
            (k): k is string => typeof k === 'string' && PANE_INDICATORS.includes(k),
          ),
        )).slice(0, 12)
      : base.activeIndicators,
    range: typeof r.range === 'string' ? r.range : null,
    signals: typeof r.signals === 'object' && r.signals !== null ? (r.signals as PaneSignals) : {},
    sync: r.sync === 'independent' ? 'independent' : 'follow',
  }
}

/**
 * 工作区 blob 规范化 → 可渲染状态。
 * pane 数量对齐模板: 缩位丢尾部 (i<n 截断), 扩位克隆已有 pane 配置 (TV 行为);
 * 空/损坏 blob 回退默认单图工作区, 保证页面永远可用。
 */
export function normalizeWorkspace(raw: unknown): ChartWorkspace {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  // 无任何持久化数据 (首次进入 / localStorage 清空) → 默认工作区 (贵州茅台 横2)
  if (!obj) return defaultWorkspace()
  const template = TEMPLATES.includes(obj?.template as SplitTemplate)
    ? (obj!.template as SplitTemplate)
    : '2h'
  const rawPanes = Array.isArray(obj?.panes) ? (obj!.panes as unknown[]) : []
  const n = templatePanes(template)
  const panes: PaneConfig[] = []
  for (let i = 0; i < n; i++) {
    // 扩位时缺位克隆最后一个已有配置 (无任何 pane 时回落默认)
    const src = rawPanes.length > 0 ? rawPanes[Math.min(i, rawPanes.length - 1)] : undefined
    panes.push(normalizePane(src, `pane-${i + 1}`))
  }
  const s = (typeof obj?.sync === 'object' && obj!.sync !== null ? obj!.sync : {}) as Record<string, unknown>
  const drawTool = DRAW_TOOL_KEYS.includes(obj?.drawTool as DrawTool)
    ? (obj!.drawTool as DrawTool)
    : 'cursor'
  // 旧持久化数据无 splitRatio → 默认均分; 越界值夹回合法区间 (拖拽中途崩溃存下的脏值)
  const splitRatioRaw = typeof obj?.splitRatio === 'number' && Number.isFinite(obj.splitRatio)
    ? (obj!.splitRatio as number)
    : 0.5
  const splitRatio = Math.min(0.8, Math.max(0.2, splitRatioRaw))
  return {
    v: 1,
    template,
    panes,
    sync: { crosshair: s.crosshair !== false, zoom: s.zoom !== false, symbol: s.symbol !== false, drawings: s.drawings !== false, reset: s.reset !== false },
    drawTool,
    splitRatio,
  }
}

/** 读取 localStorage 的持久化工作区 (无/损坏 → 默认)。 */
function loadWorkspace(): ChartWorkspace {
  try {
    return normalizeWorkspace(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? ''))
  } catch {
    return normalizeWorkspace(null)
  }
}

/** 工作台状态 hook: 持有 workspace, 800ms 防抖写回 localStorage。 */
export function useChartWorkspace() {
  const [workspace, setWorkspace] = useState<ChartWorkspace>(loadWorkspace)
  const timerRef = useRef<number>()

  useEffect(() => {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace))
      } catch {
        // 写满/隐私模式等场景静默失败, 不阻塞使用
      }
    }, 800)
    return () => window.clearTimeout(timerRef.current)
  }, [workspace])

  /** 更新单个 pane 配置 (patch merge) */
  const updatePane = useCallback((id: string, patch: Partial<PaneConfig>) => {
    setWorkspace(w => ({
      ...w,
      panes: w.panes.map(p => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }, [])

  /** 切换分屏模板: 缩位丢尾部 / 扩位克隆已有配置 (normalizeWorkspace 统一对齐);
   *  分隔比例随模板重置均分 (横/竖两个方向的比例语义不同, 沿用旧值体验割裂) */
  const setTemplate = useCallback((t: SplitTemplate) => {
    setWorkspace(w => normalizeWorkspace({ ...w, template: t, splitRatio: 0.5 }))
  }, [])

  /** 更新联动全局开关 */
  const setSync = useCallback((patch: Partial<SyncSwitches>) => {
    setWorkspace(w => ({ ...w, sync: { ...w.sync, ...patch } }))
  }, [])

  /** 更新当前绘图工具 */
  const setDrawTool = useCallback((tool: DrawTool) => {
    setWorkspace(w => ({ ...w, drawTool: tool }))
  }, [])

  /** 更新双窗分隔比例 (拖拽结束后提交; 越界值夹回 0.2-0.8) */
  const setSplitRatio = useCallback((r: number) => {
    setWorkspace(w => ({ ...w, splitRatio: Math.min(0.8, Math.max(0.2, r)) }))
  }, [])

  return { workspace, setWorkspace, updatePane, setTemplate, setSync, setDrawTool, setSplitRatio }
}
