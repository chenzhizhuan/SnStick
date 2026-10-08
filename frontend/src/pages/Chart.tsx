/**
 * 图表工作台 — /chart 页面壳。
 *
 * P1: 分屏模板容器 (1 / 横2 / 竖2 / 2×2 / 1+3, TV 式固定模板) +
 *     ChartSyncProvider 图间联动 (十字光标 / 缩放 / symbol, 以时间字符串为唯一对齐键) +
 *     绘图工具竖条 + workspace 工具条 (模板切换 + 联动全局开关)。
 *
 * symbol 联动在数据流层处理 (不走 ChartSync 总线): 某窗换股且全局开关开时,
 * 其余 sync='follow' 的窗跟随换股 (周期各保各的), independent 窗不受影响。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ChartPane } from '@/chart/ChartPane'
import { ChartSyncProvider } from '@/chart/ChartSyncContext'
import { DrawingToolbar } from '@/chart/DrawingToolbar'
import { clearChartLiveSymbols, setChartLiveSymbols } from '@/chart/liveSymbols'
import { useChartWorkspace, type PaneConfig, type SplitTemplate } from '@/chart/useChartLayout'
import { cn } from '@/lib/cn'

/** 分屏模板清单 (模板 → pane 数量见 useChartLayout.templatePanes) */
const TEMPLATES: { key: SplitTemplate; label: string; title: string }[] = [
  { key: '1', label: '单图', title: '单图' },
  { key: '2h', label: '横2', title: '横向 2 窗' },
  { key: '2v', label: '竖2', title: '纵向 2 窗' },
  { key: '4', label: '4宫', title: '2×2 四窗' },
  { key: '1+3', label: '1+3', title: '左 1 大窗 + 右 3 小窗' },
]

/** 模板 → CSS grid (Tailwind); 1+3 首格另加 md:row-span-3 占满左列 */
const GRID_CLASS: Record<SplitTemplate, string> = {
  '1': 'grid-cols-1 grid-rows-1',
  '2h': 'grid-cols-2 grid-rows-1',
  '2v': 'grid-cols-1 grid-rows-2',
  '4': 'grid-cols-2 grid-rows-2',
  '1+3': 'grid-cols-[2fr_1fr] grid-rows-3',
}

function WPill({ active, label, title, onClick }: {
  active: boolean
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`
        rounded px-2 py-0.5 font-mono text-xs transition-colors
        ${active ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-surface-variant/60 hover:text-foreground'}
      `}
    >
      {label}
    </button>
  )
}

export function Chart() {
  const { workspace, updatePane, setTemplate, setSync, setDrawTool, setSplitRatio } = useChartWorkspace()

  // ── 激活窗格 (键盘快捷键作用窗): 点击任意窗激活; 首窗默认激活 ──
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const activeId = workspace.panes.some(p => p.id === activePaneId)
    ? (activePaneId as string)
    : workspace.panes[0]?.id

  // ── 双窗分隔条拖拽 (仅横2/竖2): 拖拽中本地 ratio 实时预览, 松手才提交持久化 ──
  const gridRef = useRef<HTMLDivElement>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const ratio = dragRatio ?? workspace.splitRatio

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = gridRef.current
    if (!el) return
    const horizontal = workspace.template === '2h'
    const rect = el.getBoundingClientRect()
    const total = (horizontal ? rect.width : rect.height) - 8 // 除去中间 8px gap
    if (total <= 0) return
    const start = dragRatio ?? workspace.splitRatio
    let cur = start
    const move = (ev: PointerEvent) => {
      const d = horizontal ? ev.clientX - e.clientX : ev.clientY - e.clientY
      cur = Math.min(0.8, Math.max(0.2, start + d / total))
      setDragRatio(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragRatio(null)
      setSplitRatio(cur)
    }
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // pane 配置更新 + symbol 联动: 换股且全局开关开 → 其余 follow 窗跟随 (周期各保各的)
  const handlePaneChange = useCallback((id: string, patch: Partial<PaneConfig>) => {
    updatePane(id, patch)
    if (patch.symbol !== undefined && workspace.sync.symbol) {
      for (const p of workspace.panes) {
        if (p.id !== id && p.sync === 'follow') {
          updatePane(p.id, { symbol: patch.symbol, name: patch.name })
        }
      }
    }
  }, [updatePane, workspace.sync.symbol, workspace.panes])

  // ── 双击重置联动协调 (按「重置」开关: 开 = 全部窗格一起重置, 关 = 仅本窗) ──
  // EChartsCandlestick 双击只上报 onResetRequest, 此处按开关把重置信号派发给目标窗格,
  // 由各窗 resetSignal prop 驱动 performResetZoom (各自 60 根最佳窗口 + Y 全归位)。
  // 统一走显式信号而非 X 事件广播 (performReset 已带 __snSuppressXZoom 抑制计数),
  // 保证「关」时对端窗口/视野完全不动。
  const [resetSignals, setResetSignals] = useState<Record<string, number>>({})
  const handleResetRequest = useCallback((fromId: string) => {
    const targets = workspace.sync.reset
      ? workspace.panes.map(p => p.id)
      : [fromId]
    setResetSignals(prev => {
      const next: Record<string, number> = { ...prev }
      for (const id of targets) next[id] = (prev[id] ?? 0) + 1
      return next
    })
    // 重置后实际窗口 = 60 根「最佳窗口」, 与任何档位期望都不同 → 同步清范围栏
    // 高亮 (TV 同语义: 重置后时间轴范围指示回「自定义」)。不清会高亮残留:
    // 按钮显示旧档位而视野已是 60 根, 且 rangeEffect 依赖未变不会重放档位窗口。
    // range 变化后 rangeEffect 重跑时因 !pane.range 直接 return, 不覆盖重置窗口。
    for (const id of targets) updatePane(id, { range: null })
  }, [workspace.sync.reset, workspace.panes, updatePane])

  // P3 实时K线: 把当前所有窗格的 symbol 注册进全局 SSE 增量表
  // (quotes_updated 推送时, useQuoteStream 拉当日单行合并进日K缓存尾部)。
  // setChartLiveSymbols 内部按 Set 去重, 窗格配置变化无副作用。
  useEffect(() => {
    setChartLiveSymbols(workspace.panes.map(p => p.symbol))
    return () => clearChartLiveSymbols()
  }, [workspace.panes])

  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      {/* 绘图工具竖条 */}
      <DrawingToolbar tool={workspace.drawTool} onSelect={setDrawTool} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {/* workspace 工具条: 分屏模板 + 联动全局开关 */}
        <div className="flex h-9 shrink-0 items-center gap-3 rounded-lg border border-border/60 bg-surface/60 px-3">
          <span className="text-xs text-muted">分屏</span>
          <div className="flex items-center gap-1">
            {TEMPLATES.map(t => (
              <WPill
                key={t.key}
                active={workspace.template === t.key}
                label={t.label}
                title={t.title}
                onClick={() => setTemplate(t.key)}
              />
            ))}
          </div>

          <span className="h-4 w-px bg-border" aria-hidden="true" />

          <span className="text-xs text-muted">联动</span>
          <div className="flex items-center gap-1">
            <WPill
              active={workspace.sync.crosshair}
              label="十字"
              title="跨窗十字光标同步 (时间轴对齐, 跨标的生效)"
              onClick={() => setSync({ crosshair: !workspace.sync.crosshair })}
            />
            <WPill
              active={workspace.sync.zoom}
              label="缩放"
              title="跨窗时间缩放同步 (时间区间换算, 跨标的生效)"
              onClick={() => setSync({ zoom: !workspace.sync.zoom })}
            />
            <WPill
              active={workspace.sync.symbol}
              label="换股"
              title="换股时跟随窗一起换标的 (周期各保各的)"
              onClick={() => setSync({ symbol: !workspace.sync.symbol })}
            />
            <WPill
              active={workspace.sync.drawings}
              label="绘图"
              title="绘图图形库共享: 同股窗格共用一套图形并实时同步; 关闭后每窗独立存储互不干扰"
              onClick={() => setSync({ drawings: !workspace.sync.drawings })}
            />
            <WPill
              active={workspace.sync.reset}
              label="重置"
              title="双击重置联动: 开 = 双击任一窗全部窗格一起重置(各自 60 根最佳窗口 + Y 轴归位); 关 = 只重置当前窗、其余保持不动"
              onClick={() => setSync({ reset: !workspace.sync.reset })}
            />
          </div>

          <span className="ml-auto hidden truncate text-[10px] text-muted xl:inline">
            {workspace.drawTool !== 'cursor'
              ? `绘制模式: ${workspace.drawTool} — 在图上拖拽落定, Esc 回光标`
              : '←→ 平移 · ↑↓ 缩放 · 双击重置 · Alt+T 画线 · 点窗格切换快捷键作用窗'}
          </span>
        </div>

        {/* 分屏容器 + 联动总线 */}
        <ChartSyncProvider sync={workspace.sync}>
          <div
            ref={gridRef}
            className={cn(
              'relative grid min-h-0 flex-1 gap-2',
              // 双窗模板: 列/行宽走 CSS 变量 (分隔条拖拽实时改比例);
              // 其余模板用固定 grid; 移动端统一退化为单列纵排 (max-md 变体在样式表后置,
              // 同特异性下覆盖任意值类, 双窗比例不会漏到移动端)
              workspace.template === '2h'
                ? 'grid-rows-1 grid-cols-[var(--pane-ratio)_1fr]'
                : workspace.template === '2v'
                  ? 'grid-cols-1 grid-rows-[var(--pane-ratio)_1fr]'
                  : GRID_CLASS[workspace.template],
              'max-md:auto-rows-[minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-none',
            )}
            // 第二列/行固定 1fr, 变量传相对宽度 r/(1-r) → 实际占比 r (0.5 → 1fr 1fr 均分)
            style={{ '--pane-ratio': `${ratio / (1 - ratio)}fr` } as CSSProperties}
          >
            {workspace.panes.map((pane, i) => (
              <div
                key={pane.id}
                className={cn('min-h-0 min-w-0', workspace.template === '1+3' && i === 0 && 'md:row-span-3')}
              >
                <ChartPane
                  pane={pane}
                  drawTool={workspace.drawTool}
                  syncDrawings={workspace.sync.drawings}
                  onChange={patch => handlePaneChange(pane.id, patch)}
                  isActive={pane.id === activeId}
                  onActivate={() => setActivePaneId(pane.id)}
                  onDrawTool={setDrawTool}
                  resetSignal={resetSignals[pane.id] ?? 0}
                  onResetRequest={() => handleResetRequest(pane.id)}
                />
              </div>
            ))}

            {/* 双窗分隔条: 悬浮在两窗间隙上的拖拽把手 (hover 显形), 拖拽改分隔比例 */}
            {(workspace.template === '2h' || workspace.template === '2v') && (
              <div
                onPointerDown={onDividerDown}
                className={cn(
                  'group absolute z-20 hidden touch-none items-center justify-center md:flex',
                  workspace.template === '2h'
                    ? 'top-0 bottom-0 w-3.5 -translate-x-1/2 cursor-col-resize'
                    : 'left-0 right-0 h-3.5 -translate-y-1/2 cursor-row-resize',
                )}
                style={workspace.template === '2h'
                  ? { left: `calc((100% - 8px) * ${ratio} + 4px)` }
                  : { top: `calc((100% - 8px) * ${ratio} + 4px)` }}
              >
                <span
                  className={cn(
                    'rounded-full bg-border/80 opacity-0 transition-opacity group-hover:bg-accent/70 group-hover:opacity-100',
                    workspace.template === '2h' ? 'h-10 w-[3px]' : 'h-[3px] w-10',
                  )}
                />
              </div>
            )}
          </div>
        </ChartSyncProvider>
      </div>
    </div>
  )
}
