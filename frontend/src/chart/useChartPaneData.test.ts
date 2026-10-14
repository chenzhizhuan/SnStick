import { describe, expect, it } from 'vitest'
import { dailyRowsTo4hBars, mergeDailyRows, shiftDate } from './useChartPaneData'
import { flattenSessions, resampleMinutes } from './minuteResample'
import { enrichChartIndicators } from './indicators'
import type { KlineRow, MinuteKlineSession } from '@/lib/api'

const row = (date: string, close = 10): KlineRow => ({
  date, open: 10, high: 10, low: 10, close, volume: 100,
  ma5: null, ma10: null, ma20: null, ma60: null,
  macd_dif: null, macd_dea: null, macd_hist: null,
  rsi_6: null, rsi_14: null, rsi_24: null,
  is_live: false,
} as KlineRow)

describe('mergeDailyRows', () => {
  it('额外 (更早) + 基础 (最近) 合并后按日期升序', () => {
    const base = [row('2026-09-29'), row('2026-09-30')]
    const extra = [row('2026-09-25'), row('2026-09-28')]
    const out = mergeDailyRows(base, extra)
    expect(out.map(r => r.date)).toEqual(['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'])
  })

  it('重复日期保留后写的值 (基础最近优先)', () => {
    const base = [row('2026-09-28', 11)]
    const extra = [row('2026-09-28', 9)]
    const out = mergeDailyRows(base, extra)
    expect(out.length).toBe(1)
    expect(out[0].close).toBe(11)
  })

  it('多段额外区间连续加载不丢失', () => {
    const base = [row('2026-09-30')]
    const extra1 = [row('2026-09-20'), row('2026-09-25')]
    const extra2 = [row('2026-09-10'), row('2026-09-15')]
    const out = mergeDailyRows(mergeDailyRows(base, extra1), extra2)
    expect(out.map(r => r.date)).toEqual(['2026-09-10', '2026-09-15', '2026-09-20', '2026-09-25', '2026-09-30'])
  })
})

describe('shiftDate', () => {
  it('加减天数 (含跨月)', () => {
    expect(shiftDate('2026-09-30', -1)).toBe('2026-09-29')
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01')
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30')
  })

  it('跨年', () => {
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01')
  })
})

describe('dailyRowsTo4hBars (4h 周期日K数据源)', () => {
  it('date 标签保持分钟周期格式 "YYYY-MM-DD 09:30" (跨周期字典序对齐)', () => {
    const bars = dailyRowsTo4hBars([row('2026-10-14')])
    expect(bars.length).toBe(1)
    expect(bars[0].date).toBe('2026-10-14 09:30')
    expect('2026-10-14 09:30' > '2026-10-14').toBe(true)
    expect('2026-10-14 09:30' < '2026-10-14 10:00').toBe(true)
  })

  it('OHLCV 逐字段透传, amount/volume 缺失兜底', () => {
    const bars = dailyRowsTo4hBars([{ ...row('2026-10-14'), open: 11, high: 12, low: 9, close: 10.5, volume: 77, amount: 1234 }])
    expect(bars[0]).toMatchObject({ open: 11, high: 12, low: 9, close: 10.5, volume: 77, amount: 1234 })
    const fallback = dailyRowsTo4hBars([{ ...row('2026-10-14'), volume: undefined }]) // volume/amount 缺失
    expect(fallback[0].volume).toBe(0)
    expect(fallback[0].amount).toBeNull()
  })

  it('与分钟聚合路径等价: 同 OHLC 数值的日K行 与 240 分钟聚合桶 逐字段一致', () => {
    // 构造一个交易日的 1 分钟K (09:30-11:30 + 13:00-15:00 各几根 + 尾根 15:00)
    const mk = (dt: string, o: number, h: number, l: number, c: number, v: number): MinuteKlineSession['rows'][number] =>
      ({ datetime: dt, open: o, high: h, low: l, close: c, volume: v, amount: v * 100 })
    const dayRows = [
      mk('2026-10-14T09:30:00', 10.0, 10.2, 9.9, 10.1, 100),
      mk('2026-10-14T10:00:00', 10.1, 10.5, 10.0, 10.4, 200),
      mk('2026-10-14T13:30:00', 10.4, 10.6, 10.2, 10.3, 150),
      mk('2026-10-14T15:00:00', 10.3, 10.4, 10.1, 10.2, 50),
    ]
    const sessions: MinuteKlineSession[] = [{ date: '2026-10-14', prev_close: null, rows: dayRows }]
    const minuteAgg = resampleMinutes(flattenSessions(sessions), 240)
    expect(minuteAgg.length).toBe(1) // 全天 1 根 4h 桶

    const dailyAgg = dailyRowsTo4hBars([{
      date: '2026-10-14',
      open: minuteAgg[0].open, high: minuteAgg[0].high,
      low: minuteAgg[0].low, close: minuteAgg[0].close,
      volume: minuteAgg[0].volume, amount: minuteAgg[0].amount,
    } as KlineRow])
    // OHLCV 逐字段相等 (date 标签格式差异不影响数值等价)
    for (const k of ['open', 'high', 'low', 'close', 'volume', 'amount'] as const) {
      expect(dailyAgg[0][k]).toBe(minuteAgg[0][k])
    }
  })

  it('能量柱窗口修复: 200 行日K (4h=200 根) > SMA160 窗口 → 末行 macd_plus_hist 有值', () => {
    const rows: KlineRow[] = []
    let c = 10
    let d = new Date('2026-01-05T12:00:00')
    for (let i = 0; i < 200; i++) {
      // 模拟有波动的价格序列 (否则 |raw| 全 0 → hist 全 0 也算"有值"但弱化验证)
      c = 10 + Math.sin(i / 7) * 2 + (i % 3) * 0.1
      rows.push({ ...row(d.toISOString().slice(0, 10), Number(c.toFixed(4))) })
      d = new Date(d.getTime() + 86400000)
    }
    const bars = dailyRowsTo4hBars(rows)
    const enriched = enrichChartIndicators(bars, 160) // titanLookbackForMinutes(240) === 160
    const last = enriched[enriched.length - 1]
    expect(last.macd_plus_hist).not.toBeNull()
    expect(Number.isFinite(last.macd_plus_hist as number)).toBe(true)
    // 而分钟源 60 根 < 160 窗口 → 全 null (修复前的症状, 回归锚点)
    const short = enrichChartIndicators(dailyRowsTo4hBars(rows.slice(-60)), 160)
    expect(short.every(b => b.macd_plus_hist == null)).toBe(true)
  })
})