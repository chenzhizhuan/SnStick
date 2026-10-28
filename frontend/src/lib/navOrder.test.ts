// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAV_PATHS,
  EXT_DOMAIN_PAGE_PATHS,
  compareByDefaultNav,
  defaultNavIndex,
  seedHiddenForNewUser,
} from './navOrder'

// v4 IA 重构 (2026-10-28 第 46 轮) 后的默认基准。
// 順序 = navConfig.NAV_ITEMS 非 pinned 声明序 (单一事实来源, navConfig.test
// 有跨文件一致性断言); 改动需明确决策 — 未保存排序用户的默认侧栏随之变化。
describe('navOrder: v4 IA 重构后的默认排序基准', () => {
  it('覆盖全部 20 个非固定内置路径且无重复 (v4 补入 /chart)', () => {
    expect(DEFAULT_NAV_PATHS).toHaveLength(20)
    expect(new Set(DEFAULT_NAV_PATHS).size).toBe(20)
  })

  it('关键位置与新导航树一致', () => {
    expect(DEFAULT_NAV_PATHS[0]).toBe('/')
    expect(DEFAULT_NAV_PATHS[1]).toBe('/regime')
    expect(DEFAULT_NAV_PATHS[6]).toBe('/watchlist')
    expect(DEFAULT_NAV_PATHS[7]).toBe('/chart')
    expect(DEFAULT_NAV_PATHS[11]).toBe('/signals')
    // 监控预警组: 监控中心 / 异动监控 / 持仓提醒 (v4 用户需求单顺序)
    expect(DEFAULT_NAV_PATHS[15]).toBe('/monitor')
    expect(DEFAULT_NAV_PATHS[16]).toBe('/abnormal')
    expect(DEFAULT_NAV_PATHS[17]).toBe('/lots')
    expect(DEFAULT_NAV_PATHS[18]).toBe('/review')
    expect(DEFAULT_NAV_PATHS[19]).toBe('/data')
  })

  it('未知道径返回 Infinity, 排在已知路径之后', () => {
    expect(defaultNavIndex('/data')).toBe(19)
    expect(defaultNavIndex('/company/risk')).toBe(Number.POSITIVE_INFINITY)
    expect(defaultNavIndex('/analysis/custom1')).toBe(Number.POSITIVE_INFINITY)
  })

  it('排序比较器: 已知按默认序, 未知稳定沉底 (不产生 NaN)', () => {
    const paths = ['/monitor', '/company/risk', '/', '/analysis/x', '/watchlist', '/data']
    const sorted = [...paths].sort(compareByDefaultNav)
    // 两个未知道径保持原始相对顺序 (company/risk 在 analysis/x 前)
    expect(sorted).toEqual(['/', '/watchlist', '/monitor', '/data', '/company/risk', '/analysis/x'])
  })
})

describe('seedHiddenForNewUser: 新装用户默认隐藏种子', () => {
  it('扩展域页面清单与默认基准一致且共 11 项', () => {
    expect(EXT_DOMAIN_PAGE_PATHS).toHaveLength(11)
    for (const p of EXT_DOMAIN_PAGE_PATHS) {
      expect(defaultNavIndex(p)).not.toBe(Number.POSITIVE_INFINITY)
    }
  })

  it('新用户 (未完成 onboarding): 11 个扩展页并入隐藏清单', () => {
    const next = seedHiddenForNewUser(false, [])
    expect(next).not.toBeNull()
    for (const p of EXT_DOMAIN_PAGE_PATHS) expect(next).toContain(p)
  })

  it('新用户已有隐藏项: 取并集不丢失', () => {
    const next = seedHiddenForNewUser(false, ['/indices'])
    expect(next).toContain('/indices')
    expect(next).toContain('/review')
    expect(new Set(next).size).toBe(next!.length)
  })

  it('老用户 (已完成 onboarding) 与未知状态: 不动, 返回 null', () => {
    expect(seedHiddenForNewUser(true, [])).toBeNull()
    expect(seedHiddenForNewUser(undefined, [])).toBeNull()
  })
})
