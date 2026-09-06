import { cn } from '@/lib/cn'

interface Props {
  title: string
  subtitle?: React.ReactNode
  /** 标题右侧、subtitle 之前的额外节点(如状态徽标) */
  titleExtra?: React.ReactNode
  right?: React.ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, titleExtra, right, className }: Props) {
  return (
    <header
      className={cn(
        'sn-page-header px-7 pt-5 pb-3.5 border-b border-border flex items-center justify-between gap-4',
        className,
      )}
    >
      <div className="min-w-0">
        {/* v3.2: 标题行 — 标题 18px/600 + titleExtra；subtitle 下移独立成行（参考系页头模式） */}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {titleExtra}
        </div>
        {subtitle && <div className="mt-1 text-[13px] leading-snug text-muted">{subtitle}</div>}
      </div>
      {right}
    </header>
  )
}
