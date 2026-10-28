// @vitest-environment jsdom
// RequirePerm 守卫状态机 — 第 45 轮 RED 测试:
// 核心回归: 形态探测中 (ready=false, 此时 data 未落 → enabled 也为 false)
// 必须渲染加载 spinner, 绝不能闪现「无权限访问」403 页。
// 旧代码守卫 `enabled && !ready` 在 pending 期间恒假 (enabled=false)
// → 直接落入 hasPerm()=false → Forbidden 闪现 ~750ms (实测时序)。
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const usePermMock = vi.fn()
vi.mock('@/lib/useAuth', () => ({
  usePerm: () => usePermMock(),
}))

import { RequirePerm } from './RequirePerm'

let root: Root | null = null
const container = document.createElement('div')
document.body.appendChild(container)

async function renderGuard(permState: { enabled: boolean; ready: boolean; hasPerm: (p: string) => boolean }) {
  usePermMock.mockReturnValue(permState)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await act(async () => {
    root = createRoot(container)
    root.render(
      <MemoryRouter>
        <RequirePerm perm="stick:backtest:read">
          <div data-testid="content">CONTENT</div>
        </RequirePerm>
      </MemoryRouter>,
    )
  })
}

const html = () => container.innerHTML

beforeEach(() => { usePermMock.mockReset() })
afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container.innerHTML = ''
})

describe('RequirePerm 守卫状态机', () => {
  it('探测中 (ready=false, enabled=false — pending 组合) → spinner, 不闪 403', async () => {
    await renderGuard({ enabled: false, ready: false, hasPerm: () => false })
    expect(html()).toContain('animate-spin')
    expect(html()).not.toContain('无权限访问')
    expect(html()).not.toContain('CONTENT')
  })

  it('探测中 (ready=false, enabled=true) → spinner (原有分支保持)', async () => {
    await renderGuard({ enabled: true, ready: false, hasPerm: () => false })
    expect(html()).toContain('animate-spin')
    expect(html()).not.toContain('无权限访问')
  })

  it('就绪 + 互通 + 有权限 → 渲染 children', async () => {
    await renderGuard({ enabled: true, ready: true, hasPerm: () => true })
    expect(html()).toContain('CONTENT')
  })

  it('就绪 + 互通 + 无权限 → 403 页', async () => {
    await renderGuard({ enabled: true, ready: true, hasPerm: () => false })
    expect(html()).toContain('无权限访问')
    expect(html()).not.toContain('CONTENT')
  })

  it('就绪 + 单密码形态 (enabled=false) → 恒放行', async () => {
    await renderGuard({ enabled: false, ready: true, hasPerm: () => true })
    expect(html()).toContain('CONTENT')
  })
})
