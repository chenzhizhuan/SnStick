import { useCallback, useState } from 'react'
import { userKeyOf } from '@/lib/storage'

/**
 * 记忆"上次查看的个股"(按页面维度,localStorage 持久化)。
 *
 * 两个分析页(财务 / 个股)各自独立记忆,key 区分:
 *   - financials: 最后查看的财务分析个股
 *   - stock-analysis: 最后查看的个股分析个股
 *
 * 用户命名空间 (v2.3 多用户隔离): 互通形态下 key 带用户前缀,
 * 跨账号不串"上次看的股票"; 桌面版无前缀, 行为零改动。
 *
 * 用法:
 *   const { last, remember } = useLastStock('stock-analysis')
 *   remember('000001.SZ', '平安银行')   // 选中股票时调用
 *   <LastStockChip stock={last} ... />  // 渲染在 PageHeader 右侧
 */

export interface StockRef { symbol: string; name: string }

const PREFIX = 'last_stock:'

export function useLastStock(scope: string) {
  const [last, setLast] = useState<StockRef | null>(() => load(scope))

  const remember = useCallback((symbol: string, name: string) => {
    const ref = { symbol, name }
    setLast(ref)
    save(scope, ref)
  }, [scope])

  const clear = useCallback(() => {
    setLast(null)
    save(scope, null)
  }, [scope])

  return { last, remember, clear }
}

function realKey(scope: string): string {
  // 复用 storage 的用户前缀机制: 互通形态 → u:<uid>:last_stock:<scope>
  return userKeyOf(PREFIX + scope)
}

function load(scope: string): StockRef | null {
  try {
    const v = localStorage.getItem(realKey(scope))
    if (!v) return null
    const p = JSON.parse(v)
    if (p && typeof p.symbol === 'string' && typeof p.name === 'string') return p
  } catch { /* ignore */ }
  return null
}

function save(scope: string, ref: StockRef | null) {
  try {
    if (ref) localStorage.setItem(realKey(scope), JSON.stringify(ref))
    else localStorage.removeItem(realKey(scope))
  } catch { /* ignore */ }
}
