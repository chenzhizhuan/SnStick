import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import { Screener } from '../src/pages/Screener'
import { Logo } from '../src/components/Logo'
import { ToastContainer } from '../src/components/Toast'
import { storage } from '../src/lib/storage'
import { SCREENER_BUILTIN_COLUMNS } from '../src/lib/screener-columns'
import { strategies } from './strategy-fixtures'
import '../src/index.css'
import '../src/styles/workstation.css'
import '../src/styles/strategy-studio.css'

// Port 3013 has separate origin storage; never edits the real application's preferences.
storage.strategyPool.set(strategies.map(s => s.id))
storage.screenerCardSize.set('normal')
storage.screenerResultColumns.set(SCREENER_BUILTIN_COLUMNS.map(c => ({ ...c, visible: c.source.type === 'builtin' && ['symbol', 'price', 'pct', 'score'].includes(c.source.key) })))
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } } })
function Preview() {
  const [dark, setDark] = useState(true)
  return <MemoryRouter><QueryClientProvider client={client}><MotionConfig reducedMotion="user">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, padding: '16px 32px', borderBottom: '1px solid hsl(var(--border))', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Logo size={42}/><strong>赢在子午线</strong></div>
      <span className="text-xs text-muted">真实策略页面 · 离线样例数据 · 不连接业务服务</span>
      <button className="rounded-btn border border-border px-3 py-2 text-xs" onClick={() => { setDark(!dark); document.documentElement.classList.toggle('dark', !dark) }}>{dark ? '浅色主题' : '深色主题'}</button>
    </div>
    <main className="sn-content"><Screener/></main>
    <ToastContainer/>
  </MotionConfig></QueryClientProvider></MemoryRouter>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
