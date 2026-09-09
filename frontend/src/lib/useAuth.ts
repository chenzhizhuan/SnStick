/**
 * 认证与权限 Hooks — M3-4 前端权限体系 (v2.3 §7 前端泳道)。
 *
 * 形态判定:
 *   - 互通形态 (服务端 agti 多用户): /api/auth/me 返回身份 + 解析后的权限点集合。
 *   - 单密码形态 (桌面版 / 未互通部署): /api/auth/me 返回 404 → 无身份, 权限恒放行。
 *
 * 设计要点:
 *   - 权限点由后端 role_map.yaml 解析后随 /me 下发 (单一事实来源, 前端不复制映射)。
 *   - useAuth: 全局唯一身份快照 (query key 'auth-me')。
 *   - usePerm: 从快照 perms 计算, 零额外请求; admin 通配 *:*:* 由后端已解析进 perms。
 *   - 角色升级/降级: 后端 403 时页面 invalidate 'auth-me' 重拉, 无需重登。
 *   - 互通未启用 (desktop/local) → hasPerm 恒 true, 与升级前行为完全一致。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type AuthIdentity } from '@/lib/api'

export const AUTH_ME_KEY = ['auth', 'me'] as const

export interface AuthState {
  /** 互通是否启用 (authMe 非 404) */
  enabled: boolean
  identity: AuthIdentity | null
}

/**
 * 形态判定: /api/auth/me 返回 404 = 互通未启用 (单密码/桌面版) → enabled=false, 权限恒放行。
 * 401 (互通启用但未登录) / 200 → enabled=true, 按后端身份/权限集处理。
 *
 * 防轮询风暴 (M3-4 修复): 404 不作为 error 抛出, 而是 queryFn 内捕获为哨兵成功值
 * { notEnabled: true }。若抛 error, error query 永远 stale + retryOnMount 默认 true,
 * 守卫页 (RequirePerm) 在「pending: enabled 误判 true → 403 → 卸载; error: enabled=false
 * → 放行 → 重挂载」间振荡, 每轮重订阅都触发 refetch, 实测每秒数十次 404 风暴。
 * 哨兵值让 query 走 success 状态, staleTime 60s 真正生效, 挂载/导航零额外请求。
 */
const NOT_ENABLED = { notEnabled: true } as const
type AuthMeResult = { ok: boolean; identity: AuthIdentity } | typeof NOT_ENABLED

function authMeQueryFn(): Promise<AuthMeResult> {
  return api.authMe().catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return NOT_ENABLED
    throw err
  })
}

export function useAuth(): AuthState {
  const { data } = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: authMeQueryFn,      // 404 → 哨兵成功值, 不进 error 状态 (防轮询风暴)
    staleTime: 60_000,           // 快照 60s 内复用, 与后端 SNAPSHOT_TTL 对齐 (轻量)
    retry: false,                // 互通启用但后端异常时不重试, 失败由兜底逻辑处理
  })
  return {
    enabled: data != null && !('notEnabled' in data),
    identity: data != null && !('notEnabled' in data) ? data.identity : null,
  }
}

/** 强制重拉身份快照 (角色升级/403 后调用, 无需重登)。带 refresh=1 让后端惰性刷新快照。 */
export function useRefreshIdentity() {
  const qc = useQueryClient()
  return async () => {
    await qc.invalidateQueries({ queryKey: AUTH_ME_KEY })
    // invalidate 后的 refetch 默认不带 refresh; 再显式带 refresh 拉一次最新角色
    try {
      const me = await api.authMe(true)
      qc.setQueryData(AUTH_ME_KEY, me)
    } catch {
      // 静默: 刷新失败保留缓存快照 (陈旧快照可继续服务)
    }
  }
}

/**
 * 权限 Hook:
 *   - 互通形态: 按后端下发的 perms 集合判定; admin 已含 *:*:* 通配。
 *   - 单密码形态 (desktop/local): 恒放行 (升级前行为零改动)。
 */
export function usePerm() {
  const { enabled, identity } = useAuth()
  const perms = identity?.perms ?? []

  return {
    /** 互通是否启用 */
    enabled,
    /** 是否有某权限点 (如 'stick:backtest:run'); 单密码形态恒 true */
    hasPerm: (required: string): boolean => {
      if (!enabled) return true
      if (perms.includes('*:*:*')) return true
      return perms.includes(required)
    },
  }
}