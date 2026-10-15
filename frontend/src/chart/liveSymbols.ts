/**
 * 图表工作台日K实时增量 — 活跃窗格 symbol 注册表 (模块级, 无 React 依赖)。
 *
 * /chart 页面把当前所有窗格的 symbol 注册进来; 全局 SSE 行情推送 (useQuoteStream
 * 的 quotes_updated) 到来时, 对每个注册 symbol 拉取 klineDailyLatest 单行,
 * 增量合并进对应缓存 → 末根 K 的实时价自动覆盖。
 *
 * 三套口径 (2026-10-14 私有化收口后 + 2026-10-15 分钟实时叠加):
 * - 日常规集 (1d/2d/4d/1w/1M): latest 默认 50 档 plus → ['chart','kline-daily',…]
 * - 4h 集: latest 带 plus_lookback=160 → ['chart','kline-daily-4h',…]
 *   (4h 与 1d 同 symbol 并存时两套缓存独立, 互不污染口径)
 * - 分钟集 (15m/60m): 实时价叠加到 ['chart','intraday',…] 末根 (close 覆盖 +
 *   high/low 极值), 与日K窗格同节奏跳动; 15s 轮询仍保留作权威 OHLCV/指标回填
 *
 * 触发源是 SSE (盘中每 1~2s 推一次), 盘后无推送即自动静止 — 无需前端判断交易时段。
 * 与实时行情开关联动 (SSE 关闭时不处理), 同 symbol 多窗格由 Set 去重。
 */
let _symbols = new Set<string>()
let _symbols4h = new Set<string>()
let _symbolsMinute = new Set<string>()

/** 覆盖注册 (页面挂载/窗格布局变化时调用); 内容未变则无副作用。 */
export function setChartLiveSymbols(symbols: string[], symbols4h: string[], symbolsMinute: string[] = []): void {
  const next = new Set(symbols.filter(Boolean))
  const next4h = new Set(symbols4h.filter(Boolean))
  const nextMinute = new Set(symbolsMinute.filter(Boolean))
  if (next.size === _symbols.size && [...next].every(s => _symbols.has(s))
    && next4h.size === _symbols4h.size && [...next4h].every(s => _symbols4h.has(s))
    && nextMinute.size === _symbolsMinute.size && [...nextMinute].every(s => _symbolsMinute.has(s))) return
  _symbols = next
  _symbols4h = next4h
  _symbolsMinute = nextMinute
}

/** 清空注册 (页面卸载)。 */
export function clearChartLiveSymbols(): void {
  if (_symbols.size === 0 && _symbols4h.size === 0 && _symbolsMinute.size === 0) return
  _symbols = new Set()
  _symbols4h = new Set()
  _symbolsMinute = new Set()
}

/** 读取当前注册的活跃 symbol 集合 (日常规口径: 1d/2d/4d/1w/1M 窗格)。 */
export function getChartLiveSymbols(): ReadonlySet<string> {
  return _symbols
}

/** 读取 4h 口径的活跃 symbol 集合 (4h 窗格 → 160 档 plus 增量)。 */
export function getChartLiveSymbols4h(): ReadonlySet<string> {
  return _symbols4h
}

/** 读取分钟窗格 (15m/60m) 的活跃 symbol 集合 (末根实时叠加 → chart intraday 缓存)。 */
export function getChartLiveSymbolsMinute(): ReadonlySet<string> {
  return _symbolsMinute
}
