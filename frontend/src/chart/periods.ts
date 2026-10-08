/**
 * 图表工作台周期定义 — /chart 唯一权威。
 *
 * 分钟级 (15m/60m/4h): 拉 1 分钟K → resampleMinutes 聚合 → enrichChartIndicators
 * 日级以上 (1d/2d/4d/1w/1M): 拉日K → resampleDaily 聚合 → 后端 enriched 指标透传
 *
 * 分钟周期 date 标签统一为 "YYYY-MM-DD HH:mm" — 与日K "YYYY-MM-DD" 字典序兼容,
 * 跨周期时间对齐 (十字光标/缩放联动) 可直接用字符串比较。
 *
 * A 股每天 4 小时交易 (240 分钟), 4h 周期 = 240 分钟 = 每天 1 根, 与日K等价
 * (用户已知悉, 保留为周期选项统一交互)。
 */
export type Period = '15m' | '60m' | '4h' | '1d' | '2d' | '4d' | '1w' | '1M'

export interface PeriodDef {
  key: Period
  label: string
  /** 聚合窗长 (分钟); 分钟级周期走 resampleMinutes */
  minutes?: 15 | 60 | 240
  /** 日K聚合根数 (交易日); 日级以上周期走 resampleDaily。undefined = 不聚合 (原生日K) */
  dailyAgg?: number
}

export const PERIODS: PeriodDef[] = [
  { key: '15m', label: '15分', minutes: 15 },
  { key: '60m', label: '1小时', minutes: 60 },
  { key: '4h', label: '4小时', minutes: 240 },
  { key: '1d', label: '天' },
  { key: '2d', label: '2天', dailyAgg: 2 },
  { key: '4d', label: '4天', dailyAgg: 4 },
  { key: '1w', label: '周', dailyAgg: 5 },
  { key: '1M', label: '月', dailyAgg: 22 },
]

export const DEFAULT_PERIOD: Period = '15m'

/**
 * 聚合周期需要的原始分钟K天数: 分钟 240 根/日, 60 日原料足够任何分屏周期看图。
 * dev 打通旧版线上后端 (minute-range 上限 le=20) 期间, 在 frontend/.env.local 设
 * VITE_CHART_MINUTE_DAYS=20 覆盖; 线上后端部署 le=60 后删除覆盖即恢复 60。
 */
export const MINUTE_FETCH_DAYS = Number(import.meta.env.VITE_CHART_MINUTE_DAYS ?? 60)

/** 周期是否为分钟级 (走 resampleMinutes 路径) */
export function isMinutePeriod(p: Period): boolean {
  return periodDef(p).minutes !== undefined
}

/** 周期是否为日级以上 (走日K聚合路径) */
export function isDailyPeriod(p: Period): boolean {
  return periodDef(p).minutes === undefined
}

export function periodDef(p: Period): PeriodDef {
  return PERIODS.find(d => d.key === p) ?? PERIODS[0]
}
