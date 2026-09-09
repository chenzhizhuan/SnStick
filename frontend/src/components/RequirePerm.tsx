/**
 * 权限路由守卫 + 403 页面 — M3-4 前端权限体系 (v2.3 §7 前端泳道)。
 *
 * 用途:
 *   - <RequirePerm perm="stick:backtest:run"> 包裹路由 element, 无权限 → 403 页。
 *   - 单密码形态 (桌面版/未互通) → 恒放行 (升级前行为零改动)。
 *   - 权限点语义与后端 role_map.yaml 一致; 后端 RequirePerm 仍是最终门禁,
 *     前端守卫只是 UX 层 (直达 URL 也会被后端 403 兜底)。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { usePerm } from '@/lib/useAuth'

/** 403 无权限页 — 权限不足时展示, 并提供返回/重拉身份入口。 */
export function Forbidden() {
  const { enabled } = usePerm()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-danger/10 text-danger">
        <ShieldAlert className="h-7 w-7" />
      </div>
      <div>
        <div className="text-base font-medium text-foreground">无权限访问</div>
        <div className="mt-1 text-xs text-muted">
          当前账号未开通此功能。{enabled ? '请联系管理员开通订阅后重试。' : ''}
        </div>
      </div>
      <Link
        to="/"
        className="inline-flex items-center rounded-btn bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
      >
        返回首页
      </Link>
    </div>
  )
}

/**
 * 路由守卫: 无权限 → 渲染 403 页 (而非空白/报错)。
 * 单密码形态 → 直接放行。
 */
export function RequirePerm({ perm, children }: { perm: string; children: ReactNode }) {
  const { hasPerm } = usePerm()
  if (!hasPerm(perm)) return <Forbidden />
  return <>{children}</>
}