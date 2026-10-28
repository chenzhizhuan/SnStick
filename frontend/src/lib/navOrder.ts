/**
 * 侧栏默认排序基准 — v4 IA 重构 (2026-10-28 第 46 轮)。
 *
 * 顺序 = navConfig.NAV_ITEMS 非 pinned 条目的声明顺序 (顶部固定入口 /
 * 五大研究组 / 底部数据管理); 需求来源: 用户导航重构需求单。
 * navConfig.test 有跨文件一致性断言, 改任一侧都会被测试捕获。
 *
 * 历史: v3.2 基准为扩展域迁移兼容而生 (19 项); v4 补入 /chart 并按
 * 新树重排。已保存过 nav_order 的用户按保存值展示, 不受影响;
 * 未保存用户的新装/默认顺序按本基准。
 *
 * 未知路径 (声明式分析页、二开扩展) 排在已知路径之后, 保持相对顺序。
 * 修改本清单需同步回归 navOrder.test.ts + navConfig.test.ts。
 */
export const DEFAULT_NAV_PATHS = [
  '/',
  '/regime', '/indices', '/concept-analysis', '/industry-analysis', '/limit-ladder',
  '/watchlist', '/chart', '/stock-analysis', '/financials',
  '/factors', '/signals', '/screener', '/backtest', '/paper',
  '/monitor', '/abnormal', '/lots',
  '/review',
  '/data',
] as const

const INDEX = new Map<string, number>(DEFAULT_NAV_PATHS.map((p, i) => [p, i]))

/** 路径的默认序号; 未知路径返回 Infinity (排在全部已知路径之后) */
export function defaultNavIndex(path: string): number {
  return INDEX.get(path) ?? Number.POSITIVE_INFINITY
}

/**
 * 按默认基准排序的比较器。两个未知路径相减会产生 NaN 破坏排序,
 * 必须先判等再相减 (相等时依赖 sort 的稳定性保持相对顺序)。
 */
export function compareByDefaultNav(a: string, b: string): number {
  const ia = defaultNavIndex(a)
  const ib = defaultNavIndex(b)
  if (ia === ib) return 0
  return ia - ib
}

/**
 * 扩展域页面路径 (迁移到 custom/ 的 11 个官方页面)。
 * 新装用户的一次性种子会把它们写入 nav_hidden 默认隐藏;
 * 老用户 (升级前已完成 onboarding) 不受影响。用户随时可在
 * 设置 → 菜单设置 里点眼睛图标逐个开启。
 */
export const EXT_DOMAIN_PAGE_PATHS: readonly string[] = [
  '/stock-analysis', '/limit-ladder', '/concept-analysis', '/industry-analysis', '/financials',
  '/monitor', '/abnormal', '/lots', '/paper', '/signals', '/review',
]

/**
 * 新装用户种子: 返回应写入 nav_hidden 的完整列表 (与已有隐藏项取并集);
 * 老用户返回 null 表示不动。判定信号是 onboarding_completed —— 首启
 * 向导强制完成, 升级前用过应用的用户必然为 true。
 */
export function seedHiddenForNewUser(
  onboardingCompleted: boolean | undefined,
  currentHidden: readonly string[] | null | undefined,
): string[] | null {
  if (onboardingCompleted !== false) return null
  const hidden = new Set(currentHidden ?? [])
  for (const p of EXT_DOMAIN_PAGE_PATHS) hidden.add(p)
  return [...hidden]
}
