/**
 * 图表工作台前端指标库 — 聚合周期 (15/60/240m) 的指标现场计算。
 *
 * 工作台展示 MACD/RSI 副图 (+ 私有化克隆 MACD+/RSI+) 与主图 MA 叠加,
 * 本库只算这几类; KDJ/BOLL/OBV/CCI 已随指标精简移除 (共享组件 SUB_CHARTS
 * 仍保留其渲染能力供其他页面使用, 数据层不再为其供数)。
 *
 * 口径与后端 indicators/pipeline.py 逐式一致 (跨周期前端算 vs 日线后端算,
 * 同参同公式, 仅递推浮点微差):
 *   - MA:   滚动均值, 窗口不足为 null
 *   - MACD: EMA(α=2/(n+1), adjust=False 首值起步) 12/26 → DIF; DEA=EMA9(DIF); HIST=2*(DIF-DEA)
 *   - RSI:  RMA(α=1/n) on gain/loss (Wilder); 首行 delta 置 0; avgLoss=0 → 1e-12 兕底
 *
 * 私有化线路 (MACD+/RSI+): 与后端 indicators/plus.py 平行的前端克隆。
 * ★ 后端私有算法替换后, computeMACDPlus/computeRSIPlus 需同步同口径,
 *   保持输出字段名 (macd_plus_* 与 rsi_plus_*) 不变。
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
  macd_plus_dif?: number | null
  macd_plus_dea?: number | null
  macd_plus_hist?: number | null
  rsi_plus_6?: number | null
  rsi_plus_14?: number | null
  rsi_plus_24?: number | null
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

// ── 私有化指标克隆 (MACD+ / RSI+) ─────────────────────────
// 与后端 indicators/plus.py 平行的独立线路; 输出 macd_plus_* 与 rsi_plus_* 字段。
// ★ 后端私有算法替换后需同步此两函数口径 (字段名保持不变)。

function computeMACDPlus(closes: number[]): { dif: (number | null)[]; dea: (number | null)[]; hist: (number | null)[] } {
  // 当前 = 原版 MACD 克隆 (EMA12/26 → DIF, EMA9 → DEA, HIST=2*(DIF-DEA))
  const emaA = rma(closes, 2 / (12 + 1))
  const emaB = rma(closes, 2 / (26 + 1))
  const dif = closes.map((_, i) => emaA[i]! - emaB[i]!)
  const dea = rma(dif, 2 / (9 + 1))
  const hist = dif.map((v, i) => 2 * (v - dea[i]!))
  return { dif, dea, hist }
}

function computeRSIPlus(closes: number[], n: number): (number | null)[] {
  // 当前 = 原版 RSI 克隆 (Wilder RMA, α=1/n)
  return computeRSI(closes, n)
}

// ── 入口 ────────────────────────────────────────────────

/** 对聚合周期 bars 现场计算工作台所需指标 (MA + MACD/RSI 原版与私有化克隆 +)。
 *  输出字段直接对应 EChartsCandlestick OHLC (含 macd_plus_* 与 rsi_plus_*)。 */
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
  const macdPlus = computeMACDPlus(closes)
  const rsiPlus6 = computeRSIPlus(closes, 6)
  const rsiPlus14 = computeRSIPlus(closes, 14)
  const rsiPlus24 = computeRSIPlus(closes, 24)

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
    o.macd_plus_dif = macdPlus.dif[i]
    o.macd_plus_dea = macdPlus.dea[i]
    o.macd_plus_hist = macdPlus.hist[i]
    o.rsi_plus_6 = rsiPlus6[i]
    o.rsi_plus_14 = rsiPlus14[i]
    o.rsi_plus_24 = rsiPlus24[i]
  }
  return out
}
