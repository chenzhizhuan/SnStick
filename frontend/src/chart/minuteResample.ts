/**
 * 分钟K重采样引擎 — 把 1 分钟K聚合为 5/15/30/60 分钟K (纯函数)。
 *
 * 切桶口径与后端 intraday_features 同源:
 *   - 桶边界 = 交易日 × 交易时段 (09:30-11:30 / 13:00-15:00), 不跨午休、不跨日;
 *   - 桶序号 = floor((bar 时刻 - 时段开盘) / period);
 *   - OHLCV: open=首根 open (缺失时降级首根 close), close=末根 close,
 *            high/low=桶内极值, volume/amount=桶内求和。
 * 输出 date 标签 = 桶内首根的时间 "YYYY-MM-DD HH:mm" (TV 同款: 显示桶开始时间)。
 */
import type { MinuteKlineSession } from '@/lib/api'

export interface ResampledBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number | null
}

/** A 股连续竞价时段开盘分钟数 (自 0:00): 09:30=570, 13:00=780 */
const SESSION_OPENS = [570, 780]

/** 从 datetime 串提取 "YYYY-MM-DD" 与 "HH:MM"。兼容 'T' 或空格分隔。 */
function splitDateTime(dt: string): { day: string; hhmm: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(dt))
  if (!m) return null
  return { day: m[1], hhmm: `${m[2]}:${m[3]}` }
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * 把 minute-range 的 sessions 拍平为 1 分钟OHLC序列 (period=1 时直接可用)。
 * 无效行 (时间解析失败) 静默跳过, 保持桶内数据完整性。
 */
export function flattenSessions(sessions: MinuteKlineSession[]): ResampledBar[] {
  const out: ResampledBar[] = []
  for (const s of sessions) {
    for (const r of s.rows) {
      const parsed = splitDateTime(r.datetime)
      if (!parsed) continue
      out.push({
        date: `${parsed.day} ${parsed.hhmm}`,
        open: r.open ?? r.close,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        amount: r.amount,
      })
    }
  }
  return out
}

/**
 * 按 A 股时段切桶聚合。输入须已按时间升序 (flattenSessions 保证)。
 * period=1 复制每个 bar (浅拷贝元素, 与聚合路径新建对象同语义),
 * 保证输出与输入不共享元素引用 — 调用方可以安全 mutate 指标字段。
 */
export function resampleMinutes(bars: ResampledBar[], period: 1 | 5 | 15 | 30 | 60 | 240): ResampledBar[] {
  if (period === 1) return bars.map(b => ({ ...b }))

  const out: ResampledBar[] = []
  // 桶 key: `${day}#${sessionIdx}#${bucketIdx}` → 累积状态
  // 240 分钟 (4h) 特殊: 每天 1 根, 横跨上午+下午两个时段, 用 day 做桶 key
  let cur: { key: string; bar: ResampledBar } | null = null

  for (const b of bars) {
    const [day, hhmm] = b.date.split(' ')
    const t = hhmmToMinutes(hhmm)
    // 定位时段: 下午 (>=780) 走第二时段, 其余落第一时段
    let sIdx = 0
    let sessionOpen = SESSION_OPENS[0]
    if (t >= SESSION_OPENS[1]) {
      sIdx = 1
      sessionOpen = SESSION_OPENS[1]
    }
    const bucketIdx = Math.floor((t - sessionOpen) / period)
    // 240 分钟 (4h) = A 股全天交易时长, 每天 1 根: 桶 key 只用 day (不分 session/bucket)
    const key = period >= 240 ? day : `${day}#${sIdx}#${bucketIdx}`

    if (!cur || cur.key !== key) {
      if (cur) out.push(cur.bar)
      cur = {
        key,
        bar: { ...b }, // 首根: date 即桶标签, open/high/low/close/volume 均以首根起步
      }
    } else {
      const c = cur.bar
      c.high = Math.max(c.high, b.high)
      c.low = Math.min(c.low, b.low)
      c.close = b.close
      c.volume += b.volume
      c.amount = c.amount != null && b.amount != null ? c.amount + b.amount : (c.amount ?? b.amount)
    }
  }
  if (cur) out.push(cur.bar)
  return out
}
