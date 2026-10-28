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
  /** 形态探测是否完成 (false = 尚在加载, 权限判定不可靠) */
  ready: boolean
}

// ===== 身份快照本地缓存 (第 45 轮: 消灭刷新闪现) =====
// 现象: 硬刷新/直达守卫路由时 auth-me 需网络 RTT + lazy chunk 加载
// (~750ms 实测), 期间 ready=false → RequirePerm 闪「无权限访问」+
// 导航只剩无门槛项 → 用户观感「清空初始化」。
// 方案: 成功身份写入 localStorage, useQuery initialData 命中新鲜快照
// (≤10 分钟) 时零网络立即就绪; 401 清快照; 登出显式清。
// 安全性: 快照仅驱动 UI 渲染 (菜单/路由守卫 UX 层), 所有数据请求仍由
// 后端按 cookie 会话鉴权, 陈旧快照无提权面; 超窗自动失效。
const SNAPSHOT_KEY = 'tf-auth-me-snapshot'
const SNAPSHOT_FRESH_MS = 10 * 60_000

interface AuthMeSnapshot {
  v: { ok: boolean; identity: AuthIdentity }
  ts: number
}

function readSnapshot(): AuthMeSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as AuthMeSnapshot
    if (typeof s?.ts !== 'number' || !s?.v?.identity) return null
    return s
  } catch {
    return null
  }
}

function writeSnapshot(v: { ok: boolean; identity: AuthIdentity }): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v, ts: Date.now() }))
  } catch {
    // 隐私模式/存储满 → 静默降级 (无快照 = 走网络, 行为同旧版)
  }
}

/** 清除身份快照 (登出/会话过期时调用, 防陈旧身份渲染)。 */
export function clearAuthMeSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY)
  } catch {
    // 同上, 静默
  }
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
  return api.authMe().then((me) => {
    writeSnapshot(me)
    return { ok: true, identity: me.identity }
  }).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return NOT_ENABLED
    // 401 (未登录/会话过期): 清快照 — 否则下次刷新 initialData 又把
    // 过期身份渲染出来, 闪一个「假登录态」再被重定向到登录页
    if (err instanceof ApiError && err.status === 401) clearAuthMeSnapshot()
    throw err
  })
}

/** 取新鲜快照作 useQuery initialData (超窗返回 null 走网络)。 */
function freshSnapshotInitialData():
  { initialData: { ok: boolean; identity: AuthIdentity }; initialDataUpdatedAt: number } | undefined {
  const s = readSnapshot()
  if (!s || Date.now() - s.ts > SNAPSHOT_FRESH_MS) return undefined
  return { initialData: { ok: true, identity: s.v.identity }, initialDataUpdatedAt: s.ts }
}

export function useAuth(): AuthState {
  const { data, isLoading } = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: authMeQueryFn,      // 404 → 哨兵成功值, 不进 error 状态 (防轮询风暴)
    staleTime: 60_000,           // 快照 60s 内复用, 与后端 SNAPSHOT_TTL 对齐 (轻量)
    retry: false,                // 互通启用但后端异常时不重试, 失败由兜底逻辑处理
    // 身份快照 initialData (≤10 分钟新鲜窗): 刷新零网络立即就绪,
    // 消灭守卫路由 Forbidden 闪现; initialDataUpdatedAt 如实回填时间戳,
    // 超 staleTime 时后台 refetch 校正 (角色变更等)
    ...freshSnapshotInitialData(),
  })
  return {
    enabled: data != null && !('notEnabled' in data),
    identity: data != null && !('notEnabled' in data) ? data.identity : null,
    ready: !isLoading && data != null,
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
      writeSnapshot(me)
      qc.setQueryData(AUTH_ME_KEY, { ok: true, identity: me.identity })
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
  const { enabled, identity, ready } = useAuth()
  const perms = identity?.perms ?? []

  return {
    /** 互通是否启用 */
    enabled,
    /** 形态探测完成 (探测前 hasPerm 保守拒绝权限 Tab, 防竞态闪烁) */
    ready,
    /** 是否有某权限点 (如 'stick:backtest:run'); 单密码形态恒 true;
     *  互通形态探测中 (ready=false) 保守拒绝所有带权限点的判定, 防止登录后
     *  auth-me 未返回瞬间侧边栏全量渲染 18 项菜单 (产品面泄露) 或误挂
     *  admin 面板发 403 请求。ready=false 期间: 菜单/Tab 暂不渲染, 路由守卫
     *  显示加载态 (RequirePerm), 绝不放行也绝不误拒。
     *  ⚠️ ready 判定必须先于 enabled: 探测中 data=null → enabled=false,
     *  若先判 enabled 会恒放行, 守卫形同虚设 (v2.5 修复的闪现根因)。 */
    hasPerm: (required: string): boolean => {
      if (!ready) return false
      if (!enabled) return true
      if (perms.includes('*:*:*')) return true
      return perms.includes(required)
    },
  }
}