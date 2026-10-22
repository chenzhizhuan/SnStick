/**
 * 图表工作台前端指标库 — 聚合周期 (15/60/240m) 的公开指标现场计算。
 *
 * 私有化指标 (MACD+/RSI+) 已于 2026-10-14 收口到服务端 (backend indicators/
 * plus.py + intraday.py): 分钟周期由 /api/kline/intraday 返回带 plus 字段的
 * 聚合 bars, 4h 周期由 /api/kline/daily?plus_lookback=160 附着 — 前端只透传
 * 字段不再计算, bundle 不携带任何私有算法特征。
 *
 * 本文件保留的公开公式 (全站通用, 非私有资产):
 *   - MA: 滚动均值
 *   - MACD: EMA(α=2/(n+1)) 12/26 → DIF; DEA=EMA9(DIF); HIST=2*(DIF-DEA)
 *   - RSI:  RMA(α=1/n) on gain/loss (Wilder)
 */
import type { ResampledBar } from './minuteResample'
import type { RyFvgBox } from '@/components/EChartsCandlestick'

export interface ChartIndicatorFields {
  ma5?: number | null
  ma10?: number | null
  ma20?: number | null
  ma60?: number | null
  macd_dif?: number | null
  macd_dea?: number | null
  macd_hist?: number | null
  rsi_6?: number | null
  rsi_14?: number | null
  rsi_24?: number | null
  /** 私有化指标 (服务端附着透传, 非前端计算): macd_plus_hist = 能量柱 (动能差量级缩放) */
  macd_plus_dif?: number | null
  macd_plus_dea?: number | null
  macd_plus_hist?: number | null
  /** 私有化指标 (服务端附着透传): 资金流 ±1 单值 */
  rsi_plus?: number | null
  /** 动能双腿 (RSI28 EMA5/60, 服务端附着透传) */
  volume_rsi_fast?: number | null
  volume_rsi_slow?: number | null
  /** 资金流信号 (服务端状态机输出透传): 背景/追踪/交叉事件 */
  fund_bg_color?: number | null
  fund_tracking_state?: number | null
  fund_cross_up_lower?: boolean
  fund_cross_down_upper?: boolean
  /** 融易主图 (服务端 rymain.py 附着透传): 牛熊通道/中轨/K 通道/信号 */
  ry_upper?: number | null
  ry_mid?: number | null
  ry_lower?: number | null
  ry_mid_trend?: number | null
  ry_mid_tick?: number | null
  ry_ema_mid?: number | null
  k_trend?: number | null
  k_up?: number | null
  k_dn?: number | null
  k2_trend?: number | null
  k2_up?: number | null
  k2_dn?: number | null
  k3_trend?: number | null
  k3_up?: number | null
  k3_dn?: number | null
  ry_bar_color?: number | null
  ry_top_signal?: boolean
  ry_top_price?: number | null
  ry_btm_signal?: boolean
  ry_btm_price?: number | null
  div_top_count?: number | null
  div_btm_count?: number | null
  /** 融易 FVG 活跃区间 (仅末行携带, 区间型字段) */
  fvg_list?: RyFvgBox[]
}

export type EnrichedBar = ResampledBar & ChartIndicatorFields

/** 分钟聚合周期输入 bar: 基础字段 + 服务端附着的私有指标字段 (透传用) */
export type IntradayInputBar = ResampledBar & Partial<Pick<
  ChartIndicatorFields,
  'macd_plus_dif' | 'macd_plus_dea' | 'macd_plus_hist' | 'rsi_plus'
  | 'volume_rsi_fast' | 'volume_rsi_slow'
  | 'fund_bg_color' | 'fund_tracking_state'
  | 'fund_cross_up_lower' | 'fund_cross_down_upper'
  | 'ry_upper' | 'ry_mid' | 'ry_lower' | 'ry_mid_trend' | 'ry_mid_tick' | 'ry_ema_mid'
  | 'k_trend' | 'k_up' | 'k_dn'
  | 'k2_trend' | 'k2_up' | 'k2_dn'
  | 'k3_trend' | 'k3_up' | 'k3_dn'
  | 'ry_bar_color' | 'ry_top_signal' | 'ry_top_price' | 'ry_btm_signal' | 'ry_btm_price'
  | 'div_top_count' | 'div_btm_count' | 'fvg_list'
>>

// ── 基础算子 ──────────────────────────────────────────────

/** 滚动均值; 窗口不足 n 的前缀输出 null。 */
function rollingMA(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= n) sum -= values[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

/** EMA/RMA 递推 (adjust=False 首值起步): out[i] = prev + α×(x-prev);
 *  null 输入中断递推 (后续输出 null)。 */
function rma(values: (number | null)[], alpha: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    const x = values[i]
    if (x == null) continue
    prev = prev == null ? x : prev + alpha * (x - prev)
    out[i] = prev
  }
  return out
}

// ── 公开指标 (工作台按钮已移除原版 MACD/RSI, 数据供信号检测/信息栏) ──

function computeMACD(closes: number[]): { dif: (number | null)[]; dea: (number | null)[]; hist: (number | null)[] } {
  const emaA = rma(closes, 2 / (12 + 1))
  const emaB = rma(closes, 2 / (26 + 1))
  const dif = closes.map((_, i) => emaA[i]! - emaB[i]!)
  const dea = rma(dif, 2 / (9 + 1))
  const hist = dif.map((v, i) => 2 * (v - dea[i]!))
  return { dif, dea, hist }
}

function computeRSI(closes: number[], n: number): (number | null)[] {
  const alpha = 1 / n
  const gains: (number | null)[] = [0] // 首行 diff=null → otherwise 0 (后端口径)
  const losses: (number | null)[] = [0]
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1]
    gains.push(delta > 0 ? delta : 0)
    losses.push(delta < 0 ? -delta : 0)
  }
  const avgGain = rma(gains, alpha)
  const avgLoss = rma(losses, alpha)
  return closes.map((_, i) => {
    const g = avgGain[i]
    const l = avgLoss[i]
    if (g == null || l == null) return null
    return 100 - 100 / (1 + g / (l === 0 ? 1e-12 : l))
  })
}

// ── 入口 ────────────────────────────────────────────────

/** enrich 输入 bar 公共必需字段 (分钟聚合 bars 与日K行映射的交集;
 *  volume/amount 宽松可选 — 日K行 volume 可空、无 amount 字段)。 */
type EnrichInputBase = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
  amount?: number | null
}

/** 对聚合周期 bars 现场计算公开指标 (MA/MACD/RSI), 私有指标字段 (macd_plus_*/
/** rsi_plus) 从输入 bar 透传 — 服务端 /api/kline/intraday 或 /daily?agg= 附着。
 *  泛型保留输入 bar 的全部字段 (含日K is_live / fvg_list 等下游仍消费的字段):
 *  分钟路径 T=IntradayInputBar, 日级 agg 路径 T=OHLC。 */
export function enrichChartIndicators<T extends EnrichInputBase & Partial<ChartIndicatorFields>>(
  bars: T[],
): (T & ChartIndicatorFields)[] {
  const closes = bars.map(b => b.close)
  // spread 先保留输入全字段; 循环立即补齐 ChartIndicatorFields 全部键, 断言安全
  const out = bars.map(b => ({ ...b })) as (T & ChartIndicatorFields)[]

  const ma5 = rollingMA(closes, 5)
  const ma10 = rollingMA(closes, 10)
  const ma20 = rollingMA(closes, 20)
  const ma60 = rollingMA(closes, 60)
  const macd = computeMACD(closes)
  const rsi6 = computeRSI(closes, 6)
  const rsi14 = computeRSI(closes, 14)
  const rsi24 = computeRSI(closes, 24)

  for (let i = 0; i < out.length; i++) {
    const o = out[i]
    o.ma5 = ma5[i]
    o.ma10 = ma10[i]
    o.ma20 = ma20[i]
    o.ma60 = ma60[i]
    o.macd_dif = macd.dif[i]
    o.macd_dea = macd.dea[i]
    o.macd_hist = macd.hist[i]
    o.rsi_6 = rsi6[i]
    o.rsi_14 = rsi14[i]
    o.rsi_24 = rsi24[i]
    // 私有指标: 服务端附着值透传 (前端不再计算)
    o.macd_plus_dif = bars[i].macd_plus_dif ?? null
    o.macd_plus_dea = bars[i].macd_plus_dea ?? null
    o.macd_plus_hist = bars[i].macd_plus_hist ?? null
    o.rsi_plus = bars[i].rsi_plus ?? null
    o.volume_rsi_fast = bars[i].volume_rsi_fast ?? null
    o.volume_rsi_slow = bars[i].volume_rsi_slow ?? null
    o.fund_bg_color = bars[i].fund_bg_color ?? null
    o.fund_tracking_state = bars[i].fund_tracking_state ?? null
    o.fund_cross_up_lower = bars[i].fund_cross_up_lower === true
    o.fund_cross_down_upper = bars[i].fund_cross_down_upper === true
    // 融易主图: 服务端 rymain.py 附着值透传 (前端不再计算)
    o.ry_upper = bars[i].ry_upper ?? null
    o.ry_mid = bars[i].ry_mid ?? null
    o.ry_lower = bars[i].ry_lower ?? null
    o.ry_mid_trend = bars[i].ry_mid_trend ?? null
    o.ry_mid_tick = bars[i].ry_mid_tick ?? null
    o.ry_ema_mid = bars[i].ry_ema_mid ?? null
    o.k_trend = bars[i].k_trend ?? null
    o.k_up = bars[i].k_up ?? null
    o.k_dn = bars[i].k_dn ?? null
    o.k2_trend = bars[i].k2_trend ?? null
    o.k2_up = bars[i].k2_up ?? null
    o.k2_dn = bars[i].k2_dn ?? null
    o.k3_trend = bars[i].k3_trend ?? null
    o.k3_up = bars[i].k3_up ?? null
    o.k3_dn = bars[i].k3_dn ?? null
    o.ry_bar_color = bars[i].ry_bar_color ?? null
    o.ry_top_signal = bars[i].ry_top_signal === true
    o.ry_top_price = bars[i].ry_top_price ?? null
    o.ry_btm_signal = bars[i].ry_btm_signal === true
    o.ry_btm_price = bars[i].ry_btm_price ?? null
    o.div_top_count = bars[i].div_top_count ?? null
    o.div_btm_count = bars[i].div_btm_count ?? null
  }
  return out
}
