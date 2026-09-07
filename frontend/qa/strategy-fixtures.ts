// Synthetic fixtures for the real Screener page. Never imported by production.
export const date = '2026-09-04'
export const strategies = ['均线多头', '布林突破', '前高突破', '超卖反弹', '放量突破', '反包', '趋势加速', '分钟突破'].map((name, i) => ({
  id: `visual-${i}`, name, description: '离线示例策略，用于检查完整页面排版与操作入口。所有数值均为样例。',
  source: 'builtin', asset_types: ['stock', 'etf'], timeframes: [i === 7 ? '1m' : '1d'],
  params: [], params_defaults: {}, basic_filter: {}, scoring: {}, scoring_directions: {},
  tags: [], version: 'offline', execution_backend: 'polars_expr', entry_signals: [], exit_signals: [],
  minute_exit_trigger_supported_signals: [], stop_loss: null, take_profit: null, trailing_stop: null,
  trailing_take_profit_activate: null, trailing_take_profit_drawdown: null, max_hold_days: null,
  order_by: 'close', descending: true, limit: 30,
}))
export const rows = [
  { symbol: '000001.SZ', name: '示例标的甲', close: 33.38, change_pct: .0636, score: 56.3 },
  { symbol: '000002.SZ', name: '示例标的乙', close: 25.33, change_pct: .0719, score: 55.3 },
  { symbol: '000003.SZ', name: '示例标的丙', close: 86.52, change_pct: -.0068, score: 52.8 },
]
export const result = (id: string) => ({ strategy: id, as_of: date, rows, total: rows.length, elapsed_ms: 0 })
