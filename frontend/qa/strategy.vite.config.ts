import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { date, strategies, result } from './strategy-fixtures'

// Isolated local fixtures, no proxy and no network forwarding. Unsupported writes fail.
const fixtures: Plugin = {
  name: 'offline-strategy-fixtures',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1:3013')
      const p = url.pathname
      if (!p.startsWith('/api/')) return next()
      let data: unknown
      if (req.method === 'GET') {
        if (p === '/api/strategies') data = { strategies, load_errors: [] }
        else if (p.startsWith('/api/strategies/')) data = strategies.find(s => s.id === p.split('/').pop())
        else if (p === '/api/settings/preferences') data = { screener_auto_run: false }
        else if (p === '/api/data/status') data = { enriched: { latest_date: date, earliest_date: date } }
        else if (p === '/api/capabilities') data = { capabilities: {} }
        else if (p === '/api/settings/minute-refresh/status') data = { healthy: false }
        else if (p === '/api/intraday/status') data = { running: false }
        else if (p === '/api/monitor-rules') data = { rules: [] }
        else if (p === '/api/watchlist/groups') data = { groups: [] }
        else if (p === '/api/watchlist') data = { symbols: [] }
        else if (p === '/api/backtest/factor/columns') data = { columns: [] }
        else if (p.includes('screener') && p.includes('columns')) data = { columns: [] }
        else if (p === '/api/screener/cached-summary') data = { as_of: date, results: Object.fromEntries(strategies.map(s => [s.id, { as_of: date, total: 3 }])), today_ever_counts: {}, updated_at: null }
        else if (p.startsWith('/api/screener/cached-result/')) data = { result: result(p.split('/').pop()!), today_ever_rows: {}, strategy_ids_by_symbol: {}, updated_at: null }
        else if (p === '/api/screener/cached') data = { as_of: date, results: Object.fromEntries(strategies.map(s => [s.id, result(s.id)])), today_ever_matched: {}, today_ever_rows: {}, updated_at: null }
      } else if (req.method === 'POST' && p === '/api/screener/run_preset') {
        let body = ''
        for await (const chunk of req) body += chunk
        try { data = result(JSON.parse(body).strategy_id) } catch { /* Reject malformed input below. */ }
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.statusCode = data === undefined ? 501 : 200
      res.end(JSON.stringify(data ?? { detail: '离线视觉样例未连接此操作；没有向业务服务发送请求。' }))
    })
  },
}
export default defineConfig({
  plugins: [react(), fixtures],
  resolve: { alias: { '@': path.resolve(__dirname, '../src') } },
  server: { host: '127.0.0.1', port: 3013, strictPort: true },
})
