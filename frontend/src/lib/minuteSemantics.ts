/**
 * 分钟K时间语义换算 — 数据源"bar 结束时刻" → TradingView "bar 开始时刻"。
 *
 * 数据源 (stock-sdk / 指数分钟, 东财系) 契约:
 *   - 09:30 为集合竞价根 (只含竞价撮合量);
 *   - 09:31..11:30 / 13:01..15:00 为 bar 结束时刻: 标签 11:04 的 bar 实际覆盖
 *     [11:03,11:04), 盘中"进行中 bar"的标签超前当前分钟 1 分钟
 *     (北京 11:03:30 时最右侧K线显示 11:04)。
 * TV 范式 (本工作台展示约定):
 *   - 09:30 为竞价 + [09:30,09:31) 合并根;
 *   - 09:31..11:29 / 13:00..14:59 为 bar 开始时刻, 进行中 bar 标签 = 当前分钟。
 *
 * 变换规则 (对每个交易日的升序 rows):
 *   1. 09:30 竞价根保留不动;
 *   2. 其余合法分钟根 (09:31..11:30 / 13:01..15:00) 时间 -1 分钟
 *      (09:31→09:30, 11:30→11:29, 13:01→13:00, 15:00→14:59);
 *   3. 换算后与竞价根同标签 09:30 的 (原 09:31 根) 与之合并:
 *      open 取首根, close 取末根, high/low 取极值, volume/amount 相加。
 *
 * 防御: 非上述时段的异常标签 (如 12:xx 午休、13:00 幽灵根、15:30 盘后)
 * 不换算原样透传, 避免制造更糟的错位。
 *
 * 只做展示层标签换算, 不改 OHLCV 数值; 落盘/后端数据契约保持源语义不动。
 */
import type { MinuteKlineRow, MinuteKlineSession } from '@/lib/api'

/** 该分钟标签 (HH:MM) 是否属于可换算域 [09:31,11:30] ∪ [13:01,15:00]。 */
function isShiftable(hhmm: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return false
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(3, 5))
  if (h === 9) return m >= 31
  if (h === 10) return true
  if (h === 11) return m <= 30
  if (h === 13) return m >= 1
  if (h === 14) return true
  if (h === 15) return m === 0
  return false
}

/** 'HH:MM' 减 1 分钟 (含小时借位: 10:00→09:59)。调用方保证结果合法。 */
function shiftBackOneMinute(hhmm: string): string {
  let h = Number(hhmm.slice(0, 2))
  let m = Number(hhmm.slice(3, 5))
  m -= 1
  if (m < 0) {
    m = 59
    h -= 1
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * 单日分钟行序列: 结束时刻 → 开始时刻 (含竞价根合并)。
 * 输入须按 datetime 升序 (所有后端分钟端点均保证); 不要求 09:30 竞价根必须存在
 * (缺失时首分钟根 09:31→09:30 自然成为首根, 无需合并)。
 */
export function toMinuteStartSemanticsRows(rows: MinuteKlineRow[]): MinuteKlineRow[] {
  const out: MinuteKlineRow[] = []
  for (const r of rows) {
    const s = String(r.datetime ?? '')
    const m = /^(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2})/.exec(s)
    if (!m) {
      out.push(r)
      continue
    }
    const hhmm = isShiftable(m[3]) ? shiftBackOneMinute(m[3]) : m[3]
    const merged: MinuteKlineRow = { ...r, datetime: `${m[1]}${m[2]}${hhmm}:00` }
    const last = out[out.length - 1]
    if (last && last.datetime === merged.datetime) {
      // 与上一根同标签: 竞价根 09:30 + 首分钟根 09:31→09:30 合并
      // (volume 为可选字段, 缺失时按 0 合并 — 直接相加会得到 NaN 污染量柱/统计)
      out[out.length - 1] = {
        ...merged,
        open: last.open ?? merged.open ?? merged.close,
        high: Math.max(last.high, merged.high),
        low: Math.min(last.low, merged.low),
        volume: (last.volume ?? 0) + (merged.volume ?? 0),
        amount:
          last.amount != null && merged.amount != null
            ? last.amount + merged.amount
            : (last.amount ?? merged.amount),
      }
    } else {
      out.push(merged)
    }
  }
  return out
}

/** 多日 sessions 换算 (图表工作台 minute-range)。 */
export function toMinuteStartSemanticsSessions(
  sessions: MinuteKlineSession[],
): MinuteKlineSession[] {
  return sessions.map(s => ({ ...s, rows: toMinuteStartSemanticsRows(s.rows) }))
}