/**
 * 图表工作台前端指标库 — 聚合周期 (15/60/240m) 的指标现场计算。
 *
 * 原版 MACD/RSI (工作台已移除其按钮, 数据保留供信号检测等):
 *   - MACD: EMA(α=2/(n+1)) 12/26 → DIF; DEA=EMA9(DIF); HIST=2*(DIF-DEA)
 *   - RSI:  RMA(α=1/n) on gain/loss (Wilder)
 *
 * 私有化线路 (MACD+/RSI+) — 泰坦 T5.0 优化版指标 (与后端 indicators/plus.py
 * 平行同口径移植, 算法源: 泰坦量化策略(天机版)-T5.0.pine):
 *   - 优化版MACD: DIF=EMA12-EMA26; DEA=EMA9(DIF);
 *     能量柱 = (子午线K5 - 子午线K61) × 量级缩放系数
 *     子午线 = exp(DEMA(log(close), N)), DEMA(s,N)=2·EMA(s,N)-EMA(EMA(s,N),N)
 *     量级缩放 = SMA|DIF-DEA| / SMA|raw| (lookback 窗口)
 *   - 优化版RSI: (close-EMA26)/近50根最大乖离×100 (±100 单值;
 *     RSI>0 ⟺ 价格在 EMA26 上方; 乖离创 50 根新高时 = ±100)
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
  /** 私有化线路 (泰坦 T5.0): macd_plus_hist = 能量柱 (非标准 MACD 柱) */
  macd_plus_dif?: number | null
  macd_plus_dea?: number | null
  macd_plus_hist?: number | null
  /** 私有化线路 (泰坦 T5.0 优化版RSI): ±100 单值 */
  rsi_plus?: number | null
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

/** 滚动均值 (Pine ta.sma 语义): 窗口不足 n 输出 null。 */
function smaSeries(values: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  let count = 0
  let start = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) { sum = 0; count = 0; start = i + 1; continue }
    sum += v
    count++
    if (count > n) { sum -= values[start]!; count--; start++ }
    if (count === n) out[i] = sum / n
  }
  return out
}

/** 滚动最大 (Pine ta.highest 语义): 窗口不足 n 输出 null。 */
function rollingMax(values: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  const queue: number[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) { queue.length = 0; continue }
    queue.push(v)
    if (queue.length > n) queue.shift()
    if (queue.length === n) out[i] = Math.max(...queue)
  }
  return out
}

// ── 原版指标 (工作台按钮已移除, 数据供信号检测/信息栏) ──────

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

// ── 私有化指标 (泰坦 T5.0 优化版) — 与后端 plus.py 同口径 ──

/** 泰坦 T5.0 量级缩放回看 (Pine util_getPresetLookback): <60m=200, <1d=160。
 *  日K 在后端算 (50), 此处仅分钟线路使用。 */
export function titanLookbackForMinutes(minutes: number): number {
  return minutes < 60 ? 200 : 160
}

/** 泰坦子午线: exp(DEMA(log(close), N))。导出供 SUB_CHARTS 能量柱着色复用。 */
export function meridianDemaLog(closes: number[], length: number): (number | null)[] {
  const alpha = 2 / (length + 1)
  const e1 = rma(closes.map(c => (c > 0 ? Math.log(c) : null)), alpha)
  const e2 = rma(e1, alpha)
  return e1.map((a, i) => {
    const b = e2[i]
    if (a == null || b == null) return null
    const dema = 2 * a - b
    return Number.isFinite(dema) ? Math.exp(dema) : null
  })
}

/** 优化版MACD (泰坦 f_optMacd): DIF/DEA/能量柱。 */
export function computeMACDPlus(closes: number[], lookback: number): { dif: (number | null)[]; dea: (number | null)[]; hist: (number | null)[] } {
  const emaA = rma(closes, 2 / (12 + 1))
  const emaB = rma(closes, 2 / (26 + 1))
  const dif = closes.map((_, i) => (emaA[i] != null && emaB[i] != null ? emaA[i]! - emaB[i]! : null))
  const dea = rma(dif, 2 / (9 + 1))

  const m5 = meridianDemaLog(closes, 5)
  const m61 = meridianDemaLog(closes, 61)
  const raw = m5.map((a, i) => (a != null && m61[i] != null ? a - m61[i]! : null))

  // 量级标尺: 能量柱按 (DIF-DEA) 平均绝对幅度校准
  const absDH = dif.map((d, i) => (d != null && dea[i] != null ? Math.abs(d - dea[i]!) : null))
  const absRaw = raw.map(v => (v != null ? Math.abs(v) : null))
  const ref = smaSeries(absDH, lookback)
  const mag = smaSeries(absRaw, lookback)
  const hist = raw.map((r, i) => {
    const m = mag[i]
    const rf = ref[i]
    if (r == null || m == null || rf == null) return null
    return r * (rf / Math.max(m, 1e-5))
  })
  return { dif, dea, hist }
}

/** 优化版RSI (泰坦 f_optRsi): ±100 单值 (归一化乖离振荡器)。 */
export function computeRSIPlus(closes: number[]): (number | null)[] {
  const ma = rma(closes, 2 / (26 + 1))
  const diff = closes.map((c, i) => (ma[i] != null ? c - ma[i]! : null))
  const absDiff = diff.map(v => (v != null ? Math.abs(v) : null))
  const mx = rollingMax(absDiff, 50)
  return diff.map((d, i) => {
    if (d == null) return null
    const m = mx[i]
    if (m == null || m === 0) return 0 // Pine: nz(_mx) != 0 ? ... : 0.0
    return (d / m) * 100
  })
}

// ── 入口 ────────────────────────────────────────────────

/** 对聚合周期 bars 现场计算工作台所需指标。
 *  macdLookback: 泰坦量级缩放回看 (分钟周期按 Pine 预设表: <60m=200, ≥60m=160)。
 *  输出字段直接对应 EChartsCandlestick OHLC (含 macd_plus_* 与 rsi_plus)。 */
export function enrichChartIndicators(bars: ResampledBar[], macdLookback = 160): EnrichedBar[] {
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
  const macdPlus = computeMACDPlus(closes, macdLookback)
  const rsiPlus = computeRSIPlus(closes)

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
    o.rsi_plus = rsiPlus[i]
  }
  return out
}
