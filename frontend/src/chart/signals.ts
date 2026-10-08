/**
 * 图表工作台信号检测器 — MA 金叉/死叉 + RSI 顶背离 (纯函数)。
 *
 * 产出 ChartMarker[] (EChartsCandlestick markers prop 直接可用, 渲染层零改动):
 *   - ma-cross:      MA5 × MA10 前后值交叉 → buy(金叉) / sell(死叉)
 *   - rsi-divergence: swing 高点 pivot 法 — 相邻两个价格 pivot 且后者更高、
 *                    但后者 RSI(14) 低于前者 → 顶部紫色 "背离" 徽章 (above)
 *
 * 信号数量控制: 每类只保留最近 tailLimit 个 (参考 lc-chart 的 slice(-12) 策略),
 * 避免长历史标记过密; 0 = 不限。
 * 信号开关默认关 (TV 同款按需开启), 由 PaneConfig.signals 控制。
 */
import type { ChartMarker, OHLC } from '@/components/EChartsCandlestick'

export interface SignalOptions {
  /** MA5×MA10 金叉/死叉标记 */
  maCross?: boolean
  /** RSI(14) 顶背离徽章 */
  rsiDivergence?: boolean
  /** swing pivot 判定的左右肩宽 (根数) */
  pivotK?: number
  /** 每类信号保留的尾部个数; 0 = 不限 */
  tailLimit?: number
}

export type ChartSignal = ChartMarker & { _sig: 'ma-cross' | 'rsi-divergence' }

/** MA5 × MA10 交叉 → 金叉(buy)/死叉(sell) 标记。 */
function detectMaCross(bars: OHLC[]): ChartSignal[] {
  const out: ChartSignal[] = []
  for (let i = 1; i < bars.length; i++) {
    const m0 = bars[i - 1].ma5
    const m1 = bars[i].ma5
    const n0 = bars[i - 1].ma10
    const n1 = bars[i].ma10
    if (m0 == null || m1 == null || n0 == null || n1 == null) continue
    if (m0 <= n0 && m1 > n1) {
      out.push({ date: bars[i].date, kind: 'buy', label: '金叉', _sig: 'ma-cross' })
    } else if (m0 >= n0 && m1 < n1) {
      out.push({ date: bars[i].date, kind: 'sell', label: '死叉', _sig: 'ma-cross' })
    }
  }
  return out
}

/** swing 高点 pivot: 比左右各 k 根都高的 high → 候选 pivot 下标序列。 */
function swingHighs(bars: OHLC[], k: number): number[] {
  const idx: number[] = []
  for (let i = k; i < bars.length - k; i++) {
    const h = bars[i].high
    let isHigh = true
    for (let j = i - k; j <= i + k; j++) {
      if (j !== i && bars[j].high >= h) { isHigh = false; break }
    }
    if (isHigh) idx.push(i)
  }
  return idx
}

/** 顶背离: 相邻两个价格 swing 高点, 价格抬升但 RSI(14) 回落 → 在第二个高点挂紫色 "背离" 徽章。 */
function detectRsiTopDivergence(bars: OHLC[], k: number): ChartSignal[] {
  const out: ChartSignal[] = []
  const pivots = swingHighs(bars, k)
  for (let p = 1; p < pivots.length; p++) {
    const i1 = pivots[p - 1]
    const i2 = pivots[p]
    const priceHigher = bars[i2].high > bars[i1].high
    const r1 = bars[i1].rsi_14
    const r2 = bars[i2].rsi_14
    if (!priceHigher || r1 == null || r2 == null) continue
    if (r2 < r1) {
      out.push({
        date: bars[i2].date,
        kind: 'neutral',
        label: '背离',
        above: true,
        color: '#7C3AED',
        _sig: 'rsi-divergence',
      })
    }
  }
  return out
}

/** 入口: 按开关产出信号标记 (已按 tailLimit 截尾)。 */
export function detectSignals(bars: OHLC[], opts: SignalOptions = {}): ChartSignal[] {
  const { maCross = false, rsiDivergence = false, pivotK = 3, tailLimit = 12 } = opts
  const limit = (list: ChartSignal[]): ChartSignal[] => (tailLimit > 0 ? list.slice(-tailLimit) : list)

  const out: ChartSignal[] = []
  if (maCross) out.push(...limit(detectMaCross(bars)))
  if (rsiDivergence) out.push(...limit(detectRsiTopDivergence(bars, pivotK)))
  // 按时间序返回 (两类信号各自有序, merge 后整体排序保证 markers 渲染稳定)
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
