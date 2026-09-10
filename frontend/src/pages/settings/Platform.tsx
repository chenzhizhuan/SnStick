/**
 * 平台管理面板 (方案 B) — 仅 admin:view 角色可见 (互通形态)。
 *
 * 展示:
 *   - 运行指标 (在线会话 / 登录统计 / AGTi 连接 / role_map / 审计健康 / 运行时长)
 *   - 审计事件流 (按天滚动 JSONL, 支持 category 筛选)
 *
 * 设计约束:
 *   - agti 库严格只读, 用户管理/改密/订阅留在 AGTi 平台, 本页只读观测 + 审计。
 *   - 无 admin:view 权限时 Settings.tsx 不渲染本 Tab; 后端 403 为最终门禁。
 */
import { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ShieldCheck, Users, Server, ScrollText,
  RefreshCw, AlertTriangle, CheckCircle2, XCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'

const CATEGORY_LABELS: Record<string, string> = {
  security: '安全事件',
  access: '权限拒绝',
  admin: '管理操作',
}

const EVENT_LABELS: Record<string, string> = {
  login_ok: '登录成功',
  login_fail: '登录失败',
  login_locked: '登录锁定',
  logout: '登出',
  no_perm: '权限拒绝',
  admin_action: '管理操作',
}

function fmtTs(ts?: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString('zh-CN', { hour12: false })
}

function fmtMs(ms?: number | null): string {
  if (ms == null) return '—'
  return ms >= 100 ? Math.round(ms).toString() : ms.toFixed(1)
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}天${h}小时` : `${h}小时${m}分`
}

export function SettingsPlatformPanel() {
  const [category, setCategory] = useState<string>('')
  const [day, setDay] = useState<string>('')

  const { data: metrics, refetch: refetchMetrics, isFetching: metricsLoading } = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: () => api.adminMetrics(),
    refetchInterval: 30_000,   // 指标 30s 自动刷新
    staleTime: 10_000,
  })

  const { data: audit, refetch: refetchAudit, isFetching: auditLoading } = useQuery({
    queryKey: ['admin', 'audit', day, category],
    queryFn: () => api.adminAudit({ day: day || undefined, category: category || undefined, limit: 200 }),
    staleTime: 5_000,
  })

  const refreshAll = useCallback(() => {
    refetchMetrics()
    refetchAudit()
  }, [refetchMetrics, refetchAudit])

  useEffect(() => {
    // 首次进入刷新一次
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const m = metrics

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-medium text-foreground flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-accent" />
          平台管理
        </h2>
        <button
          onClick={refreshAll}
          disabled={metricsLoading || auditLoading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-btn text-xs
                     bg-elevated text-secondary hover:text-foreground transition-colors
                     disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', (metricsLoading || auditLoading) && 'animate-spin')} />
          刷新
        </button>
      </div>

      {/* ===== 指标卡 ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          icon={<Users className="h-4 w-4 text-accent" />}
          label="在线会话"
          value={m?.sessions?.active ?? '—'}
          sub={`总数 ${m?.sessions?.total ?? '—'} · 失效 ${m?.sessions?.stale ?? '—'}`}
        />
        <MetricCard
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          label="登录成功"
          value={m?.login?.ok ?? '—'}
          sub={m?.login?.last_ok_ts ? `最近 ${fmtTs(m.login.last_ok_ts)}` : '暂无记录'}
        />
        <MetricCard
          icon={<AlertTriangle className="h-4 w-4 text-amber-400" />}
          label="登录失败"
          value={m?.login?.fail ?? '—'}
          sub={m?.login?.last_fail_ts ? `最近 ${fmtTs(m.login.last_fail_ts)}` : '暂无记录'}
        />
        <MetricCard
          icon={<AlertTriangle className="h-4 w-4 text-rose-400" />}
          label="权限拒绝"
          value={m?.access?.no_perm_count ?? '—'}
          sub={m?.access?.last_no_perm_ts ? `最近 ${fmtTs(m.access.last_no_perm_ts)}` : '暂无记录'}
        />
      </div>

      {/* ===== 服务状态 ===== */}
      <section className="rounded-card border border-border bg-surface p-5 mt-6">
        <div className="flex items-center gap-2 mb-4">
          <Server className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-medium text-foreground">服务状态</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StatusRow
            label="AGTi 身份库"
            ok={m?.agti?.ok}
            detail={m?.agti?.enabled
              ? (m.agti.ok ? `连接正常 · ${fmtMs(m.agti.latency_ms)}ms` : `异常: ${m.agti.error ?? '未知'}`)
              : '未启用账号互通'}
          />
          <StatusRow
            label="role_map 加载"
            ok={m?.role_map?.loaded}
            detail={m?.role_map
              ? `${m.role_map.role_count ?? '—'} 个角色`
              : `加载失败: ${m?.role_map?.error ?? '未知'}`}
          />
          <StatusRow
            label="审计写盘"
            ok={m && m.audit.write_fail === 0}
            detail={m
              ? `成功 ${m.audit.write_ok} · 失败 ${m.audit.write_fail} · 队列 ${m.audit.queue_size}`
              : '—'}
          />
          <StatusRow
            label="服务运行"
            ok={m ? true : undefined}
            detail={m ? `已运行 ${fmtUptime(m.server.uptime_s)}` : '—'}
          />
        </div>
      </section>

      {/* ===== 审计事件 ===== */}
      <section className="rounded-card border border-border bg-surface p-5 mt-6">
        <div className="flex items-center gap-2 mb-4">
          <ScrollText className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-medium text-foreground">审计事件</h3>
          <span className="ml-auto text-[11px] text-muted">
            {audit ? `共 ${audit.count} 条` : '—'}
          </span>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <input
            type="date"
            value={day}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDay(e.target.value)}
            className="h-8 px-2 rounded-btn border border-border bg-base text-xs text-foreground"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-8 px-2 rounded-btn border border-border bg-base text-xs text-foreground"
          >
            <option value="">全部类型</option>
            <option value="security">安全事件</option>
            <option value="access">权限拒绝</option>
            <option value="admin">管理操作</option>
          </select>
        </div>

        {audit?.items?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted border-b border-border">
                  <th className="text-left py-2 pr-3 font-normal">时间</th>
                  <th className="text-left py-2 pr-3 font-normal">类型</th>
                  <th className="text-left py-2 pr-3 font-normal">事件</th>
                  <th className="text-left py-2 pr-3 font-normal">操作者</th>
                  <th className="text-left py-2 font-normal">详情</th>
                </tr>
              </thead>
              <tbody>
                {audit.items.map((item, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 text-muted whitespace-nowrap font-mono">{item.ts}</td>
                    <td className="py-2 pr-3">
                      <span className={cn(
                        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
                        item.category === 'security' && 'bg-sky-400/10 text-sky-400',
                        item.category === 'access' && 'bg-rose-400/10 text-rose-400',
                        item.category === 'admin' && 'bg-amber-400/10 text-amber-400',
                      )}>
                        {CATEGORY_LABELS[item.category] ?? item.category}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{EVENT_LABELS[item.event] ?? item.event}</td>
                    <td className="py-2 pr-3 text-secondary">{item.actor}</td>
                    <td className="py-2 text-muted truncate max-w-[16rem]" title={item.detail}>{item.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center text-muted text-xs">
            {auditLoading ? '加载中…' : '暂无审计记录'}
          </div>
        )}
      </section>
    </>
  )
}


// ===== 小组件 =====

function MetricCard({ icon, label, value, sub }: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sub?: string
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-[11px] text-muted">{label}</span>
      </div>
      <div className="text-xl font-semibold text-foreground">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

function StatusRow({ label, ok, detail }: {
  label: string
  ok?: boolean | null
  detail?: string
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {detail && <div className="text-[11px] text-muted truncate">{detail}</div>}
      </div>
      {ok === true ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
      ) : ok === false ? (
        <XCircle className="h-4 w-4 text-rose-400 shrink-0" />
      ) : (
        <span className="text-[11px] text-muted shrink-0">未知</span>
      )}
    </div>
  )
}