// @vitest-environment jsdom
// useAuth 身份快照本地缓存 — 第 45 轮 RED 测试:
// 刷新时 auth-me 需网络 RTT (~100-400ms) + 守卫路由 lazy chunk (~700ms),
// 期间 ready=false → 页面闪「无权限访问」(用户报「清空初始化的感觉」)。
// 方案: 成功身份快照写 localStorage (10 分钟新鲜窗), useQuery initialData
// 立即就绪; 401 (会话过期) 清快照; 登出显式清快照。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authMeMock = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { authMe: (refresh = false) => authMeMock(refresh) },
  // 镜像真实 ApiError 签名 (message, status) — 动态 import 的类型来自真实模块
  ApiError: class ApiError extends Error {
    readonly status: number
    constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status }
  },
}))

import { clearAuthMeSnapshot, useAuth } from './useAuth'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const IDENTITY = {
  user_id: '1', user_name: 'admin', nick_name: '超管',
  roles: ['admin'], perms: ['*:*:*'],
}

let root: Root | null = null
const container = document.createElement('div')
document.body.appendChild(container)

async function renderUseAuth() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let state: ReturnType<typeof useAuth> | null = null
  function Probe() { state = useAuth(); return null }
  await act(async () => {
    root = createRoot(container)
    root.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>)
  })
  return {
    get state() { return state! },
    qc,
    /** 等异步 query 解析落定。 */
    settle: async (ms = 60) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) },
  }
}

const SNAPSHOT_KEY = 'tf-auth-me-snapshot'

beforeEach(() => {
  localStorage.clear()
  authMeMock.mockReset()
})
afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container.innerHTML = ''
  localStorage.clear()
})

describe('authMeQueryFn 快照读写', () => {
  it('200 身份 → 快照写入 localStorage, query 返回身份', async () => {
    authMeMock.mockResolvedValue({ ok: true, identity: IDENTITY })
    const h = await renderUseAuth()
    await h.settle()
    expect(h.state.identity?.user_id).toBe('1')
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).v.identity.user_id).toBe('1')
  })

  it('404 (单密码形态) → NOT_ENABLED 哨兵, 不写快照', async () => {
    const { ApiError } = await import('@/lib/api')
    authMeMock.mockRejectedValueOnce(new ApiError('账号互通未启用', 404))
    const h = await renderUseAuth()
    await h.settle()
    expect(h.state.enabled).toBe(false)
    expect(h.state.ready).toBe(true)
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull()
  })

  it('401 (会话过期) → 快照被清除', async () => {
    const { ApiError } = await import('@/lib/api')
    authMeMock.mockRejectedValueOnce(new ApiError('未登录或会话已过期', 401))
    // stale 快照 (ts = 5 分钟前, 超过 staleTime 60s 但在 10 分钟新鲜窗内):
    // initialData 立即生效 → 后台 refetch 401 → 快照被清
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: { ok: true, identity: IDENTITY }, ts: Date.now() - 5 * 60_000 }))
    const h = await renderUseAuth()
    // initialData 立即生效
    expect(h.state.ready).toBe(true)
    expect(h.state.identity?.user_id).toBe('1')
    // 等 refetch (401) 完成后快照被清
    await h.settle()
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull()
  })
})

describe('useAuth initialData 新鲜窗', () => {
  it('快照 30s 内 (<staleTime) → 立即 ready, 零网络请求', async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: { ok: true, identity: IDENTITY }, ts: Date.now() - 30_000 }))
    const h = await renderUseAuth()
    await h.settle(30)
    expect(h.state.ready).toBe(true)
    expect(h.state.enabled).toBe(true)
    expect(h.state.identity?.user_id).toBe('1')
    expect(authMeMock).not.toHaveBeenCalled()
  })

  it('快照 5min (新鲜窗内, 超 staleTime) → 立即 ready + 后台校正', async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: { ok: true, identity: IDENTITY }, ts: Date.now() - 5 * 60_000 }))
    authMeMock.mockResolvedValue({ ok: true, identity: IDENTITY })
    const h = await renderUseAuth()
    // initialData 立即生效 (零闪烁)
    expect(h.state.ready).toBe(true)
    expect(h.state.identity?.user_id).toBe('1')
    // 后台 refetch 校正已发出
    expect(authMeMock).toHaveBeenCalledTimes(1)
    await h.settle()
    expect(h.state.ready).toBe(true)
  })

  it('陈旧快照 (>10min) → 忽略, 走网络', async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: { ok: true, identity: IDENTITY }, ts: Date.now() - 11 * 60_000 }))
    authMeMock.mockResolvedValue({ ok: true, identity: IDENTITY })
    const h = await renderUseAuth()
    await h.settle()
    expect(authMeMock).toHaveBeenCalled()
    expect(h.state.identity?.user_id).toBe('1')
  })

  it('clearAuthMeSnapshot 显式清除', () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: { ok: true, identity: IDENTITY }, ts: Date.now() }))
    clearAuthMeSnapshot()
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull()
  })
})
