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
  /** 私有化指标 (服务端附着透传, 非前端计算): macd_plus_hist = 能量柱 (非标准 MACD 柱) */
  macd_plus_dif?: number | null
  macd_plus_dea?: number | null
  macd_plus_hist?: number | null
  /** 私有化指标 (服务端附着透传, 非前端计算): ±100 单值 */
  rsi_plus?: number | null
}

export type EnrichedBar = ResampledBar & ChartIndicatorFields

/** 分钟聚合周期输入 bar: 基础字段 + 服务端附着的私有指标字段 (透传用) */
export type IntradayInputBar = ResampledBar & Partial<Pick<
  ChartIndicatorFields, 'macd_plus_dif' | 'macd_plus_dea' | 'macd_plus_hist' | 'rsi_plus'
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

/** 对聚合周期 bars 现场计算公开指标 (MA/MACD/RSI), 私有指标字段 (macd_plus_*/
/** rsi_plus) 从输入 bar 透传 — 服务端 /api/kline/intraday 附着。 */
export function enrichChartIndicators(bars: IntradayInputBar[]): EnrichedBar[] {
  const closes = bars.map(b => b.close)
  const out: EnrichedBar[] = bars.map(b => ({ ...b }))

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
  }
  return out
}
