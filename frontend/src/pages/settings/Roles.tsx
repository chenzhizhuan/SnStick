/**
 * 权限管理面板 (P2 可视化授权) — 仅 admin 角色 (stick:admin:view) 可见, 写操作需 stick:admin:manage。
 *
 * 交互模型:
 *   - 矩阵: 行=功能分组/权限点, 列=角色; 勾选=生效权限。
 *   - 覆盖语义 (全量授权): 覆盖集合 = 角色最终生效权限, 可收敛也可扩张;
 *     所有角色均可勾选任意权限点 (选与不选 → 保存); admin 列只读 (代码硬控 *:*:*)。
 *   - 保存 = PUT overlay → 后端写 role_overlay.json → 热加载立即生效 (无需重启)。
 *   - 「恢复基线」= 该角色从 overlay 移除 (勾选回基线状态)。
 *
 * 设计约束:
 *   - AGTi 库严格只读; 覆盖只落本地 data/role_overlay.json, 不触碰 AGTi。
 */
import { useMemo, useState } from 'react'
import { Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  KeyRound, RefreshCw, Save, Undo2, Loader2, Lock,
} from 'lucide-react'
import { api } from '@/lib/api'
import type { RoleEntry } from '@/lib/api'
import { cn } from '@/lib/cn'
import { usePerm } from '@/lib/useAuth'
import { toast } from '@/components/Toast'

/** 本地编辑态: role_key → 生效权限集合 */
type Draft = Record<string, Set<string>>

export function SettingsRolesPanel() {
  const { hasPerm } = usePerm()
  const canManage = hasPerm('stick:admin:manage')

  const { data, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'role-map'],
    queryFn: () => api.adminRoleMap(),
    staleTime: 30_000,
  })

  // 服务端数据变化 (含保存后刷新) → 重建草稿
  const roleRows = useMemo(() => data?.roles ?? [], [data])
  const baseDraft = useMemo(() => {
    const d: Draft = {}
    for (const r of roleRows) d[r.key] = new Set(r.effective)
    return d
  }, [roleRows])

  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)

  // 未编辑时草稿为空 → 直接用服务端返回的生效集
  const effectiveDraft: Draft = useMemo(() => {
    if (Object.keys(draft).length === 0) return baseDraft
    return draft
  }, [draft, baseDraft])

  const dirty = useMemo(() => {
    if (!data) return false
    for (const r of data.roles) {
      const cur = effectiveDraft[r.key]
      if (!cur) continue
      const a = [...cur].sort().join(',')
      const b = [...r.effective].sort().join(',')
      if (a !== b) return true
    }
    return false
  }, [data, effectiveDraft])

  const resetDraft = () => setDraft({})

  const reload = () => {
    resetDraft()
    refetch()
  }

  const toggle = (roleKey: string, perm: string) => {
    setDraft((prev) => {
      const src = prev[roleKey] ?? new Set(baseDraft[roleKey] ?? [])
      const next = new Set(src)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return { ...prev, [roleKey]: next }
    })
  }

  /** 恢复某角色为基线: 覆盖清空 (overlay 中移除该角色)。 */
  const resetRole = (roleKey: string) => {
    setDraft((prev) => {
      const base = roleRows.find((r) => r.key === roleKey)
      if (!base) return prev
      return { ...prev, [roleKey]: new Set(base.base) }
    })
  }

  const save = async () => {
    if (!data) return
    // 组装 overlay: 只提交被修改的角色 (未动的不进 overlay, 保持原覆盖)
    const overlay: Record<string, string[]> = {}
    for (const r of data.roles) {
      if (r.key === 'admin') continue
      const cur = effectiveDraft[r.key]
      if (!cur) continue
      const a = [...cur].sort().join(',')
      const b = [...r.effective].sort().join(',')
      if (a === b) continue // 未变化 → 保留服务端现有 overlay
      // 等于基线 → 从覆盖中移除 (空数组后端按未覆盖处理)
      const baseSorted = [...r.base].sort().join(',')
      overlay[r.key] = a === baseSorted ? [] : [...cur].sort()
    }

    // 服务端语义: PUT 全量覆盖 overlay; 未出现在 payload 的角色 = 恢复基线。
    // 因此需要带上「服务端已有 overlay 但本次未编辑」的角色, 避免误清。
    for (const r of data.roles) {
      if (r.key === 'admin') continue
      if (r.key in overlay) continue
      if (r.overlay.length > 0) overlay[r.key] = [...r.overlay].sort()
    }

    setSaving(true)
    try {
      await api.updateRoleMap(overlay)
      toast('权限已保存并即时生效', 'success')
      resetDraft()
      await refetch()
    } catch (e) {
      toast(`保存失败: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!data) {
    return (
      <div className="py-16 text-center text-muted text-xs">
        {isFetching ? '加载中…' : '暂无数据'}
      </div>
    )
  }

  const groups = data.groups
  const roles = data.roles

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-medium text-foreground flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-accent" />
          权限管理
        </h2>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={resetDraft}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-btn text-xs
                         bg-elevated text-secondary hover:text-foreground transition-colors cursor-pointer"
            >
              <Undo2 className="h-3.5 w-3.5" />
              撤销修改
            </button>
          )}
          <button
            onClick={reload}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-btn text-xs
                       bg-elevated text-secondary hover:text-foreground transition-colors
                       disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            刷新
          </button>
          {canManage && (
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-btn text-xs
                         bg-accent text-white hover:bg-accent/90 transition-colors font-medium
                         disabled:opacity-40 cursor-pointer"
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Save className="h-3.5 w-3.5" />}
              {saving ? '保存中…' : '保存并生效'}
            </button>
          )}
        </div>
      </div>

      {!canManage && (
        <div className="mb-4 rounded-btn border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-400">
          当前角色仅有查看权限 (stick:admin:view), 修改需 stick:admin:manage。
        </div>
      )}

      <div className="rounded-card border border-border bg-surface p-5">
        <p className="text-[11px] text-muted mb-4">
          勾选 = 角色拥有该功能权限, 选与不选后保存即生效 (覆盖层优先于
          <span className="text-foreground font-medium"> role_map.yaml</span> 基线, 可收敛也可扩张);
          admin 为系统超管 (通配), 不可修改。保存后立即生效, 无需重启。
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-xs border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-surface text-left text-muted font-normal py-2 pr-4 min-w-[10rem]">
                  功能 / 权限点
                </th>
                {roles.map((r) => (
                  <th key={r.key} className="py-2 px-2 text-center min-w-[5.5rem]">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-foreground font-medium">{r.label}</span>
                      {r.overlay.length > 0 && (
                        <span className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
                          已覆盖
                        </span>
                      )}
                      {r.key === 'admin' && (
                        <span className="inline-flex items-center gap-0.5 text-[9px] text-muted">
                          <Lock className="h-2.5 w-2.5" /> 系统超管
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((grp) => (
                <Fragment key={grp.label}>
                  <tr>
                    <td
                      colSpan={roles.length + 1}
                      className="pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted"
                    >
                      {grp.label}
                    </td>
                  </tr>
                  {grp.perms.map((p) => (
                    <tr key={p.key} className="group">
                      <td className="sticky left-0 z-10 bg-surface py-1.5 pr-4 text-secondary">
                        {p.label}
                        <span className="ml-1.5 text-[9px] text-muted font-mono">{p.key}</span>
                      </td>
                      {roles.map((r) => {
                        // admin 通配: 固定勾选且不可改
                        if (r.key === 'admin') {
                          return (
                            <td key={r.key} className="py-1.5 px-2 text-center">
                              <input
                                type="checkbox"
                                checked
                                disabled
                                className="h-3.5 w-3.5 cursor-not-allowed accent-emerald-500"
                                title="admin 系统超管, 不可修改"
                              />
                            </td>
                          )
                        }
                        const cur = effectiveDraft[r.key]
                        const checked = cur ? cur.has(p.key) : r.effective.includes(p.key)
                        return (
                          <td key={r.key} className="py-1.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggle(r.key, p.key)}
                              disabled={!canManage}
                              className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed"
                              title={canManage ? '勾选 = 授予该权限' : undefined}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr>
                <td className="pt-4" />
              </tr>
            </tbody>
          </table>
        </div>

        {/* ===== 角色操作行 ===== */}
        <div className="mt-2 pt-4 border-t border-border flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">单角色操作:</span>
          {roles.filter((r) => r.key !== 'admin').map((r) => (
            <button
              key={r.key}
              onClick={() => resetRole(r.key)}
              disabled={!canManage}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-btn text-[10px]
                         bg-elevated text-secondary hover:text-foreground transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title={`将 ${r.label} 恢复为 role_map.yaml 基线权限 (清除覆盖)`}
            >
              <Undo2 className="h-3 w-3" />
              {r.label} 恢复基线
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-card border border-border bg-surface p-5">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-medium text-foreground">覆盖状态</h3>
          <span className="text-[11px] text-muted">
            {roles.filter((r) => r.overlay.length > 0).length
              ? `${roles.filter((r) => r.overlay.length > 0).length} 个角色存在覆盖`
              : '全部角色使用基线配置 (role_map.yaml)'}
          </span>
        </div>
        <div className="space-y-2">
          {roles.map((r) => (
            <RoleOverlayRow key={r.key} role={r} />
          ))}
        </div>
      </div>

    </>
  )
}

/** 单角色覆盖摘要行。 */
function RoleOverlayRow({ role }: { role: RoleEntry }) {
  const overlaid = role.overlay.length > 0
  const removed = role.base.filter((p) => !role.effective.includes(p))
  const added = role.effective.filter((p) => !role.base.includes(p))
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-16 shrink-0 text-xs text-foreground">{role.label}</span>
      {role.key === 'admin' ? (
        <span className="text-[11px] text-muted">系统超管 · 全功能通配</span>
      ) : overlaid ? (
        <div className="min-w-0 flex-1">
          <span className="text-[11px] text-amber-400">
            已覆盖{added.length > 0 ? ` · 较基线新增 +${added.length}` : ''}
            {removed.length > 0 ? ` · 较基线删减 -${removed.length}` : ''}
          </span>
          <span className="ml-1.5 text-[11px] text-muted font-mono truncate">
            {role.overlay.join(', ')}
          </span>
        </div>
      ) : (
        <span className="text-[11px] text-muted">基线 · {role.base.length} 项权限</span>
      )}
    </div>
  )
}
