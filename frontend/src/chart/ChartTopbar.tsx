/**
 * 图表工作台顶栏 — symbol 搜索 / 周期切换 / K线样式 / 指标开关。
 *
 * 搜索: 输入防抖 300ms → /api/kline/instruments/search (instrumentSearch);
 * 周期/样式/指标为受控组件 (状态由 Chart 页持有并持久化)。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Loader2, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { SUB_CHARTS } from '@/components/EChartsCandlestick'
import { PERIODS, type Period } from './periods'
import { RANGES } from './ranges'
import { PANE_INDICATORS } from './useChartLayout'

export type ChartStyle = 'candle' | 'hollow' | 'line' | 'area'

/** 顶栏 → pane 的语义化 patch (toggle 类字段由 pane 转译为状态更新) */
export interface ChartTopbarPatch {
  symbol?: string
  name?: string
  period?: Period
  chartStyle?: ChartStyle
  range?: string | null
  toggleIndicator?: string
  toggleSignal?: 'maCross' | 'rsiDivergence'
}

const STYLE_LABELS: { key: ChartStyle; label: string; title: string }[] = [
  { key: 'candle', label: '蜡烛', title: '蜡烛图' },
  { key: 'hollow', label: '空心', title: '空心蜡烛' },
  { key: 'line', label: '线', title: '收盘价折线' },
  { key: 'area', label: '面积', title: '收盘价面积图' },
]

function Pill({ active, label, title, onClick, activeClass = 'bg-accent/20 text-accent' }: {
  active: boolean
  label: string
  title?: string
  onClick: () => void
  activeClass?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
        active ? activeClass : 'bg-elevated text-muted hover:text-secondary'
      }`}
    >
      {label}
    </button>
  )
}

/** 紧凑单选下拉框 — 周期/范围/形态等单选控件共用, 腾出图表空间。
 *  触发器: 圆角按钮 (h-7, 与搜索框同高) + 当前值 + ChevronDown; 面板: 选项列表当前项高亮。
 *  value=null 且有 placeholder 时显示占位文本 (范围栏手动缩放后 = "自定义")。 */
function SingleSelect<T extends string>({ value, options, onChange, placeholder, title }: {
  value: T | null
  options: { key: T; label: string; title?: string }[]
  onChange: (key: T) => void
  placeholder?: string
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; minW: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // 面板经 createPortal 挂在 document.body, 不在触发按钮 DOM 内 — 必须同时豁免
      // 面板内部点击, 否则选项的 mousedown 先判为「外部」关闭面板并卸载 portal,
      // click 事件落在已卸载元素上永不触发, 选项无法选中 (下拉只关不选)。
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useLayoutEffect(() => {
    if (!open || !btnRef.current) { setPanelPos(null); return }
    const r = btnRef.current.getBoundingClientRect()
    setPanelPos({ top: r.bottom + 4, left: r.left, minW: r.width })
  }, [open])

  const selected = options.find(o => o.key === value)
  const displayLabel = selected?.label ?? placeholder ?? '选择'

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        title={title}
        className="flex h-7 items-center gap-1 rounded-btn border border-border bg-base px-2 text-xs font-mono transition-colors hover:border-border/80"
      >
        <span className={selected ? 'text-foreground' : 'text-muted'}>{displayLabel}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 rounded-lg border border-border/60 bg-surface shadow-lg"
          style={{ top: panelPos.top, left: panelPos.left, minWidth: panelPos.minW }}
        >
          {options.map(o => (
            <button
              key={o.key}
              type="button"
              title={o.title}
              onClick={() => { onChange(o.key); setOpen(false) }}
              className={`flex w-full items-center whitespace-nowrap px-3 py-1.5 text-left text-xs font-mono transition-colors hover:bg-accent/10 first:rounded-t-lg last:rounded-b-lg ${
                o.key === value ? 'text-accent bg-accent/5' : 'text-secondary'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** symbol 搜索框: 联想下拉 + 选中回填。宽度由窗格空间自适应 (分屏窄窗下缩窄)。 */
function SymbolSearch({ symbol, name, widthClass = 'w-52', onSelect }: {
  symbol: string
  name?: string
  widthClass?: string
  onSelect: (symbol: string, name?: string) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [debounced, setDebounced] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number>()

  useEffect(() => {
    window.clearTimeout(timerRef.current)
    if (!q.trim()) { setDebounced(''); return }
    timerRef.current = window.setTimeout(() => setDebounced(q.trim()), 300)
    return () => window.clearTimeout(timerRef.current)
  }, [q])

  const { data, isFetching } = useQuery({
    enabled: debounced.length > 0,
    queryKey: QK.instrumentSearch(debounced, 'stock,etf'),
    queryFn: () => api.instrumentSearch(debounced, 12, 'stock,etf'),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const results = debounced ? data?.results ?? [] : []

  return (
    <div ref={boxRef} className={`relative shrink-0 ${widthClass}`}>
      <div className="flex h-7 items-center gap-1.5 rounded-btn border border-border bg-base px-2">
        <Search className="h-3 w-3 shrink-0 text-muted" />
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          // 回车 → 选中第一项 (TV/同花顺同款: 打字联想后直接回车落定, 免鼠标点选)
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            const first = results[0]
            if (!first) return
            onSelect(first.symbol, first.name)
            setQ('')
            setOpen(false)
          }}
          placeholder={name ? `${symbol} ${name}` : symbol || '搜索代码 / 名称'}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted/60 outline-none"
        />
        {isFetching && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted" />}
        {q && (
          <button type="button" onClick={() => { setQ(''); setOpen(false) }} className="shrink-0 text-muted/60 hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border/60 bg-surface shadow-lg">
          {results.map(r => (
            <button
              key={`${r.asset_type ?? 'stock'}:${r.symbol}`}
              type="button"
              onClick={() => { onSelect(r.symbol, r.name); setQ(''); setOpen(false) }}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/10"
            >
              <span className="font-mono text-xs text-accent">{r.symbol}</span>
              <span className="truncate text-xs text-secondary">{r.name}</span>
              {r.asset_type === 'etf' && <span className="ml-auto shrink-0 rounded bg-elevated px-1 text-[9px] text-muted">ETF</span>}
            </button>
          ))}
        </div>
      )}
      {open && debounced && !isFetching && results.length === 0 && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border/60 bg-surface px-3 py-2 text-center text-xs text-muted shadow-lg">
          无匹配标的
        </div>
      )}
    </div>
  )
}

export function ChartTopbar({ symbol, name, period, chartStyle, activeIndicators, range, signals, onChange }: {
  symbol: string
  name?: string
  period: Period
  chartStyle: ChartStyle
  activeIndicators: string[]
  /** 当前选中的可见范围 key (用户手动缩放后由 pane 置空 → 高亮自动清除) */
  range?: string | null
  /** 信号开关 (默认全关) */
  signals?: { maCross?: boolean; rsiDivergence?: boolean }
  onChange: (patch: ChartTopbarPatch) => void
}) {
  // 分屏兼容: 页面级断点 (md/lg) 在窗格变窄时失效, 按工具条自身宽度自适应 —
  // 窄窗格搜索框缩窄, 其余按钮组全部进横向滚动区 (够宽自然全显, 不够宽可滚)。
  const barRef = useRef<HTMLDivElement>(null)
  const [barW, setBarW] = useState(1600)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setBarW(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const compactSearch = barW < 640

  /** 横向滚动区: 滚轮在工具条上转为横向滚动 (Windows 滚轮默认不横滚)。 */
  const onWheelHorizontal = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY + e.deltaX
  }

  return (
    <div ref={barRef} className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-2">
      {/* symbol 搜索 — 固定区, 不参与横向滚动 */}
      <SymbolSearch
        symbol={symbol}
        name={name}
        widthClass={compactSearch ? 'w-36' : 'w-52'}
        onSelect={(s, n) => onChange({ symbol: s, name: n })}
      />

      <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />

      {/* 按钮区 — 统一横向滚动; 分屏窄窗格下不再依赖页面级断点隐藏按钮 */}
      <div
        className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
        onWheel={onWheelHorizontal}
      >
        {/* 周期 (下拉) */}
        <SingleSelect
          value={period}
          options={PERIODS.map(p => ({ key: p.key, label: p.label, title: `${p.label}周期` }))}
          onChange={k => onChange({ period: k })}
          title="时间周期"
        />

        <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* 可见范围 (下拉; 手动缩放后 range=null → 显示"自定义") */}
        <SingleSelect
          value={range ?? null}
          options={RANGES.map(r => ({ key: r.key, label: r.label, title: `可见范围: ${r.label}` }))}
          onChange={k => onChange({ range: k })}
          placeholder="自定义"
          title="可见范围"
        />

        <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* K 线样式 (下拉) */}
        <SingleSelect
          value={chartStyle}
          options={STYLE_LABELS.map(s => ({ key: s.key, label: s.label, title: s.title }))}
          onChange={k => onChange({ chartStyle: k })}
          title="K线形态"
        />

        <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* 指标开关 (副图; 工作台只提供 MACD/RSI, 其余指标不在此暴露) */}
        <div className="flex shrink-0 items-center gap-1">
          {PANE_INDICATORS.map(key => {
            const def = SUB_CHARTS.find(s => s.key === key)
            if (!def) return null
            return (
              <Pill
                key={def.key}
                active={activeIndicators.includes(def.key)}
                label={def.label}
                title={`${def.label} 副图`}
                onClick={() => onChange({ toggleIndicator: def.key })}
              />
            )
          })}
        </div>

        <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* 信号开关 (金叉/死叉 + 顶背离; 默认关)。
         *  RSI 零轴震荡形态为固定形态 (无开关), 由 ChartPane 固定传 rsiZeroAxis=true */}
        <div className="flex shrink-0 items-center gap-1">
          <Pill
            active={!!signals?.maCross}
            label="金叉"
            title="MA5×MA10 金叉/死叉标记"
            activeClass="bg-amber-400/15 text-amber-400"
            onClick={() => onChange({ toggleSignal: 'maCross' })}
          />
          <Pill
            active={!!signals?.rsiDivergence}
            label="背离"
            title="RSI(14) 顶背离标记"
            activeClass="bg-violet-400/15 text-violet-400"
            onClick={() => onChange({ toggleSignal: 'rsiDivergence' })}
          />
        </div>
      </div>
    </div>
  )
}
