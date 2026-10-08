/**
 * 图表工作台日K实时增量 — 活跃窗格 symbol 注册表 (模块级, 无 React 依赖)。
 *
 * /chart 页面把当前所有窗格的 symbol 注册进来; 全局 SSE 行情推送 (useQuoteStream
 * 的 quotes_updated) 到来时, 对每个注册 symbol 拉取 klineDailyLatest 单行,
 * 增量合并进 ['chart','kline-daily',symbol,*] 缓存 → 末根 K 的实时价自动覆盖。
 *
 * 触发源是 SSE (盘中每 1~2s 推一次), 盘后无推送即自动静止 — 无需前端判断交易时段。
 * 与实时行情开关联动 (SSE 关闭时不处理), 同 symbol 多窗格由 Set 去重。
 */
let _symbols = new Set<string>()

/** 覆盖注册 (页面挂载/窗格布局变化时调用); 内容未变则无副作用。 */
export function setChartLiveSymbols(symbols: string[]): void {
  const next = new Set(symbols.filter(Boolean))
  if (next.size === _symbols.size && [...next].every(s => _symbols.has(s))) return
  _symbols = next
}

/** 清空注册 (页面卸载)。 */
export function clearChartLiveSymbols(): void {
  if (_symbols.size === 0) return
  _symbols = new Set()
}

/** 读取当前注册的活跃 symbol 集合。 */
export function getChartLiveSymbols(): ReadonlySet<string> {
  return _symbols
}