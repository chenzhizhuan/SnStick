/**
 * 图表工作台绘图工具 — 数据模型 + ECharts markLine/markArea 生成 (纯函数)。
 *
 * 核心思路 (v2 方案): markLine / markArea 天生按数据坐标锚定 (coord: [dateStr, price]),
 * 缩放 / 平移 / 换窗后 ECharts 自动重定位 — 无需手写 convertToPixel 像素换算。
 *
 * 工具集 (P2 最小四件套):
 *   trendline 趋势线 (两点线段) / hline 水平线 (一点) /
 *   fib 斐波那契回撤 (两点高低 → 6 档水平线 + 区间填充) / rect 矩形区域 (两点)
 *
 * 持久化: 共享库 key = stick.chart-drawings.{symbol} (TV 同款 per-symbol, 绘图联动开);
 * 关闭绘图联动时每窗独立库 key = stick.chart-drawings.pane.{paneId}.{symbol} (互不干扰);
 * 锚点日期不在当前数据集时该图形暂不渲染 (换周期不炸, 回到原周期自动恢复)。
 */

export type DrawTool = 'cursor' | 'trendline' | 'hline' | 'fib' | 'rect'

export const DRAW_TOOLS: { key: DrawTool; label: string; title: string }[] = [
  { key: 'cursor', label: '光标', title: '光标 (退出绘制)' },
  { key: 'trendline', label: '趋势线', title: '趋势线: 两点连线' },
  { key: 'hline', label: '水平线', title: '水平线: 单点全宽横线' },
  { key: 'fib', label: '斐波', title: '斐波那契回撤: 两点定高低' },
  { key: 'rect', label: '矩形', title: '矩形区域' },
]

export interface DrawPoint {
  date: string
  price: number
}

export interface DrawingObject {
  id: string
  tool: Exclude<DrawTool, 'cursor'>
  /** trendline / rect / fib 两点; hline 一点 (price 生效, date 仅作存在锚) */
  points: DrawPoint[]
  style: { color: string; width: number }
}

export const DEFAULT_DRAW_STYLE = { color: '#3B82F6', width: 1.5 }

/** 斐波那契回撤档位 */
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1]

/** 绘图持久化 key: per symbol (TV 同款 — 图形是标的的资产, 同股窗格跨周期共享;
 *  锚点日期不在某周期数据集时暂不渲染, 回到覆盖该日期的周期自动出现)。 */
export function drawingsStorageKey(symbol: string): string {
  return `stick.chart-drawings.${symbol}`
}

/** pane 独立库 key (绘图联动关时每窗私有): stick.chart-drawings.pane.{paneId}.{symbol}。 */
export function paneDrawingsStorageKey(paneId: string, symbol: string): string {
  return `stick.chart-drawings.pane.${paneId}.${symbol}`
}

/** 只保留结构合法的图形项。 */function filterValid(raw: unknown): DrawingObject[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d): d is DrawingObject =>
      d != null && typeof d === 'object' &&
      typeof d.id === 'string' && typeof d.tool === 'string' &&
      ['trendline', 'hline', 'fib', 'rect'].includes(d.tool) &&
      Array.isArray(d.points) && d.points.length >= 1 &&
      d.points.every((p: DrawPoint) => p != null && typeof p.date === 'string' && Number.isFinite(p.price)),
  )
}

/**
 * 旧版 per symbol+period key 的图形迁移合并到 per-symbol 库 (一次性):
 * 读取 `stick.chart-drawings.{symbol}.{period}` 全部旧 key, 按 id 去重合并。
 * 旧 key 保留不删 — 迁移结果写入新 key 后, 后续 load 不再走到这里。
 */
function migrateLegacyDrawings(symbol: string): DrawingObject[] {
  const prefix = `stick.chart-drawings.${symbol}.`
  const seen = new Set<string>()
  const merged: DrawingObject[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(prefix)) continue
    try {
      for (const d of filterValid(JSON.parse(localStorage.getItem(k) ?? '[]'))) {
        if (!seen.has(d.id)) { seen.add(d.id); merged.push(d) }
      }
    } catch { /* 损坏旧 key 跳过 */ }
  }
  return merged
}

/**
 * 读取持久化图形 (损坏/缺失 → 空数组)。
 * storeKey 省略 → per-symbol 共享库 (首次访问自动迁移旧 symbol+period key);
 * storeKey 指定 → pane 独立库 (绘图联动关时每窗私有, 不参与迁移)。
 */
export function loadDrawings(symbol: string, storeKey?: string): DrawingObject[] {
  try {
    const key = storeKey ?? drawingsStorageKey(symbol)
    const raw = localStorage.getItem(key)
    if (raw != null) return filterValid(JSON.parse(raw))
    if (storeKey) return [] // 独立库无旧数据可迁移
    // per-symbol 库尚不存在 → 合并旧版 symbol+period 图形 (一次性迁移)
    const legacy = migrateLegacyDrawings(symbol)
    if (legacy.length > 0) localStorage.setItem(key, JSON.stringify(legacy))
    return legacy
  } catch {
    return []
  }
}

/** 写入持久化图形 (storeKey 语义同 loadDrawings; 写失败静默, 不阻塞使用)。 */
export function saveDrawings(symbol: string, drawings: DrawingObject[], storeKey?: string): void {
  try {
    localStorage.setItem(storeKey ?? drawingsStorageKey(symbol), JSON.stringify(drawings))
  } catch {
    /* 存满/隐私模式: 静默 */
  }
}

/**
 * 锚点日期 → 当前数据集下标; 精确失败后按日级降级匹配 (跨周期共享的关键):
 *   - 日K 锚点 '2026-09-17' → 分钟集: 线性扫到该日首根 (如 '2026-09-17 09:30');
 *   - 分钟锚点 '2026-09-17 10:30' → 日K集: 直接 get('2026-09-17') 命中。
 * 都未命中 (数据集不覆盖该日) → null → 该图形暂不渲染, 回到覆盖周期自动出现。 */
function anchorIndex(dateIndexMap: Map<string, number>, date: string): number | null {
  const exact = dateIndexMap.get(date)
  if (exact != null) return exact
  const day = date.slice(0, 10)
  if (day !== date) {
    const byDay = dateIndexMap.get(day)
    if (byDay != null) return byDay
  }
  for (const [k, idx] of dateIndexMap) {
    if (k.slice(0, 10) === day) return idx
  }
  return null
}

/**
 * DrawingObject[] → ECharts markLine / markArea data (挂到主图 series 上)。
 * 纯生成函数: 图形状态在 pane, 渲染锚定交给 ECharts。
 * dates 为当前数据集标签数组: 跨周期降级命中时把渲染锚替换为该日首根的实际标签
 * (markLine coord 必须是数据集内存在的类目, 否则 ECharts 不渲染)。 */
export function drawingsToMarks(
  drawings: DrawingObject[],
  dateIndexMap: Map<string, number>,
  dates: string[],
): { markLine: any[]; markArea: any[] } {
  const markLine: any[] = []
  const markArea: any[] = []

  for (const d of drawings) {
    const pts = d.points.map(p => {
      const idx = anchorIndex(dateIndexMap, p.date)
      if (idx == null) return null
      return { ...p, date: dates[idx] ?? p.date }
    })

    // 水平线: 一点定 price
    if (d.tool === 'hline') {
      const p = pts[0]
      if (!p) continue
      markLine.push({
        yAxis: p.price,
        lineStyle: { color: d.style.color, width: d.style.width, type: 'solid' },
        label: { show: true, formatter: p.price.toFixed(2), position: 'insideEndTop', fontSize: 9, color: d.style.color },
      })
      continue
    }

    if (pts[0] == null || pts[1] == null) continue
    const a = pts[0]!
    const b = pts[1]!

    if (d.tool === 'trendline') {
      markLine.push([
        { coord: [a.date, a.price], lineStyle: { color: d.style.color, width: d.style.width, type: 'solid' }, label: { show: false } },
        { coord: [b.date, b.price], lineStyle: { color: d.style.color, width: d.style.width, type: 'solid' }, label: { show: false } },
      ])
    } else if (d.tool === 'rect') {
      const xa = a.date <= b.date ? a.date : b.date
      const xb = a.date <= b.date ? b.date : a.date
      const yLo = Math.min(a.price, b.price)
      const yHi = Math.max(a.price, b.price)
      markArea.push([
        { coord: [xa, yLo], itemStyle: { color: 'rgba(59,130,246,0.08)' } },
        { coord: [xb, yHi] },
      ])
    } else if (d.tool === 'fib') {
      // 6 档水平线 (锚点=所选高低两点) + 0~1 区间浅填充; x 覆盖两点之间的横向范围
      const xa = a.date <= b.date ? a.date : b.date
      const xb = a.date <= b.date ? b.date : a.date
      for (const lv of FIB_LEVELS) {
        const price = a.price + (b.price - a.price) * lv
        markLine.push({
          yAxis: price,
          lineStyle: { color: d.style.color, width: lv === 0.5 ? 1 : 0.8, type: 'dashed', opacity: 0.9 },
          label: { show: true, formatter: `${price.toFixed(2)} (${(lv * 100).toFixed(1)}%)`, position: 'insideStartTop', fontSize: 9, color: d.style.color },
        })
      }
      markArea.push([
        { coord: [xa, a.price], itemStyle: { color: 'rgba(59,130,246,0.05)' } },
        { coord: [xb, b.price] },
      ])
    }
  }

  return { markLine, markArea }
}
