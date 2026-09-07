import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import { Logo } from '../src/components/Logo'
import { PageHeader } from '../src/components/PageHeader'
import { Modal } from '../src/components/Modal'
import { StrategyCard, type CardSize } from '../src/components/screener/StrategyCard'
import { StockDataTable } from '../src/components/stock-table/StockDataTable'
import type { ColumnConfig } from '../src/lib/list-columns'
import '../src/index.css'
import '../src/styles/workstation.css'

// Synthetic UI fixtures. Imports actual production components, never API or app bootstrap.
const names = ['布林突破', '均线多头', '超卖反弹', '反包', '分歧反包', '空中加油']
const rows = [
  { symbol: '000603', name: '示例标的甲', price: 33.38, pct: 6.36, score: 56.3 },
  { symbol: '003040', name: '示例标的乙', price: 25.33, pct: 7.19, score: 55.3 },
  { symbol: '688981', name: '示例标的丙', price: 86.52, pct: -0.68, score: 52.8 },
]
const columns = ['标的', '现价', '涨跌幅', '评分'].map((label, i) => ({
  id: ['symbol', 'price', 'pct', 'score'][i], label, visible: true,
  source: { type: 'builtin', key: ['symbol', 'price', 'pct', 'score'][i] }, align: i ? 'right' : 'left',
})) as ColumnConfig[]

function Preview() {
  const [dark, setDark] = useState(true)
  const [active, setActive] = useState(2)
  const [size, setSize] = useState<CardSize>('normal')
  const [dialog, setDialog] = useState(false)
  const [monitored, setMonitored] = useState(false)
  const [width, setWidth] = useState(false)
  const [empty, setEmpty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('离线组件验收 · 全部为示例数据 · 不连接后端')
  return <MotionConfig reducedMotion="user">
    <div style={{ maxWidth: width ? 390 : undefined, margin: '0 auto' }}>
      <div style={{padding:12, display:'flex', flexWrap:'wrap', gap:8, borderBottom:'1px solid hsl(var(--border))', fontSize:12}}>
        <strong>{notice}</strong>
        <button className="rounded-btn border border-border px-3 py-1" onClick={() => { setDark(!dark); document.documentElement.classList.toggle('dark', !dark) }}>{dark ? '亮色主题' : '暗色主题'}</button>
        <button className="rounded-btn border border-border px-3 py-1" onClick={() => setWidth(!width)}>{width ? '桌面宽度' : '390px 窄屏'}</button>
      </div>
      <div className="sn-workstation" style={{display:'grid', gridTemplateColumns: width ? '1fr' : '224px minmax(0,1fr)', minHeight:'calc(100vh - 60px)'}}>
        <aside className="sn-navigation" style={{padding:16, display:width?'none':'block'}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:24}}><Logo size={40}/><strong>赢在子午线</strong></div>
          <nav style={{display:'grid',gap:6}}>{['看板','自选','策略','回测','挖掘','持仓提醒','个股分析','连板梯队','概念分析','行业分析','财务分析','监控中心','市场环境','异动监控','复盘','指数','数据'].map(name => <a key={name} href="#" aria-current={name==='策略'?'page':undefined} onClick={e=>{e.preventDefault();setNotice('仅组件样式样例，导航未连接业务')}} className="rounded-btn px-3 py-2 text-sm">{name}</a>)}</nav>
        </aside>
        <main className="sn-content">
          <PageHeader title="策略" subtitle="组件样例" right={<button className="rounded-btn bg-accent px-3 py-2 text-xs text-white" onClick={()=>setDialog(true)}>参数设置</button>}/>
          <div style={{padding:16}}>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
              <select aria-label="策略卡密度" className="rounded-input border border-border bg-surface px-2 py-1 text-xs" value={size} onChange={e=>setSize(e.target.value as CardSize)}><option value="mini">紧凑</option><option value="normal">标准</option><option value="large">详细</option></select>
              <button className="rounded-btn border border-border px-3 py-1 text-xs" onClick={()=>setLoading(!loading)}>{loading?'结束加载':'加载状态'}</button>
              <button className="rounded-btn border border-border px-3 py-1 text-xs" onClick={()=>setEmpty(!empty)}>{empty?'恢复样例':'空数据状态'}</button>
              <button disabled className="rounded-btn bg-accent px-3 py-1 text-xs text-white opacity-50">禁用操作</button>
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:24}}>{names.map((name,i)=><StrategyCard key={name} name={name} description="示例策略说明 · 不参与真实计算" source={i<2?'builtin':'custom'} active={active===i} count={i?26:0} expiredCount={i===3?2:0} loading={loading} cardSize={size} onRun={()=>setActive(i)} disabled={loading} onSettings={()=>setDialog(true)} monitored={monitored&&active===i} onToggleMonitor={()=>setMonitored(!monitored)}/>)}</div>
            <div className="rounded-card border border-border bg-surface p-4" style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}><strong className="text-sm">样例数据面板</strong><span className="text-xs text-muted">2026-09-04 · 历史快照</span></div>
              <div style={{display:'flex',gap:24,flexWrap:'wrap'}}><div><div className="text-xs text-muted">匹配数量</div><strong className="text-xl num">26</strong></div><div><div className="text-xs text-muted">上涨示例</div><strong className="text-xl num text-bull">+6.36%</strong></div><div><div className="text-xs text-muted">下跌示例</div><strong className="text-xl num text-bear">−0.68%</strong></div></div>
            </div>
            <StockDataTable columns={columns} rows={empty?[]:rows} minWidth={560} renderCell={(row,col)=><td style={{padding:'16px 12px',textAlign:col.id==='symbol'?'left':'right'}} className={col.id==='pct'?(row.pct>=0?'text-bull':'text-bear'):''}>{col.id==='symbol'?`${row.name} ${row.symbol}`:col.id==='pct'?`${row.pct>0?'+':''}${row.pct.toFixed(2)}%`:row[col.id]}</td>}/>
            {empty&&<p className="text-xs text-muted" style={{padding:16}}>暂无数据（离线空状态）</p>}
            <p className="text-xs text-warning" style={{marginTop:16}}>无数据源能力与错误提示沿用原业务页面，此处只验证视觉。</p>
          </div>
        </main>
      </div>
    </div>
    {dialog&&<Modal onClose={()=>setDialog(false)} ariaLabel="参数设置样例"><div style={{padding:24}}><h2 className="text-lg font-semibold">参数设置样例</h2><p className="text-xs text-muted" style={{margin:'8px 0 20px'}}>只用于验证控件与焦点，不保存业务参数。</p><label className="text-sm">回看窗口<input defaultValue="20" className="rounded-input border border-border bg-base px-3 py-2" style={{display:'block',width:'100%',marginTop:8}}/></label><div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:24}}><button className="rounded-btn border border-border px-4 py-2 text-sm" onClick={()=>setDialog(false)}>取消</button><button className="rounded-btn bg-accent px-4 py-2 text-sm text-white" onClick={()=>setDialog(false)}>完成预览</button></div></div></Modal>}
  </MotionConfig>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
