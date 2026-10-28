// @vitest-environment node
// navConfig 结构断言 — 第 46 轮 IA 重构 (v4 导航树) 的形状契约。
// 业务来源: 用户 2026-10-28 导航重构需求 + r46d 反馈调整 (总览分组标题
// 恢复 + 账户与系统仅数据管理)。
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, NAV_ITEMS, ASSISTANT_OPEN_EVENT, type NavConfigItem } from './navConfig'
import { DEFAULT_NAV_PATHS } from './navOrder'

const byGroup = (key: string) => NAV_ITEMS.filter(n => n.group === key)

describe('NAV_GROUPS — v4 导航分组', () => {
  it('7 组顺序: 总览 / 市场研究 / 标的研究 / 量化研究 / 监控预警 / 复盘中心 / 账户与系统', () => {
    expect(NAV_GROUPS.map(g => g.key)).toEqual([
      'top', 'market', 'subject', 'quant', 'monitor', 'review', 'system',
    ])
    expect(NAV_GROUPS.map(g => g.label)).toEqual([
      '总览', '市场研究', '标的研究', '量化研究', '监控预警', '复盘中心', '账户与系统',
    ])
  })
})

describe('NAV_ITEMS — 总览组', () => {
  it('恰好 2 项: 市场看板 (恒可见) + AI 投研助手 (动作型, pinned)', () => {
    expect(byGroup('top').map(n => n.label)).toEqual(['市场看板', 'AI 投研助手'])
    const [dashboard, assistant] = byGroup('top')
    expect(dashboard.to).toBe('/')
    expect(dashboard.perm).toBeUndefined()
    expect(assistant.action).toBe('assistant')
    expect(assistant.pinned).toBe(true)
  })
})

describe('NAV_ITEMS — 五大研究组内容与顺序', () => {
  it('市场研究: 市场环境/指数分析/概念分析/行业分析/连板梯队', () => {
    expect(byGroup('market').map(n => n.label)).toEqual([
      '市场环境', '指数分析', '概念分析', '行业分析', '连板梯队',
    ])
    expect(byGroup('market').map(n => n.to)).toEqual([
      '/regime', '/indices', '/concept-analysis', '/industry-analysis', '/limit-ladder',
    ])
  })
  it('标的研究: 自选股/专业图表/个股分析/财务分析', () => {
    expect(byGroup('subject').map(n => n.label)).toEqual([
      '自选股', '专业图表', '个股分析', '财务分析',
    ])
    expect(byGroup('subject').map(n => n.to)).toEqual([
      '/watchlist', '/chart', '/stock-analysis', '/financials',
    ])
  })
  it('量化研究: 因子研究/信号库/策略中心/策略回测/模拟盘', () => {
    expect(byGroup('quant').map(n => n.label)).toEqual([
      '因子研究', '信号库', '策略中心', '策略回测', '模拟盘',
    ])
    expect(byGroup('quant').map(n => n.to)).toEqual([
      '/factors', '/signals', '/screener', '/backtest', '/paper',
    ])
  })
  it('监控预警: 监控中心/异动监控/持仓提醒 (持仓提醒自量化研究移入)', () => {
    expect(byGroup('monitor').map(n => n.label)).toEqual([
      '监控中心', '异动监控', '持仓提醒',
    ])
    expect(byGroup('monitor').map(n => n.to)).toEqual([
      '/monitor', '/abnormal', '/lots',
    ])
  })
  it('复盘中心: AI市场复盘 (独立成组)', () => {
    expect(byGroup('review').map(n => n.label)).toEqual(['AI市场复盘'])
    expect(byGroup('review').map(n => n.to)).toEqual(['/review'])
  })
})

describe('NAV_ITEMS — 底部账户与系统', () => {
  it('r46d 起仅数据管理 (3 个设置入口已移除, 设置归用户菜单/实时行情区块)', () => {
    expect(byGroup('system').map(n => n.label)).toEqual(['数据管理'])
    expect(byGroup('system').map(n => n.to)).toEqual(['/data'])
    const [data] = byGroup('system')
    expect(data.perm).toBe('stick:menu:data')
    expect(data.pinned).toBeUndefined()
    // 设置入口不再作为导航条目存在
    expect(NAV_ITEMS.some(n => n.to.startsWith('/settings'))).toBe(false)
  })
})

describe('NAV_ITEMS — 不变量', () => {
  it('r46d: pinned 仅 AI 投研助手 (设置入口已移除); 市场看板与数据管理可自定义', () => {
    const pinned = NAV_ITEMS.filter(n => n.pinned)
    expect(pinned.map(n => n.label)).toEqual(['AI 投研助手'])
  })
  it('所有条目 group 均在 NAV_GROUPS; to 全局唯一', () => {
    const groupKeys = new Set(NAV_GROUPS.map(g => g.key))
    for (const n of NAV_ITEMS) expect(groupKeys.has(n.group)).toBe(true)
    const tos = NAV_ITEMS.map(n => n.to)
    expect(new Set(tos).size).toBe(tos.length)
  })
  it('非动作型条目 perm 缺省或 stick:<模块>:<动作> 格式', () => {
    for (const n of NAV_ITEMS) {
      if (n.action) continue
      if (n.perm === undefined) continue
      expect(n.perm).toMatch(/^stick:[a-z-]+:[a-z-]+$/)
    }
  })
  it('动作型条目仅 AI 投研助手, 事件名常量导出', () => {
    const actions = NAV_ITEMS.filter(n => n.action)
    expect(actions).toHaveLength(1)
    expect(typeof ASSISTANT_OPEN_EVENT).toBe('string')
    expect(ASSISTANT_OPEN_EVENT).toContain('assistant')
  })
})

describe('与 navOrder 基准一致性', () => {
  it('DEFAULT_NAV_PATHS = 非 pinned 条目按声明顺序的 to 列表', () => {
    const expected = NAV_ITEMS.filter(n => !n.pinned).map((n: NavConfigItem) => n.to)
    expect([...DEFAULT_NAV_PATHS]).toEqual(expected)
  })
})
