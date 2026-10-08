/**
 * 图表工作台前端指标库 — 聚合周期 (15/60/240m) 的指标现场计算。
 *
 * 工作台只展示 MACD/RSI 副图 (+ 主图 MA 叠加), 本库只算这三类;
 * KDJ/BOLL/OBV/CCI 已随指标精简移除 (共享组件 SUB_CHARTS 仍保留其渲染
 * 能力供其他页面使用, 数据层不再为其供数)。
 *
 * 口径与后端 indicators/pipeline.py 逐式一致 (跨周期前端算 vs 日线后端算,
 * 同参同公式, 仅递推浮点微差):
 *   - MA:   滚动均值, 窗口不足为 null
 *   - MACD: EMA(α=2/(n+1), adjust=False 首值起步) 12/26 → DIF; DEA=EMA9(DIF); HIST=2*(DIF-DEA)
 *   - RSI:  RMA(α=1/n) on gain/loss (Wilder); 首行 delta 置 0; avgLoss=0 → 1e-12 兕底
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
}

export type EnrichedBar = ResampledBar & ChartIndicatorFields

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

// ── 单指标 ──────────────────────────────────────────────

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

/** 对聚合周期 bars 现场计算工作台所需指标 (MA + MACD + RSI; EChartsCandlestick OHLC 字段)。 */
export function enrichChartIndicators(bars: ResampledBar[]): EnrichedBar[] {
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
  }
  return out
}
