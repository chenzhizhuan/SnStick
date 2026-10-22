import { describe, expect, it } from 'vitest'
import { dailyRowsTo4hBars, mergeDailyRows, shiftDate } from './useChartPaneData'
import { flattenSessions, resampleMinutes } from './minuteResample'
import { enrichChartIndicators } from './indicators'
import type { KlineRow, MinuteKlineSession } from '@/lib/api'
import type { OHLC } from '@/components/EChartsCandlestick'

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

  it('私有指标透传: 服务端附着的 plus 字段原样保留, 前端不再计算', () => {
    // 私有化收口: enrichChartIndicators 只算公开指标, macd_plus_*/rsi_plus
    // 从输入 bar 透传 (服务端 /api/kline/intraday 附着)
    const bars = [
      { ...dailyRowsTo4hBars([row('2026-10-14')])[0], close: 10.5 },
      { ...dailyRowsTo4hBars([row('2026-10-15')])[0], close: 10.8 },
    ] as import('./indicators').IntradayInputBar[]
    bars[0].macd_plus_dif = 1.5
    bars[0].macd_plus_dea = 1.2
    bars[0].macd_plus_hist = 0.3
    bars[0].rsi_plus = 42.5
    // 第二根不带 plus 字段 → 透传为 null (服务端窗口前缀无值语义)
    const enriched = enrichChartIndicators(bars)
    expect(enriched[0].macd_plus_dif).toBe(1.5)
    expect(enriched[0].macd_plus_dea).toBe(1.2)
    expect(enriched[0].macd_plus_hist).toBe(0.3)
    expect(enriched[0].rsi_plus).toBe(42.5)
    expect(enriched[1].macd_plus_dif).toBeNull()
    expect(enriched[1].rsi_plus).toBeNull()
    // 公开指标照常计算
    expect(enriched[0].macd_dif).toBe(0) // 首行 EMA 同起步
    expect(enriched[1].macd_dif).not.toBeNull()
  })
})

describe('enrichChartIndicators (日级 agg 路径: OHLC 输入)', () => {
  it('公开指标在聚合 K 上现场重算, 私有字段透传, is_live 保留', () => {
    // 模拟 mapDailyRow 产出的聚合 K 行 (后端 /daily?agg= 已在聚合 K 上重算私有指标)
    const mk = (date: string, close: number, extra: Record<string, unknown> = {}): OHLC =>
      ({ date, open: close - 0.1, high: close + 0.2, low: close - 0.3, close, ...extra } as OHLC)
    const rows = [
      mk('2026-09-21', 10, { ry_upper: 11.5, ry_mid: 10.5, k2_up: 12, is_live: false }),
      mk('2026-09-28', 10.5, { ry_upper: 11.6, ry_mid: 10.6 }),
      mk('2026-10-05', 11, { ry_upper: 11.7, ry_mid: 10.7, is_live: true }),
    ]
    const out = enrichChartIndicators(rows)
    // 公开指标重算: MA5 窗口不足 → null (后端聚合行不携带 MA, 前端现场算)
    expect(out.map(o => o.ma5)).toEqual([null, null, null])
    // MACD 首行 adjust=False 同起步
    expect(out[0].macd_dif).toBe(0)
    // 私有字段透传 (后端在聚合 K 上重算的值不被前端覆盖)
    expect(out[0].ry_upper).toBe(11.5)
    expect(out[2].ry_upper).toBe(11.7)
    expect(out[1].k2_up).toBeNull() // 未携带字段 → null (窗口前缀无值语义)
    // is_live 保留 (末根活动桶实时徽记; 泛型签名修复的关键验证点)
    expect(out[2].is_live).toBe(true)
    expect(out[0].is_live).toBe(false)
  })
})