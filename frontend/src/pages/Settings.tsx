/**
 * 统一设置页面 — Tab 切换外壳。
 *
 * 通过 URL query param ?tab=xxx 同步 Tab 状态。
 */
import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Database, KeyRound, LayoutGrid, Library, Radio, Sparkles, Settings2, ShieldCheck, PanelLeftClose, PanelLeftOpen, Clock3, Info, HardDriveDownload } from 'lucide-react'
// 面板按 tab 按需加载 (r47: main 归拢为 9 tab + 品牌线 platform/roles 权限管理)
const SettingsAIPanel = lazy(() => import('./settings/AI').then(m => ({ default: m.SettingsAIPanel })))
const SettingsApiTokensPanel = lazy(() => import('./settings/ApiTokens').then(m => ({ default: m.SettingsApiTokensPanel })))
const SettingsBackupPanel = lazy(() => import('./settings/Backup').then(m => ({ default: m.SettingsBackupPanel })))
const SettingsDefinitionsPanel = lazy(() => import('./settings/Definitions').then(m => ({ default: m.SettingsDefinitionsPanel })))
const SettingsMonitoringPanel = lazy(() => import('./settings/Monitoring').then(m => ({ default: m.SettingsMonitoringPanel })))
const SettingsPageAdminPanel = lazy(() => import('./settings/PageAdmin').then(m => ({ default: m.SettingsPageAdminPanel })))
const SettingsTimeoutPanel = lazy(() => import('./settings/Timeout').then(m => ({ default: m.SettingsTimeoutPanel })))
const SettingsSystemPanel = lazy(() => import('./settings/System').then(m => ({ default: m.SettingsSystemPanel })))
const SettingsAboutPanel = lazy(() => import('./settings/About').then(m => ({ default: m.SettingsAboutPanel })))
const SettingsDataSourcesPanel = lazy(() => import('./settings/DataSources').then(m => ({ default: m.SettingsDataSourcesPanel })))
const SettingsPlatformPanel = lazy(() => import('./settings/Platform').then(m => ({ default: m.SettingsPlatformPanel })))
const SettingsRolesPanel = lazy(() => import('./settings/Roles').then(m => ({ default: m.SettingsRolesPanel })))
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/cn'
import { usePerm } from '@/lib/useAuth'
import { setUiPref } from '@/lib/uiPrefs'

// ===== Tab 定义 =====

type TabDef = {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  panel: ComponentType<{ highlight?: string }>
  badge?: string
  /** 互通形态下要求的权限点 (缺省 = 无门槛); 无权限时 Tab 隐藏。 */
  perm?: string
}

const TABS: readonly TabDef[] = [
  { key: 'data-sources', label: '数据源',     icon: Database,  panel: SettingsDataSourcesPanel },
  { key: 'ai',         label: 'AI 设置',    icon: Sparkles,  panel: SettingsAIPanel },
  { key: 'monitoring', label: '实时监控',   icon: Radio,      panel: SettingsMonitoringPanel },
  { key: 'pages',      label: '页面管理',   icon: LayoutGrid, panel: SettingsPageAdminPanel },
  { key: 'timeout',    label: '网络设置',   icon: Clock3,     panel: SettingsTimeoutPanel },
  { key: 'api-tokens', label: '开放接口',   icon: KeyRound,   panel: SettingsApiTokensPanel },
  { key: 'definitions', label: '定义目录',   icon: Library,    panel: SettingsDefinitionsPanel },
  { key: 'backup',     label: '配置备份',   icon: HardDriveDownload, panel: SettingsBackupPanel },
  { key: 'system',     label: '系统设置',   icon: Settings2,  panel: SettingsSystemPanel },
  // 品牌线权限体系 (r47 保留): 平台管理与角色权限 — 仅超管可见
  { key: 'platform',   label: '平台管理',   icon: ShieldCheck, panel: SettingsPlatformPanel, perm: 'stick:admin:view' },
  { key: 'roles',      label: '权限管理',   icon: KeyRound,    panel: SettingsRolesPanel,    perm: 'stick:admin:view' },
  { key: 'about',      label: '关于',       icon: Info,       panel: SettingsAboutPanel },
]

// 「页面管理」归拢前的三个 tab key → 深链子区块, 历史链接零失效
const LEGACY_PAGE_TAB_SECTIONS: Record<string, string> = {
  menus: 'menus',
  'ext-pages': 'ext-pages',
  'page-packs': 'page-packs',
}

type TabKey = (typeof TABS)[number]['key']

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { hasPerm, ready } = usePerm()
  // 权限过滤: 互通形态下, 无权限的 Tab 隐藏 (如平台管理仅 admin 可见)。
  // 探测完成前 (ready=false) 仅显示无权限门槛的 Tab, 防登录后竞态误挂 admin 面板。
  const visibleTabs = TABS.filter((t) => !t.perm || (ready && hasPerm(t.perm)))
  const tabParam = searchParams.get('tab') as TabKey | null
  // 旧 tab (menus/ext-pages/page-packs) 已并入「页面管理」(r47 main): 渲染按 pages
  // 处理, 再用 replace 把 URL 归一化并透传 section, 保持深链与历史记录干净;
  // 权限过滤 (品牌线) 叠加在归一化之后 — 无权限的 Tab 仍隐藏。
  const legacySection = tabParam ? LEGACY_PAGE_TAB_SECTIONS[tabParam] : undefined
  const activeTab = visibleTabs.find((t) => t.key === (legacySection ? 'pages' : tabParam)) ?? visibleTabs[0]
  const highlight = searchParams.get('highlight') ?? ''

  useEffect(() => {
    if (!legacySection) return
    const next = new URLSearchParams(searchParams)
    next.set('tab', 'pages')
    next.set('section', legacySection)
    setSearchParams(next, { replace: true })
  }, [legacySection, searchParams, setSearchParams])

  // 设置菜单收起状态 — 持久化到 localStorage
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('tf-settings-nav-collapsed') === '1' } catch { return false }
  })
  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev
      try { setUiPref('tf-settings-nav-collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }

  return (
    <>
      <PageHeader
        title="设置"
        subtitle="管理账户、数据刷新策略和高级功能配置。"
      />

      <div className="px-8 py-6">
        <div className="flex gap-6 items-stretch">
          {/* ===== 竖向 Tab 侧栏 ===== */}
          <nav className={cn('shrink-0 transition-all duration-200 ease-smooth', collapsed ? 'w-10' : 'w-36')}>
            <div className="flex flex-col gap-0.5 justify-center min-h-[60vh] sticky top-6">
              {/* 收起/展开 按钮 */}
              <button
                onClick={toggleCollapsed}
                className={cn(
                  'flex items-center gap-2 rounded-btn text-muted hover:text-foreground hover:bg-elevated/60 transition-colors duration-150 ease-smooth mb-1',
                  collapsed ? 'justify-center px-0 py-2' : 'px-3 py-2 text-xs',
                )}
                title={collapsed ? '展开菜单' : '收起菜单'}
              >
                {collapsed
                  ? <PanelLeftOpen className="h-3.5 w-3.5 shrink-0" />
                  : <PanelLeftClose className="h-3.5 w-3.5 shrink-0" />
                }
                {!collapsed && <span>收起菜单</span>}
              </button>

              {/* Tab 按钮列表 — 收起时只显示图标 */}
              {visibleTabs.map(({ key, label, icon: Icon, badge }) => (
                <button
                  key={key}
                  onClick={() => setSearchParams({ tab: key }, { replace: true })}
                  title={collapsed ? label : undefined}
                  className={cn(
                    'relative flex items-center rounded-btn text-sm transition-colors duration-150 ease-smooth',
                    collapsed ? 'justify-center px-0 py-2' : 'items-center gap-2 px-3 py-2 text-left',
                    activeTab.key === key
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-secondary hover:text-foreground hover:bg-elevated/60',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {!collapsed && <span>{label}</span>}
                  {!collapsed && badge && (
                    <span className="ml-auto inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400 shrink-0">
                      {badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </nav>

          {/* ===== Tab 内容 ===== */}
          <motion.div
            key={activeTab.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="min-w-0 flex-1"
          >
            <Suspense fallback={<div className="py-12 text-center text-xs text-muted">加载中…</div>}>
              {activeTab.key === 'monitoring'
                ? <SettingsMonitoringPanel highlight={highlight} />
                : <activeTab.panel highlight={highlight} />}
            </Suspense>
          </motion.div>
        </div>
      </div>
    </>
  )
}
