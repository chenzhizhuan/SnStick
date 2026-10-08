/**
 * 日K重采样引擎 — 把日K聚合为 2天/4天/周/月 等更高粒度K线 (纯函数)。
 *
 * 桶口径: 按交易日序号分组, 每 N 个交易日合并为 1 根。
 *   - OHLCV: open=首根 open, close=末根 close, high/low=桶内极值, volume=求和;
 *   - date 标签 = 桶内首根的日期 "YYYY-MM-DD" (与日K同格式, 字典序兼容)。
 *
 * 指标字段 (ma5/ma10/ma20/ma60, macd_dif/dea/hist, rsi_6/14/24) 不在聚合层
 * 重算 — 聚合K线的指标用末根的值透传 (近似: 周/月级别指标看趋势, 不需要精确逐根重算)。
 * 如需精确, 可在 useChartPaneData 聚合后重新 enrichChartIndicators, 但对周/月
 * 级别意义不大 (数据点少, 指标曲线平滑度足够)。
 * (工作台只展示 MACD/RSI, kdj/boll/obv/cci 字段已不再进入数据层)
 */
import type { OHLC } from '@/components/EChartsCandlestick'

/**
 * 按交易日聚合日K。period=1 时直接返回 (浅拷贝, 保持语义一致)。
 * 输入须按日期升序 (日K API 保证)。
 */
export function resampleDaily(bars: OHLC[], period: number): OHLC[] {
  if (period <= 1) return bars.map(b => ({ ...b }))

  const out: OHLC[] = []
  let cur: OHLC | null = null
  let count = 0

  for (const b of bars) {
    if (!cur || count >= period) {
      if (cur) out.push(cur)
      cur = { ...b }
      count = 1
    } else {
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.close = b.close
      cur.volume = (cur.volume ?? 0) + (b.volume ?? 0)
      // 指标字段: 取桶内末根的值 (近似, 周/月级趋势足够)
      cur.ma5 = b.ma5 ?? cur.ma5
      cur.ma10 = b.ma10 ?? cur.ma10
      cur.ma20 = b.ma20 ?? cur.ma20
      cur.ma60 = b.ma60 ?? cur.ma60
      cur.macd_dif = b.macd_dif ?? cur.macd_dif
      cur.macd_dea = b.macd_dea ?? cur.macd_dea
      cur.macd_hist = b.macd_hist ?? cur.macd_hist
      cur.rsi_6 = b.rsi_6 ?? cur.rsi_6
      cur.rsi_14 = b.rsi_14 ?? cur.rsi_14
      cur.rsi_24 = b.rsi_24 ?? cur.rsi_24
      cur.is_live = b.is_live
      count++
    }
  }
  if (cur) out.push(cur)
  return out
}
