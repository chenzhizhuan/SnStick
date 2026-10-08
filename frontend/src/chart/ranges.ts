/**
 * 图表工作台时间范围快捷栏 — TV 底栏同款 9 档可见范围选择。
 *
 * 范围统一以「交易日」为单位定义, 按各周期每日根数换算成该周期 bar 数:
 *   1m=240 根/日, 5m=48, 15m=16, 30m=8, 60m=4, 日K=1
 * 选中 → 换算根数 → chart.dispatchAction({ type: 'dataZoom', start, end })。
 * 用户手动缩放后高亮清除 (回到 "自定义" 态); 各 pane 独立、不广播缩放联动。
 */
import type { Period } from './periods'

export interface RangeDef {
  key: string
  label: string
  /** 覆盖的交易日数; special 项为 undefined */
  days?: number
  special?: 'ytd' | 'all'
}

export const RANGES: RangeDef[] = [
  { key: '1d', label: '1天', days: 1 },
  { key: '5d', label: '5天', days: 5 },
  { key: '1m', label: '1月', days: 22 },
  { key: '3m', label: '3月', days: 66 },
  { key: '6m', label: '6月', days: 132 },
  { key: 'ytd', label: 'YTD', special: 'ytd' },
  { key: '1y', label: '1年', days: 250 },
  { key: '5y', label: '5年', days: 1250 },
  { key: 'all', label: '全部', special: 'all' },
]

/** 各周期每交易日的 bar 根数 (A 股 240 分钟连续竞价)。
 *  4h=240 分钟=A 股全天, 每天 1 根; 日级以上聚合周期按聚合根数折算。 */
export const BARS_PER_DAY: Record<Period, number> = {
  '15m': 16,
  '60m': 4,
  '4h': 1,
  '1d': 1,
  '2d': 1 / 2,
  '4d': 1 / 4,
  '1w': 1 / 5,
  '1M': 1 / 22,
}

/** YTD 已过交易日估算: 年初至今的工作日数近似 (dayOfYear × 5/7, 向上取整)。 */
function ytdTradingDays(now: Date): number {
  const start = new Date(now.getFullYear(), 0, 1)
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1
  return Math.max(1, Math.ceil((dayOfYear * 5) / 7))
}

/** 指定范围在该周期下的目标可见 bar 根数 (all = 全量, 由调用方用数据长度处理)。
 *  无效/缺失 key → 默认 60 根「最佳窗口」: 与双击重置同口径 — 首次加载不展示全量
 *  (几百上千根 K 线挤成针尖, 多周期多窗下粗细不可读), 用户要看全部点「全部」档。 */
export function rangeBars(rangeKey: string | null | undefined, period: Period, now: Date = new Date()): number | 'all' {
  const def = RANGES.find(r => r.key === rangeKey)
  if (!def) return 60
  if (def.special === 'all') return 'all'
  const days = def.special === 'ytd' ? ytdTradingDays(now) : def.days ?? 1
  return Math.max(1, Math.round(days * BARS_PER_DAY[period]))
}

/** 由目标根数换算 dataZoom 百分比 (end 固定 100, start 按尾部对齐)。 */
export function zoomForBars(bars: number, total: number): { start: number; end: number } {
  if (!Number.isFinite(bars) || bars <= 0 || total <= 0) return { start: 0, end: 100 }
  return { start: Math.max(0, 100 - (Math.min(bars, total) / total) * 100), end: 100 }
}
