/**
 * 侧栏导航配置 — v4 IA 重构 (第 46 轮, 2026-10-28 用户需求)。
 *
 * 纯数据单一事实来源: NAV_GROUPS + NAV_ITEMS 供 Layout 渲染 /
 * navConfig.test 结构断言 / navOrder 默认基准 (非 pinned 序列) 共用,
 * 菜单结构与权限点不再散落 Layout。
 *
 * 结构 (r46d 调整, 2026-10-28 用户反馈):
 *   - 总览 (top): 市场看板 + AI研究助手 (动作型) — 恢复分组标题
 *   - 五大研究组: 市场研究 / 标的研究 / 量化研究 / 监控预警 / 复盘中心
 *   - 底部账户与系统 (system): 仅数据管理 (3 个设置入口已移除 —
 *     设置仍可从右上角用户菜单与侧栏底部实时行情区块进入)
 *
 * pinned 语义: 不参与用户自定义排序与隐藏 (菜单设置不可控),
 * 恒按组声明顺序渲染 — 当前仅 AI研究助手 (动作型骨架入口)。
 *
 * 权限点: stick:menu:<slug> 仅控制菜单可见性 (与 role_map.yaml 同步);
 * stick:settings:read 控制设置类入口; 数据管理 (stick:menu:data +
 * stick:data:read/write) v4 起仅超级版 (admin) 拥有。
 */
import type { ReactNode } from 'react'
import {
  IconDashboard, IconChart, IconWatchlist, IconStrategy, IconFactors, IconBacktest,
  IconStockFocus, IconLadder, IconConcept, IconIndustry, IconFinancials,
  IconMonitor, IconRegime, IconAlert, IconLots, IconPaper, IconSignals,
  IconReview, IconIndices, IconData,
} from '@/components/BrandIcons'
import { Sparkles } from 'lucide-react'

/** AI 研究助手导航入口点击时派发的全局事件 — assistant 扩展监听后开抽屉。
 *  走事件桥而非直接 import: assistant 是完全解耦模块 (删目录即卸载),
 *  核心导航不得依赖其内部实现。 */
export const ASSISTANT_OPEN_EVENT = 'sn:assistant:open'

/** 导航分组 key 联合类型 — Layout 渲染与合并逻辑共用 */
export type NavGroupKey = (typeof NAV_GROUPS)[number]['key']

export interface NavConfigItem {
  to: string
  label: string
  icon: (props: { className?: string }) => ReactNode
  /** 所属分组 (NAV_GROUPS 之一; 类型锁定防拼错 key) */
  group: NavGroupKey
  /** 互通形态权限点 (role_map.yaml 同口径); undefined = 恒可见 */
  perm?: string
  /** 动作型条目: 点击派发事件而非路由跳转 (当前仅 AI 研究助手) */
  action?: 'assistant'
  /** 固定项: 不参与用户自定义排序/隐藏 (当前仅 AI 研究助手动作型入口) */
  pinned?: boolean
}

export const NAV_GROUPS = [
  { key: 'top', label: '总览' },
  { key: 'market', label: '市场研究' },
  { key: 'subject', label: '标的研究' },
  { key: 'quant', label: '量化研究' },
  { key: 'monitor', label: '监控预警' },
  { key: 'review', label: '复盘中心' },
  { key: 'system', label: '账户与系统' },
] as const

export const NAV_ITEMS: readonly NavConfigItem[] = [
  // ── 总览 ──
  { to: '/', label: '市场看板', icon: IconDashboard, group: 'top' },
  { to: 'assistant://open', label: 'AI研究助手', icon: Sparkles, group: 'top', action: 'assistant', pinned: true },
  // ── 一、市场研究 ──
  { to: '/regime', label: '市场环境', icon: IconRegime, group: 'market', perm: 'stick:menu:regime' },
  { to: '/indices', label: '指数分析', icon: IconIndices, group: 'market', perm: 'stick:menu:indices' },
  { to: '/concept-analysis', label: '概念分析', icon: IconConcept, group: 'market', perm: 'stick:menu:concept-analysis' },
  { to: '/industry-analysis', label: '行业分析', icon: IconIndustry, group: 'market', perm: 'stick:menu:industry-analysis' },
  { to: '/limit-ladder', label: '连板梯队', icon: IconLadder, group: 'market', perm: 'stick:menu:limit-ladder' },
  // ── 二、标的研究 ──
  { to: '/watchlist', label: '自选股', icon: IconWatchlist, group: 'subject', perm: 'stick:menu:watchlist' },
  { to: '/chart', label: '专业图表', icon: IconChart, group: 'subject', perm: 'stick:menu:chart' },
  { to: '/stock-analysis', label: '个股分析', icon: IconStockFocus, group: 'subject', perm: 'stick:menu:stock-analysis' },
  { to: '/financials', label: '财务分析', icon: IconFinancials, group: 'subject', perm: 'stick:menu:financials' },
  // ── 三、量化研究 ──
  { to: '/factors', label: '因子研究', icon: IconFactors, group: 'quant', perm: 'stick:menu:factors' },
  { to: '/signals', label: '信号库', icon: IconSignals, group: 'quant', perm: 'stick:menu:signals' },
  { to: '/screener', label: '策略中心', icon: IconStrategy, group: 'quant', perm: 'stick:menu:screener' },
  { to: '/backtest', label: '策略回测', icon: IconBacktest, group: 'quant', perm: 'stick:menu:backtest' },
  { to: '/paper', label: '模拟盘', icon: IconPaper, group: 'quant', perm: 'stick:menu:paper' },
  // ── 四、监控预警 ──
  { to: '/monitor', label: '监控中心', icon: IconMonitor, group: 'monitor', perm: 'stick:menu:monitor' },
  { to: '/abnormal', label: '异动监控', icon: IconAlert, group: 'monitor', perm: 'stick:menu:abnormal' },
  { to: '/lots', label: '持仓提醒', icon: IconLots, group: 'monitor', perm: 'stick:menu:lots' },
  // ── 五、复盘中心 ──
  { to: '/review', label: 'AI市场复盘', icon: IconReview, group: 'review', perm: 'stick:menu:review' },
  // ── 底部 · 账户与系统 (面向管理员; r46d 起仅数据管理,
  //    设置入口归右上角用户菜单 + 侧栏底部实时行情区块) ──
  { to: '/data', label: '数据管理', icon: IconData, group: 'system', perm: 'stick:menu:data' },
]
