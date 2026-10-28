/**
 * AI 投研助手面板 — 非模态, 从页面最右缘滑入(right: 0), 默认 720px 宽,
 * 左缘拖拽可调宽并持久化到 localStorage。
 *
 * 非模态是核心体验决策: 用户边看行情边问, 页面主体不遮挡、不解锁滚动。
 * 拖拽调宽沿用仓库 60fps 手法: 拖动期间直接改 DOM style.width, 松手才
 * 提交 React state + 持久化。视觉全部走设计令牌; 动画用全站统一缓动。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDown,
  Bot,
  Database,
  FlaskConical,
  History,
  MousePointerClick,
  Plus,
  Puzzle,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  Star,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  fetchAssistantStatus,
  fetchAssistantSuggests,
  type AssistantStatus,
  type QuickSuggest,
} from '../client'
import {
  clearDraft,
  closeAssistant,
  deleteSession,
  newSession,
  retryLast,
  selectSession,
  sendMessage,
  setDraft,
  stopSending,
  useAssistantStore,
} from '../store'
import { AssistantMessageView } from './messages'

const EASE_SMOOTH: [number, number, number, number] = [0.16, 1, 0.3, 1]

const WIDTH_STORAGE_KEY = 'assistant.width.v1'
const DEFAULT_WIDTH = 720
const MIN_WIDTH = 480

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY)
    const value = raw ? Number.parseInt(raw, 10) : Number.NaN
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch { /* 存储不可用时仅内存态 */ }
}

function clampWidth(width: number): number {
  // 右缘贴齐, 至少给页面主体留 64px 上下文。
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 64)
  return Math.min(Math.max(width, MIN_WIDTH), maxWidth)
}

export function AssistantDrawer() {
  const { open, sending, sessions, activeId } = useAssistantStore()
  const active = sessions.find(s => s.id === activeId) ?? null
  const messages = active?.messages ?? []

  return createPortal(
    <AnimatePresence>
      {open && (
        <DrawerPanel key="assistant-drawer" sending={sending} messages={messages} />
      )}
    </AnimatePresence>,
    // #root (缩放层): 抽屉随界面缩放, 且与 Modal 同层叠上下文保持 z 序设计。
    document.getElementById('root') ?? document.body,
  )
}

type DrawerMessages = ReturnType<typeof useAssistantStore>['sessions'][number]['messages']

function DrawerPanel({
  sending,
  messages,
}: {
  sending: boolean
  messages: DrawerMessages
}) {
  const { sessions, activeId, draft } = useAssistantStore()
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [suggests, setSuggests] = useState<QuickSuggest[]>([])
  const [width, setWidth] = useState(() => clampWidth(loadWidth()))
  const panelRef = useRef<HTMLElement>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetchAssistantStatus().then(s => { if (!cancelled) setStatus(s) }).catch(() => {})
    fetchAssistantSuggests().then(list => { if (!cancelled) setSuggests(list) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 窗口缩放后重新夹取宽度, 保证面板不越出视口。
  useEffect(() => {
    const onResize = () => setWidth(prev => clampWidth(prev))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 拖拽期间直接改 DOM(60fps), 松手才提交 state + 持久化。
  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
  }
  const onHandlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const el = panelRef.current
    if (el) el.style.width = `${clampWidth(window.innerWidth - event.clientX)}px`
  }
  const onHandlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const finalWidth = clampWidth(window.innerWidth - event.clientX)
    setWidth(finalWidth)
    saveWidth(finalWidth)
  }

  return (
    <motion.aside
      ref={panelRef}
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.26, ease: EASE_SMOOTH }}
      style={{ right: 0, width }}
      className={cn(
        'fixed inset-y-0 z-[60] flex min-w-0 flex-col border-l border-border',
        'bg-surface/95 shadow-2xl backdrop-blur-xl',
      )}
      role="complementary"
      aria-label="AI 投研助手"
    >
      <DrawerHeader status={status} sessions={sessions} activeId={activeId} sending={sending} />
      <MessageList messages={messages} sending={sending} status={status} suggests={suggests} />
      <InputArea sending={sending} blocked={status ? !status.supports_tools : false} draft={draft} />

      {/* 左缘拖拽调宽 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整宽度"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerEnd}
        onLostPointerCapture={onHandlePointerEnd}
        className="group/handle absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none"
        title="拖拽调整宽度"
      >
        <span className="absolute left-1/2 top-1/2 h-10 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/50 opacity-0 transition-opacity duration-150 ease-smooth group-hover/handle:opacity-100" />
      </div>
    </motion.aside>
  )
}

function DrawerHeader({
  status,
  sessions,
  activeId,
  sending,
}: {
  status: AssistantStatus | null
  sessions: ReturnType<typeof useAssistantStore>['sessions']
  activeId: string
  sending: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="relative flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <Sparkles className="h-4 w-4 shrink-0 text-accent" />
      <span className="shrink-0 text-sm font-semibold text-foreground">AI 投研助手</span>
      {status?.model && (
        <span
          className="min-w-0 truncate rounded-btn bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted"
          title={`模型: ${status.model}\n供应商: ${status.provider ?? '-'}`}
        >
          {status.model}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <div className="relative">
          <IconButton title="历史会话" onClick={() => setMenuOpen(v => !v)} disabled={sending}>
            <History className="h-4 w-4" />
          </IconButton>
          {menuOpen && <SessionMenu sessions={sessions} activeId={activeId} onDone={() => setMenuOpen(false)} />}
        </div>
        <IconButton title="新对话" onClick={() => { newSession(); setMenuOpen(false) }} disabled={sending}>
          <Plus className="h-4 w-4" />
        </IconButton>
        <IconButton title="关闭 (Esc)" onClick={closeAssistant}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  )
}

function SessionMenu({
  sessions,
  activeId,
  onDone,
}: {
  sessions: ReturnType<typeof useAssistantStore>['sessions']
  activeId: string
  onDone: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-[61]" onClick={onDone} />
      <div className="absolute right-0 top-full z-[62] mt-1 max-h-72 w-60 overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-xl">
        {sessions.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted">暂无历史会话</div>
        )}
        {sessions.map(session => (
          <div
            key={session.id}
            className={cn(
              'group flex items-center gap-1 rounded-btn px-2 py-1.5 text-xs transition-colors duration-150 ease-smooth',
              session.id === activeId ? 'bg-elevated text-foreground' : 'text-secondary hover:bg-elevated/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              className="min-w-0 flex-1 cursor-pointer truncate text-left"
              onClick={() => { selectSession(session.id); onDone() }}
              title={session.title}
            >
              {session.title || '新对话'}
            </button>
            <button
              type="button"
              className="hidden cursor-pointer text-muted transition-colors duration-150 ease-smooth hover:text-danger group-hover:block"
              onClick={() => deleteSession(session.id)}
              title="删除会话"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-btn text-secondary transition-colors duration-150 ease-smooth hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function MessageList({
  messages,
  sending,
  status,
  suggests,
}: {
  messages: DrawerMessages
  sending: boolean
  status: AssistantStatus | null
  suggests: QuickSuggest[]
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distance < 80
    setShowJump(distance >= 240)
  }

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <EmptyState status={status} suggests={suggests} />
        ) : (
          messages.map(message => (
            <AssistantMessageView key={message.id} message={message} onRetry={sending ? undefined : retryLast} />
          ))
        )}
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15, ease: EASE_SMOOTH }}
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 flex h-7 w-7 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-elevated text-secondary shadow-md transition-colors duration-150 ease-smooth hover:text-foreground"
            title="回到底部"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

/** 空会话建议分组的图标 (后端 suggests 的 group 字段驱动, 未匹配时兜底)。 */
const SUGGEST_GROUP_ICONS: Record<string, typeof TrendingUp> = {
  行情与大盘: TrendingUp,
  我的与个股: Star,
  策略与信号: FlaskConical,
  数据与扩展: Database,
}

function EmptyState({ status, suggests }: { status: AssistantStatus | null; suggests: QuickSuggest[] }) {
  const navigate = useNavigate()

  if (status && !status.configured) {
    return (
      <div className="rounded-card border border-warning/30 bg-warning/5 p-4 text-sm">
        <div className="flex items-center gap-1.5 font-medium text-warning">
          <Settings2 className="h-4 w-4" />
          AI 未配置
        </div>
        <p className="mt-1.5 text-secondary">AI 投研助手需要先配置 AI 供应商和 API Key 才能对话。</p>
        <button
          type="button"
          onClick={() => navigate('/settings?tab=ai')}
          className="mt-2 cursor-pointer rounded-btn bg-accent px-3 py-1.5 text-xs text-white transition-colors duration-150 ease-smooth hover:bg-accent/90"
        >
          去设置页配置
        </button>
      </div>
    )
  }

  if (status && !status.supports_tools) {
    return (
      <div className="rounded-card border border-warning/30 bg-warning/5 p-4 text-sm">
        <div className="flex items-center gap-1.5 font-medium text-warning">
          <Settings2 className="h-4 w-4" />
          当前供应商不支持工具调用
        </div>
        <p className="mt-1.5 text-secondary">
          AI 投研助手依赖工具调用能力({status.provider} 不支持), 请在设置页切换为 OpenAI 兼容模型。
        </p>
        <button
          type="button"
          onClick={() => navigate('/settings?tab=ai')}
          className="mt-2 cursor-pointer rounded-btn bg-accent px-3 py-1.5 text-xs text-white transition-colors duration-150 ease-smooth hover:bg-accent/90"
        >
          去设置页调整
        </button>
      </div>
    )
  }

  if (!suggests.length) {
    return (
      <p className="pt-8 text-center text-xs text-muted">
        问我任何关于行情、个股、策略、扩展数据或数据能力的问题。
      </p>
    )
  }

  // 按后端 group 字段分区, 保持原始顺序; 未分组的建议归入「更多」。
  const groups = new Map<string, QuickSuggest[]>()
  for (const suggest of suggests) {
    const key = suggest.group || '更多'
    groups.set(key, [...(groups.get(key) ?? []), suggest])
  }

  return (
    <div className="space-y-4 pb-2 pt-2">
      <div className="rounded-card border border-border bg-gradient-to-b from-accent/10 to-transparent px-4 py-4 text-center">
        <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Bot className="h-4.5 w-4.5" />
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">有什么可以帮你？</p>
        <p className="mt-1 text-xs text-muted">基于本地真实数据回答 · 点击建议填入提问框, 可修改参数后再发送</p>
      </div>

      {[...groups.entries()].map(([group, items]) => {
        const GroupIcon = SUGGEST_GROUP_ICONS[group] ?? Sparkles
        return (
          <div key={group} className="space-y-2">
            <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted">
              <GroupIcon className="h-3.5 w-3.5" />
              {group}
            </div>
            <div className="flex flex-wrap gap-2">
              {items.map(suggest => (
                <button
                  key={suggest.id}
                  type="button"
                  onClick={() => setDraft(suggest.prompt, true)}
                  title="点击填入提问框, 示例代码可直接选中替换后发送"
                  className="max-w-full shrink-0 cursor-pointer rounded-card border border-border bg-base/60 px-3 py-2 text-left text-xs text-secondary transition-all duration-150 ease-smooth hover:border-accent/40 hover:bg-elevated hover:text-foreground"
                >
                  {suggest.label}
                </button>
              ))}
            </div>
          </div>
        )
      })}

      <div className="rounded-card border border-dashed border-border bg-base/40 px-3.5 py-3 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Puzzle className="h-3.5 w-3.5 text-accent" />
          扩展内容同样可以问
        </div>
        <p className="mt-1 leading-relaxed text-secondary">
          扩展数据表、自定义策略与信号等扩展内容都能问答互动, 比如「我的扩展数据表里有什么」「看看最新一张的数据」。
          AI 投研助手本身也是一个 custom 扩展模块。
        </p>
      </div>
    </div>
  )
}

/** 示例代码选区: 全局匹配所有代码占位 (如 600519.SH), 相邻 (间隔≤3 字符,
 * 如「、」分隔) 并为同一簇, 返回首簇 [起, 止)。多代码模板 (示例代码 A、B、C)
 * 整组选中, 打字即整组替换; 代码分散出现时只选第一簇, 避免选区吞掉中间正文。 */
function exampleCodeSpan(text: string): [number, number] | null {
  let start: number | null = null
  let end = -1
  for (const match of text.matchAll(/\d{6}\.[A-Z]{2}/g)) {
    if (match.index === undefined) continue
    if (start === null) start = match.index
    else if (match.index - end > 3) break
    end = match.index + match[0].length
  }
  return start !== null && end > start ? [start, end] : null
}

function InputArea({
  sending,
  blocked,
  draft,
}: {
  sending: boolean
  blocked: boolean
  draft: { text: string; seq: number; selectCode?: boolean }
}) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastDraftSeq = useRef(0)
  // 预填提示: 'code'=模板已填入+示例代码可替换; 'draft'=草稿已恢复。
  // 不依赖选区高亮 (Firefox 失焦后选区不可见), 让用户始终知道下一步。
  const [hint, setHint] = useState<'code' | 'draft' | null>(null)
  // 草稿镜像: 卸载 cleanup 闭包拿不到最新 state, 用 ref 同步。
  const textRef = useRef('')
  textRef.current = text

  // 抽屉关闭 = InputArea 卸载: 未发送的非空草稿存回 draft,
  // 重开抽屉自动填回 — 误按 Esc 不丢正在编辑的长问题。
  useEffect(() => () => {
    if (textRef.current.trim()) setDraft(textRef.current)
  }, [])

  // 消费预填指令: 填入文本并聚焦; 建议卡片预填 (selectCode) 时自动选中
  // 全部示例代码 (单个如 600519.SH, 多个如 600519.SH、000858.SZ、603288.SH
  // 整组选中), 用户直接打字即替换; 草稿恢复则光标置末尾。
  // rAF 等一帧再操作 DOM: setText 同帧内 focus 会被 React 重渲染重置;
  // Firefox 首帧 paint 后可能清除程序化选区, 再延迟 80ms 幂等补设一次。
  useEffect(() => {
    if (!draft.seq || draft.seq === lastDraftSeq.current) return
    lastDraftSeq.current = draft.seq
    setText(draft.text)
    setHint(draft.selectCode ? 'code' : 'draft')
    const applySelection = () => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const len = draft.text.length
      if (draft.selectCode) {
        const span = exampleCodeSpan(draft.text)
        if (span) {
          el.setSelectionRange(span[0], span[1])
          autoGrow()
          return
        }
      }
      el.setSelectionRange(len, len)
      autoGrow()
    }
    let retryTimer: number | undefined
    const raf = requestAnimationFrame(() => {
      applySelection()
      retryTimer = window.setTimeout(applySelection, 80)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- autoGrow 稳定引用, 无需重跑
  }, [draft])

  const canSend = !sending && !blocked && text.trim().length > 0

  const submit = () => {
    if (!canSend) return
    sendMessage(text)
    setText('')
    setHint(null)
    clearDraft()
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const autoGrow = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`
  }

  return (
    <div className="shrink-0 border-t border-border bg-surface px-4 pb-3 pt-2.5">
      <AnimatePresence>
        {hint && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: EASE_SMOOTH }}
            className={cn(
              'mb-1.5 flex items-center gap-1 px-1 text-[11px]',
              hint === 'code' ? 'text-accent' : 'text-muted',
            )}
          >
            {hint === 'code'
              ? <><MousePointerClick className="h-3 w-3 shrink-0" />模板已填入 — 示例代码已选中, 直接打字即可替换, 改好按 Enter 发送</>
              : <><History className="h-3 w-3 shrink-0" />已恢复上次未发送的草稿, 继续编辑后发送</>}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-end gap-2 rounded-card border border-border bg-base focus-within:border-accent/50">
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={blocked}
          placeholder={blocked ? '请先在设置页配置 AI' : '提问, Enter 发送 / Shift+Enter 换行'}
          onChange={e => { setText(e.target.value); setHint(null); autoGrow() }}
          onKeyDown={onKeyDown}
          className="max-h-36 min-h-[38px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
        {sending ? (
          <button
            type="button"
            onClick={stopSending}
            title="停止生成"
            aria-label="停止生成"
            className="mr-1.5 mb-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-btn bg-elevated text-secondary transition-colors duration-150 ease-smooth hover:text-foreground"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            title="发送"
            aria-label="发送"
            className="mr-1.5 mb-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-btn bg-accent text-white transition-all duration-150 ease-smooth hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="mt-1.5 px-1 text-[10px] text-muted">
        ⌘K / Ctrl+K 呼出 · 左缘可拖拽调宽 · 回答基于本地数据, 不构成投资建议
      </div>
    </div>
  )
}
