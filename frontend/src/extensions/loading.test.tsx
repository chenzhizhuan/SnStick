// @vitest-environment jsdom
import { act, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Activity } from 'lucide-react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FrontendExtensionModule } from './types'

const loads = vi.hoisted(() => ({ paper: vi.fn(), fake: vi.fn() }))
vi.mock('../custom/paper/Page', () => {
  loads.paper()
  return { Paper: () => <div>模拟盘页面</div> }
})
// v0.3.26 合并调整: 品牌线已内置化异动监控页 (custom/abnormal 目录不存在),
// 第二个被测扩展改为内联 fake 模块, 不依赖具体 custom 目录结构。
const fakeExtension = (): Promise<FrontendExtensionModule> => {
  // 页面组件内计数: 与 vi.mock(Page) 的「页面模块被加载」语义对齐 —
  // 注册阶段不触发, 仅路由真实渲染该组件时才算"页面已加载"。
  const FakePage = () => { loads.fake(); return <div>假扩展页面</div> }
  return Promise.resolve({
    default: {
      id: 'test.fake',
      apiVersion: 1 as const,
      routes: [{ id: 'fake', path: '/fake', component: FakePage }],
      navigation: [{ id: 'fake-nav', routeId: 'fake', label: '假扩展页', icon: Activity }],
    },
  })
}

afterEach(() => { vi.resetModules() })

it('注册菜单不加载页面；直接访问扩展路由只加载该页面', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const registry = await import('./registry')
  await registry.loadFrontendExtensions({
    paper: () => import('../custom/paper/extension'),
    fake: fakeExtension,
  })
  registry.finalizeFrontendExtensions(new Set(['/']))
  expect(loads.paper).not.toHaveBeenCalled()
  expect(loads.fake).not.toHaveBeenCalled()
  expect(registry.getFrontendExtensionNavigation().map(n => n.label).sort()).toEqual(['假扩展页', '模拟盘'].sort())
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/paper']}>
        <Suspense fallback={<span>加载中</span>}>
          <Routes>{registry.getFrontendExtensionRoutes().map(route => {
            const Page = route.component
            return <Route key={route.id} path={route.path} element={<Page />} />
          })}</Routes>
        </Suspense>
      </MemoryRouter>,
    ))
    expect(container.textContent).toBe('模拟盘页面')
    expect(loads.paper).toHaveBeenCalledTimes(1)
    expect(loads.fake).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
  }
})

it('并发加载仍按源顺序处理重复 ID，隔离同步抛错的模块', async () => {
  const registry = await import('./registry')
  let finish!: (m: FrontendExtensionModule) => void
  const first = new Promise<FrontendExtensionModule>(resolve => { finish = resolve })
  const second = vi.fn(async () => ({ default: { id: 'test.same', apiVersion: 1 as const } }))
  const loading = registry.loadFrontendExtensions({
    z: second,
    a: () => first,
    broken: () => { throw new Error('bad module') },
  })
  await Promise.resolve()
  expect(second).toHaveBeenCalledTimes(1)
  finish({ default: {
    id: 'test.same', apiVersion: 1,
    routes: [{ id: 'first', path: '/first', component: () => null }],
  } })
  await loading
  registry.finalizeFrontendExtensions(new Set())
  expect(registry.getFrontendExtensionRoutes().map(r => r.path)).toEqual(['/first'])
  expect(registry.getFrontendExtensionLoadErrors().map(e => e.source)).toEqual(['broken', 'z'])
})
