/**
 * 访问认证页 — 复用同一组件处理「首次设密码」/「单密码登录」/「账号登录(互通)」。
 *
 * 形态判定 (依据 /api/auth/status):
 *   - configured=false → 设置访问密码 (单密码, 首次)
 *   - configured=true  → 尝试账号互通: 互通启用(后端 /me 非404) → 用户名+密码
 *                        互通未启用 → 单密码登录
 *
 * 互通形态 (服务端 agti 多用户):
 *   - 登录走 /api/auth/identity/login (用户名+密码)
 *   - 登录成功 → 进入面板, 身份快照由 useAuth 拉取
 *   - 无角色/未开通 → 后端 401/403 提示
 *
 * 安全: 设密码接口后端限本机/内网; 登录失败后端限流(账号5次/10分钟)。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Eye, EyeOff, Loader2, Lock, ShieldCheck, ShieldAlert, Sparkles, User } from 'lucide-react'
import { api } from '@/lib/api'
import { AUTH_ME_KEY } from '@/lib/useAuth'
import { cn } from '@/lib/cn'
import logoUrl from '@/assets/logo.png'
// import { Logo } from '@/components/Logo'

export function Auth() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')  // 仅设密码时用
  const [showPwd, setShowPwd] = useState(false)
  const [localError, setLocalError] = useState('')
  const [identityMode, setIdentityMode] = useState(false)     // 互通账号模式 (双字段)

  // 取认证状态(是否已设密码) + 探测互通是否启用
  const [status, setStatus] = useState<{ configured: boolean; authenticated: boolean } | null>(null)
  useEffect(() => {
    api.authStatus().then(async s => {
      setStatus(s)
      // 已登录直接进面板(避免登录页死循环)
      if (s.authenticated) { navigate('/', { replace: true }); return }
      // 已设密码 → 探测互通: 仅 404(互通未启用)降级单密码; 200/401 都是互通形态
      // (401 = 互通启用但当前未登录, 需走账号登录)
      if (s.configured) {
        try {
          await api.authMe()
          setIdentityMode(true)
        } catch (err: any) {
          setIdentityMode(err?.status !== 404)
        }
      }
    }).catch(() => setStatus({ configured: false, authenticated: false }))
  }, [navigate])

  const isSetup = !status?.configured  // configured=false → 设密码模式

  // 登录 / 设密码 共用一个 mutation(按模式调不同接口)
  const submitMut = useMutation({
    mutationFn: async () => {
      if (isSetup) {
        return api.authSetup(password)
      }
      if (identityMode) {
        return api.identityLogin(username, password)
      }
      return api.authLogin(password)
    },
    onSuccess: () => {
      // 互通登录成功后丢弃旧的 auth-me 缓存 (可能是登录前的 404 哨兵/401 error),
      // 进面板后 useAuth 重新拉取真实身份与权限集。
      qc.removeQueries({ queryKey: AUTH_ME_KEY })
      // 成功: 跳回原页面(或首页)
      const redirect = new URLSearchParams(window.location.search).get('redirect') || '/'
      navigate(redirect, { replace: true })
    },
    onError: (err: any) => {
      const msg = err?.message || (isSetup ? '设置失败' : '登录失败')
      setLocalError(msg)
    },
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setLocalError('')
    if (isSetup) {
      if (password.length < 6) { setLocalError('密码至少 6 位'); return }
      if (password !== confirmPassword) { setLocalError('两次密码不一致'); return }
    }
    if (identityMode && !username.trim()) { setLocalError('请输入用户名'); return }
    submitMut.mutate()
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base">
        <Loader2 className="h-6 w-6 animate-spin text-muted" />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base px-4">
      <div className="sn-auth-reflection pointer-events-none absolute inset-0" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-sm"
      >
        {/* Logo */}
        <div className="mb-6 flex items-center justify-center">
          {/* <Logo size={96} className="shrink-0" /> */}
          <img src={logoUrl} className="h-[60px] w-[180px] shrink-0 object-contain object-left" alt="天玑实验室" draggable={false} />
        </div>

        <div className="sn-dialog rounded-card border border-border bg-surface/90 p-6 shadow-2xl">
          {/* 标题区: 图标 + 文案随模式切换 */}
          <div className="mb-5 flex items-center gap-2.5">
            <div className={cn(
              'grid h-9 w-9 place-items-center rounded-lg',
              'bg-accent/15 text-accent',
            )}>
              {isSetup ? <ShieldCheck className="h-5 w-5" /> : identityMode ? <User className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">
                {isSetup ? '设置访问密码' : identityMode ? '账号登录' : '登录访问'}
              </div>
              <div className="text-[11px] text-muted">
                {isSetup
                  ? '首次使用, 请为面板设置访问密码'
                  : identityMode
                    ? '请输入平台账号与密码'
                    : '请输入访问密码以继续'}
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            {/* 互通账号登录: 用户名 */}
            {identityMode && (
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="用户名"
                  autoFocus
                  autoComplete="username"
                  className="h-10 w-full rounded-btn border border-border bg-base pl-9 pr-3 text-sm text-foreground outline-none transition-colors focus:border-accent/50"
                />
              </div>
            )}

            {/* 密码输入 */}
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="访问密码"
                autoFocus={!identityMode}
                autoComplete={identityMode ? 'current-password' : undefined}
                className="h-10 w-full rounded-btn border border-border bg-base px-3 pr-9 text-sm text-foreground outline-none transition-colors focus:border-accent/50"
              />
              <button
                type="button"
                onClick={() => setShowPwd(s => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground"
                tabIndex={-1}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {/* 确认密码(仅设密码模式) */}
            {isSetup && (
              <input
                type={showPwd ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                className="h-10 w-full rounded-btn border border-border bg-base px-3 text-sm text-foreground outline-none transition-colors focus:border-accent/50"
              />
            )}

            {/* 错误提示 */}
            {(localError || submitMut.error) && (
              <div className="flex items-start gap-1.5 rounded-btn bg-danger/10 px-3 py-2 text-[11px] text-danger">
                <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>{localError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitMut.isPending || !password || (identityMode && !username.trim())}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-btn bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {submitMut.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" />处理中…</>
              ) : (
                <>{isSetup ? '设置并进入' : '登录'}</>
              )}
            </button>
          </form>

          {/* 提示: 设密码模式告知本机限制 */}
          {isSetup && (
            <div className="mt-3 space-y-1.5 text-[10px] leading-relaxed text-muted/70">
              <p>
                出于安全考虑, 首次设置密码需在服务器本机或内网访问时操作。公网环境下仅可登录。
              </p>
              <p>
                详细配置说明见{' '}
                <a
                  href="https://github.com/shy3130/tickflow-stock-panel/blob/main/docs/deploy-password.md"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  访问密码部署文档
                </a>
              </p>
            </div>
          )}

          {/* 互通模式: 提示无账号怎么办 */}
          {identityMode && (
            <div className="mt-3 text-[10px] leading-relaxed text-muted/70">
              <p>
                登录账号由平台统一开通。若无法登录, 请联系管理员开通订阅后重试。
              </p>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-center gap-1.5 text-[10px] text-muted/60">
          <Sparkles className="h-3 w-3" />
          自托管量化工作台 · 数据完全掌握在自己手里
        </div>
      </motion.div>
    </div>
  )
}