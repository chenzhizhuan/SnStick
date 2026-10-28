// @vitest-environment node
// navConfig 结构断言 — 第 46 轮 IA 重构 (v4 导航树) 的形状契约。
// 业务来源: 用户 2026-10-28 导航重构需求 (顶部固定入口 + 五大研究组 +
// 底部账户与系统)。
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, NAV_ITEMS, ASSISTANT_OPEN_EVENT, type NavConfigItem } from './navConfig'
import { DEFAULT_NAV_PATHS } from './navOrder'

const byGroup = (key: string) => NAV_ITEMS.filter(n => n.group === key)

describe('NAV_GROUPS — v4 导航分组', () => {
  it('7 组顺序: 顶部(无标题) / 市场研究 / 标的研究 / 量化研究 / 监控预警 / 复盘中心 / 账户与系统', () => {
    expect(NAV_GROUPS.map(g => g.key)).toEqual([
      'top', 'market', 'subject', 'quant', 'monitor', 'review', 'system',
    ])
    expect(NAV_GROUPS.map(g => g.label)).toEqual([
      '', '市场研究', '标的研究', '量化研究', '监控预警', '复盘中心', '账户与系统',
    ])
  })
})

describe('NAV_ITEMS — 顶部固定入口', () => {
  it('恰好 2 项: 市场看板 (恒可见) + AI研究助手 (动作型, pinned)', () => {
    expect(byGroup('top').map(n => n.label)).toEqual(['市场看板', 'AI研究助手'])
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
  it('数据管理 + 3 个 pinned 设置入口 (实时行情/数据源/页面)', () => {
    expect(byGroup('system').map(n => n.label)).toEqual([
      '数据管理', '实时行情设置', '数据源设置', '页面设置',
    ])
    expect(byGroup('system').map(n => n.to)).toEqual([
      '/data', '/settings?tab=monitoring', '/settings?tab=data-sources', '/settings?tab=menus',
    ])
    const [data, realtime, ds, pages] = byGroup('system')
    expect(data.perm).toBe('stick:menu:data')
    expect(data.pinned).toBeUndefined()
    expect(realtime.pinned).toBe(true)
    expect(ds.pinned).toBe(true)
    expect(pages.pinned).toBe(true)
    expect(new Set([realtime.perm, ds.perm, pages.perm])).toEqual(new Set(['stick:settings:read']))
  })
})

describe('NAV_ITEMS — 不变量', () => {
  it('pinned 恰好 4 项 (AI助手 + 3 设置入口); 市场看板与数据管理可自定义', () => {
    const pinned = NAV_ITEMS.filter(n => n.pinned)
    expect(pinned.map(n => n.label)).toEqual([
      'AI研究助手', '实时行情设置', '数据源设置', '页面设置',
    ])
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
  it('动作型条目仅 AI研究助手, 事件名常量导出', () => {
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
