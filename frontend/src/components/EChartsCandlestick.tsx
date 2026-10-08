import { useEffect, useRef, useCallback, useMemo } from 'react'
import { chartTheme, getTheme, useTheme } from '@/lib/theme'
import { fmtPct } from '@/lib/format'
import * as echarts from 'echarts'
import type { ECharts, EChartsOption } from 'echarts'
import { drawingsToMarks, type DrawingObject } from '@/chart/drawings'

export interface OHLC {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
  ma5?: number | null
  ma10?: number | null
  ma20?: number | null
  ma60?: number | null
  macd_dif?: number | null
  macd_dea?: number | null
  macd_hist?: number | null
  rsi_6?: number | null
  rsi_14?: number | null
  rsi_24?: number | null
  kdj_k?: number | null
  kdj_d?: number | null
  kdj_j?: number | null
  boll_upper?: number | null
  boll_lower?: number | null
  obv?: number | null
  cci?: number | null
  /** 后端注入的当日实时行标记 (日K); 现价标签用它显示实时徽记 */
  is_live?: boolean
}

export interface ChartMarker {
  date: string
  kind: 'buy' | 'sell' | 'neutral'
  label?: string
  /** 若为 true，标记放在蜡烛上方（如涨停连板标签）。 */
  above?: boolean
  /** 自定义标签颜色，覆盖默认的 kind 对应色。 */
  color?: string
}

export interface ChartRange {
  start: string
  end: string
  label?: string
  color?: string
}

export interface ChartPriceLine {
  value: number
  label?: string
  color?: string
  start?: string
  end?: string
}

export interface StockInfo {
  name?: string
  total_shares?: number
  float_shares?: number
  /** 扩展数据（key: configId__fieldName），来自 klineDaily 的 ext_columns */
  ext?: Record<string, unknown>
}

export interface VolumeCompareConfig {
  enabled: boolean
  days: number
}

interface SubChartContext {
  compact: boolean
  volumeCompare: VolumeCompareConfig
  rsiZeroAxis: boolean
}

/** 子图定义 */
export interface SubChartDef {
  key: string
  label: string
  /** 子图固定高度 px */
  height: number
  /** 构建 series 数组 */
  buildSeries: (data: OHLC[], context: SubChartContext) => any[]
  /** 构建信息栏文字 (当前数据行 -> 显示内容) */
  buildInfo: (d: OHLC | null) => { label: string; color: string; value: string }[]
  /** Y 轴特殊配置 */
  yAxisConfig?: Record<string, any>
}

// ===== 成交量 N 日均量 =====
function volMaN(data: OHLC[], n: number): (number | null)[] {
  const result: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < n - 1) { result.push(null); continue }
    let sum = 0
    for (let j = i - n + 1; j <= i; j++) sum += data[j].volume ?? 0
    result.push(sum / n)
  }
  return result
}

function fmtVol(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '万'
  return v.toFixed(0)
}

function volumeRatioAt(data: OHLC[], index: number, days: number): number | null {
  const window = Math.max(1, Math.min(20, Math.round(days)))
  if (index < window) return null
  let sum = 0
  for (let offset = 1; offset <= window; offset++) {
    const volume = data[index - offset]?.volume
    if (volume == null || !Number.isFinite(volume)) return null
    sum += volume
  }
  const average = sum / window
  const current = data[index]?.volume
  if (current == null || !Number.isFinite(current) || average <= 0) return null
  return current / average
}

function fmtVolumeRatio(value: number | null, digits = 2): string {
  return value == null ? '—' : `${value.toFixed(digits)}x`
}

export const SUB_CHARTS: SubChartDef[] = [
  {
    key: 'vol',
    label: '成交量',
    height: 84,
    yAxisConfig: { min: 0 },
    buildSeries: (data, context) => {
      const ma5Data = volMaN(data, 5)
      const ma10Data = volMaN(data, 10)
      const compareDays = context.volumeCompare.days
      return [
        {
          name: '成交量',
          type: 'bar',
          data: data.map((d, index) => {
            const ratio = volumeRatioAt(data, index, compareDays)
            return {
              value: d.volume ?? 0,
              volumeRatioLabel: ratio == null ? '' : fmtVolumeRatio(ratio, 1),
              itemStyle: {
                color: d.close >= d.open ? 'rgba(240,68,56,0.6)' : 'rgba(18,183,106,0.6)',
              },
            }
          }),
          barWidth: '60%',
          label: {
            show: context.volumeCompare.enabled && !context.compact,
            position: 'top',
            distance: 2,
            color: CT().text,
            fontSize: 8,
            fontFamily: 'JetBrains Mono, monospace',
            formatter: (params: any) => params.data?.volumeRatioLabel ?? '',
          },
          labelLayout: { hideOverlap: true },
          animation: false,
        },
        {
          name: 'VOL5',
          type: 'line',
          data: ma5Data,
          smooth: true, symbol: 'none', animation: false,
          lineStyle: { width: 1, color: '#FACC15' },
          itemStyle: { color: '#FACC15' },
        },
        {
          name: 'VOL10',
          type: 'line',
          data: ma10Data,
          smooth: true, symbol: 'none', animation: false,
          lineStyle: { width: 1, color: '#8B5CF6' },
          itemStyle: { color: '#8B5CF6' },
        },
      ]
    },
    buildInfo: (d) => {
      if (!d) return []
      return [
        { label: '量', color: d.close >= d.open ? '#C74040' : '#2D9B65', value: fmtVol(d.volume) },
      ]
    },
  },
  {
    key: 'macd',
    label: 'MACD',
    height: 72,
    buildSeries: (data) => [
      {
        name: 'DIF',
        type: 'line',
        data: data.map(d => d.macd_dif != null ? Number(d.macd_dif) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#FACC15' },
        itemStyle: { color: '#FACC15' },
      },
      {
        name: 'DEA',
        type: 'line',
        data: data.map(d => d.macd_dea != null ? Number(d.macd_dea) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#8B5CF6' },
        itemStyle: { color: '#8B5CF6' },
      },
      {
        name: 'MACD',
        type: 'bar',
        data: data.map(d => {
          const v = d.macd_hist
          if (v == null) return '-'
          return {
            value: Number(v),
            itemStyle: { color: Number(v) >= 0 ? 'rgba(240,68,56,0.6)' : 'rgba(18,183,106,0.6)' },
          }
        }),
        barWidth: '40%',
        animation: false,
      },
    ],
    buildInfo: (d) => {
      if (!d) return []
      return [
        { label: 'DIF', color: '#FACC15', value: d.macd_dif != null ? d.macd_dif.toFixed(3) : '—' },
        { label: 'DEA', color: '#8B5CF6', value: d.macd_dea != null ? d.macd_dea.toFixed(3) : '—' },
        { label: 'MACD', color: d.macd_hist != null && d.macd_hist >= 0 ? '#C74040' : '#2D9B65', value: d.macd_hist != null ? d.macd_hist.toFixed(3) : '—' },
      ]
    },
  },
  {
    key: 'rsi',
    label: 'RSI',
    height: 72,
    yAxisConfig: { min: 0, max: 100 },
    buildSeries: (data, context) => {
      // 零轴震荡形态: RSI-50 映射到 ±50 (lc-chart 副图同款观感); 信息栏仍显示原始 RSI
      const shift = context.rsiZeroAxis ? 50 : 0
      const rsiLine = (key: 'rsi_6' | 'rsi_14' | 'rsi_24', color: string, name: string) => ({
        name, type: 'line',
        data: data.map(d => d[key] != null ? Number(d[key]) - shift : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color },
        itemStyle: { color },
      })
      return [
        rsiLine('rsi_6', '#FACC15', 'RSI6'),
        rsiLine('rsi_14', '#3B82F6', 'RSI14'),
        rsiLine('rsi_24', '#8B5CF6', 'RSI24'),
      ]
    },
    buildInfo: (d) => {
      if (!d) return []
      return [
        { label: 'RSI6', color: '#FACC15', value: d.rsi_6 != null ? d.rsi_6.toFixed(1) : '—' },
        { label: 'RSI14', color: '#3B82F6', value: d.rsi_14 != null ? d.rsi_14.toFixed(1) : '—' },
        { label: 'RSI24', color: '#8B5CF6', value: d.rsi_24 != null ? d.rsi_24.toFixed(1) : '—' },
      ]
    },
  },
  {
    key: 'kdj',
    label: 'KDJ',
    height: 72,
    buildSeries: (data) => [
      {
        name: 'K',
        type: 'line',
        data: data.map(d => d.kdj_k != null ? Number(d.kdj_k) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#FACC15' },
        itemStyle: { color: '#FACC15' },
      },
      {
        name: 'D',
        type: 'line',
        data: data.map(d => d.kdj_d != null ? Number(d.kdj_d) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#3B82F6' },
        itemStyle: { color: '#3B82F6' },
      },
      {
        name: 'J',
        type: 'line',
        data: data.map(d => d.kdj_j != null ? Number(d.kdj_j) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#8B5CF6' },
        itemStyle: { color: '#8B5CF6' },
      },
    ],
    buildInfo: (d) => {
      if (!d) return []
      return [
        { label: 'K', color: '#FACC15', value: d.kdj_k != null ? d.kdj_k.toFixed(1) : '—' },
        { label: 'D', color: '#3B82F6', value: d.kdj_d != null ? d.kdj_d.toFixed(1) : '—' },
        { label: 'J', color: '#8B5CF6', value: d.kdj_j != null ? d.kdj_j.toFixed(1) : '—' },
      ]
    },
  },
  {
    key: 'obv',
    label: 'OBV',
    height: 72,
    buildSeries: (data) => [
      {
        name: 'OBV',
        type: 'line',
        data: data.map(d => d.obv != null ? Number(d.obv) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#F97316' },
        itemStyle: { color: '#F97316' },
      },
    ],
    buildInfo: (d) => {
      if (!d) return []
      return [
        { label: 'OBV', color: '#F97316', value: d.obv != null ? fmtVol(d.obv) : '—' },
      ]
    },
  },
  {
    key: 'cci',
    label: 'CCI',
    height: 72,
    buildSeries: (data) => [
      {
        name: 'CCI',
        type: 'line',
        data: data.map(d => d.cci != null ? Number(d.cci) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 1, color: '#06B6D4' },
        itemStyle: { color: '#06B6D4' },
        markLine: {
          silent: true, symbol: 'none', animation: false,
          lineStyle: { color: CT().grid, type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ yAxis: 100 }, { yAxis: -100 }],
        },
      },
    ],
    buildInfo: (d) => {
      if (!d) return []
      return [
        { label: 'CCI', color: '#06B6D4', value: d.cci != null ? d.cci.toFixed(1) : '—' },
      ]
    },
  },
]

/** 向后兼容的 INDICATORS 导出 (不含 vol) */
export const INDICATORS = SUB_CHARTS.filter(s => s.key !== 'vol')

/** 主图叠加指标 (画在 K 线上方, 不占副图空间) */
export const OVERLAY_INDICATORS: { key: string; label: string }[] = [
  { key: 'boll', label: 'BOLL' },
]

interface Props {
  data: OHLC[]
  markers?: ChartMarker[]
  ranges?: ChartRange[]
  priceLines?: ChartPriceLine[]
  height?: number
  showMA?: boolean
  showInfoBar?: boolean
  showMarkers?: boolean
  onToggleMarkers?: () => void
  stockInfo?: StockInfo
  symbol?: string
  linkedPrice?: number | null
  onDateClick?: (date: string) => void
  onPriceDoubleClick?: (price: number, currentPrice: number) => void
  /** 默认可见蜡烛根数, 默认 60; 'all' = 初始适配显示全部返回数据 */
  visibleBars?: number | 'all'
  /** 已激活的子图 key 列表 (含 vol, 按点击顺序) */
  activeIndicators?: string[]
  /** 成交量柱相对前 N 个交易日均量的显示设置 */
  volumeCompare?: VolumeCompareConfig
  /** 加入自选日 (北京时间 YYYY-MM-DD); 有值且落在当前区间内时, 主图画一条「自选」竖虚线 */
  addedDate?: string | null
  /** 图表实例就绪/销毁回调 (图表工作台联动层、绘图层取实例用); 销毁时回传 null */
  chartReady?: (chart: ECharts | null) => void
  /** K 线样式: candle 蜡烛(默认) / hollow 空心 / line 收盘折线 / area 收盘面积 */
  chartStyle?: 'candle' | 'hollow' | 'line' | 'area'
  /** RSI 副图零轴震荡形态 (RSI-50, 显示范围 ±50); 默认 0-100 */
  rsiZeroAxis?: boolean
  /** 外部绘图层 (图表工作台): 趋势线/水平线/斐波/矩形, 数据坐标锚定自动重定位 */
  externalDrawings?: DrawingObject[]
  /** 图区内按住拖拽平移 Y 窗口 (Y 已手动缩放时生效); 绘图模式下应传 false 让位给画线 */
  panEnabled?: boolean
  /** 双击重置信号 (图表工作台): 值变化时执行 TV 同款重置 (60 根最佳窗口 + 全部 grid Y 归位) */
  resetSignal?: number
  /** 双击重置请求回调 (图表工作台): 存在时双击只上报、由 resetSignal 统一驱动重置;
   *  缺省时保持本地双击自重置 (个股分析页等无协调层的调用方不受影响) */
  onResetZoom?: () => void
  /** 「往左加载更多」请求回调: 数据是完整序列 (更早数据拼在前面), 视野停留在原日期段;
   *  图表拖到 X 最左边界 (dataZoom.start ≤ 0) 时触发, 由调用方判断是否有更多历史 */
  onLoadMoreLeft?: () => void
}

// 序列颜色 (双主题通用); 画布轴/网格/文字等主题相关色走 CT() 动态取
const THEME = {
  bull: '#C74040',
  bear: '#2D9B65',
  bullAlpha: 'rgba(240,68,56,0.7)',
  bearAlpha: 'rgba(18,183,106,0.7)',
  ma5: '#A1A1AA',
  ma10: '#3B82F6',
  ma20: '#F97316',
  ma60: '#8B5CF6',
  bg: 'transparent',
}

/** 当前主题的图表调色板 (buildOption/信息栏在渲染时调用; 主题切换由组件 effect 触发重建)。 */
const CT = () => chartTheme(getTheme())

/** 可见蜡烛超过此数量时，涨停/炸板标签切换为小圆点。 */
const COMPACT_THRESHOLD = 60

/** 加入自选日竖线颜色 (蓝色虚线, 与同花顺的标注观感一致) */
const ADDED_DATE_COLOR = '#3B82F6'

/** 子图上方信息栏高度 (px) */
const INFO_BAR_H = 16
/** 子图之间的间距 (px) */
const SUB_GAP_PX = 4

function buildSubInfoGraphics(
  data: OHLC[],
  infoIdx: number,
  activeIndicators: string[],
  subStartTop: number,
  volumeCompare: VolumeCompareConfig,
): any[] {
  const d = infoIdx >= 0 && infoIdx < data.length ? data[infoIdx] : null
  const graphics: any[] = []
  let curTop = subStartTop

  activeIndicators.forEach((key) => {
    const def = SUB_CHARTS.find(s => s.key === key)
    if (!def) return

    const items = def.buildInfo(d)
    if (def.key === 'vol' && d) {
      const calcVolMa = (n: number) => {
        if (infoIdx < n - 1) return null
        let sum = 0
        for (let j = infoIdx - n + 1; j <= infoIdx; j++) sum += data[j].volume ?? 0
        return sum / n
      }
      const vol5 = calcVolMa(5)
      const vol10 = calcVolMa(10)
      items.push({ label: 'VOL5', color: '#FACC15', value: fmtVol(vol5) })
      items.push({ label: 'VOL10', color: '#8B5CF6', value: fmtVol(vol10) })
      if (volumeCompare.enabled) {
        const ratio = volumeRatioAt(data, infoIdx, volumeCompare.days)
        items.push({
          label: `量比${volumeCompare.days}`,
          color: ratio != null && ratio >= 1 ? '#C74040' : '#2D9B65',
          value: fmtVolumeRatio(ratio),
        })
      }
    }

    // 每个元素加固定 id，确保 ECharts 增量更新时能正确匹配
    graphics.push({
      id: `sub-sep-${key}`,
      type: 'line',
      shape: { x1: 0, y1: curTop, x2: 2000, y2: curTop },
      style: { stroke: 'rgba(255,255,255,0.08)', lineWidth: 1 },
      silent: true, z: 0,
    })
    graphics.push({
      id: `sub-label-${key}`,
      type: 'text',
      style: {
        text: def.label,
        x: 4, y: curTop + 4,
        fill: '#8E8E96',
        fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
        fontWeight: 'bold',
      },
      silent: true, z: 10,
    })

    const richTextParts: string[] = []
    const rich: Record<string, any> = {}
    items.forEach((item, idx) => {
      const styleKey = `s${idx}`
      richTextParts.push(`{${styleKey}|${item.label}:${item.value}}`)
      rich[styleKey] = {
        fill: item.color,
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
      }
    })
    graphics.push({
      id: `sub-val-${key}`,
      type: 'text',
      // 右上角 (right 64 = 60px Y 轴刻度区 + 4px 留白), 不与刻度数字重叠;
      // TV 观感: 指标名在左上, 指标值在右上贴轴
      right: 64,
      style: {
        text: richTextParts.join(`{gap|  }`),
        y: curTop + 3,
        rich: {
          gap: { fill: 'transparent', fontSize: 10 },
          ...rich,
        },
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
        textAlign: 'right',
        textVerticalAlign: 'top',
      },
      silent: true, z: 10,
    })

    curTop += INFO_BAR_H + def.height + SUB_GAP_PX
  })

  return graphics
}

function buildOption(
  data: OHLC[],
  dates: string[],
  dateIndexMap: Map<string, number>,
  markers: ChartMarker[] | undefined,
  ranges: ChartRange[] | undefined,
  priceLines: ChartPriceLine[] | undefined,
  showMA: boolean,
  compact: boolean,
  activeIndicators: string[],
  containerHeight: number,
  infoIdx: number,
  linkedPrice: number | null | undefined,
  volumeCompare: VolumeCompareConfig,
  addedDate: string | null | undefined,
  chartStyle: 'candle' | 'hollow' | 'line' | 'area' | undefined,
  rsiZeroAxis: boolean,
  externalDrawings: DrawingObject[] | undefined,
): EChartsOption {
  const candleData = data.map(d => [d.open, d.close, d.low, d.high])

  const hasMA = showMA && data.some(d => d.ma5 != null || d.ma10 != null || d.ma20 != null || d.ma60 != null)

  const markPointData: any[] = []
  if (markers && markers.length > 0) {
    for (const m of markers) {
      const idx = dateIndexMap.get(m.date)
      if (idx == null) continue
      const d = data[idx]
      const isBuy = m.kind === 'buy'
      const isSell = m.kind === 'sell'

      if (m.above) {
        const dotColor = m.color ?? (isBuy ? '#FACC15' : CT().text)
        if (compact) {
          markPointData.push({
            name: m.date, coord: [m.date, d.high],
            symbol: 'circle', symbolSize: 4, symbolOffset: [0, -10],
            itemStyle: { color: dotColor, cursor: 'pointer' },
            label: { show: false }, z: 100, zlevel: 10,
          })
        } else {
          markPointData.push({
            name: m.date, coord: [m.date, d.high],
            symbol: 'circle', symbolSize: 12, symbolOffset: [0, -2],
            itemStyle: { color: 'transparent' },
            label: {
              show: true, formatter: m.label ?? '', position: 'top', distance: 0,
              color: dotColor, fontSize: 10, fontWeight: 'normal',
              fontFamily: 'JetBrains Mono, monospace',
            },
            z: 100, zlevel: 10,
          })
        }
      } else {
        markPointData.push({
          name: m.label ?? '',
          coord: [m.date, isBuy ? d.low : d.high],
          symbol: 'arrow', symbolSize: 12,
          symbolRotate: isBuy ? 0 : 180,
          symbolOffset: isBuy ? [0, '60%'] : [0, '-60%'],
          itemStyle: { color: isBuy ? THEME.bull : isSell ? THEME.bear : CT().text },
          label: {
            show: !!m.label, formatter: m.label ?? '',
            position: isBuy ? 'bottom' : 'top', distance: 8,
            color: CT().text, fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
          },
        })
      }
    }
  }

  // ====== 布局计算 ======
  // TV/同花顺同款: 价格轴在右侧 (最新价标签贴右缘, 符合阅读直觉);
  // left 只留 x 轴末端留白, right 让出 Y 轴标签宽度。
  const left = 20
  const right = 60
  const topPad = 8
  const candleBottomPad = 22

  let subTotalH = 0
  const activeSubDefs: SubChartDef[] = []
  activeIndicators.forEach(key => {
    const def = SUB_CHARTS.find(s => s.key === key)
    if (!def) return
    activeSubDefs.push(def)
    subTotalH += INFO_BAR_H + def.height
  })
  if (activeSubDefs.length > 0) subTotalH += activeSubDefs.length * SUB_GAP_PX

  const candleAvail = Math.max(containerHeight - topPad - candleBottomPad - subTotalH, 100)

  const grids: any[] = []
  const xAxes: any[] = []
  const yAxes: any[] = []
  const series: any[] = []
  const xAxisIndices: number[] = []

  const priceLineValues = (priceLines ?? [])
    .map(line => line.value)
    .filter(value => Number.isFinite(value) && value > 0)
  const axisMin = priceLineValues.length > 0
    ? ({ min, max }: { min: number; max: number }) => {
        const nextMin = Math.min(min, ...priceLineValues)
        const nextMax = Math.max(max, ...priceLineValues)
        return nextMin - Math.max((nextMax - nextMin) * 0.03, nextMax * 0.001)
      }
    : undefined
  const axisMax = priceLineValues.length > 0
    ? ({ min, max }: { min: number; max: number }) => {
        const nextMin = Math.min(min, ...priceLineValues)
        const nextMax = Math.max(max, ...priceLineValues)
        return nextMax + Math.max((nextMax - nextMin) * 0.03, nextMax * 0.001)
      }
    : undefined

  // ===== grid 0: K线主图 =====
  grids.push({ left, right, top: topPad, height: candleAvail })
  xAxes.push({
    type: 'category', data: dates, boundaryGap: true,
    axisLine: { lineStyle: { color: CT().border } },
    axisLabel: { color: CT().text, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
    axisTick: { show: false },
    splitLine: { show: false },
  })
  yAxes.push({
    scale: true,
    position: 'right',
    min: axisMin,
    max: axisMax,
    // 上下各留 3% 边距: 防止最高/最低点的蜡烛贴边, 涨停/炸板标签被遮挡
    boundaryGap: [0.03, 0.03],
    splitArea: { show: false },
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: CT().grid } },
    axisLabel: { color: CT().text, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
  })
  xAxisIndices.push(0)

  const markAreaData = (ranges ?? [])
    .filter(r => dateIndexMap.has(r.start) && dateIndexMap.has(r.end))
    .map(r => ([
      {
        name: r.label ?? '',
        xAxis: r.start,
        itemStyle: { color: r.color ?? 'rgba(59,130,246,0.08)' },
        label: {
          show: !!r.label,
          position: 'insideTop',
          distance: 8,
          color: CT().tooltipText,
          backgroundColor: CT().tooltipBg,
          borderColor: 'rgba(59,130,246,0.35)',
          borderWidth: 1,
          borderRadius: 4,
          padding: [2, 6],
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
        },
      },
      { xAxis: r.end },
    ]))

  const markLineData: any[] = (priceLines ?? [])
    .filter(line => Number.isFinite(line.value))
    .map(line => {
      const lineStyle = {
        color: line.color ?? CT().text,
        type: 'dashed' as const,
        width: 1,
        opacity: 0.92,
      }
      const label = {
        show: !!line.label,
        formatter: line.label ?? '',
        position: 'insideEndTop' as const,
        color: line.color ?? CT().text,
        backgroundColor: CT().tooltipBg,
        borderRadius: 4,
        padding: [2, 6],
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
      }
      if (line.start && line.end && dateIndexMap.has(line.start) && dateIndexMap.has(line.end)) {
        return [
          { xAxis: line.start, yAxis: line.value },
          { xAxis: line.end, yAxis: line.value, lineStyle, label, symbol: 'none' },
        ]
      }
      return { yAxis: line.value, lineStyle, label, symbol: 'none' }
    })

  if (linkedPrice != null) {
    markLineData.push({
      yAxis: linkedPrice,
      lineStyle: { color: '#3B82F6', type: 'dashed', width: 1, opacity: 0.7 },
      label: {
        show: true,
        formatter: linkedPrice.toFixed(2),
        position: 'insideEndTop',
        color: '#3B82F6',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
        backgroundColor: CT().tooltipBg,
        borderColor: '#3B82F6',
        borderWidth: 1,
        padding: [1, 4],
        borderRadius: 2,
      },
      symbol: 'none',
    })
  }

  // TV 同款现价标签: 末根收盘价贴在价格轴 (position 'end' = 横线右端 = 右侧轴区),
  // 涨跌色背景白字, 实时行 (is_live) 前缀 ● 徽记 — 盯盘第一视觉锚点。
  const lastBar = data[data.length - 1]
  if (lastBar != null && Number.isFinite(lastBar.close)) {
    const prevBar = data[data.length - 2]
    const lastUp = prevBar != null && Number.isFinite(prevBar.close)
      ? lastBar.close >= prevBar.close
      : true
    const liveBadge = lastBar.is_live === true ? '●' : ''
    markLineData.push({
      yAxis: lastBar.close,
      symbol: 'none',
      lineStyle: { color: lastUp ? THEME.bull : THEME.bear, type: 'dashed', width: 1, opacity: 0.5 },
      label: {
        show: true,
        formatter: `${liveBadge}${lastBar.close.toFixed(2)}`,
        position: 'end',
        color: '#FFFFFF',
        backgroundColor: lastUp ? THEME.bull : THEME.bear,
        borderRadius: 2,
        padding: [2, 5],
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
      },
    })
  }

  // 外部绘图层 (图表工作台 DrawingToolbar 落定的图形): 数据坐标锚定, 缩放/平移后自动重定位;
  // 跨周期共享时锚点按日级降级映射 (dateIndexMap 精确失败 → 该日首根, 传 dates 供渲染锚替换)
  if (externalDrawings && externalDrawings.length > 0) {
    const drawMarks = drawingsToMarks(externalDrawings, dateIndexMap, dates)
    markLineData.push(...drawMarks.markLine)
    markAreaData.push(...drawMarks.markArea)
  }

  // 主图 series — 按 chartStyle 分支 (默认蜡烛, 与既有调用方一致); 标注三件套无论样式均挂在主 series 上
  const mainMarkExtras = {
    markPoint: markPointData.length > 0 ? { data: markPointData, animation: false } : undefined,
    markArea: markAreaData.length > 0 ? { silent: true, data: markAreaData } : undefined,
    markLine: markLineData.length > 0 ? { silent: true, symbol: 'none', data: markLineData, animation: false } : undefined,
  }
  if (chartStyle === 'line' || chartStyle === 'area') {
    series.push({
      name: 'K', type: 'line', data: data.map(d => d.close),
      animation: false,
      smooth: false, symbol: 'none',
      lineStyle: { width: chartStyle === 'line' ? 1.5 : 1, color: THEME.ma5 },
      itemStyle: { color: THEME.ma5 },
      ...(chartStyle === 'area' ? { areaStyle: { color: 'rgba(161,161,175,0.15)' } } : {}),
      ...mainMarkExtras,
    })
  } else {
    // candle / hollow: hollow 时涨柱体透明 (仅描边), 观感同 TV 空心蜡烛
    series.push({
      name: 'K', type: 'candlestick', data: candleData,
      animation: false,
      itemStyle: {
        color: chartStyle === 'hollow' ? 'transparent' : THEME.bull,
        color0: chartStyle === 'hollow' ? 'transparent' : THEME.bear,
        borderColor: THEME.bull, borderColor0: THEME.bear,
        cursor: 'pointer',
      },
      ...mainMarkExtras,
    })
  }

  if (hasMA) {
    const maLine = (key: keyof OHLC, color: string, name: string) => ({
      name, type: 'line',
      data: data.map(d => (d[key] != null ? Number(d[key]) : '-')),
      smooth: true, symbol: 'none', animation: false,
      silent: true,
      lineStyle: { width: 1, color }, itemStyle: { color },
    })
    series.push(maLine('ma5', THEME.ma5, 'MA5'))
    series.push(maLine('ma10', THEME.ma10, 'MA10'))
    series.push(maLine('ma20', THEME.ma20, 'MA20'))
    series.push(maLine('ma60', THEME.ma60, 'MA60'))
  }

  // 加入自选日标注: 蓝色竖虚线从该根K线的下沿连到主图底端的「自选」标签。
  // 用 custom series 而非 markLine: 两端要贴网格底边, 而 y 轴随 dataZoom 动态定界,
  // 静态 option 里算不出底边价格; markLine 的坐标是数据坐标, 越界值会让整条线被丢弃。
  //
  // 加入日不一定有K线 (周末/节假日加入, 或当天数据尚未落盘), 此时回落到 <= 加入日的
  // 最近交易日 —— 与「加入以来」的基准日同口径, 竖线所在那天的收盘价正是基准价。
  // 仍落在当前区间外 (例如半年前加入) 才不画, 由弹窗工具栏「自选于 …」文字兜底。
  const addedIdx = (() => {
    if (!addedDate) return undefined
    const exact = dateIndexMap.get(addedDate)
    if (exact != null) return exact
    let last: number | undefined  // dates 升序, 取最后一个 <= addedDate 的类目
    for (let i = 0; i < dates.length; i += 1) {
      if (dates[i] > addedDate) break
      last = i
    }
    return last
  })()
  if (addedIdx != null && data[addedIdx]) {
    // 标签内留白四边各 4px (两个汉字 @10px ≈ 20x10 → 框 28x18);
    // 整个框再离图表下边框留 8px margin
    const BADGE_PAD = 4
    const BADGE_W = 20 + BADGE_PAD * 2
    const BADGE_H = 10 + BADGE_PAD * 2
    const BADGE_MARGIN_BOTTOM = 8
    series.push({
      name: 'addedDateMark',
      type: 'custom',
      xAxisIndex: 0, yAxisIndex: 0,
      silent: true, animation: false, z: 3,
      data: [[addedIdx, data[addedIdx].low]],
      renderItem: (params: any, api: any) => {
        const cs = params.coordSys
        const [x, lowY] = api.coord([api.value(0), api.value(1)])
        const badgeTop = cs.y + cs.height - BADGE_H - BADGE_MARGIN_BOTTOM
        return {
          type: 'group',
          children: [
            {
              type: 'line',
              // 该根K线下沿低于标签时 (贴底的长下影) 夹到标签顶, 避免线段反向
              shape: { x1: x, y1: Math.min(lowY, badgeTop), x2: x, y2: badgeTop },
              style: { stroke: ADDED_DATE_COLOR, lineWidth: 1, lineDash: [4, 3] },
            },
            {
              type: 'rect',
              shape: { x: x - BADGE_W / 2, y: badgeTop, width: BADGE_W, height: BADGE_H, r: 2 },
              style: { fill: CT().tooltipBg, stroke: ADDED_DATE_COLOR, lineWidth: 1 },
            },
            {
              type: 'text',
              style: {
                text: '自选', x, y: badgeTop + BADGE_H / 2, fill: ADDED_DATE_COLOR,
                font: '10px JetBrains Mono, monospace',
                textAlign: 'center', textVerticalAlign: 'middle',
              },
            },
          ],
        }
      },
    })
  }

  // BOLL 布林带 — 需在 activeIndicators 中激活; 上下轨之间加浅色填充带 (堆叠法)
  const showBOLL = activeIndicators.includes('boll') && data.some(d => d.boll_upper != null || d.boll_lower != null)
  if (showBOLL) {
    const bollLine = (key: keyof OHLC, color: string, name: string) => ({
      name, type: 'line',
      data: data.map(d => (d[key] != null ? Number(d[key]) : '-')),
      smooth: true, symbol: 'none', animation: false,
      silent: true,
      lineStyle: { width: 1, color, type: 'dashed' as const }, itemStyle: { color },
    })
    series.push(bollLine('boll_upper', '#E879F9', 'BOLL上'))
    series.push(bollLine('boll_lower', '#E879F9', 'BOLL下'))
    // 填充带: 下轨作堆叠基底(透明), 带宽=(上轨-下轨)堆叠其上, areaStyle 填在两轨之间 (z:1 垫底不遮 K 线)
    series.push({
      name: 'BOLL带', type: 'line', stack: 'boll-band', z: 1,
      data: data.map(d => d.boll_lower != null && d.boll_upper != null ? Number(d.boll_lower) : '-'),
      smooth: true, symbol: 'none', animation: false, silent: true,
      lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 },
    })
    series.push({
      name: 'BOLL带填充', type: 'line', stack: 'boll-band', z: 1,
      data: data.map(d => d.boll_lower != null && d.boll_upper != null
        ? Number(d.boll_upper) - Number(d.boll_lower) : '-'),
      smooth: true, symbol: 'none', animation: false, silent: true,
      lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 },
      areaStyle: { color: 'rgba(232,121,249,0.10)' },
    })
  }

  // ===== 子图区域 =====
  let curTop = topPad + candleAvail + candleBottomPad

  activeSubDefs.forEach((def, i) => {
    const gridIdx = i + 1
    const xAxisIdx = i + 1
    const yAxisIdx = i + 1

    const chartTop = curTop + INFO_BAR_H
    grids.push({
      left, right,
      top: chartTop,
      height: def.height,
      show: true,
      borderColor: CT().grid,
      borderWidth: 1,
    })

    xAxes.push({
      type: 'category', gridIndex: gridIdx, data: dates, boundaryGap: true,
      axisLine: { show: false }, axisLabel: { show: false },
      axisTick: { show: false }, splitLine: { show: false },
      axisPointer: { label: { show: false } },
    })

    // RSI 零轴形态: 副图范围从 0~100 切换到 ±50
    const yCfg = def.key === 'rsi' && rsiZeroAxis ? { min: -50, max: 50 } : def.yAxisConfig
    const isFixedRange = !!yCfg
    yAxes.push({
      scale: !isFixedRange,
      position: 'right',
      ...(isFixedRange ? yCfg : {}),
      gridIndex: gridIdx,
      splitNumber: 2,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: CT().grid } },
      axisLabel: {
        show: true, color: CT().text, fontSize: 9,
        fontFamily: 'JetBrains Mono, monospace',
      },
    })

    xAxisIndices.push(xAxisIdx)

    const subSeries = def.buildSeries(data, { compact, volumeCompare, rsiZeroAxis })
    subSeries.forEach((s: any) => {
      series.push({ ...s, xAxisIndex: xAxisIdx, yAxisIndex: yAxisIdx })
    })

    curTop += INFO_BAR_H + def.height + SUB_GAP_PX
  })

  // 子图信息栏 graphic
  const subStartTop = topPad + candleAvail + candleBottomPad
  const infoGraphics = buildSubInfoGraphics(data, infoIdx, activeIndicators, subStartTop, volumeCompare)

  // Y 轴缩放承载组件: 每个 grid (主图 0 + 激活副图 1..N) 各一个, dataZoomIndex = 1 + gridIdx。
  // 禁用一切内置交互 (滚轮/拖拽/点击都不动), 仅作数据缩放窗口的载体 — 实际缩放/平移由
  // 下方 zr 事件手动 dispatch (刻度区滚轮/按住拖拽 = 缩放; 图区内上下拖拽 = 平移)。
  // 主图价格 + 副图指标 (MACD/RSI/OBV...) 与 TV 同款均可独立缩放平移。
  const yZooms: any[] = []
  for (let g = 0; g <= activeSubDefs.length; g++) {
    yZooms.push({
      type: 'inside',
      yAxisIndex: [g],
      start: 0,
      end: 100,
      zoomOnMouseWheel: false,
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
    })
  }

  return {
    animation: false,
    backgroundColor: THEME.bg,
    tooltip: {
      // richText: 走 canvas 渲染, 无 DOM 依赖 — 手动 dispatch updateAxisPointer (图间十字联动)
      // 时 HTML 模式的 tooltip DOM 为 null 会抛异常, 中断 axisPointer 渲染导致联动十字不显示。
      // 本组件 tooltip 为"隐形设计"(空 formatter, 仅借 tooltip 系统驱动十字光标), richText 无观感差异。
      renderMode: 'richText',
      trigger: 'axis',
      axisPointer: { type: 'cross', crossStyle: { color: CT().crosshair } },
      backgroundColor: 'transparent',
      borderWidth: 0,
      textStyle: { fontSize: 0 },
      formatter: () => '',
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: {
        backgroundColor: CT().crosshairLabelBg,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
      },
    },
    graphic: infoGraphics.length > 0 ? infoGraphics : undefined,
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: xAxisIndices,
        start: 0,
        end: 100,
        // 拖拽平移由下方 zr 事件自研 (水平=动 X, 垂直=动 Y 互不干扰):
        // 内置 moveOnMouseMove 不区分方向, 垂直拖拽会同时平移 X → 可见数据范围
        // 每帧变化 → Y 窗口基准漂移, K 线被推挤到视野外 ("拖拽中 K 线消失")。
        // 滚轮 X 缩放同样自研 (zoomOnMouseWheel: false): 内置灵敏度仅 ~1.053x/格,
        // 从默认 60 根窗口缩到全量需 50+ 格, TV 同操作只要 5-10 格 — 与 Y 轴滚轮
        // 同灵敏度 exp(±0.15) ≈ 1.16x/格, 锚定鼠标 X 位置 (见 handleYWheel)。
        moveOnMouseMove: false,
        zoomOnMouseWheel: false,
      },
      ...yZooms,
    ],
    series,
  }
}


const DEFAULT_VOLUME_COMPARE = { enabled: true, days: 1 }
const DEFAULT_ACTIVE_INDICATORS: string[] = []

export function EChartsCandlestick({
  data,
  markers,
  ranges,
  priceLines,
  height = 480,
  showMA = true,
  showInfoBar = true,
  showMarkers: showMarkersProp = true,
  onToggleMarkers: _onToggleMarkers,
  stockInfo,
  symbol: _symbol,
  linkedPrice,
  onDateClick,
  onPriceDoubleClick,
  visibleBars = 60,
  activeIndicators = DEFAULT_ACTIVE_INDICATORS,
  volumeCompare = DEFAULT_VOLUME_COMPARE,
  addedDate,
  chartReady,
  chartStyle,
  rsiZeroAxis,
  externalDrawings,
  panEnabled = true,
  resetSignal,
  onResetZoom,
  onLoadMoreLeft,
}: Props) {
  const hoverSurfaceRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const onDateClickRef = useRef(onDateClick)
  onDateClickRef.current = onDateClick
  const onPriceDoubleClickRef = useRef(onPriceDoubleClick)
  onPriceDoubleClickRef.current = onPriceDoubleClick
  const chartReadyRef = useRef(chartReady)
  chartReadyRef.current = chartReady
  const panEnabledRef = useRef(panEnabled)
  panEnabledRef.current = panEnabled
  const onResetZoomRef = useRef(onResetZoom)
  onResetZoomRef.current = onResetZoom
  const onLoadMoreLeftRef = useRef(onLoadMoreLeft)
  onLoadMoreLeftRef.current = onLoadMoreLeft
  // 主题: buildOption/信息栏内部通过 CT() 动态取调色板, 这里只负责切换时触发重建
  const theme = useTheme()

  // --- 全部用 ref，避免高频交互触发 React 重渲染 ---
  const infoIdxRef = useRef<number>(data.length - 1)
  const compactRef = useRef(false)
  const userZoomRef = useRef<{ start: number; end: number } | null>(null)
  // 「往左加载更多」前插检测: 记录上次 setOption 时的数据, 判断新数据是否在头部前插了更早历史
  const prevDataRef = useRef<OHLC[]>([])
  // Y 轴(价格/指标)手动缩放窗口 per grid (TV 同款, 主图 0 + 副图 1..N):
  // 刻度区滚轮/拖拽缩放、图区内上下拖拽平移后记录, setOption 重建时恢复;
  // 重置按钮 / 双击 / 换股后清空 → 回落 0-100 (跟随数据自动定界)。
  const yZoomByGridRef = useRef<Map<number, { start: number; end: number }>>(new Map())
  // dataZoom 监听只在图表创建时注册一次, 直接调用会一直执行「创建那次渲染」的 updateCompactPresentation:
  // 它的 data/dateIndexMap/markers 停在旧标的, 会把上一只的买卖标记 merge 回新标的图上。
  // 与 dataRef/getInfoBarHTMLRef 同法, 经 ref 取最新一次渲染的函数。
  const updateCompactPresentationRef = useRef<() => void>(() => {})
  // 竖虚线(crosshair)是否可见: 控制信息栏「至今」字段的显隐。鼠标移出图表区即 false。
  const hoverActiveRef = useRef(false)

  // Y 轴价格缩放: 重置按钮 (TV 同款「A」) → 全部 grid 恢复自动定界窗口
  const resetYPrice = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    const dzs = (chart.getOption() as any)?.dataZoom ?? []
    for (let g = 0; g + 1 < dzs.length; g++) {
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + g, start: 0, end: 100 })
    }
    yZoomByGridRef.current.clear()
  }, [])

  // 双击重置 (TV 同款): X 回默认 60 根「最佳窗口」(不显示全部数据) + 全部 grid Y 回自动定界。
  // 60 根窗口记入 userZoomRef (而非清空): range 档位 (如 all) 的 initialZoom 会在下次
  // setOption 重建 (轮询/SSE 合并) 时把窗口冲回全部, 重置效果必须作为「用户缩放状态」保持。
  // __snSuppressXZoom 抑制计数: 程序窗口操作 — ChartPane 的 dataZoom 监听器豁免 (不清范围栏
  // 高亮不广播); 重置联动由 Chart 协调层按开关显式派发 resetSignal, 不依赖 X 事件广播,
  // 保证「关」时对端窗口/视野完全不动。
  const performResetZoom = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    const z = defaultZoomRef.current
    userZoomRef.current = { start: z.start, end: z.end }
    yZoomByGridRef.current.clear()
    ;(chart as any).__snSuppressXZoom = ((chart as any).__snSuppressXZoom ?? 0) + 1
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: z.start, end: z.end })
    const dzs = (chart.getOption() as any)?.dataZoom ?? []
    for (let g = 0; g + 1 < dzs.length; g++) {
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + g, start: 0, end: 100 })
    }
    window.setTimeout(() => {
      const c = chart as any
      c.__snSuppressXZoom = Math.max(0, (c.__snSuppressXZoom ?? 1) - 1)
    }, 0)
  }, [])

  // 双击重置协调信号 (图表工作台): Chart 层按「重置联动」开关派发, 值递增即执行一次重置。
  // 首次挂载跳过 (prev 初始 == resetSignal); 数据轮询等重建不重跑 (deps 只含 resetSignal)。
  const prevResetSignalRef = useRef(resetSignal)
  useEffect(() => {
    if (resetSignal === prevResetSignalRef.current) return
    prevResetSignalRef.current = resetSignal
    performResetZoom()
  }, [resetSignal, performResetZoom])

  // 需要在闭包中访问最新值的变量 — 先声明占位，后面赋值
  const activeIndicatorsRef = useRef(activeIndicators)
  activeIndicatorsRef.current = activeIndicators
  const volumeCompareRef = useRef(volumeCompare)
  volumeCompareRef.current = volumeCompare
  const chartHeightRef = useRef(300)
  const subTotalHRef = useRef(0)
  const getInfoBarHTMLRef = useRef<() => string>(() => '')

  // 强制刷新信息栏 DOM 的回调
  const infoBarRef = useRef<HTMLDivElement>(null)
  const triggerInfoBarUpdate = useRef(() => {
    const idx = infoIdxRef.current
    const curData = dataRef.current
    const d = idx >= 0 && idx < curData.length ? curData[idx] : null
    if (!d) return
    const chart = chartRef.current
    if (!chart) return
    const subStartTop = chartHeightRef.current - subTotalHRef.current
    const infoGraphics = buildSubInfoGraphics(
      curData,
      idx,
      activeIndicatorsRef.current,
      subStartTop,
      volumeCompareRef.current,
    )
    if (infoGraphics.length > 0) {
      chart.setOption({ graphic: infoGraphics }, { lazyUpdate: true })
    }
  }).current

  // 计算子图总高度
  const activeSubDefs = activeIndicators
    .map(key => SUB_CHARTS.find(s => s.key === key))
    .filter((d): d is SubChartDef => !!d)

  let subTotalH = 0
  activeSubDefs.forEach(def => { subTotalH += INFO_BAR_H + def.height })
  if (activeSubDefs.length > 0) subTotalH += activeSubDefs.length * SUB_GAP_PX

  const mainInfoBarH = showInfoBar ? 40 : 0
  const minCandleH = 120

  const chartHeight = Math.max(height - mainInfoBarH, 8 + minCandleH + 14 + subTotalH)
  chartHeightRef.current = chartHeight
  subTotalHRef.current = subTotalH

  // 预计算 date→index Map (O(1) 查找)
  const dates = useMemo(() => data.map(d => d.date), [data])
  const dateIndexMap = useMemo(() => {
    const m = new Map<string, number>()
    dates.forEach((d, i) => m.set(d, i))
    return m
  }, [dates])

  // dataZoom 初始范围: 'all' = 显示整段数据, 否则取末尾 visibleBars 根
  const initialZoom = useMemo(() => {
    const start = visibleBars === 'all'
      ? 0
      : Math.max(0, 100 - (visibleBars / Math.max(data.length, 1)) * 100)
    return { start, end: 100 }
  }, [visibleBars, data.length])

  // 双击重置的「最佳窗口」: 默认 60 根 (与图表默认视野同口径), 不随外部 range (如 all = 全部数据)
  // 走 — 多周期多窗下各窗都回到根数合理、K 线粗细可读的窗口 (TV reset 语义, 而非显示全部)。
  const defaultZoom = useMemo(() => ({
    start: Math.max(0, 100 - (60 / Math.max(data.length, 1)) * 100),
    end: 100,
  }), [data.length])
  const defaultZoomRef = useRef(defaultZoom)
  defaultZoomRef.current = defaultZoom

  // ===== 信息栏 HTML 内容 (基于 infoIdxRef.current) =====
  const getInfoBarHTML = useCallback(() => {
    let idx = infoIdxRef.current
    let d = idx >= 0 && idx < data.length ? data[idx] : null
    // fallback: 如果当前 idx 无数据，取最后一根 K 线
    if (!d && data.length > 0) {
      idx = data.length - 1
      d = data[idx]
    }
    if (!d) return ''
    const prev = idx > 0 ? data[idx - 1] : null
    const chg = prev ? d.close - prev.close : 0
    const isUp = chg >= 0
    const clr = isUp ? THEME.bull : THEME.bear
    const floatShares = stockInfo?.float_shares
    const turnoverRate = floatShares && d.volume ? (d.volume * 100 / floatShares * 100) : null

    let html = `<div style="display:flex;align-items:center;gap:6px;padding:0 8px;font:11px 'JetBrains Mono',monospace;select:none;min-height:20px;flex-wrap:wrap">`
    html += `<span style="color:${CT().text}">${d.date}</span>`
    html += `<span style="color:${CT().text}">开</span>`
    html += `<span style="color:${d.open >= d.close ? THEME.bear : THEME.bull}">${d.open.toFixed(2)}</span>`
    html += `<span style="color:${CT().text}">高</span>`
    html += `<span style="color:${THEME.bull}">${d.high.toFixed(2)}</span>`
    html += `<span style="color:${CT().text}">低</span>`
    html += `<span style="color:${THEME.bear}">${d.low.toFixed(2)}</span>`
    html += `<span style="color:${CT().text}">收</span>`
    html += `<span style="color:${clr};font-weight:600">${d.close.toFixed(2)}</span>`
    // 涨跌幅 (收盘后, 换手前; 和收间隔一些距离)
    if (prev) {
      const chgPct = (chg / prev.close * 100)
      html += `<span style="color:${clr};margin-left:8px">${isUp ? '+' : ''}${chgPct.toFixed(2)}%</span>`
    }
    if (turnoverRate != null) {
      html += `<span style="color:${CT().text}">换手</span>`
      html += `<span style="color:${CT().text}">${turnoverRate.toFixed(2)}%</span>`
    }
    // 至今: 仅当竖虚线(crosshair)在图上且鼠标悬停某根 K 线时显示。
    // 最新价取最后一根K线收盘 (后端 _maybe_inject_live_candle 盘中注入实时价, 收盘后即最近收盘)。
    // 基准取该K线昨收(前一日收盘), 与同花顺及全市场涨幅口径一致; 数据第一根K线无昨收则跳过。
    if (hoverActiveRef.current && prev && Number.isFinite(prev.close) && prev.close > 0) {
      const latestPrice = data[data.length - 1].close
      if (Number.isFinite(latestPrice)) {
        const sinceRatio = (latestPrice - prev.close) / prev.close
        const sinceClr = sinceRatio >= 0 ? THEME.bull : THEME.bear
        html += `<span style="color:${CT().text}">至今</span>`
        html += `<span style="color:${sinceClr}">${fmtPct(sinceRatio)}</span>`
        // 周期数: 从该K线(含)到最新一根K线共多少根; 悬停最后一根时为 1
        html += `<span style="color:${CT().text}">周期 ${data.length - idx}</span>`
      }
    }
    html += `</div>`

    // 第二行: MA + BOLL
    if (showMA) {
      html += `<div style="display:flex;align-items:center;gap:10px;padding:0 8px;font:11px 'JetBrains Mono',monospace;select:none;min-height:20px;flex-wrap:wrap">`
      if (d.ma5 != null) html += `<span style="color:${THEME.ma5}">MA5:${Number(d.ma5).toFixed(2)}</span>`
      if (d.ma10 != null) html += `<span style="color:${THEME.ma10}">MA10:${Number(d.ma10).toFixed(2)}</span>`
      if (d.ma20 != null) html += `<span style="color:${THEME.ma20}">MA20:${Number(d.ma20).toFixed(2)}</span>`
      if (d.ma60 != null) html += `<span style="color:${THEME.ma60}">MA60:${Number(d.ma60).toFixed(2)}</span>`
      if (d.boll_upper != null && activeIndicators.includes('boll')) {
        html += `<span style="color:#E879F9">BOLL:${Number(d.boll_upper).toFixed(2)}/${Number(d.ma20).toFixed(2)}/${Number(d.boll_lower).toFixed(2)}</span>`
      }
      html += `</div>`
    }

    return html
  }, [data, stockInfo, showMA, activeIndicators])
  getInfoBarHTMLRef.current = getInfoBarHTML

  // data/symbol 变化时重置 infoIdx:
  // symbol(_symbol) 进依赖是必要的——预取切股到同长度邻股时 data.length 不变,
  // 但悬停上下文来自上一只股票, 必须清掉 hoverActiveRef 以免「至今/周期」残留显示。
  // (同一股的实时刷新 symbol 不变, 不触发, 悬停位置与「至今」保持实时)
  useEffect(() => {
    infoIdxRef.current = data.length - 1
    compactRef.current = false
    // 前插(「往左加载更多」): 旧数据是新数据尾部连续段 → 保留 userZoomRef 供下方
    // setOption effect 的前插检测右移视野; 其他 data.length 变化(换周期/换数据集)
    // 重置 X 窗口, 旧窗口对新数据无意义。
    const prev = prevDataRef.current
    const isFrontInsert = prev.length > 0 && data.length > prev.length
      && data[0].date < prev[0].date
      && data[data.length - prev.length].date === prev[0].date
    if (!isFrontInsert) {
      userZoomRef.current = null
    }
    // Y 轴缩放窗口 (主图+副图) 随标的全部重置 — 新股价格范围不同, 旧窗口无意义
    yZoomByGridRef.current.clear()
    // 新数据无悬停上下文, 隐藏「至今」; 下次鼠标移动时由 updateAxisPointer 重新置位
    hoverActiveRef.current = false
  }, [_symbol, data.length])

  // ===== 初始化 chart (只在 chartHeight 变化时重建) =====
  useEffect(() => {
    const el = containerRef.current
    const hoverEl = hoverSurfaceRef.current
    if (!el || !hoverEl) return

    const chart = echarts.init(el, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chartReadyRef.current?.(chart)

    // 信息栏内容由本组件直接写 innerHTML; 悬停显隐与悬停 K 线变化共用这一处写入口
    const writeInfoBar = () => {
      const infoEl = infoBarRef.current
      if (!infoEl) return
      const html = getInfoBarHTMLRef.current()
      if (html) infoEl.innerHTML = html  // 只在有内容时更新
    }

    // 切换悬停态; 返回是否翻转, 翻转后由调用方重绘
    const setHoverActive = (active: boolean) => {
      if (active === hoverActiveRef.current) return false
      hoverActiveRef.current = active
      return true
    }

    // The outer chart surface stays under the pointer when the info bar wraps and
    // pushes the canvas down, so hover visibility cannot oscillate at that boundary.
    const handlePointerEnter = () => { if (setHoverActive(true)) writeInfoBar() }
    const handlePointerLeave = () => { if (setHoverActive(false)) writeInfoBar() }
    hoverEl.addEventListener('mouseenter', handlePointerEnter)
    hoverEl.addEventListener('mouseleave', handlePointerLeave)

    // 鼠标移动 → 只更新 ref + DOM，不触发 React re-render
    // 设计原则: 找不到有效数据时保持上次显示，永远不清空信息栏。
    chart.on('updateAxisPointer', (event: any) => {
      const axesInfo = event.axesInfo
      const d = dataRef.current
      // 竖虚线是否正落在某根有效 K 线上 (鼠标在图表数据区内)
      let foundIdx = -1
      if (axesInfo) {
        for (const info of Object.values(axesInfo)) {
          const val = (info as any)?.value
          if (val == null) continue
          const idx = typeof val === 'number' ? val : d.findIndex(x => x.date === val)
          if (idx >= 0 && idx < d.length) { foundIdx = idx; break }
        }
      }
      if (foundIdx < 0) return
      const idxChanged = infoIdxRef.current !== foundIdx
      if (idxChanged) infoIdxRef.current = foundIdx
      // 竖虚线命中 K 线即悬停成立: 切股后竖虚线重画而鼠标没离开图表区, 等不到 mouseenter, 靠这里复显
      const hoverResumed = setHoverActive(true)
      if (idxChanged || hoverResumed) writeInfoBar()
      // 更新子图 graphic (仅悬停 K 线变化时; 纯显隐切换不影响副图)
      if (idxChanged) triggerInfoBarUpdate()
    })

    chart.on('click', (params: any) => {
      if (params.componentType === 'markPoint' && params.name) {
        onDateClickRef.current?.(params.name)
        return
      }
      if (params.seriesName !== 'K' || params.dataIndex == null) return
      const d = dataRef.current
      const idx = params.dataIndex
      if (idx >= 0 && idx < d.length) {
        onDateClickRef.current?.(d[idx].date)
      }
    })

    const handlePriceDoubleClick = (event: { offsetX: number; offsetY: number }) => {
      const pixel: [number, number] = [event.offsetX, event.offsetY]
      if (!chart.containPixel({ gridIndex: 0 }, pixel)) return
      const coordinate = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, pixel)
      const price = Array.isArray(coordinate) ? Number(coordinate[1]) : NaN
      const currentPrice = dataRef.current[dataRef.current.length - 1]?.close
      if (Number.isFinite(price) && price > 0 && Number.isFinite(currentPrice) && currentPrice > 0) {
        onPriceDoubleClickRef.current?.(price, currentPrice)
      }
    }
    // 双击语义: 有价格提醒消费者 (个股分析页) → 报价回调;
    // 无消费者 (图表工作台等) → TV 同款重置缩放。工作台走协调层 (onResetZoom 存在时只上报,
    // 由 Chart 按「重置联动」开关派发 resetSignal — 开 = 全部窗一起重置, 关 = 仅本窗);
    // 无协调层的调用方保持本地自重置 (performResetZoom)。
    const handleDblClick = (event: { offsetX: number; offsetY: number }) => {
      if (onPriceDoubleClickRef.current) {
        handlePriceDoubleClick(event)
        return
      }
      if (onResetZoomRef.current) {
        onResetZoomRef.current()
        return
      }
      performResetZoom()
    }
    chart.getZr().on('dblclick', handleDblClick)

    // ── Y 轴缩放/平移 — TV 同款, 主图 + 全部副图均可独立操作 ──
    // 右侧刻度带: 滚轮缩放 / 按住上下拖拽缩放 (不抢 grid 内的 X 缩放/十字光标/绘图);
    // 图区内: 该 grid Y 已手动缩放时按住上下拖拽 = 平移 Y 窗口 (缩放后 K 线出视野可拖回来,
    // 垂直分量与内置 X 平移共存 → 斜拖时时间价格同时动, TV 同款); 绘图模式禁用 (让位画线)。
    const gridCount = () => {
      const dzs = (chart.getOption() as any)?.dataZoom ?? []
      return Math.max(0, dzs.length - 1)
    }
    const gridRectAt = (g: number) => {
      const comp = (chart as any).getModel().getComponent('grid', g)
      return comp?.coordinateSystem?.getRect()
    }
    /** 鼠标在哪个 grid 的右侧刻度带; -1 = 不在 (含左右两带中的左带: 价格轴在右, 左带不算)。 */
    const locateYBand = (px: number, py: number): number => {
      if (px < 0 || px >= chart.getWidth()) return -1
      for (let g = 0; g < gridCount(); g++) {
        const r = gridRectAt(g)
        if (!r) continue
        if (py < r.y || py > r.y + r.height) continue
        if (px > r.x + r.width + 2) return g
      }
      return -1
    }
    /** 鼠标在哪个 grid 图区内; -1 = 不在。 */
    const locateGrid = (px: number, py: number): number => {
      for (let g = 0; g < gridCount(); g++) {
        const r = gridRectAt(g)
        if (!r) continue
        if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) return g
      }
      return -1
    }
    /** 把 grid g 的 Y 窗口以锚点比例(anchorRatio: 0=底 1=顶)缩放 factor 倍 (factor>1 = 收窄 = 放大)。 */
    const scaleYWindow = (g: number, anchorRatio: number, factor: number) => {
      const opt = chart.getOption() as any
      const yz = opt?.dataZoom?.[1 + g]
      if (!yz) return
      const s = yz.start ?? 0
      const e = yz.end ?? 100
      const w0 = e - s
      // 窗宽夹在 [0.5, 100]: 全窗口继续放大时 w0/factor > 100, 不夹会让
      // 后续“夹回 0-100”算出负 start, ECharts 忽略无效 dispatch → 缩放无响应
      const w = Math.max(Math.min(w0 / factor, 100), 0.5)
      const c = s + anchorRatio * w0
      let sN = c - (c - s) / factor
      let eN = sN + w
      if (sN < 0) { sN = 0; eN = w }
      if (eN > 100) { eN = 100; sN = Math.max(0, 100 - w) }
      yZoomByGridRef.current.set(g, { start: sN, end: eN })
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + g, start: sN, end: eN })
    }
    // 滚轮: 以鼠标位置为锚 (上滚放大, 下滚缩小)。zr 的 wheelDelta 已归一化
    // (上滚 = +1, 下滚 = -1), 每格约 ±15%; 刻度带在 grid 右侧 (TV 同款)
    const handleYWheel = (ev: any) => {
      const g = locateYBand(ev.offsetX, ev.offsetY)
      if (g < 0) {
        // 图区内滚轮 → X 轴缩放 (自研, 锚定鼠标 X; 内置灵敏度太慢见 buildOption 注释)
        ev.preventDefault?.()
        const xg = locateGrid(ev.offsetX, ev.offsetY)
        const xr = xg >= 0 ? gridRectAt(xg) : null
        const opt = chart.getOption() as any
        const xz = opt?.dataZoom?.[0]
        const delta = Number(ev.wheelDelta ?? ev.zrDelta ?? 0)
        if (!xr || !xz || !Number.isFinite(delta) || delta === 0) return
        const factor = Math.exp(delta * 0.15) // 上滚>1 = 放大 (与 Y 轴滚轮同灵敏度)
        const s = xz.start ?? 0
        const e = xz.end ?? 100
        const w0 = e - s
        // 锚点比例 (0=窗口最左 1=最右): 缩放后该比例处的数据仍在鼠标下方
        const anchor = Math.max(0, Math.min(1, (ev.offsetX - xr.x) / xr.width))
        const w = Math.max(Math.min(w0 / factor, 100), 0.5)
        const c = s + anchor * w0
        let sN = c - (c - s) / factor
        let eN = sN + w
        if (sN < 0) { sN = 0; eN = w }
        if (eN > 100) { eN = 100; sN = Math.max(0, 100 - w) }
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: sN, end: eN })
        return
      }
      ev.preventDefault?.()
      const r = gridRectAt(g)
      if (!r) return
      const anchor = 1 - (ev.offsetY - r.y) / r.height
      const delta = Number(ev.wheelDelta ?? ev.zrDelta ?? 0)
      if (!Number.isFinite(delta) || delta === 0) return
      // 上滚 delta>0 → factor>1 → 窗口收窄 = 放大 (与拖拽向上=放大同语义)
      scaleYWindow(g, anchor, Math.exp(delta * 0.15))
    }
    // 按住拖拽 — 双模式: 刻度带内 = 缩放; 图区内 = 双轴平移 (TV 同款)
    // pan: 水平分量只动 X 窗口, 垂直分量只动 Y 窗口 (仅该 grid Y 已手动缩放时响应) —
    // 互不干扰, 垂直拖不会把可见数据带推跑, K 线不再“拖一拖消失再显示”
    type Drag =
      | { mode: 'scale'; grid: number; y0: number; ry: number; h: number; s0: number; e0: number }
      | { mode: 'pan'; grid: number; hasY: boolean; x0: number; y0: number; gw: number; gh: number; s0X: number; e0X: number; s0Y: number; e0Y: number }
    let drag: Drag | null = null
    const handleZrMouseDown = (ev: { offsetX: number; offsetY: number }) => {
      const bandGrid = locateYBand(ev.offsetX, ev.offsetY)
      if (bandGrid >= 0) {
        // 刻度带: 缩放模式 — 按下点记录窗口与锚, 上下拖动按比例缩放 (拖满 grid 高 = 2 倍)
        const opt = chart.getOption() as any
        const yz = opt?.dataZoom?.[1 + bandGrid]
        if (!yz) return
        const r = gridRectAt(bandGrid)
        if (!r) return
        drag = { mode: 'scale', grid: bandGrid, y0: ev.offsetY, ry: r.y, h: r.height, s0: yz.start ?? 0, e0: yz.end ?? 100 }
        return
      }
      // 图区内: 平移模式 — X 始终可拖; Y 仅在该 grid 已手动缩放时可拖 (自动定界不转手动)
      if (!panEnabledRef.current) return
      const g = locateGrid(ev.offsetX, ev.offsetY)
      if (g < 0) return
      const r = gridRectAt(g)
      if (!r) return
      const opt = chart.getOption() as any
      const xz = opt?.dataZoom?.[0]
      const yz = yZoomByGridRef.current.get(g)
      drag = {
        mode: 'pan', grid: g, hasY: !!yz,
        x0: ev.offsetX, y0: ev.offsetY, gw: r.width, gh: r.height,
        s0X: xz?.start ?? 0, e0X: xz?.end ?? 100,
        s0Y: yz ? yz.start : 0, e0Y: yz ? yz.end : 100,
      }
    }
    const handleZrMouseMove = (ev: { offsetX: number; offsetY: number }) => {
      if (!drag) return
      if (drag.mode === 'scale') {
        const dy = ev.offsetY - drag.y0
        if (dy === 0) return
        const w0 = drag.e0 - drag.s0
        const factor = Math.pow(2, -dy / drag.h) // 上拖(负) → factor>1 → 窗口收窄 = 放大
        // 窗宽夹在 [0.5, 100] (同 scaleYWindow: 全窗口继续放大需夹住, 否则负 start 无效)
        const w = Math.max(Math.min(w0 / factor, 100), 0.5)
        const c = drag.s0 + (1 - (drag.y0 - drag.ry) / drag.h) * w0
        let sN = c - (c - drag.s0) / factor
        let eN = sN + w
        if (sN < 0) { sN = 0; eN = w }
        if (eN > 100) { eN = 100; sN = Math.max(0, 100 - w) }
        yZoomByGridRef.current.set(drag.grid, { start: sN, end: eN })
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + drag.grid, start: sN, end: eN })
        return
      }
      // pan: 水平分量 → X 平移 (内容跟随手指: 左拖看更晚数据, 窗口右移); 垂直分量 → Y 平移
      const dx = ev.offsetX - drag.x0
      const dy = ev.offsetY - drag.y0
      if (dx !== 0) {
        const w = drag.e0X - drag.s0X
        const d = (dx / drag.gw) * w
        const sN = Math.max(0, Math.min(100 - w, drag.s0X - d))
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: sN, end: sN + w })
      }
      if (dy !== 0 && drag.hasY) {
        const w = drag.e0Y - drag.s0Y
        const d = (dy / drag.gh) * w
        const sN = Math.max(0, Math.min(100 - w, drag.s0Y + d))
        yZoomByGridRef.current.set(drag.grid, { start: sN, end: sN + w })
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + drag.grid, start: sN, end: sN + w })
      }
    }
    const handleZrDragEnd = () => { drag = null }
    const zr = chart.getZr()
    zr.on('mousewheel', handleYWheel)
    zr.on('mousedown', handleZrMouseDown)
    zr.on('mousemove', handleZrMouseMove)
    zr.on('mouseup', handleZrDragEnd)
    zr.on('globalout', handleZrDragEnd)

    // dataZoom → 只更新 ref，不触发 React re-render
    // compact 变化时需要增量更新 markPoint
    chart.on('dataZoom', () => {
      const opt = chart.getOption() as any
      const zoom = opt?.dataZoom?.[0]
      if (!zoom) return
      userZoomRef.current = { start: zoom.start, end: zoom.end }

      // 「往左加载更多」: 视野贴到最左边界 (start ≤ 0.5%) 时上报一次。
      // 防重复由调用方 (ChartPane: canLoadMore + isFetching) 负责; 加载后数据变长、
      // 视野平移, start 回正, 直到用户再次拖到边界才再次触发 — 天然实现逐步加载。
      if (zoom.start <= 0.5 && onLoadMoreLeftRef.current) {
        onLoadMoreLeftRef.current()
      }

      const d = dataRef.current
      const total = d.length
      const visibleCount = Math.round(total * (zoom.end - zoom.start) / 100)
      const newCompact = visibleCount > COMPACT_THRESHOLD
      if (newCompact !== compactRef.current) {
        compactRef.current = newCompact
        updateCompactPresentationRef.current()
      }
    })

    const ro = new ResizeObserver(() => { chart.resize() })
    ro.observe(el)

    return () => {
      chart.off('updateAxisPointer')
      chart.off('click')
      chart.off('dataZoom')
      hoverEl.removeEventListener('mouseenter', handlePointerEnter)
      hoverEl.removeEventListener('mouseleave', handlePointerLeave)
      chart.getZr().off('dblclick', handleDblClick)
      zr.off('mousewheel', handleYWheel)
      zr.off('mousedown', handleZrMouseDown)
      zr.off('mousemove', handleZrMouseMove)
      zr.off('mouseup', handleZrDragEnd)
      zr.off('globalout', handleZrDragEnd)
      chartReadyRef.current?.(null)
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [chartHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  // 缩放跨过紧凑阈值时，仅增量更新标签，不重建整张图。
  function updateCompactPresentation() {
    const chart = chartRef.current
    if (!chart) return
    const mkrs = showMarkersProp ? markers : undefined
    const compact = compactRef.current
    const seriesUpdates: any[] = []
    const markPointData: any[] = []
    for (const m of mkrs ?? []) {
      const idx = dateIndexMap.get(m.date)
      if (idx == null) continue
      const d = data[idx]
      const isBuy = m.kind === 'buy'
      const isSell = m.kind === 'sell'
      if (m.above) {
        const dotColor = m.color ?? (isBuy ? '#FACC15' : CT().text)
        if (compact) {
          markPointData.push({
            name: m.date, coord: [m.date, d.high],
            symbol: 'circle', symbolSize: 4, symbolOffset: [0, -10],
            itemStyle: { color: dotColor, cursor: 'pointer' },
            label: { show: false }, z: 100, zlevel: 10,
          })
        } else {
          markPointData.push({
            name: m.date, coord: [m.date, d.high],
            symbol: 'circle', symbolSize: 12, symbolOffset: [0, -2],
            itemStyle: { color: 'transparent' },
            label: {
              show: true, formatter: m.label ?? '', position: 'top', distance: 0,
              color: dotColor, fontSize: 10, fontWeight: 'normal',
              fontFamily: 'JetBrains Mono, monospace',
            },
            z: 100, zlevel: 10,
          })
        }
      } else {
        markPointData.push({
          name: m.label ?? '',
          coord: [m.date, isBuy ? d.low : d.high],
          symbol: 'arrow', symbolSize: 12,
          symbolRotate: isBuy ? 0 : 180,
          symbolOffset: isBuy ? [0, '60%'] : [0, '-60%'],
          itemStyle: { color: isBuy ? THEME.bull : isSell ? THEME.bear : CT().text },
          label: {
            show: !!m.label, formatter: m.label ?? '',
            position: isBuy ? 'bottom' : 'top', distance: 8,
            color: CT().text, fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
          },
        })
      }
    }
    if (mkrs?.length) {
      seriesUpdates.push({
        name: 'K',
        markPoint: markPointData.length > 0 ? { data: markPointData, animation: false } : undefined,
      })
    }
    if (activeIndicatorsRef.current.includes('vol')) {
      seriesUpdates.push({
        name: '成交量',
        label: { show: volumeCompareRef.current.enabled && !compact },
      })
    }
    if (seriesUpdates.length > 0) chart.setOption({ series: seriesUpdates })
  }
  updateCompactPresentationRef.current = updateCompactPresentation

  // ===== 核心: 仅在数据/配置变更时全量 setOption =====
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const option = buildOption(
      data, dates, dateIndexMap,
      showMarkersProp ? markers : undefined,
      ranges,
      priceLines,
      showMA, compactRef.current,
      activeIndicators, chartHeight,
      infoIdxRef.current,
      linkedPrice,
      volumeCompare,
      addedDate,
      chartStyle,
      !!rsiZeroAxis,
      externalDrawings,
    )

    chart.setOption(option, true)

    // 恢复用户缩放位置 (dataZoomIndex: 0 只动 X — 不带 index 会打到全部 Y 窗口)。
    // __snSuppressXZoom 抑制计数: setOption 全量重建会瞬时触发 dataZoom 事件 (option 里
    // 写死的 start:0/end:100), 会把程序恢复窗口误判成用户手动缩放 (清范围高亮/广播幽灵
    // 窗口) — 程序窗口操作期间 (宏任务内) ChartPane 的 dataZoom 监听一律豁免;
    // 组件内自己的监听 (维护 userZoomRef) 不豁免, 恢复窗口正常入账。
    const prevData = prevDataRef.current
    const zoom = userZoomRef.current
    let xWin = zoom ?? initialZoom
    if (zoom && prevData.length > 0 && data.length > prevData.length) {
      // 「往左加载更多」前插检测: 新数据头部是更早历史, 旧数据仍是其尾部连续段。
      // 此时把旧视野的索引段整体右移 inserted 根, 保持用户看到的日期段不变
      // (否则百分比 start/end 不变会因分母变大而视觉跳变)。
      const inserted = data.length - prevData.length
      const isFrontInsert = data[0].date < prevData[0].date && data[inserted].date === prevData[0].date
      if (isFrontInsert) {
        const startIdx = (zoom.start / 100) * prevData.length
        const endIdx = (zoom.end / 100) * prevData.length
        xWin = {
          start: ((startIdx + inserted) / data.length) * 100,
          end: ((endIdx + inserted) / data.length) * 100,
        }
      }
    }
    prevDataRef.current = data
    ;(chart as any).__snSuppressXZoom = ((chart as any).__snSuppressXZoom ?? 0) + 1
    window.setTimeout(() => {
      const c = chart as any
      c.__snSuppressXZoom = Math.max(0, (c.__snSuppressXZoom ?? 1) - 1)
    }, 0)
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: xWin.start, end: xWin.end })
    // 恢复 Y 轴手动缩放窗口 (主图+全部副图; 切周期/指标等重建后保持; 新标的已随
    // _symbol 重置清空)。setOption 不会重置 dataZoom 的窗口状态, 未缩放的 grid 也需
    // 显式归位 0-100, 否则换股后旧标的的价格窗口会残留到新标的上。
    const dzs = (chart.getOption() as any)?.dataZoom ?? []
    for (let g = 0; g + 1 < dzs.length; g++) {
      const yZoom = yZoomByGridRef.current.get(g)
      chart.dispatchAction({
        type: 'dataZoom', dataZoomIndex: 1 + g,
        start: yZoom ? yZoom.start : 0,
        end: yZoom ? yZoom.end : 100,
      })
    }

    // 初始信息栏
    const infoEl = infoBarRef.current
    if (infoEl) {
      infoEl.innerHTML = getInfoBarHTMLRef.current()
    }
  }, [data, markers, ranges, priceLines, linkedPrice, showMA, showMarkersProp, activeIndicators, volumeCompare, addedDate, chartStyle, rsiZeroAxis, externalDrawings, chartHeight, dates, dateIndexMap, initialZoom, theme])

  // 渲染信息栏容器 (内容由 JS 直接写入)
  const initialHTML = useMemo(() => {
    const idx = data.length - 1
    const d = idx >= 0 && idx < data.length ? data[idx] : null
    if (!d) return ''
    const floatShares = stockInfo?.float_shares
    const turnoverRate = floatShares && d.volume ? (d.volume * 100 / floatShares * 100) : null
    let html = `<div style="display:flex;align-items:center;gap:6px;padding:0 8px;font:11px 'JetBrains Mono',monospace;min-height:20px;flex-wrap:wrap">`
    html += `<span style="color:${CT().text}">${d.date}</span>`
    html += `<span style="color:${CT().text}">开</span>`
    html += `<span style="color:${d.open >= d.close ? THEME.bear : THEME.bull}">${d.open.toFixed(2)}</span>`
    html += `<span style="color:${CT().text}">高</span>`
    html += `<span style="color:${THEME.bull}">${d.high.toFixed(2)}</span>`
    html += `<span style="color:${CT().text}">低</span>`
    html += `<span style="color:${THEME.bear}">${d.low.toFixed(2)}</span>`
    html += `<span style="color:${CT().text}">收</span>`
    const prevClose0 = data[idx-1]?.close ?? d.close
    const clr0 = d.close >= prevClose0 ? THEME.bull : THEME.bear
    html += `<span style="color:${clr0};font-weight:600">${d.close.toFixed(2)}</span>`
    // 涨跌幅 (收盘后, 换手前; 和收间隔一些距离)
    if (idx > 0) {
      const chgPct0 = ((d.close - prevClose0) / prevClose0 * 100)
      html += `<span style="color:${clr0};margin-left:8px">${chgPct0 >= 0 ? '+' : ''}${chgPct0.toFixed(2)}%</span>`
    }
    if (turnoverRate != null) {
      html += `<span style="color:${CT().text}">换手</span>`
      html += `<span style="color:${CT().text}">${turnoverRate.toFixed(2)}%</span>`
    }
    html += `</div>`
    if (showMA) {
      html += `<div style="display:flex;align-items:center;gap:10px;padding:0 8px;font:11px 'JetBrains Mono',monospace;min-height:20px;flex-wrap:wrap">`
      if (d.ma5 != null) html += `<span style="color:${THEME.ma5}">MA5:${Number(d.ma5).toFixed(2)}</span>`
      if (d.ma10 != null) html += `<span style="color:${THEME.ma10}">MA10:${Number(d.ma10).toFixed(2)}</span>`
      if (d.ma20 != null) html += `<span style="color:${THEME.ma20}">MA20:${Number(d.ma20).toFixed(2)}</span>`
      if (d.ma60 != null) html += `<span style="color:${THEME.ma60}">MA60:${Number(d.ma60).toFixed(2)}</span>`
      if (d.boll_upper != null && activeIndicators.includes('boll')) {
        html += `<span style="color:#E879F9">BOLL:${Number(d.boll_upper).toFixed(2)}/${Number(d.ma20).toFixed(2)}/${Number(d.boll_lower).toFixed(2)}</span>`
      }
      html += `</div>`
    }
    return html
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={hoverSurfaceRef} className="relative w-full">
      {/* 主图信息栏 — 内容由 JS 直接操作 innerHTML */}
      {showInfoBar && (
        <div ref={infoBarRef} style={{ backgroundColor: CT().infoBarBg }}
          dangerouslySetInnerHTML={{ __html: initialHTML }} />
      )}

      {/* Y 轴缩放重置 (TV 同款「A」): 主图+全部副图一起恢复自动定界;
          右侧刻度区滚轮或按住拖拽可手动缩放, Y 缩放后图内上下拖拽可平移。
          放在 ECharts 容器之外 (兄弟节点), 避免 zrender 容器内子节点被 React 协调移除 */}
      <button
        type="button"
          title="恢复主图与全部副图 Y 轴自动高度 (右侧刻度区滚轮/拖拽可缩放, 图内上下拖拽可平移)"
        onClick={resetYPrice}
        className="absolute z-20 flex h-4 w-4 items-center justify-center rounded-full border border-border/60 bg-surface/80 font-mono text-[10px] leading-none text-secondary opacity-70 transition-opacity hover:border-accent/50 hover:text-accent hover:opacity-100"
        style={{ right: 8, top: (showInfoBar ? 40 : 0) + 8 }}
      >
        A
      </button>

      {/* ECharts canvas */}
      <div ref={containerRef} className="w-full" style={{ height: chartHeight }} />
    </div>
  )
}
