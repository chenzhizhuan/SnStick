import { useEffect, useRef, useMemo, useState } from 'react'
import { chartTheme, getTheme, useTheme } from '@/lib/theme'
import * as echarts from 'echarts'
import type { ECharts, EChartsOption } from 'echarts'
import type { KlineRow, LevelSeries } from '@/lib/api'

/**
 * 个股分析专用日 K 图表。
 *
 * 与 StockDailyKChart/EChartsCandlestick 刻意不复用:
 *   - 那套图表面向「行情浏览」,强调全套指标副图(MA/MACD/KDJ/BOLL)、涨停标记等;
 *   - 本图表面向「分析决策」,核心是【关键价位】(压力/支撑/密集区/枢轴/前高前低),
 *     通过开关按钮控制各价位组的显隐,布局更简洁(主图 + 成交量即可)。
 *
 * 预留接口(类型已定义,渲染逻辑留 hook,后续实现):
 *   - markers: 日期标记点(新闻/暴雷/利好 → markPoint)
 *   - ranges:  区间高亮(事件区间 → markArea)
 *   - onDateClick: 点击日期回调(后续接消息面时间轴)
 *   - 指标副图: 后续如需 MACD/KDJ,按 SUB_CHARTS 模式扩展
 */

// ===== 配色(红涨绿跌, 双主题通用); 画布轴/网格主题相关色走 CT() =====
const THEME = {
  bull: '#C74040',
  bear: '#2D9B65',
  volUp: 'rgba(240,68,56,0.5)',
  volDown: 'rgba(18,183,106,0.5)',
}

/** 当前主题的图表调色板 (buildOption 渲染时调用; 切换由组件 effect 触发重建)。 */
const CT = () => chartTheme(getTheme())

// ===== 价位类型(与后端 levels.py 的 LEVEL_TYPES 对齐) =====
export type LevelType = 'sr' | 'pivot' | 'extreme' | 'boll' | 'keltner_s' | 'keltner_m' | 'keltner_l' | 'atr_stop' | 'gap' | 'fib' | 'round'

export interface PriceLevel {
  value: number
  label: string
  type: LevelType
  side: 'resistance' | 'support' | 'neutral'
  strength?: 'strong' | 'medium' | 'weak'
  /** 档位(仅 pivot 有):0=P, 1=R1/S1, 2=R2/S2, 3=R3/S3 */
  rank?: number
}

/** 价位组开关配置:label = 按钮文案,color = markLine 颜色 */
export const LEVEL_GROUPS: { key: LevelType; label: string; color: string }[] = [
  { key: 'sr',       label: '压力支撑',  color: '#F97316' },   // 橙(成交密集区,价量驱动)
  { key: 'pivot',    label: '枢轴点',    color: '#8B5CF6' },   // 紫
  { key: 'extreme',  label: '前高前低',  color: '#EAB308' },   // 黄
  { key: 'boll',     label: '布林带',    color: '#F97316' },   // 橙(MA20±2σ 曲线)
  { key: 'keltner_s',label: 'Keltner短期',  color: '#06B6D4' },   // 青(MA20±2ATR 曲线)
  { key: 'keltner_m',label: 'Keltner中期',  color: '#22D3EE' },   // 浅青(MA60±2.5ATR 曲线)
  { key: 'keltner_l',label: 'Keltner长期',  color: '#67E8F9' },   // 更浅青(MA120±3ATR 曲线)
  { key: 'atr_stop', label: 'ATR波动通道',  color: '#EF4444' },   // 红(警示)
  { key: 'gap',      label: '缺口位',    color: '#EC4899' },   // 粉
  { key: 'fib',      label: '斐波那契',  color: '#F59E0B' },   // 金
  { key: 'round',    label: '整数关口',  color: '#71717A' },   // 灰(心理位,弱视觉)
]

// 通道曲线元数据(单一数据源):供 buildOption 画线 + 右侧面板取最新值共用。
//   alignedKey: alignedSeries 中的 key(由 series.boll/keltner/atr 对齐而来)
//   group:      属于哪个价位开关组(开关该组即开关这条曲线)
//   endLabel:   右侧端点标签(显示最新值的文字)
const CURVE_DEFS: { alignedKey: string; group: LevelType; endLabel: string; color: string; dashed?: boolean }[] = [
  { alignedKey: 'boll_upper',     group: 'boll',      endLabel: '布林上轨', color: '#F97316', dashed: true },
  { alignedKey: 'boll_lower',     group: 'boll',      endLabel: '布林下轨', color: '#F97316', dashed: true },
  { alignedKey: 'boll_mid',       group: 'boll',      endLabel: '布林中轨', color: '#FB923C', dashed: false },
  { alignedKey: 'keltner_s_upper',group: 'keltner_s', endLabel: 'Keltner短上', color: '#06B6D4', dashed: true },
  { alignedKey: 'keltner_s_lower',group: 'keltner_s', endLabel: 'Keltner短下', color: '#06B6D4', dashed: true },
  { alignedKey: 'keltner_m_upper',group: 'keltner_m', endLabel: 'Keltner中上', color: '#22D3EE', dashed: true },
  { alignedKey: 'keltner_m_lower',group: 'keltner_m', endLabel: 'Keltner中下', color: '#22D3EE', dashed: true },
  { alignedKey: 'keltner_l_upper',group: 'keltner_l', endLabel: 'Keltner长上', color: '#67E8F9', dashed: true },
  { alignedKey: 'keltner_l_lower',group: 'keltner_l', endLabel: 'Keltner长下', color: '#67E8F9', dashed: true },
  { alignedKey: 'atr_stop',       group: 'atr_stop',  endLabel: 'ATR下轨', color: '#EF4444', dashed: true },
  { alignedKey: 'atr_tp',         group: 'atr_stop',  endLabel: 'ATR上轨', color: '#F87171', dashed: true },
]

// ===== 预留:标记 / 区间(后续新闻面、事件区间用) =====
export interface ChartMarker {
  date: string
  label?: string
  color?: string
  above?: boolean
}
export interface ChartRange {
  start: string
  end: string
  label?: string
  color?: string
}

interface Props {
  rows: KlineRow[]
  /** 当前标的 (换股检测用: 换股时清用户缩放窗口回默认, 工作台同款语义) */
  symbol?: string
  levels?: Record<LevelType, PriceLevel[]>
  /** 带状曲线指标(布林带/Keltner/ATR)的每日序列 —— 画成跟随时间漂移的曲线 */
  series?: LevelSeries
  /** series 数据对应的日期数组(与 series 各数组对齐) */
  seriesDates?: string[]
  /** 默认开启的价位组 */
  defaultLevelTypes?: LevelType[]
  /** 预留:新闻/暴雷/利好日期标记 */
  markers?: ChartMarker[]
  /** 预留:事件区间高亮 */
  ranges?: ChartRange[]
  /** 预留:点击某根 K 线 */
  onDateClick?: (date: string) => void
  height?: number
  className?: string
}

const VOL_PANE_H = 90

export function AnalysisKChart({
  rows,
  symbol,
  levels,
  series,
  seriesDates,
  defaultLevelTypes = ['sr', 'pivot', 'keltner_s'],
  markers,
  ranges,
  onDateClick,
  height = 460,
  className,
}: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstRef = useRef<ECharts | null>(null)
  /** seriesIndex → levelKey 映射, buildOption 填充, ECharts hover 事件反查 */
  const seriesKeyMapRef = useRef<Map<number, string>>(new Map())
  // 主题: buildOption 内部用 CT() 动态取色, 这里只负责切换时触发重建
  const theme = useTheme()
  const [activeTypes, setActiveTypes] = useState<Set<LevelType>>(new Set(defaultLevelTypes))
  /** 枢轴点显示到第几档:1=只P+R1/S1, 2=到R2/S2, 3=全档(R3/S3) */
  const [pivotRank, setPivotRank] = useState<1 | 2 | 3>(1)
  /** 双向联动高亮: hover 价位标签 ↔ hover 下方文字行。值为 levelKey, null=无高亮 */
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  // 数据预处理 + 带状曲线序列对齐(后端 series 的日期范围可能与 rows 不同,需映射)
  const { dates, candle, vols, dateIndex, defaultZoom, alignedSeries } = useMemo(() => {
    const dates = rows.map(r => (typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date)))
    const candle = rows.map(r => [r.open, r.close, r.low, r.high])
    const vols = rows.map(r => ({
      value: r.volume ?? 0,
      itemStyle: { color: r.close >= r.open ? THEME.volUp : THEME.volDown },
    }))
    const dateIndex = new Map(dates.map((d, i) => [d, i]))
    // 默认显示最近 6 个月 ≈ 120 个交易日;数据不足则全部显示
    const showBars = 120
    const start = dates.length > showBars ? Math.round((1 - showBars / dates.length) * 100) : 0
    const defaultZoom = { start, end: 100 }

    // 把后端 series(按 seriesDates 对齐)映射到前端 rows 的 dates 顺序
    const alignedSeries: Record<string, (number | null)[]> = {}
    if (series && seriesDates && seriesDates.length > 0) {
      // 构建 seriesDates 索引
      const sIdx = new Map(seriesDates.map((d, i) => [d, i]))
      // 通用对齐:给定 series 里某条数组,返回与 rows dates 对齐的版本
      const align = (arr: (number | null)[] | undefined): (number | null)[] => {
        if (!arr) return dates.map(() => null)
        return dates.map(d => {
          const i = sIdx.get(d)
          return i != null ? arr[i] : null
        })
      }
      if (series.boll) {
        alignedSeries['boll_upper'] = align(series.boll.upper)
        alignedSeries['boll_lower'] = align(series.boll.lower)
        if (series.boll.mid) alignedSeries['boll_mid'] = align(series.boll.mid)
      }
      if (series.keltner_s) {
        alignedSeries['keltner_s_upper'] = align(series.keltner_s.upper)
        alignedSeries['keltner_s_lower'] = align(series.keltner_s.lower)
      }
      if (series.keltner_m) {
        alignedSeries['keltner_m_upper'] = align(series.keltner_m.upper)
        alignedSeries['keltner_m_lower'] = align(series.keltner_m.lower)
      }
      if (series.keltner_l) {
        alignedSeries['keltner_l_upper'] = align(series.keltner_l.upper)
        alignedSeries['keltner_l_lower'] = align(series.keltner_l.lower)
      }
      if (series.atr) {
        alignedSeries['atr_stop'] = align(series.atr.stop_loss)
        alignedSeries['atr_tp'] = align(series.atr.take_profit)
      }
    }

    return { dates, candle, vols, dateIndex, defaultZoom, alignedSeries }
  }, [rows, series, seriesDates])

  // ── TV 同款交互状态 (ref, 高频交互不触发 React 重渲染) ──
  // X 用户窗口 (拖拽/滚轮/双击重置后记录, setOption 重建时恢复); null = 默认 120 根
  const xZoomRef = useRef<{ start: number; end: number } | null>(null)
  // 主图 Y 手动缩放窗口; null = 自动定界 (0-100, 跟随数据)
  const yZoomRef = useRef<{ start: number; end: number } | null>(null)
  const defaultZoomRef = useRef(defaultZoom)
  defaultZoomRef.current = defaultZoom
  const datesRef = useRef<string[]>(dates)
  datesRef.current = dates

  // 换股重置 (工作台 [_symbol] 同款): 标的切换时旧股的 X/Y 用户窗口语义已失效
  // (价格尺度/数据长度不同), 清空回默认 120 根 + Y 自动定界;
  // 同股数据更新 (轮询追加/滑动窗口首日变化) 不重置。
  const prevSymbolRef = useRef(symbol)
  useEffect(() => {
    if (prevSymbolRef.current === symbol) return
    prevSymbolRef.current = symbol
    xZoomRef.current = null
    yZoomRef.current = null
  }, [symbol])

  // 构建 option
  const buildOption = (): EChartsOption => {
    const priceLines = collectPriceLines(levels, activeTypes, pivotRank)

    // 三段布局:主图 / 成交量 / 缩放条,从上到下累加,各段之间留间距,互不遮挡
    //   [16 顶部] [mainH 主图] [8 间距] [volH 成交量] [12 间距] [SLIDER_H 缩放条] [8 底部]
    const SLIDER_H = 22
    const PAD_TOP = 16
    const GAP_MAIN_VOL = 8        // 主图 ↔ 成交量
    const GAP_VOL_SLIDER = 12     // 成交量 ↔ 缩放条(留足,避免遮挡)
    const PAD_BOTTOM = 8
    const volH = VOL_PANE_H
    const mainH = height - PAD_TOP - GAP_MAIN_VOL - volH - GAP_VOL_SLIDER - SLIDER_H - PAD_BOTTOM
    const volTop = PAD_TOP + mainH + GAP_MAIN_VOL
    const sliderBottom = PAD_BOTTOM

    // 预留:markPoint(新闻标记)
    const markPointData: any[] = (markers ?? [])
      .filter(m => dateIndex.has(m.date))
      .map(m => ({
        coord: [m.date, rows[dateIndex.get(m.date)!].high],
        symbol: 'pin', symbolSize: 32,
        itemStyle: { color: m.color ?? '#EAB308' },
        label: { show: !!m.label, formatter: m.label ?? '', fontSize: 9, color: '#fff' },
      }))

    // 预留:markArea(事件区间)
    const markAreaData: any[] = (ranges ?? [])
      .filter(r => dateIndex.has(r.start) && dateIndex.has(r.end))
      .map(r => [{
        xAxis: r.start, name: r.label ?? '',
        itemStyle: { color: r.color ?? 'rgba(234,179,8,0.08)' },
        label: r.label ? { show: true, position: 'insideTop', distance: 6, color: '#EAB308', fontSize: 10 } : undefined,
      }, { xAxis: r.end }])

// TV 同款现价标签: 末根收盘价贴价格轴 (价格轴在左, position 'start' = 横线左端
    // = 左侧轴区, 盖在刻度上), 涨跌色背景白字, 实时行 (is_live) 前缀 ● 徽记 — 盯盘
    // 第一视觉锚点; 右侧带专留给价位线标签不与之争位。
    const lastBar = rows[rows.length - 1]
    const prevBar = rows[rows.length - 2]
    const lastUp = prevBar != null && Number.isFinite(prevBar.close)
      ? lastBar.close >= prevBar.close
      : true
    const liveBadge = lastBar.is_live === true ? '●' : ''
    const liveMarkLine = lastBar != null && Number.isFinite(lastBar.close) ? {
      silent: true,
      symbol: 'none' as const,
      data: [{
        yAxis: lastBar.close,
        lineStyle: { color: lastUp ? THEME.bull : THEME.bear, type: 'dashed' as const, width: 1, opacity: 0.5 },
        label: {
          show: true,
          formatter: `${liveBadge}${lastBar.close.toFixed(2)}`,
          position: 'start' as const,
          color: '#FFFFFF',
          backgroundColor: lastUp ? THEME.bull : THEME.bear,
          borderRadius: 2,
          padding: [2, 5],
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
        },
      }],
      animation: false,
    } : undefined

    const series: any[] = [
      {
        name: 'K', type: 'candlestick', data: candle, animation: false,
        // z=2 让蜡烛始终在价位线(z=1)之上, hover 高亮价位线时不会被遮挡/变淡
        z: 2,
        itemStyle: {
          color: THEME.bull, color0: THEME.bear,
          borderColor: THEME.bull, borderColor0: THEME.bear,
        },
        markPoint: markPointData.length ? { data: markPointData, animation: false } : undefined,
        markArea: markAreaData.length ? { silent: true, data: markAreaData } : undefined,
        markLine: liveMarkLine,
      },
      {
        name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
        data: vols, animation: false,
      },
    ]

    // 价位水平线 —— 用 line series(恒定值)画水平线,endLabel 显示标签文字;
    // 与通道曲线一致,标签落在右侧 grid.right 预留带(外侧),不压蜡烛。
    // hoveredKey 非空时:命中线加粗高亮,其它线淡化(opacity 0.15),形成聚焦效果。
    const dimming = hoveredKey != null
    for (const p of priceLines) {
      const k = levelKey(p.type, p.value)
      const hit = hoveredKey === k
      const opacity = dimming ? (hit ? 1 : 0.12) : 0.7
      const width = hit ? 2 : 1
      series.push({
        name: p.label, type: 'line', silent: false, animation: false,
        symbol: 'none',
        data: dates.map(() => p.value),
        // 默认 z=1 在蜡烛(z=2)之下; 命中时 zlevel=10 提到独立顶层, 标签不再被遮挡
        z: 1,
        zlevel: hit ? 10 : 0,
        lineStyle: { width, color: p.color, type: 'dashed', opacity },
        itemStyle: { color: p.color },
        endLabel: {
          show: true,
          formatter: () => `${p.label} ${p.value.toFixed(2)}`,
          color: p.color, fontSize: hit ? 10 : 9, fontFamily: 'JetBrains Mono, monospace',
          fontWeight: hit ? 'bold' : 'normal',
          backgroundColor: hit ? CT().tooltipBg : CT().infoBarBg,
          borderColor: hit ? p.color : 'transparent',
          borderWidth: hit ? 1 : 0,
          padding: [2, 5], borderRadius: 2,
          distance: 6,
        },
      })
    }

    // 带状曲线指标(布林带 / Keltner通道 / ATR波动通道) —— 跟随行情漂移的曲线
    // 单一数据源 CURVE_DEFS 驱动:每条曲线带 endLabel(右侧端点标签),显示最新数值
    for (const def of CURVE_DEFS) {
      if (!activeTypes.has(def.group)) continue
      const data = alignedSeries[def.alignedKey]
      if (!data || !data.some(v => v != null)) continue
      // 取最后一个有效值作为右侧端点显示文字
      let lastVal: number | null = null
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] != null) { lastVal = data[i]; break }
      }
      // 曲线 key 用 group(同组上下轨联动),hover 命中时高亮
      const hit = hoveredKey === def.group
      const opacity = dimming ? (hit ? 1 : 0.12) : 0.8
      const width = hit ? 1.8 : 1
      series.push({
        name: def.endLabel, type: 'line', data: data.map(v => v ?? '-'),
        smooth: true, symbol: 'none', silent: false, animation: false,
        z: 1,
        zlevel: hit ? 10 : 0,
        lineStyle: { width, color: def.color, type: def.dashed === false ? 'solid' : 'dashed', opacity },
        itemStyle: { color: def.color },
        // 右侧端点标签:显示该通道的最新数值,距绘图区右缘留 6px 间距
        endLabel: lastVal != null ? {
          show: true,
          formatter: () => `${lastVal!.toFixed(2)}`,
          color: def.color, fontSize: hit ? 10 : 9, fontFamily: 'JetBrains Mono, monospace',
          fontWeight: hit ? 'bold' : 'normal',
          backgroundColor: hit ? CT().tooltipBg : CT().infoBarBg,
          borderColor: hit ? def.color : 'transparent',
          borderWidth: hit ? 1 : 0,
          padding: [2, 5], borderRadius: 2,
          distance: 6,
        } : undefined,
      })
    }

    // 填充 seriesIndex → levelKey 映射(K/成交量索引 0/1 不参与联动)
    const keyMap = new Map<number, string>()
    // series[0]=K线, series[1]=成交量, 之后是按 priceLines + CURVE_DEFS 顺序 push 的
    let si = 2
    for (const p of priceLines) {
      keyMap.set(si++, levelKey(p.type, p.value))
    }
    for (const def of CURVE_DEFS) {
      if (!activeTypes.has(def.group)) continue
      const data = alignedSeries[def.alignedKey]
      if (!data || !data.some(v => v != null)) continue
      keyMap.set(si++, def.group)
    }
    seriesKeyMapRef.current = keyMap

    // 窗口: X 优先用户窗口 (xZoomRef, 含双击重置的默认 120 根), 重建后保持;
    // Y 主图手动窗口 (yZoomRef) 或自动定界 0-100。
    const xWin = xZoomRef.current ?? defaultZoom
    const yWin = yZoomRef.current

    return {
      animation: false,
      backgroundColor: 'transparent',
      // grid: 左侧价格刻度带 (标准行情区) + 右侧价位标签带 (价位线 endLabel 文字区)。
      // 价位标签从网格右缘向右约 76px (最长标签「成交密集区(POC) 12.34」), right 144 足够;
      // 价格标尺回左后与价位标签互不干扰, 右带专给价位文字。
      grid: [
        { left: 56, right: 144, top: 16, height: mainH },
        { left: 56, right: 144, top: volTop, height: volH },
      ],
      xAxis: [
        {
          type: 'category', data: dates, boundaryGap: true,
          axisLine: { lineStyle: { color: CT().grid } },
          axisLabel: { color: CT().text, fontSize: 10 },
          splitLine: { show: false },
          // 十字光标时间读数 (label 由 tooltip.axisPointer 统一配置)
          axisPointer: { show: true, label: { show: true } },
        },
        {
          type: 'category', gridIndex: 1, data: dates, boundaryGap: true,
          axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false },
        },
      ],
      yAxis: [
        // 价格标尺回左 (标准行情区; 右侧专让价位标签带), 与价位线文字互不干扰。
        // axisPointer: 十字光标悬停时在轴区显示光标所在价格读数。
        { scale: true, axisLabel: { color: CT().text, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
          axisPointer: { show: true, label: { show: true } },
          splitLine: { lineStyle: { color: CT().grid } } },
        { scale: true, gridIndex: 1, splitNumber: 2,
          // 成交量区不画背景横线
          splitLine: { show: false },
          axisLabel: { color: CT().text, fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                       formatter: (v: number) => fmtVol(v) } },
      ],
      // 窗口: X 优先用户窗口 (xZoomRef, 含双击重置的默认 120 根), 重建后保持;
      // Y 主图手动窗口 (yZoomRef) 或自动定界 0-100。
      // dataZoom 结构: [0]=X inside, [1]=X slider, [2]=主图 Y inside (自研窗口控制)。
      dataZoom: [
        // X 拖拽平移由 zr 自研 (水平=动 X, 垂直=动主图 Y 互不干扰): 内置 moveOnMouseMove
        // 不区分方向, 垂直拖会同时平移 X → 可见数据范围每帧变化 → 价位线/蜡烛被推挤出
        // 视野 (与工作台同款修复)。滚轮 X 缩放保留 (zoomOnMouseWheel)。
        { type: 'inside', xAxisIndex: [0, 1], start: xWin.start, end: xWin.end, moveOnMouseMove: false, zoomOnMouseWheel: true },
        { type: 'slider', xAxisIndex: [0, 1], bottom: sliderBottom, height: SLIDER_H, start: xWin.start, end: xWin.end,
          borderColor: 'transparent', fillerColor: CT().zoomFill,
          handleStyle: { color: '#52525B' }, textStyle: { color: CT().text, fontSize: 10 } },
        { type: 'inside', yAxisIndex: 0, start: yWin ? yWin.start : 0, end: yWin ? yWin.end : 100,
          moveOnMouseMove: false, zoomOnMouseWheel: false },
      ],
      // 不弹 hover tooltip(用户要求);但保留十字光标 axisPointer 作为缩放/定位参照。
      // 轴读数 label 与工作台同款 (时间+价格, 悬停显示) — 行情图表的基础交互。
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'transparent',
        borderWidth: 0,
        textStyle: { fontSize: 0 },
        formatter: () => '',
        axisPointer: {
          type: 'cross',
          label: {
            show: true,
            backgroundColor: CT().tooltipBg,
            borderColor: CT().tooltipBorder,
            borderWidth: 1,
            padding: [2, 5],
            color: CT().tooltipText,
            fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
          },
          crossStyle: { color: CT().crosshair, type: 'dashed', width: 1 },
          lineStyle: { color: CT().crosshair, type: 'dashed', width: 1 },
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      series,
    }
  }

  // 初始化 + 数据更新
  useEffect(() => {
    if (!chartRef.current) return
    if (!chartInstRef.current) {
      chartInstRef.current = echarts.init(chartRef.current, undefined, { renderer: 'canvas' })
      chartInstRef.current.on('click', (params: any) => {
        // 预留:点击 K 线(非 markPoint/markLine)回调
        if (params.componentType === 'series' && params.seriesType === 'candlestick' && onDateClick) {
          onDateClick(dates[params.dataIndex])
        }
      })
      // hover 价位线/曲线 endLabel → 联动高亮(与下方文字行双向联动)
      chartInstRef.current.on('mouseover', (params: any) => {
        if (params.componentType === 'series') {
          const k = seriesKeyMapRef.current.get(params.seriesIndex as number)
          if (k) setHoveredKey(k)
        }
      })
      chartInstRef.current.on('globalout', () => setHoveredKey(null))

      // ── TV 同款交互: 主图 Y 缩放/双轴平移 + 双击重置 (工作台同款, 精简单主图版) ──
      const chart = chartInstRef.current
      const gridRectAt = (g: number) => {
        const comp = (chart as any).getModel().getComponent('grid', g)
        return comp?.coordinateSystem?.getRect() as { x: number; y: number; width: number; height: number } | undefined
      }
      /** 鼠标在哪个 grid 内; -1 = 不在 (主图 0 / 成交量 1)。 */
      const locateGrid = (px: number, py: number): number => {
        for (let g = 0; g < 2; g++) {
          const r = gridRectAt(g)
          if (r && px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) return g
        }
        return -1
      }
      /** 鼠标是否在主图左侧价格刻度带 (价格轴在左, TV 同款: 左缘滚轮/拖拽缩放 Y)。
       *  右侧价位标签带不参与缩放, 避免误触价位文字。 */
      const inPriceAxis = (px: number, py: number): boolean => {
        const r = gridRectAt(0)
        if (!r) return false
        if (py < r.y || py > r.y + r.height) return false
        return px < r.x - 2 && px >= r.x - 62
      }
      /** 主图 Y 窗口缩放 (anchorRatio: 0=底 1=顶; factor>1 = 收窄 = 放大)。 */
      const scaleMainY = (anchorRatio: number, factor: number) => {
        const opt = chart.getOption() as any
        const yz = opt?.dataZoom?.[2]
        if (!yz) return
        const s = yz.start ?? 0
        const e = yz.end ?? 100
        const w0 = e - s
        const w = Math.max(Math.min(w0 / factor, 100), 0.5)
        const c = s + anchorRatio * w0
        let sN = c - (c - s) / factor
        let eN = sN + w
        if (sN < 0) { sN = 0; eN = w }
        if (eN > 100) { eN = 100; sN = Math.max(0, 100 - w) }
        yZoomRef.current = { start: sN, end: eN }
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 2, start: sN, end: eN })
      }
      // 滚轮: 价格轴区上滚放大/下滚缩小 (与拖拽向上=放大同语义)
      const handleYWheel = (ev: any) => {
        if (!inPriceAxis(ev.offsetX, ev.offsetY)) return
        ev.preventDefault?.()
        const r = gridRectAt(0)
        if (!r) return
        const anchor = 1 - (ev.offsetY - r.y) / r.height
        const delta = Number(ev.wheelDelta ?? ev.zrDelta ?? 0)
        if (!Number.isFinite(delta) || delta === 0) return
        scaleMainY(anchor, Math.exp(delta * 0.15))
      }
      // 按住拖拽 — 双模式: 价格轴带内 = 缩放 Y; 图区内 = 双轴平移
      // pan: 水平分量只动 X, 垂直分量只动主图 Y (已手动缩放时) — 互不干扰,
      // 垂直拖不会把可见数据带推跑 (K 线不再"拖一拖消失再显示")。
      type Drag =
        | { mode: 'scale'; y0: number; ry: number; h: number; s0: number; e0: number }
        | { mode: 'pan'; hasY: boolean; x0: number; y0: number; gw: number; gh: number; s0X: number; e0X: number; s0Y: number; e0Y: number }
      let drag: Drag | null = null
      const handleZrMouseDown = (ev: { offsetX: number; offsetY: number }) => {
        if (inPriceAxis(ev.offsetX, ev.offsetY)) {
          const opt = chart.getOption() as any
          const yz = opt?.dataZoom?.[2]
          const r = gridRectAt(0)
          if (!yz || !r) return
          drag = { mode: 'scale', y0: ev.offsetY, ry: r.y, h: r.height, s0: yz.start ?? 0, e0: yz.end ?? 100 }
          return
        }
        const g = locateGrid(ev.offsetX, ev.offsetY)
        if (g < 0) return
        const r = gridRectAt(g)
        if (!r) return
        const opt = chart.getOption() as any
        const xz = opt?.dataZoom?.[0]
        if (!xz) return
        const yz = yZoomRef.current
        drag = {
          mode: 'pan', hasY: g === 0 && !!yz,
          x0: ev.offsetX, y0: ev.offsetY, gw: r.width, gh: r.height,
          s0X: xz.start ?? 0, e0X: xz.end ?? 100,
          s0Y: yz ? yz.start : 0, e0Y: yz ? yz.end : 100,
        }
      }
      const handleZrMouseMove = (ev: { offsetX: number; offsetY: number }) => {
        if (!drag) return
        if (drag.mode === 'scale') {
          const dy = ev.offsetY - drag.y0
          if (dy === 0) return
          const w0 = drag.e0 - drag.s0
          const factor = Math.pow(2, -dy / drag.h)
          const w = Math.max(Math.min(w0 / factor, 100), 0.5)
          const c = drag.s0 + (1 - (drag.y0 - drag.ry) / drag.h) * w0
          let sN = c - (c - drag.s0) / factor
          let eN = sN + w
          if (sN < 0) { sN = 0; eN = w }
          if (eN > 100) { eN = 100; sN = Math.max(0, 100 - w) }
          yZoomRef.current = { start: sN, end: eN }
          chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 2, start: sN, end: eN })
          return
        }
        // pan: 水平 → X 平移 (内容跟随手指: 左拖看更晚数据); 垂直 → 主图 Y 平移
        const dx = ev.offsetX - drag.x0
        const dy = ev.offsetY - drag.y0
        if (dx !== 0) {
          const w = drag.e0X - drag.s0X
          const d = (dx / drag.gw) * w
          const sN = Math.max(0, Math.min(100 - w, drag.s0X - d))
          xZoomRef.current = { start: sN, end: sN + w }
          chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: sN, end: sN + w })
          chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: sN, end: sN + w })
        }
        if (dy !== 0 && drag.hasY) {
          const w = drag.e0Y - drag.s0Y
          const d = (dy / drag.gh) * w
          const sN = Math.max(0, Math.min(100 - w, drag.s0Y + d))
          yZoomRef.current = { start: sN, end: sN + w }
          chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 2, start: sN, end: sN + w })
        }
      }
      const handleZrDragEnd = () => { drag = null }
      // 双击重置 (TV 同款): X 回默认 120 根窗口 + 主图 Y 回自动定界
      const handleDblClick = () => {
        const z = defaultZoomRef.current
        xZoomRef.current = { start: z.start, end: z.end }
        yZoomRef.current = null
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: z.start, end: z.end })
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: z.start, end: z.end })
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 2, start: 0, end: 100 })
      }
      // X slider (dataZoom[1]) 与 inside (dataZoom[0]) 窗口同步 + 用户窗口入账:
      // ① inside 滚轮缩放/自研拖拽只动 0, slider 手柄会脱节 → 事件里互相补齐, 防递归;
      // ② 同步把最新窗口记入 xZoomRef — hover 价位线等触发 setOption 全量重建时
      //    buildOption 用 xZoomRef 恢复窗口, 不入账会把用户刚滚轮缩放的窗口弹回旧值
      //    (EChartsCandlestick 的 dataZoom→userZoomRef 同款机制)。
      // 注意: 内置滚轮缩放触发的事件 params 为空对象 (不带 dataZoomIndex) —
      // 从 getOption() 读实际窗口而非依赖 params; Y 组件 (index 2) 的事件跳过。
      let zoomSyncing = false
      chart.on('dataZoom', (params: any) => {
        if (zoomSyncing) return
        const idx = params?.dataZoomIndex
        if (idx === 2) return // Y 组件事件: X 窗口无关
        const opt = chart.getOption() as any
        // slider 手柄拖拽 (idx=1) 只动了 slider → 从 1 读; 其余 (内置滚轮空 params /
        // 自研拖拽/程序 dispatch 到 0) 从 0 读 (inside 与 slider 双写, 二者一致)
        const z = idx === 1 ? opt?.dataZoom?.[1] : opt?.dataZoom?.[0]
        if (!z) return
        xZoomRef.current = { start: z.start, end: z.end }
        // 与另一个 X 组件同步 (窗口已一致时跳过, 防递归)
        const otherIdx = idx === 1 ? 0 : 1
        const zs = opt?.dataZoom?.[otherIdx]
        if (zs && (Math.abs(zs.start - z.start) > 0.01 || Math.abs(zs.end - z.end) > 0.01)) {
          zoomSyncing = true
          chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: otherIdx, start: z.start, end: z.end })
          zoomSyncing = false
        }
      })
      const zr = chart.getZr()
      zr.on('mousewheel', handleYWheel)
      zr.on('mousedown', handleZrMouseDown)
      zr.on('mousemove', handleZrMouseMove)
      zr.on('mouseup', handleZrDragEnd)
      zr.on('globalout', handleZrDragEnd)
      zr.on('dblclick', handleDblClick)
    }
    chartInstRef.current.setOption(buildOption(), true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, levels, series, seriesDates, activeTypes, pivotRank, markers, ranges, height, theme, hoveredKey])

  // resize
  useEffect(() => {
    const inst = chartInstRef.current
    if (!inst) return
    const onResize = () => inst.resize()
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); inst.dispose(); chartInstRef.current = null }
  }, [])

  const toggleType = (t: LevelType) => {
    setActiveTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  return (
    <div className={className}>
      {/* 价位开关按钮组 */}
      {levels && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <span className="text-[10px] text-muted mr-1">关键价位</span>
          {LEVEL_GROUPS.map(g => {
            const active = activeTypes.has(g.key)
            // 枢轴点数量按当前档位过滤显示;其他组显示原始数量
            const raw = levels[g.key] ?? []
            const count = g.key === 'pivot'
              ? raw.filter(p => p.rank === undefined || p.rank <= pivotRank).length
              : raw.length
            return (
              <button
                key={g.key}
                onClick={() => toggleType(g.key)}
                disabled={raw.length === 0}
                title={`${g.label} (${count} 个)`}
                className={`inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10px] font-medium border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                  active
                    ? 'text-foreground'
                    : 'text-muted bg-base/40 border-border/30 hover:border-border/60'
                }`}
                style={active ? { borderColor: g.color + '66', backgroundColor: g.color + '1a' } : undefined}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? g.color : '#52525B' }} />
                {g.label}
                <span className="opacity-50">{count}</span>
              </button>
            )
          })}

          {/* 枢轴点档位选择器 —— 仅当枢轴点开启时显示 */}
          {activeTypes.has('pivot') && (levels.pivot?.length ?? 0) > 0 && (
            <div className="inline-flex items-center gap-0.5 ml-1 pl-2 border-l border-border/40">
              <span className="text-[10px] text-muted mr-1">档位</span>
              {([1, 2, 3] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setPivotRank(r)}
                  title={r === 1 ? 'P + R1/S1(3 个)' : r === 2 ? '到 R2/S2(5 个)' : '全档 R3/S3(7 个)'}
                  className={`h-6 px-2 rounded-md text-[10px] font-mono border transition-all ${
                    pivotRank === r
                      ? 'bg-[#8B5CF6]/15 border-[#8B5CF6]/40 text-[#c4b5fd]'
                      : 'text-muted bg-base/40 border-border/30 hover:border-border/60'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* 图表:右侧预留带(grid.right 预留)显示价位标签文字,不压蜡烛 */}
      <div ref={chartRef} style={{ width: '100%', height }} />

      {/* 价位统计面板:把当前开启的点位按"压力 / 支撑"结构化列出 */}
      {levels && (
        <LevelOverview
          levels={levels}
          activeTypes={activeTypes}
          pivotRank={pivotRank}
          close={rows.length ? rows[rows.length - 1].close : undefined}
          hoveredKey={hoveredKey}
          onHover={setHoveredKey}
        />
      )}
    </div>
  )
}

// ===== 价位统计面板(图表下方,结构化文本展示) =====
function LevelOverview({
  levels, activeTypes, pivotRank, close, hoveredKey, onHover,
}: {
  levels: Record<LevelType, PriceLevel[]>
  activeTypes: Set<LevelType>
  pivotRank: 1 | 2 | 3
  close?: number
  hoveredKey: string | null
  onHover: (k: string | null) => void
}) {
  // 收集当前显示的点位(同 collectPriceLines 的过滤逻辑)
  const visible: PriceLevel[] = []
  for (const g of LEVEL_GROUPS) {
    if (!activeTypes.has(g.key)) continue
    for (const p of levels[g.key] ?? []) {
      if (p.type === 'pivot' && p.rank !== undefined && p.rank > pivotRank) continue
      visible.push(p)
    }
  }
  if (visible.length === 0) return null

  // 按方向分两组:压力位(在当前价之上) / 支撑位(之下),各自按距当前价远近排序
  const cur = close ?? visible[0].value
  const resistances = visible
    .filter(p => p.side === 'resistance')
    .sort((a, b) => a.value - b.value)        // 由近及远(低→高)
  const supports = visible
    .filter(p => p.side === 'support')
    .sort((a, b) => b.value - a.value)         // 由近及远(高→低)
  const neutrals = visible.filter(p => p.side === 'neutral')

  const fmtPct = (v: number) => {
    if (!cur) return ''
    const pct = ((v - cur) / cur) * 100
    const sign = pct >= 0 ? '+' : ''
    return `${sign}${pct.toFixed(1)}%`
  }

  const Row = ({ p }: { p: PriceLevel }) => {
    const color = LEVEL_GROUPS.find(g => g.key === p.type)?.color ?? CT().text
    const k = levelKey(p.type, p.value)
    const hit = hoveredKey === k
    const dim = hoveredKey != null && !hit
    return (
      <div
        onMouseEnter={() => onHover(k)}
        onMouseLeave={() => onHover(null)}
        className={`flex items-center gap-2 py-0.5 px-1.5 -mx-1.5 rounded transition-colors cursor-default ${
          hit ? 'bg-elevated/60' : ''
        }`}
        style={dim ? { opacity: 0.35 } : undefined}
      >
        <span className="h-1.5 w-1.5 rounded-full shrink-0 transition-transform" style={{ backgroundColor: color, transform: hit ? 'scale(1.5)' : 'scale(1)' }} />
        <span className={`text-[11px] w-24 shrink-0 truncate ${hit ? 'text-foreground font-medium' : 'text-secondary'}`}>{p.label}</span>
        <span className={`text-[11px] font-mono ${hit ? 'text-foreground font-bold' : 'text-foreground'}`}>{p.value.toFixed(2)}</span>
        <span className="text-[9px] font-mono text-muted">{fmtPct(p.value)}</span>
      </div>
    )
  }

  return (
    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border/40 bg-base/20 px-3 py-2">
      {/* 当前价 */}
      <div className="sm:col-span-2 flex items-center gap-2 pb-1 border-b border-border/30 mb-0.5">
        <span className="text-[10px] text-muted">当前价</span>
        <span className="text-xs font-mono font-medium text-foreground">{cur.toFixed(2)}</span>
      </div>
      {/* 压力位(从近到远,即从低到高)倒序展示:最高的在最上 */}
      {resistances.length > 0 && (
        <div>
          <div className="text-[10px] font-medium text-bear mb-0.5">压力位 ↑</div>
          {[...resistances].reverse().map((p, i) => <Row key={`r-${i}`} p={p} />)}
        </div>
      )}
      {/* 支撑位 + 中性(枢轴位 P) */}
      <div>
        {supports.length > 0 && (
          <>
            <div className="text-[10px] font-medium text-bull mb-0.5">支撑位 ↓</div>
            {supports.map((p, i) => <Row key={`s-${i}`} p={p} />)}
          </>
        )}
        {neutrals.length > 0 && (
          <div className={supports.length > 0 ? 'mt-2' : ''}>
            {supports.length === 0 && <div className="text-[10px] font-medium text-muted mb-0.5">枢轴位</div>}
            {neutrals.map((p, i) => <Row key={`n-${i}`} p={p} />)}
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 工具:收集要画的水平价位线(按开启的组 + 档位 + 强度配色) =====
// 注意:带状指标(布林带/Keltner/ATR)改用曲线渲染,不在此画水平线,避免重复。
function collectPriceLines(
  levels: Record<LevelType, PriceLevel[]> | undefined,
  active: Set<LevelType>,
  pivotRank: 1 | 2 | 3,
): { value: number; label: string; color: string; type: string }[] {
  if (!levels) return []
  const out: { value: number; label: string; color: string; type: string }[] = []
  for (const g of LEVEL_GROUPS) {
    if (!active.has(g.key)) continue
    for (const p of levels[g.key] ?? []) {
      // 枢轴点:按档位过滤(rank>P 的,只显示到选定的档位)
      if (p.type === 'pivot' && p.rank !== undefined && p.rank > pivotRank) continue
      // 波动通道类(boll / keltner三档 / atr_stop)整组走曲线渲染,不画水平线;
      // sr 组现为成交密集区水平点,直接画线即可,无需特判。
      if (p.type === 'boll' || p.type === 'keltner_s' || p.type === 'keltner_m'
          || p.type === 'keltner_l' || p.type === 'atr_stop') continue
      out.push({ value: p.value, label: p.label, color: strengthColor(p.strength, g.color), type: p.type })
    }
  }
  return out
}

function strengthColor(strength: string | undefined, base: string): string {
  // strong 用实色,medium 用 0.85,weak 用 0.55 透明
  if (strength === 'weak') return base + '8C'
  if (strength === 'medium') return base + 'D9'
  return base
}

/** 价位唯一标识: 同类型同价格视为同一点位(用于联动高亮)。 */
function levelKey(type: string, value: number): string {
  return `${type}-${value.toFixed(2)}`
}

function fmtVol(v: number): string {
  if (!v) return '0'
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '万'
  return v.toFixed(0)
}
