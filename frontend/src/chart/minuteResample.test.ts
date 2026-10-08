import { describe, expect, it } from 'vitest'
import { flattenSessions, resampleMinutes, type ResampledBar } from './minuteResample'
import type { MinuteKlineSession } from '@/lib/api'

const row = (datetime: string, o: Partial<{ open: number | null; high: number; low: number; close: number; volume: number; amount: number | null }> = {}) => ({
  datetime,
  open: 10, high: 10, low: 10, close: 10, volume: 10, amount: null,
  ...o,
})

const session = (date: string, rows: ReturnType<typeof row>[]): MinuteKlineSession => ({
  date, prev_close: null, rows,
})

describe('flattenSessions', () => {
  it('拍平 sessions, date 标签为 "YYYY-MM-DD HH:mm"', () => {
    const out = flattenSessions([
      session('2026-09-28', [row('2026-09-28T09:30:00')]),
      session('2026-09-29', [row('2026-09-29 13:05:00')]),
    ])
    expect(out.map(b => b.date)).toEqual(['2026-09-28 09:30', '2026-09-29 13:05'])
  })

  it('open 为 null 时降级用 close (stock-sdk 历史源无分钟 open)', () => {
    const out = flattenSessions([session('2026-09-29', [row('2026-09-29 09:31:00', { open: null, close: 12.5 })])])
    expect(out[0].open).toBe(12.5)
  })

  it('无效 datetime 静默跳过', () => {
    const out = flattenSessions([session('2026-09-29', [
      row('bad-format'),
      row('2026-09-29 09:30:00'),
    ])])
    expect(out.length).toBe(1)
  })
})

describe('resampleMinutes', () => {
  it('period=1 透传且返回副本 (调用方可安全 mutate)', () => {
    const bars: ResampledBar[] = [
      { date: '2026-09-29 09:30', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: null },
    ]
    const out = resampleMinutes(bars, 1)
    out[0].volume = 999
    expect(bars[0].volume).toBe(1)
  })

  it('5 分钟桶: open=首根 open, close=末根 close, high/low=极值, volume 求和, 标签=桶开始时间', () => {
    const out = resampleMinutes(
      flattenSessions([session('2026-09-29', [
        row('2026-09-29 09:30', { open: 10, high: 11, low: 9.5, close: 10.2, volume: 100 }),
        row('2026-09-29 09:31', { open: 10.2, high: 10.8, low: 10, close: 10.4, volume: 50 }),
        row('2026-09-29 09:32', { open: 10.4, high: 10.6, low: 10.1, close: 10.1, volume: 30 }),
        row('2026-09-29 09:35', { open: 10.1, high: 10.3, low: 10, close: 10.3, volume: 70 }),
      ])]),
      5,
    )
    expect(out.length).toBe(2)
    expect(out[0]).toMatchObject({
      date: '2026-09-29 09:30',
      open: 10, close: 10.1, high: 11, low: 9.5, volume: 180,
    })
    expect(out[1]).toMatchObject({ date: '2026-09-29 09:35', close: 10.3, volume: 70 })
  })

  it('不跨午休: 上午末桶与下午首桶分离', () => {
    const out = resampleMinutes(
      flattenSessions([session('2026-09-29', [
        row('2026-09-29 11:29', { close: 11, volume: 10 }),
        row('2026-09-29 13:01', { close: 12, volume: 20 }),
      ])]),
      60,
    )
    expect(out.length).toBe(2)
    expect(out[0].close).toBe(11)
    expect(out[1].close).toBe(12)
  })

  it('不跨日: 相同时刻不同日归不同桶', () => {
    const out = resampleMinutes(
      flattenSessions([
        session('2026-09-28', [row('2026-09-28 09:30', { close: 9 })]),
        session('2026-09-29', [row('2026-09-29 09:30', { close: 10 })]),
      ]),
      60,
    )
    expect(out.length).toBe(2)
    expect(out.map(b => b.close)).toEqual([9, 10])
  })

  it('60 分钟桶: 09:30-10:29 同桶, 10:30 起新桶', () => {
    const out = resampleMinutes(
      flattenSessions([session('2026-09-29', [
        row('2026-09-29 09:31', { close: 1, volume: 1 }),
        row('2026-09-29 10:15', { close: 2, volume: 1 }),
        row('2026-09-29 10:29', { close: 3, volume: 1 }),
        row('2026-09-29 10:30', { close: 4, volume: 1 }),
      ])]),
      60,
    )
    expect(out.length).toBe(2)
    expect(out[0]).toMatchObject({ date: '2026-09-29 09:31', close: 3, volume: 3 })
    expect(out[1]).toMatchObject({ date: '2026-09-29 10:30', close: 4 })
  })

  it('amount 累加; null 侧断档时取可得值', () => {
    const out = resampleMinutes(
      flattenSessions([session('2026-09-29', [
        row('2026-09-29 09:30', { close: 1, amount: 100 }),
        row('2026-09-29 09:31', { close: 2, amount: 50 }),
        row('2026-09-29 09:32', { close: 3, amount: null }),
      ])]),
      5,
    )
    expect(out[0].amount).toBe(150)
  })

  it('240 分钟 (4h): 全天两时段合并为 1 根/日, 跨午休', () => {
    const out = resampleMinutes(
      flattenSessions([session('2026-09-29', [
        row('2026-09-29 09:30', { open: 10, high: 11, low: 9.5, close: 10.2, volume: 100 }),
        row('2026-09-29 11:30', { close: 11, volume: 50 }),
        row('2026-09-29 13:01', { close: 10.5, volume: 30 }),
        row('2026-09-29 14:59', { open: 10.5, high: 12, low: 10, close: 11.8, volume: 80 }),
      ])]),
      240,
    )
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({
      date: '2026-09-29 09:30',
      open: 10, close: 11.8, high: 12, low: 9.5, volume: 260,
    })
  })

  it('240 分钟 (4h): 不同日不同桶', () => {
    const out = resampleMinutes(
      flattenSessions([
        session('2026-09-28', [row('2026-09-28 14:59', { close: 9, volume: 5 })]),
        session('2026-09-29', [row('2026-09-29 09:30', { close: 10, volume: 5 })]),
      ]),
      240,
    )
    expect(out.length).toBe(2)
    expect(out.map(b => b.date)).toEqual(['2026-09-28 14:59', '2026-09-29 09:30'])
    expect(out.map(b => b.close)).toEqual([9, 10])
  })
})
