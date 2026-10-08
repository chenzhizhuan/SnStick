/**
 * 绘图工具竖条 — TV 左侧工具栏观感, workspace 级单选。
 * 选中非「光标」工具后, 在任意 pane 主图区按下拖拽即绘制 (ChartPane 内状态机接管)。
 */
import { Minus, MousePointer2, Percent, Square, TrendingUp } from 'lucide-react'
import { DRAW_TOOLS, type DrawTool } from './drawings'

const ICONS: Record<DrawTool, typeof MousePointer2> = {
  cursor: MousePointer2,
  trendline: TrendingUp,
  hline: Minus,
  fib: Percent,
  rect: Square,
}

/** 工具 → 键盘快捷键 (ChartPane 内监听; 仅激活窗生效) */
const SHORTCUTS: Record<DrawTool, string> = {
  cursor: 'Esc / Alt+C',
  trendline: 'Alt+T',
  hline: 'Alt+H',
  fib: 'Alt+F',
  rect: 'Alt+R',
}

export function DrawingToolbar({ tool, onSelect }: {
  tool: DrawTool
  onSelect: (t: DrawTool) => void
}) {
  return (
    <div className="flex w-9 shrink-0 flex-col items-center gap-1 rounded-lg border border-border/60 bg-surface p-1.5">
      {DRAW_TOOLS.map(t => {
        const Icon = ICONS[t.key]
        const active = tool === t.key
        return (
          <button
            key={t.key}
            type="button"
            title={`${t.title} · 快捷键 ${SHORTCUTS[t.key]}`}
            aria-label={t.label}
            onClick={() => onSelect(t.key)}
            className={`
              rounded-md p-1.5 transition-colors
              ${active
                ? 'bg-accent/15 text-accent'
                : 'text-secondary hover:bg-surface-variant/60 hover:text-foreground'}
            `}
          >
            <Icon size={15} strokeWidth={2} />
          </button>
        )
      })}
    </div>
  )
}
