import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryCache } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { initializeFrontendExtensions } from './extensions/bootstrap'
import { createAppPersister, shouldPersistQuery, PERSIST_BUSTER } from './lib/queryPersist'
// 字体自托管 (@fontsource): 替代 rsms.me / Google Fonts 渲染阻塞外链,
// 内网/离线部署不再白屏等字体。权重覆盖 tailwind 全部用量 (300-900)。
import '@fontsource/inter/300.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/900.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import './index.css'
import './styles/workstation.css'
import './styles/strategy-studio.css'

// 全局认证拦截: 任何 query/mutation 收到 401 (未登录/会话过期) → 跳登录页。
// api.ts 的 request() 已对 401 静默 (不弹 toast), 这里统一负责跳转。
// 排除 /login 自身的请求, 避免登录页请求失败又跳登录形成死循环。
const _redirectToLogin = (() => {
  let redirecting = false
  return (err: unknown) => {
    if (redirecting) return
    if (!(err instanceof Error)) return
    const msg = err.message || ''
    // 401 (未登录/会话过期) → 跳登录页
    // 403 未初始化 (面板未设密码, 公网访问) → 也跳登录页(显示设密码提示)
    const is401 = msg.includes('未登录') || msg.includes('会话已过期') || msg.includes('401')
    const isNotInit = msg.includes('尚未初始化访问密码') || msg.includes('NOT_INITIALIZED')
    if (!is401 && !isNotInit) return
    // 已在登录页则不跳(避免死循环)
    if (window.location.pathname === '/login') return
    redirecting = true
    const redirect = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.href = `/login?redirect=${redirect}`
  }
})()

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => _redirectToLogin(err),
  }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,           // 5s 内复用,与 §4.2 Repository 不变量一致
      refetchOnWindowFocus: false,
    },
    mutations: {
      onError: (err) => _redirectToLogin(err),
    },
  },
})

/**
 * 用户级 localStorage 命名空间 (v2.3 多用户隔离前端侧):
 *   - 登录身份就绪后设置前缀 `u:<user_id>:`, 用户级 key (策略池/草稿/回测残留/
 *     last_stock 等) 按账号隔离;
 *   - v2.3.1: 隔离完全靠前缀天然实现, 不删除任何 u: 前缀 key (包括其他账号的)。
 *     账号 B 只读写 `u:<B>:` 前缀, 永远读不到 A 的 `u:<A>:` 数据; A 登出再登回,
 *     数据还在。仅一次性打扫升级前无前缀写入的裸 key 残留。
 * 桌面版/单密码形态: /me 404 → 无前缀, 行为与升级前完全一致。
 */
async function initUserKeyNamespace() {
  try {
    const { api } = await import('./lib/api')
    const me = await api.authMe()
    if (me?.identity?.user_id) {
      const { setActiveUserKeyPrefix, clearLegacyUserKeys } = await import('./lib/storage')
      setActiveUserKeyPrefix(`u:${me.identity.user_id}:`)
      clearLegacyUserKeys()
    }
  } catch {
    // 401 (未登录, 登录页流程) / 404 (桌面版) / 网络异常 → 不设前缀, 走默认
  }
}

async function bootstrap() {
  await initializeFrontendExtensions()
  await initUserKeyNamespace()
  const { router } = await import('./router')
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MotionConfig reducedMotion="user">
          <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{
              persister: createAppPersister(),
              buster: PERSIST_BUSTER,
              // 恢复超过 1 天的缓存直接丢弃 (慢变族一天内必然后台刷新过)
              maxAge: 24 * 60 * 60 * 1000,
              dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
            }}
          >
            <RouterProvider router={router} />
          </PersistQueryClientProvider>
      </MotionConfig>
    </React.StrictMode>,
  )
}

void bootstrap()
