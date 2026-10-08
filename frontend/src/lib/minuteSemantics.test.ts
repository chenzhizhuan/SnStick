/**
 * minuteSemantics 单测 — 数据源"结束时刻" → TV "开始时刻" 语义换算。
 *
 * 用例数据取自 2026-09-29 实测 (300917.SZ): 09:30 竞价根 v=3577,
 * 09:31 首分钟根 v=17052, 午间 11:30 根, 下午首根 13:01, 收盘根 15:00。
 */
import { describe, expect, it } from 'vitest'
import { toMinuteStartSemanticsRows, toMinuteStartSemanticsSessions } from './minuteSemantics'
import type { MinuteKlineRow } from '@/lib/api'

const row = (datetime: string, o: Partial<MinuteKlineRow> = {}): MinuteKlineRow => ({
  datetime,
  open: 10,
  high: 10,
  low: 10,
  close: 10,
  volume: 10,
  amount: null,
  ...o,
})

describe('toMinuteStartSemanticsRows', () => {
  it('竞价根 + 首分钟根合并为 09:30 (OHLC 聚合、量额相加)', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-29 09:30:00', { open: 33.3, high: 33.3, low: 33.3, close: 33.3, volume: 3577, amount: 11_910_000 }),
      row('2026-09-29 09:31:00', { open: 33.4, high: 34.2, low: 32.8, close: 33.01, volume: 17052, amount: 56_800_000 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      datetime: '2026-09-29 09:30:00', // 保留输入分隔符 (空格)
      open: 33.3,        // 竞价根 open
      close: 33.01,      // 首分钟根 close
      high: 34.2,        // 极值
      low: 32.8,
      volume: 3577 + 17052,
      amount: 11_910_000 + 56_800_000,
    })
  })

  it('盘中进行中根: 11:04 → 11:03 (与当前分钟对齐), 与上一根 11:03→11:02 不合并', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-30T11:03:00'),
      row('2026-09-30T11:04:00', { close: 33.2, volume: 422 }),
    ])
    expect(out.map(r => r.datetime)).toEqual([
      '2026-09-30T11:02:00', // 上一根 (源 11:03 覆盖 [11:02,11:03))
      '2026-09-30T11:03:00', // 进行中根 (源 11:04 覆盖 [11:03,11:04))
    ])
    expect(out[1].close).toBe(33.2)
    expect(out[1].volume).toBe(422)
  })

  it('边界换算: 11:30→11:29, 13:01→13:00, 15:00→14:59', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-29T11:30:00'),
      row('2026-09-29T13:01:00'),
      row('2026-09-29T15:00:00'),
    ])
    expect(out.map(r => r.datetime)).toEqual([
      '2026-09-29T11:29:00',
      '2026-09-29T13:00:00',
      '2026-09-29T14:59:00',
    ])
  })

  it('跨小时借位: 10:00→09:59, 14:00→13:59', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-29T10:00:00'),
      row('2026-09-29T14:00:00'),
    ])
    expect(out.map(r => r.datetime)).toEqual([
      '2026-09-29T09:59:00',
      '2026-09-29T13:59:00',
    ])
  })

  it('无竞价根: 首根 09:31→09:30 自然成为首根, 不与后续 09:32→09:31 合并', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-29T09:31:00', { close: 1 }),
      row('2026-09-29T09:32:00', { close: 2 }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].datetime).toBe('2026-09-29T09:30:00')
    expect(out[1].datetime).toBe('2026-09-29T09:31:00')
  })

  it('防御: volume 缺失 (可选字段) 的合并不产生 NaN', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-29T09:30:00', { volume: undefined as unknown as number }),
      row('2026-09-29T09:31:00', { volume: undefined as unknown as number }),
    ])
    expect(out).toHaveLength(1)
    expect(Number.isFinite(out[0].volume)).toBe(true)
    expect(out[0].volume).toBe(0)
  })

  it('防御: 午休/盘后/异常标签不换算原样透传', () => {
    const out = toMinuteStartSemanticsRows([
      row('2026-09-29T11:31:00'), // 午休边界后
      row('2026-09-29T13:00:00'), // 幽灵根 (源无此标签)
      row('2026-09-29T15:31:00'), // 盘后
      row('bad-format'),          // 无法解析
    ])
    expect(out.map(r => r.datetime)).toEqual([
      '2026-09-29T11:31:00',
      '2026-09-29T13:00:00',
      '2026-09-29T15:31:00',
      'bad-format',
    ])
  })

  it('全天完整日: 241 根 → 240 根 (仅首根合并)', () => {
    const rows: MinuteKlineRow[] = []
    // 上午 09:30..11:30 (121 根)
    for (let m = 0; m <= 120; m++) {
      const t = new Date(Date.UTC(2026, 8, 29, 9, 30 + m))
      rows.push(row(`${t.toISOString().slice(0, 10)}T${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:00`))
    }
    // 下午 13:01..15:00 (120 根)
    for (let m = 1; m <= 120; m++) {
      const t = new Date(Date.UTC(2026, 8, 29, 13, m))
      rows.push(row(`2026-09-29T${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:00`))
    }
    expect(rows).toHaveLength(241)
    const out = toMinuteStartSemanticsRows(rows)
    expect(out).toHaveLength(240)
    expect(out[0].datetime).toBe('2026-09-29T09:30:00')
    expect(out[119].datetime).toBe('2026-09-29T11:29:00')
    expect(out[120].datetime).toBe('2026-09-29T13:00:00')
    expect(out[239].datetime).toBe('2026-09-29T14:59:00')
  })
})

describe('toMinuteStartSemanticsSessions', () => {
  it('多日 sessions 逐日换算, 保留 date/prev_close', () => {
    const out = toMinuteStartSemanticsSessions([
      { date: '2026-09-29', prev_close: 33, rows: [row('2026-09-29T15:00:00')] },
      { date: '2026-09-30', prev_close: 33.3, rows: [row('2026-09-30T09:30:00'), row('2026-09-30T09:31:00')] },
    ])
    expect(out[0]).toMatchObject({ date: '2026-09-29', prev_close: 33 })
    expect(out[0].rows[0].datetime).toBe('2026-09-29T14:59:00')
    expect(out[1].rows).toHaveLength(1) // 09:30 竞价 + 09:31 合并
    expect(out[1].rows[0].datetime).toBe('2026-09-30T09:30:00')
  })
})