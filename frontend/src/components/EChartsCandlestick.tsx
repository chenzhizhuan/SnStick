import { useEffect, useRef, useCallback, useMemo } from 'react'
import { chartTheme, getTheme, useTheme } from '@/lib/theme'
import { installEChartsZoomFix } from '@/lib/echartsZoomFix'
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
  /** 私有化指标线路 (R5 经典版附图口径): macd_plus_hist = 能量柱 (动能差量级缩放);
 *  rsi_plus = 资金流 ±1 单值; fund_* = 资金流信号 (背景/追踪状态/交叉事件) */
  macd_plus_dif?: number | null
  macd_plus_dea?: number | null
  macd_plus_hist?: number | null
  rsi_plus?: number | null
  /** 动能双腿 (RSI28 的 EMA5/60, 服务端附着透传) */
  volume_rsi_fast?: number | null
  volume_rsi_slow?: number | null
  /** 资金流背景状态: 0=无 1=超卖低位(红) 2=超买高位(绿) */
  fund_bg_color?: number | null
  /** 资金流追踪状态: 0-4 (服务端状态机输出) */
  fund_tracking_state?: number | null
  /** 上穿下轨 → B 买信号事件 (布尔) */
  fund_cross_up_lower?: boolean
  /** 下穿上轨 → S 卖信号事件 (布尔) */
  fund_cross_down_upper?: boolean
  kdj_k?: number | null
  kdj_d?: number | null
  kdj_j?: number | null
  boll_upper?: number | null
  boll_lower?: number | null
  obv?: number | null
  cci?: number | null
  /** 后端注入的当日实时行标记 (日K); 现价标签用它显示实时徽记 */
  is_live?: boolean
  /** 融易主图 (R5, 服务端 rymain.py 附着): 牛熊通道 EMA110±ATR50×0.55 */
  ry_upper?: number | null
  ry_mid?: number | null
  ry_lower?: number | null
  /** 中轨 EMA24 + MACD 快线分色 (+1/-1/0) + 刻度半幅 */
  ry_mid_trend?: number | null
  ry_mid_tick?: number | null
  ry_ema_mid?: number | null
  /** K/K2/K3 SuperTrend 通道 (K2/K3 为 4/8 根合并周期) */
  k_trend?: number | null
  k_up?: number | null
  k_dn?: number | null
  k2_trend?: number | null
  k2_up?: number | null
  k2_dn?: number | null
  k3_trend?: number | null
  k3_up?: number | null
  k3_dn?: number | null
  /** K 线通道位置着色: +1 上轨外多头 / -1 下轨外空头 / 0 通道内灰 */
  ry_bar_color?: number | null
  /** 梯形菱形信号 (归一化乖离极值反转) + 锚价 */
  ry_top_signal?: boolean
  ry_top_price?: number | null
  ry_btm_signal?: boolean
  ry_btm_price?: number | null
  /** 多指标背离计数 (顶部负背离/底部正背离) */
  div_top_count?: number | null
  div_btm_count?: number | null
  /** 融易 FVG (公平价值缺口) 活跃区间 — 仅末行携带 (服务端 rymain.py) */
  fvg_list?: RyFvgBox[]
}

/** 融易 FVG 活跃区间 (Pine 主图最后模块: 检测/失效/合并后的存活盒子)。 */
export interface RyFvgBox {
  /** 起始 bar 的 date 标签 (未失效区间前端画到末根 — 全量延伸口径) */
  start: string
  min: number
  max: number
  is_bull: boolean
  combined?: boolean
  high_vol?: number
  low_vol?: number
  total_vol?: number
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
  /** 可选: 副图级 visualMap (预留钩子; seriesIndices 为本副图 series 的全局索引) */
  buildVisualMap?: (data: OHLC[], seriesIndices: number[]) => any[] | undefined
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

// ── RSI+ custom series 渲染 (零轴夹域渐变 + 正负突变分色线) ─────────────
//
// 为何不用 line series + areaStyle + visualMap 组合 (2026-10-14 排查记录):
// 1. ECharts 5.5 的 series 渐变 colorStops 锚定「形状包围盒」而非 grid —
//    offset 0.5 只有在 |max|==|min| (数据对称) 时才恰为零轴; 真实行情数据
//    不对称时红绿分界与透明点全部错位 (实验数据对称时"通过"属巧合)。
// 2. piecewise visualMap 对带 areaStyle 的 line series 不产生段落线色
//    (单 grid/多 grid 全变体实测, 线恒为 lineStyle 兜底色); 缺边界的
//    pieces 还会让 getVisualGradient 抛 TypeError。
// 3. convertFromPixel({xAxisIndex}) 单轴 finder 返回 null 的同源问题
//    说明 axis-based 渲染要自己精确控坐标。
// 2026-10-15 二次排查 (线上像素验证发现填充不可见, zrender 活体解剖):
// 3. 「dataIndexInside===0 哨兵 + 闭包全量绘制」在 progressive 分块渲染下
//    灾难性失效: 生产 dataZoom dispatch 触发了分块 (34 元素=17段×2份),
//    首块渲染时轴布局未就绪, api.coord 返回离屏负坐标 (-2379px), 旧分块
//    元素不清除 → 12 段全部画飞在画布左侧外。
// 4. custom series 子元素 style.fill 传 plain-object 渐变不可靠: zrender
//    按包围盒相对坐标解释 (global 缺省 false), 端点落在包围盒倍数空间,
//    取色锚定完全错。正确姿势是 echarts.graphic.LinearGradient 实例 +
//    globalCoord=true (绝对像素锚定; 像素实测: 半透明渐变 26280px/不透明 0)。
// 5. getImageData 非预乘: 半透明填充 RGB 通道仍为原色只是 α 低 — 像素
//    验证必须区分 α 层级, 否则把填充误计为不透明线。
//
// 最终架构: 逐数据项 renderItem — 每项只画 (前项→本项) 线段 + 其零轴夹域
// 梯形; 无跨项全局假设 → 与 progressive 分块、dataZoom 窗口过滤天然兼容;
// 穿零段插值交点, 红绿子段共享交点 (连续无断口); 线为直线段 (该密度下
// 与 catmull-rom 视觉无差, TV LC 参考亦为直线段)。
// R5 附图能量柱五色 (2026-10-25 用户指定改用平台原有色板 THEME.bull #C74040 / bear #2D9B65,
// 原Pine色 #C71C31/#75BD42 系偏鲜艳; 明暗层级关系保留: 深色=能量确认/浅色=回落回升)
// 正柱=红系 / 负柱=绿系; 增长/回落 × 动能快线(RSI28 EMA5) <50/>=50
const RY5_BAR_UP = '#C74040'          // 正柱增长且 vf≥50 (能量确认, 平台红)
const RY5_BAR_UP_L = '#E9B3B3'        // 正柱回落且 vf≥50 (浅红)
const RY5_BAR_GRAY = '#AEAAAA'        // 正柱增长 vf<50 / 负柱下探 vf≥50 (反常区)
const RY5_BAR_LGRAY = '#E7E6E6'       // 正柱回落 vf<50 / 负柱回升 vf≥50
const RY5_BAR_DOWN_L = '#ABD7C1'      // 负柱回升且 vf<50 (浅绿)
const RY5_BAR_DOWN = '#2D9B65'        // 负柱下探且 vf<50 (能量确认, 平台绿)
// R5 资金流曲线/填充 (多空色按平台色板, 2026-10-25)
const RY5_FUND_LINE_BULL = 'rgba(199,64,64,0.8)'    // state2 段 (平台红 t20)
const RY5_FUND_LINE_BEAR = 'rgba(45,155,101,0.8)'   // state0/1 段 (平台绿 t20)
const RY5_FUND_LINE_WARN = 'rgba(255,235,59,0.8)'   // state3/4 段 (黄 t20)
const RY5_FUND_BULL = [199, 64, 64] as const
const RY5_FUND_BEAR = [45, 155, 101] as const

/** RSI+ 序列 → custom series (逐项绘制: state 分色线段 + 零轴夹域能量梯形)
 *  Pine 附图口径: 线色 fund_rsi_line_color (state3/4 黄 / state2 绿 / 其余红);
 *  填充基色 fund_base_color (state2/3 绿 / 其余红), 透明度按 |fund_rsi×3| 强度
 *  (f_energyGradientColor: transp = 99 − min(1,|v|)×99, 越强越不透明)。 */
function buildRsiPlusSeries(data: OHLC[]): Record<string, any> {
  const vals = data.map(d => d.rsi_plus != null ? Number(d.rsi_plus) : null)
  const states = data.map(d => d.fund_tracking_state ?? 0)
  const lineColorOf = (st: number) =>
    st === 3 || st === 4 ? RY5_FUND_LINE_WARN
      : st === 2 ? RY5_FUND_LINE_BULL : RY5_FUND_LINE_BEAR
  const fillOf = (st: number, v: number) => {
    const [r, g, b] = st === 2 || st === 3 ? RY5_FUND_BULL : RY5_FUND_BEAR
    const a = Math.max(0, Math.min(1, Math.abs(v * 3)))
    return `rgba(${r},${g},${b},${((99 - a * 99) / 100).toFixed(3)})`
  }
  const renderItem = (params: any, api: any) => {
    // 逐项自绘: 每个数据项只画 (前项→本项) 的线段及其零轴夹域梯形。
    // 无跨项全局假设 → progressive 分块渲染下每块自洽, 不依赖轴在首块时
    // 已就绪; dataZoom 窗口外的项被 echarts 过滤, 窗口内首项的左段由
    // clip 裁剪, 均天然正确。dataIndex 用原始索引取闭包 vals (窗口内
    // dataIndexInside 与 dataIndex 不同, 取值必须用原始索引)。
    const di = params.dataIndex
    if (di <= 0) return
    const prevV = vals[di - 1]
    const curV = vals[di]
    if (prevV == null || curV == null) return

    const [x1, y1] = api.coord([di - 1, prevV])
    const [x2, y2] = api.coord([di, curV])
    const zeroY = api.coord([0, 0])[1]

    // 穿零处直线插值交点 → 子段共享交点 (连续无断口); 未穿零单段
    const segs: { ax: number; ay: number; bx: number; by: number }[] = []
    if ((y1 <= zeroY) !== (y2 <= zeroY)) {
      const t = (y1 - zeroY) / (y1 - y2)
      const xc = x1 + (x2 - x1) * t
      segs.push(
        { ax: x1, ay: y1, bx: xc, by: zeroY },
        { ax: xc, ay: zeroY, bx: x2, by: y2 },
      )
    } else {
      segs.push({ ax: x1, ay: y1, bx: x2, by: y2 })
    }

    const st = states[di] ?? 0
    const fill = fillOf(st, curV)
    const children: any[] = []
    for (const s of segs) {
      // 填充: (前点, 当前点, 当前点@零轴, 前点@零轴) 梯形 (零轴夹域)
      children.push({
        type: 'polygon',
        shape: { points: [[s.ax, s.ay], [s.bx, s.by], [s.bx, zeroY], [s.ax, zeroY]] },
        style: { fill }, silent: true, z: 1,
      })
      // 线段: 按 fund_tracking_state 逐段着色 (Pine fund_rsi_line_color)
      children.push({
        type: 'line',
        shape: { x1: s.ax, y1: s.ay, x2: s.bx, y2: s.by },
        style: { stroke: lineColorOf(st), lineWidth: 2 },
        silent: true, z: 3,
      })
    }
    return { type: 'group', children }
  }

  return {
    name: 'RSI+',
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    data: vals.map((v, i) => [i, v]),
    renderItem,
    clip: true, silent: true, animation: false, z: 3,
    // 共享零轴灰线 (多空分界: RSI+>0 ⟺ 价在 EMA26 上方) — 挂 custom series 上
    markLine: {
      silent: true, symbol: 'none', animation: false,
      data: [{ yAxis: 0 }],
      lineStyle: { color: 'rgba(156,163,175,0.6)', width: 1 },
      label: { show: false },
    },
  }
}

// ── 资金流信号层 (R5) — Pine 附图 line 204-209 原色一比一 (交叉色 2026-10-24 按 A 股反转): ──
//   超卖低位(bg=1) 暗红 rgb(133,19,32) t80 / 超买高位(bg=2) 暗青 rgb(24,96,90) t80;
//   B 交叉(上穿下轨) #FF5252 t40 红背景 / S 交叉(下穿上轨) #26A69A t40 青绿背景;
//   B/S 字母白色 (plotchar color=white)。
const FUND_BG_LOW = 'rgba(149,48,48,0.2)'
const FUND_BG_HIGH = 'rgba(34,116,76,0.2)'
const FUND_CROSS_B = 'rgba(199,64,64,0.4)'
const FUND_CROSS_S = 'rgba(45,155,101,0.4)'
const FUND_LETTER_B = '#FFFFFF'
const FUND_LETTER_S = '#FFFFFF'
// (主图 fund 背景常量已删: Pine 主图 GLOBAL_SHOW_*=false, TV 主图无 fund 背景)
// 主图信号/背景/字母三件套只在附图 (buildFundOverlaySeries) 渲染

/** fund 行背景色 (交叉事件优先于状态背景)。 */
function fundRowBg(d: OHLC): string | null {
  if (d.fund_cross_up_lower === true) return FUND_CROSS_B
  if (d.fund_cross_down_upper === true) return FUND_CROSS_S
  if (d.fund_bg_color === 1) return FUND_BG_LOW
  if (d.fund_bg_color === 2) return FUND_BG_HIGH
  return null
}

/** 数据是否携带 fund 信号字段 (旧数据/无 plus 附着时背景层不渲染)。 */
function hasFundSignal(data: OHLC[]): boolean {
  return data.some(d => d.fund_bg_color != null
    || d.fund_cross_up_lower === true || d.fund_cross_down_upper === true)
}

/** 资金流副图叠加层: 逐行背景色条 + S/B 信号字母 (custom series 自绘)。
 *  每个数据项只画本根的背景与字母 → progressive 分块 / dataZoom 窗口过滤天然兼容。 */
function buildFundOverlaySeries(data: OHLC[]): Record<string, any> {
  const renderItem = (params: any, api: any) => {
    const di = params.dataIndex
    const d = data[di]
    if (!d) return undefined
    const cs = params.coordSys
    const children: any[] = []
    const bg = fundRowBg(d)
    if (bg) {
      // 单根背景条: 类目单位宽 (重叠 1px 防缝隙, 相邻同色视觉连片)
      const [cx] = api.coord([di, 0])
      const barW = api.size?.([1, 0])?.[0] ?? 6
      children.push({
        type: 'rect',
        shape: { x: cx - barW / 2 - 0.5, y: cs.y, width: barW + 1, height: cs.height },
        style: { fill: bg }, silent: true, z: 0,
      })
    }
    // 字母: B 贴 grid 底 / S 贴 grid 顶 (Pine location 语义)
    if (d.fund_cross_up_lower === true) {
      children.push({
        type: 'text',
        style: {
          text: 'B', x: api.coord([di, 0])[0], y: cs.y + cs.height - 2,
          fill: FUND_LETTER_B, font: 'bold 10px JetBrains Mono, monospace',
          textAlign: 'center', textVerticalAlign: 'bottom',
        },
        silent: true, z: 10,
      })
    }
    if (d.fund_cross_down_upper === true) {
      children.push({
        type: 'text',
        style: {
          text: 'S', x: api.coord([di, 0])[0], y: cs.y + 2,
          fill: FUND_LETTER_S, font: 'bold 10px JetBrains Mono, monospace',
          textAlign: 'center', textVerticalAlign: 'top',
        },
        silent: true, z: 10,
      })
    }
    return children.length > 0 ? { type: 'group', children } : undefined
  }
  return {
    name: 'fund信号',
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    data: data.map((_, i) => [i, 0]),
    renderItem,
    clip: true, silent: true, animation: false, z: 0,
  }
}

// ── 融易主图 (R5) 渲染色 (2026-10-25 用户指定: 红绿改用平台原有色板) ──────
const RY_CHANNEL = '#FACC15'                 // 牛熊通道三线 (黄)
// 十字线 (第 32 轮调优): 主题 crosshair alpha 0.35 → 1px 虚线在深底上有效亮度
// 仅 ~0.09, 水平线肉眼难辨 (第 27 轮补的联动水平线形同虚设); 提亮到 0.6
// (亮度 ~0.16, 仍低于网格/文字元素)。仅图表模块, 不动全局 theme.crosshair。
const RY_CROSSHAIR = 'rgba(148,163,184,0.6)'
// ↓ 融易多空色系: 2026-10-24 按 A 股红涨绿跌反转语义; 2026-10-25 用户指定
//   色值从 Pine 原值 (#FF5252/#26A69A/#C71C31/#75BD42 系) 换为平台色板
//   (#C74040 红 / #2D9B65 绿), 主副图红绿全局统一
const RY_MID_BULL = '#C74040'                // 中轨多头色 (平台红)
const RY_MID_BEAR = '#2D9B65'                // 中轨空头色 (平台绿)
const RY_MID_FLAT = 'rgba(156,163,175,0.5)'  // 中轨零值色 (灰 t50, Pine color.new(gray,50))
const RY_K_BULL = 'rgba(199,64,64,0.7)'      // K 通道多头线 (平台红; 用户要求 2026-10-25 可见浓度 0.7)
const RY_K_BEAR = 'rgba(45,155,101,0.7)'     // K 通道空头线 (平台绿; 同上)
const RY_K_FILL_BULL = 'rgba(199,64,64,0.2)' // K fill(ohlc4↔轨道) 多头 (t80; 用户要求 2026-10-25 恢复)
const RY_K_FILL_BEAR = 'rgba(45,155,101,0.2)'
const RY_BAR_BULL = '#C74040'                // K 线着色多头 (通道上方, 平台红)
const RY_BAR_BEAR = '#2D9B65'                // K 线着色空头 (通道下方, 平台绿)
const RY_BAR_FLAT = '#AEAAAA'                // K 线着色通道内 (灰)
const RY_DIV_TOP_BG = '#000080'              // 顶部背离标签底 (Pine color.navy)
const RY_DIV_BTM_BG = '#FFEB3B'              // 底部背离标签底 (Pine color.yellow)
// FVG 盒子 (Pine renderFVG 原色: 主盒 #87878788 t×1.5/×1.1; 量能子盒 bull/bear t40)
const FVG_MAIN = 'rgba(135,135,135,0.30)'         // 主盒 (t70 ≈ 透明度 30%)
const FVG_MAIN_COMBINED = 'rgba(135,135,135,0.49)' // 合并区间主盒 (t×1.1 ≈ 49%)
const FVG_POS = 'rgba(199,64,64,0.40)'            // 量能子盒上半 (多头缺口, 平台红)
const FVG_NEG = 'rgba(45,155,101,0.40)'           // 量能子盒下半 (空头缺口, 平台绿)

// ── Y 轴双向缩放 (第 33 轮重构: pad 方案, 替代第 31 轮池化) ──
// 用户需求纠偏: ① 默认大小必须与池化前完全一致 (轴=窗口数据贴身, 不预放大);
// ② 缩小方向"无限小" (池化方案上限只有 2×); ③ 放大保持可用。
// 机制: 默认 yZoom 窗口 [0,100] + 无 pad → 轴=窗口数据范围 (filter 模式下 min/max
// 函数收到 X 窗口内数据范围); 刻度带下滚 → yPadRef 记录轴 padding (以鼠标锚扩展,
// 无上限) → K 线无限变小; 上滚先消 pad 再收 dataZoom 窗口 (filter 让轴跟随窗口数据)。
// 池化方案废弃原因: ① 默认窗口预收窄到 94% (观感=预放大); ② filterMode:'none' 使
// min/max 函数收到全历史范围 (4h 图 Y 轴顶到全历史高点 1367, 窗口数据被压 ~86%)。

/** FVG 活跃区间渲染 (Pine 一比一): 主灰盒从起点延伸到末根 + 左 1/3 量能子盒
 *  (上半 bull 色/high_vol 宽, 下半 bear 色/low_vol 宽, mirror 口径均从左端起)。 */
function buildRyFvgSeries(data: OHLC[], dateIndexMap: Map<string, number>): Record<string, any> {
  const lastIdx = data.length - 1
  const boxes = (data[lastIdx]?.fvg_list ?? [])
    .filter((b: RyFvgBox) => b.start != null && b.min != null && b.max != null)
  const resolveIdx = (start: string): number => {
    const exact = dateIndexMap.get(start)
    if (exact != null) return exact
    // 日K→4h 标签前缀对齐 / 起点在视野左外时夹到首根 (盒子从左缘进入)
    for (let i = 0; i < data.length; i++) {
      if (data[i].date >= start) return i
    }
    return 0
  }
  const renderItem = (params: any, api: any) => {
    const b = boxes[params.dataIndex]
    if (!b) return
    const s = resolveIdx(b.start)
    const x1 = api.coord([s, b.max])[0]
    const x2 = api.coord([lastIdx, b.max])[0]
    const yMax = api.coord([s, b.max])[1]
    const yMin = api.coord([s, b.min])[1]
    const mid = (yMax + yMin) / 2
    const left = Math.min(x1, x2)
    const width = Math.abs(x2 - x1)
    const children: any[] = [{
      type: 'rect',
      shape: { x: left, y: yMax, width, height: yMin - yMax },
      style: { fill: b.combined ? FVG_MAIN_COMBINED : FVG_MAIN }, silent: true, z: 1,
    }]
    const tv = Number(b.total_vol) || 0
    if (tv > 0) {
      const w3 = width / 3  // volumeBarsLeftSide: 量能子区占区间左 1/3
      const wPos = (Number(b.high_vol) || 0) / tv * w3
      const wNeg = (Number(b.low_vol) || 0) / tv * w3
      children.push({
        type: 'rect', shape: { x: left, y: yMax, width: wPos, height: mid - yMax },
        style: { fill: FVG_POS }, silent: true, z: 2,
      })
      children.push({
        type: 'rect', shape: { x: left, y: mid, width: wNeg, height: yMin - mid },
        style: { fill: FVG_NEG }, silent: true, z: 2,
      })
    }
    return { type: 'group', children }
  }
  return {
    name: 'FVG', type: 'custom', coordinateSystem: 'cartesian2d',
    // x 占位必须用末根索引: ECharts 按 dataZoom 窗口剔除窗口外的数据项 (renderItem
    // 不触发) — 盒子索引 0/1/2 会被默认右侧窗口整批剔除 → 灰盒不渲染 (echarts 5.6
    // SSR 实测 0 次回调)。末根在默认视图/范围档/右缘缩放下都在窗口内; 深度左移浏览
    // 历史时 FVG 隐藏 (区间语义为延伸到末根的活跃区, 可接受)。
    // y 维 '-' 空值不参与轴 extent (占位 0 会拉爆 Y 轴 — 同 ry fill 教训)
    data: boxes.map(() => [lastIdx, '-']),
    renderItem, clip: true, silent: true, animation: false, z: 1,
  }
}

/** K/K2/K3 趋势填充 (Pine fill(ohlc4, 轨道)): 多头 ohlc4↔up / 空头 ohlc4↔dn 梯形,
 *  趋势切换段不画 (linebr 语义)。同段趋势连续填充视觉连片。
 *  (2026-10-25 曾按用户指令移除, 同日用户澄清要保留效果仅去悬停轴标签蓝底高亮, 恢复) */
function buildRyTrendFillSeries(
  data: OHLC[],
  trendKey: 'k_trend' | 'k2_trend' | 'k3_trend',
  upKey: 'k_up' | 'k2_up' | 'k3_up',
  dnKey: 'k_dn' | 'k2_dn' | 'k3_dn',
  bull: string, bear: string,
): Record<string, any> {
  const ohlc4 = (d: OHLC) => (d.open != null && d.high != null && d.low != null && d.close != null
    ? (Number(d.open) + Number(d.high) + Number(d.low) + Number(d.close)) / 4 : null)
  const renderItem = (params: any, api: any) => {
    const di = params.dataIndex
    if (di <= 0) return
    const d = data[di]
    const p = data[di - 1]
    const tr = d[trendKey]
    const ptr = p[trendKey]
    if (tr == null || ptr == null || tr !== ptr) return
    const track = tr === 1 ? upKey : dnKey
    const a0 = p[track]
    const a1 = d[track]
    const m0 = ohlc4(p)
    const m1 = ohlc4(d)
    if (a0 == null || a1 == null || m0 == null || m1 == null) return
    const [x1, y1a] = api.coord([di - 1, a0])
    const [x2, y2a] = api.coord([di, a1])
    const [, y1m] = api.coord([di - 1, m0])
    const [, y2m] = api.coord([di, m1])
    return {
      type: 'polygon',
      shape: { points: [[x1, y1m], [x2, y2m], [x2, y2a], [x1, y1a]] },
      style: { fill: tr === 1 ? bull : bear }, silent: true, z: 1,
    }
  }
  return {
    name: `${trendKey}Fill`, type: 'custom', coordinateSystem: 'cartesian2d',
    // data y 维用 '-' (ECharts 空值): 不参与 Y 轴 extent — 占位 0 会把主图
    // Y 轴拉爆到含 0 (与中轨 encode.y 同源教训); renderItem 取值走闭包 data
    data: data.map((_, i) => [i, '-']), renderItem,
    clip: true, silent: true, animation: false, z: 1,
  }
}

/** 中轨刻度竖线 custom series (每根 ema±tick 短竖线, 分段色)。 */
function buildRyMidTickSeries(data: OHLC[]): Record<string, any> {
  const renderItem = (params: any, api: any) => {
    const di = params.dataIndex
    const d = data[di]
    if (!d || d.ry_ema_mid == null || d.ry_mid_tick == null || d.ry_mid_tick <= 0) return
    const color = d.macd_plus_dif != null && d.macd_plus_hist != null
      ? (Number(d.macd_plus_dif) > 0 && Number(d.macd_plus_hist) > 0 ? RY_MID_BULL
        : Number(d.macd_plus_dif) < 0 && Number(d.macd_plus_hist) < 0 ? RY_MID_BEAR : RY_MID_FLAT)
      : RY_MID_FLAT
    const [x] = api.coord([di, d.ry_ema_mid])
    const [, yTop] = api.coord([di, d.ry_ema_mid + d.ry_mid_tick])
    const [, yBot] = api.coord([di, d.ry_ema_mid - d.ry_mid_tick])
    return {
      type: 'line',
      shape: { x1: x - 1, y1: yTop, x2: x - 1, y2: yBot },
      style: { stroke: color, lineWidth: 2, opacity: 0.55 },
      silent: true, z: 1,
    }
  }
  return {
    name: '中轨刻度',
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    // null 值不参与 Y 轴范围 (?? 0 会把轴拉到 0)
    data: data.map((d, i) => [i, d.ry_ema_mid ?? null]),
    renderItem,
    clip: true, silent: true, animation: false, z: 1,
  }
}

/** 数据是否携带融易主图字段 (无附着时不渲染叠加层)。 */
function hasRyMain(data: OHLC[]): boolean {
  return data.some(d => d.ry_mid != null || d.k_up != null)
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
  // ── 私有化指标 (MACD+ / RSI+) — 算法为 R5 经典版附图口径 (服务端 plus.py),
  //    视觉样式遵从平台规范配色 (黄/紫双线 + 正红负绿柱; 资金流 ±1 量程):
  //    数据口径与源指标一致, 仅渲染风格与全站统一。 ──
  {
    key: 'macd_plus',
    label: 'MACD+',
    height: 72,
    buildSeries: (data) => [
      {
        name: 'DIF+',
        type: 'line',
        data: data.map(d => d.macd_plus_dif != null ? Number(d.macd_plus_dif) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 2, color: 'rgba(255,255,255,0.8)' },   // Pine 能量场快线 (白 t20)
        itemStyle: { color: 'rgba(255,255,255,0.8)' },
      },
      {
        name: 'DEA+',
        type: 'line',
        data: data.map(d => d.macd_plus_dea != null ? Number(d.macd_plus_dea) : '-'),
        smooth: true, symbol: 'none', animation: false,
        lineStyle: { width: 2, color: 'rgba(255,235,59,0.8)' },    // Pine 能量场慢线 (黄 t20)
        itemStyle: { color: 'rgba(255,235,59,0.8)' },
      },
      {
        name: 'MACD+',
        type: 'bar',
        data: data.map((d, i) => {
          const v = d.macd_plus_hist
          if (v == null) return '-'
          // R5 能量柱五色 (Pine 附图 line 146 一比一): 增长/回落 × 动能快线(RSI28 EMA5) 50 阈
          // prev=na (首根/断档) → Pine na 比较恒 false → 回落色 (非增长)
          const num = Number(v)
          const vf = d.volume_rsi_fast != null ? Number(d.volume_rsi_fast) : null
          const pv = i > 0 && data[i - 1].macd_plus_hist != null ? Number(data[i - 1].macd_plus_hist) : null
          const growing = pv != null ? pv < num : false
          const vfLow = vf != null && vf < 50
          let color: string
          if (num >= 0) {
            color = growing
              ? (vfLow ? RY5_BAR_GRAY : RY5_BAR_UP)
              : (vfLow ? RY5_BAR_LGRAY : RY5_BAR_UP_L)
          } else {
            color = growing
              ? (vfLow ? RY5_BAR_DOWN_L : RY5_BAR_LGRAY)
              : (vfLow ? RY5_BAR_DOWN : RY5_BAR_GRAY)
          }
          return { value: num, itemStyle: { color } }
        }),
        barWidth: '40%',
        animation: false,
        // 共享零轴灰线 (能量柱正负分界)
        markLine: {
          silent: true, symbol: 'none', animation: false,
          data: [{ yAxis: 0 }],
          lineStyle: { color: 'rgba(156,163,175,0.6)', width: 1 },
          label: { show: false },
        },
      },
      // 资金流信号叠加层 (背景色块 + S/B 字母; 数据无 fund 字段时不渲染)
      ...(hasFundSignal(data) ? [buildFundOverlaySeries(data)] : []),
    ],
    buildInfo: (d) => {
      if (!d) return []
      // 行序对齐 TV 图例 (2026-10-23 周线已收盘 bar 实证: TV 显示顺序 = 能量柱/DIF/DEA,
      // 我们 (dif,dea,hist)=(-16.08,-24.97,59.73) 与 TV (-16.08,-24.97,59.73) 精确一致)
      return [
        { label: '能量柱', color: d.macd_plus_hist != null && d.macd_plus_hist >= 0 ? '#C74040' : '#2D9B65', value: d.macd_plus_hist != null ? d.macd_plus_hist.toFixed(2) : '—' },
        { label: 'DIF+', color: '#FFFFFF', value: d.macd_plus_dif != null ? d.macd_plus_dif.toFixed(2) : '—' },
        { label: 'DEA+', color: '#FFEB3B', value: d.macd_plus_dea != null ? d.macd_plus_dea.toFixed(2) : '—' },
      ]
    },
  },
  {
    key: 'rsi_plus',
    label: 'RSI+',
    height: 72,
    // 资金流 ±1 量程 (RSI14 归一化) — Y 轴自适应 (TV 实测左日线 -0.60~0.40 /
    // 右周线 -0.40~0.40, 随数据范围自动定界, 不固定 ±1)
    buildSeries: (data) => {
      const fundLine = buildRsiPlusSeries(data)
      // 零轴灰线 (Pine hline 资金流零轴); ±0.4 多空轨道不画 — Pine
      // display=OPEN_FUND_TRACKING_FILTER ? all : none 且默认 false,
      // TV 实拍副图仅虚线网格无白色实线轨道 (复刻对拍 2026-10-23 定案)
      fundLine.markLine = {
        silent: true, symbol: 'none', animation: false,
        data: [
          { yAxis: 0, lineStyle: { color: 'rgba(156,163,175,0.6)', width: 1 } },
        ],
        label: { show: false },
      }
      return [
        fundLine,
        // 资金流信号叠加层 (背景色块 + S/B 字母)
        ...(hasFundSignal(data) ? [buildFundOverlaySeries(data)] : []),
      ]
    },
    buildInfo: (d) => {
      if (!d) return []
      const v = d.rsi_plus
      // 信息栏同步正负分色 (与 MACD+ 能量柱信息栏同款深红绿)
      const c = v != null && v >= 0 ? '#C74040' : '#2D9B65'
      const items: { label: string; color: string; value: string }[] = [
        { label: 'RSI+', color: c, value: v != null ? v.toFixed(2) : '—' },
      ]
      // 2026-10-25 用户指定: 高位标识与 S/B 交叉提示从值显示去除, 只留 RSI+ 数值
      // (低位/超卖标识保留; 图内 S/B 字母与背景条为图元渲染, 不属值显示)
      if (d.fund_bg_color === 1) items.push({ label: '低位', color: '#C74040', value: '超卖' })
      return items
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

/** 主图叠加指标 (画在 K 线上方, 不占副图空间) — 融易主图拆五层独立开关
 *  (ry_channel/ry_mid/ry_k/ry_k2/ry_k3, 见 useChartLayout RY_MAIN_KEYS)。 */
export const OVERLAY_INDICATORS: { key: string; label: string }[] = [
  { key: 'boll', label: 'BOLL' },
  { key: 'ry_channel', label: '牛熊分界线' },
  { key: 'ry_mid', label: '中轨' },
  { key: 'ry_k', label: '波段' },
  { key: 'ry_k2', label: '趋势' },
  { key: 'ry_k3', label: '战略' },
]

/** 融易主图五层 key (信息栏/叠加段共用; 与 useChartLayout.RY_MAIN_KEYS 同源)。 */
const RY_INFO_KEYS: readonly string[] = ['ry_channel', 'ry_mid', 'ry_k', 'ry_k2', 'ry_k3']

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
  /** R5 梯形菱形信号 (ry_top_signal/ry_btm_signal) 显隐, 默认开 (Pine 无独立开关, 工作台 UI 层控制) */
  showRyDiamond?: boolean
  /** R5 多指标背离方块 (div_top_count/div_btm_count) 显隐, 默认开 */
  showRyDivergence?: boolean
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
      // 右上角 (right 112 = 108px Y 轴刻度区 + 4px 留白), 不与刻度数字重叠;
      // TV 观感: 指标名在左上, 指标值在右上贴轴
      right: 112,
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
  showRyDiamond: boolean,
  showRyDivergence: boolean,
  xLabelMetrics: { current: { axisWidth: number; visibleCount: number; containerWidth: number } },
  symbol: string | undefined,
  yPadMap: Map<number, { lo: number; hi: number }>,
): EChartsOption {
  // 融易主图五层独立开关 (对齐 Pine OPEN_*): 任一层开 = 指标加载 (K 线着色/
  // 菱形/背离跟随, Pine 无独立开关); 主图 fund 背景不叠加 (Pine 主图 GLOBAL_SHOW_*=false)
  const ryOn = (k: string) => activeIndicators.includes(k)
  const showRYChannel = ryOn('ry_channel')
  const showRYMid = ryOn('ry_mid')
  const showRYK = ryOn('ry_k')
  const showRYK2 = ryOn('ry_k2')
  const showRYK3 = ryOn('ry_k3')
  const showRYOverlay = (showRYChannel || showRYMid || showRYK || showRYK2 || showRYK3) && hasRyMain(data)
  // 融易主图着色: close 相对牛熊通道位置 (多头/空头/通道内灰), 覆盖默认红绿
  const candleData = showRYOverlay
    ? data.map(d => {
        const v = [d.open, d.close, d.low, d.high]
        const c = d.ry_bar_color ?? 0
        const col = c > 0 ? RY_BAR_BULL : c < 0 ? RY_BAR_BEAR : RY_BAR_FLAT
        return {
          value: v,
          itemStyle: {
            color: chartStyle === 'hollow' ? 'transparent' : col,
            color0: chartStyle === 'hollow' ? 'transparent' : col,
            borderColor: col, borderColor0: col,
          },
        }
      })
    : data.map(d => [d.open, d.close, d.low, d.high])

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
  const left = 46
  // 右侧轴区 108px: 容纳双段式现价标签 (~98px + 边距) 完整显示不裁切
  // (2026-10-25 修复: 原 60px 时标签被右侧裁掉 ~45px, "600519 13" 后不可见)
  const right = 108
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
  // Y 轴双向缩放 (第 33 轮 pad 方案, 见常量区注释): 默认轴范围 = 窗口数据贴身
  // (min/max 函数直返 ECharts 传入的窗口数据范围, 不再加 pad);
  // 刻度带下滚扩大轴范围 (yPadRef 记录 padding, 无上限 = 无限小), 上滚反向收缩,
  // pad 归零后继续放大走 dataZoom 窗口收窄。priceLines 并入数据范围。
  const axisMin = ({ min, max }: { min: number; max: number }) => {
    const pad = yPadMap.get(0)
    const lo = priceLineValues.length > 0 ? Math.min(min, ...priceLineValues) : min
    const hi = priceLineValues.length > 0 ? Math.max(max, ...priceLineValues) : max
    return pad ? lo - (hi - lo) * pad.lo : lo
  }
  const axisMax = ({ min, max }: { min: number; max: number }) => {
    const pad = yPadMap.get(0)
    const lo = priceLineValues.length > 0 ? Math.min(min, ...priceLineValues) : min
    const hi = priceLineValues.length > 0 ? Math.max(max, ...priceLineValues) : max
    return pad ? hi + (hi - lo) * pad.hi : hi
  }

  // ===== grid 0: K线主图 =====
  grids.push({ left, right, top: topPad, height: candleAvail })
  // ===== X 轴 TV 式刻度 (2026-10-22 对齐 TradingView 底轴) =====
  // TV 规则: 月内刻度 = 日数字 (无前导零), 跨月首根 = "M月", 跨年首根 = "YYYY";
  // 边界点恒显示, 普通点按 stride 锚定数据索引 (index 固定 → 平移时刻度跟着 bar 走)。
  // SSR 实测 (repro_xaxis_interval.mjs): axisLabel.interval 的 index = 绝对数据索引
  // (仅对窗口内 bar 顺序调用, dataZoom 后重新调用); axisLabel.formatter 的 index =
  // 相对窗口索引 (不可用于定位数据!) → formatter 必须用第一参数 (date 原文) 查 Map。
  const xLabelOf = new Map<string, string>()
  const xBoundary = new Set<number>()
  {
    let prevDay = ''
    dates.forEach((d, i) => {
      const s = String(d)
      const day = s.slice(0, 10)
      if (!prevDay) {
        xLabelOf.set(s, String(parseInt(day.slice(8, 10), 10)))
      } else if (day.slice(0, 4) !== prevDay.slice(0, 4)) {
        xLabelOf.set(s, day.slice(0, 4))
        xBoundary.add(i)
      } else if (day.slice(0, 7) !== prevDay.slice(0, 7)) {
        xLabelOf.set(s, `${parseInt(day.slice(5, 7), 10)}月`)
        xBoundary.add(i)
      } else {
        xLabelOf.set(s, String(parseInt(day.slice(8, 10), 10)))
      }
      prevDay = day
    })
  }
  xAxes.push({
    type: 'category', data: dates, boundaryGap: true,
    axisLine: { lineStyle: { color: CT().border } },
    axisLabel: {
      color: CT().text, fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
      formatter: (v: string) => xLabelOf.get(String(v)) ?? String(v),
      interval: (index: number) => {
        if (xBoundary.has(index)) return true
        const m = xLabelMetrics.current
        const barW = m.axisWidth / Math.max(m.visibleCount, 1)
        const stride = Math.max(2, Math.round(72 / Math.max(barW, 1)))
        if (index % stride !== 0) return false
        return !xBoundary.has(index - 1) && !xBoundary.has(index + 1)
      },
    },
    // 十字悬浮标签: TV 格式 "周五 2026-10-09 09:30" (星期 + 全量日期时间)
    axisPointer: {
      label: {
        formatter: (p: { value: unknown }) => {
          const s = String(p.value)
          const day = s.slice(0, 10)
          const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
            new Date(`${day}T00:00:00+08:00`).getDay()
          ]
          return `${wd} ${s}`
        },
      },
    },
    axisTick: { show: false },
    splitLine: { show: false },
  })
  yAxes.push({
    scale: true,
    position: 'right',
    min: axisMin,
    max: axisMax,
    // 上下边距由默认 Y 窗口 (数据±3%) 提供; 显式 min/max 下 boundaryGap 不生效故移除
    splitArea: { show: false },
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: CT().grid } },
    // TV 格式: 千分位 + 2 位小数 ("1,325.00") — 像素级校对 (2026-10-22)
    axisLabel: {
      color: CT().text, fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
      formatter: (v: number) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    },
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

  // (主图 fund 背景已删: Pine 主图 GLOBAL_SHOW_BG/CROSS_HIGHLIGHTS = false,
  //  TV 主图无 fund 背景/交叉条/B·S 字母 — 该三件套只在附图 RSI+/MACD+ 副图渲染)

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
  // 双段式 (左深色代码段 + 右浅色价格段, 涨青/跌红两套, 像素级校对 2026-10-22),
  // 实时行 (is_live) 前缀 ● 徽记 — 盯盘第一视觉锚点。
  const lastBar = data[data.length - 1]
  if (lastBar != null && Number.isFinite(lastBar.close)) {
    const prevBar = data[data.length - 2]
    const lastUp = prevBar != null && Number.isFinite(prevBar.close)
      ? lastBar.close >= prevBar.close
      : true
    const liveBadge = lastBar.is_live === true ? '●' : ''
    const codeText = `${liveBadge}${(symbol ?? '').split('.')[0]}`
    const deepBg = lastUp ? '#953030' : '#22744C'   // 代码段 (深红=涨/深绿=跌, 平台色板暗阶)
    const liteBg = lastUp ? '#C74040' : '#2D9B65'   // 价格段 (平台红=涨/平台绿=跌)
    markLineData.push({
      yAxis: lastBar.close,
      symbol: 'none',
      lineStyle: { color: lastUp ? THEME.bull : THEME.bear, type: 'dashed', width: 1, opacity: 0.5 },
      label: {
        show: true,
        formatter: `{c|${codeText}}{p|${lastBar.close.toFixed(2)}}`,
        position: 'end',
        rich: {
          c: {
            color: '#FFFFFF', backgroundColor: deepBg,
            padding: [3, 2, 3, 5], fontSize: 9,
            fontFamily: 'JetBrains Mono, monospace',
            borderRadius: [2, 0, 0, 2],
          },
          p: {
            color: '#FFFFFF', backgroundColor: liteBg,
            padding: [2, 5, 2, 2], fontSize: 10, fontWeight: 'bold',
            fontFamily: 'JetBrains Mono, monospace',
            borderRadius: [0, 2, 2, 0],
          },
        },
      },
    })
  }

  // 外部绘图层 (图表工作台 DrawingToolbar 落定的图形): 数据坐标锚定, 缩放/平移后自动重定位;
  // 跨周期共享时锚点按日级降级映射 (dateIndexMap 精确失败 → 该日首根, 传 dates 供渲染锚替换)
  // vline (垂直线) 的副图联动副本: 挂到每个激活副图的 series 上同步显示 (时间轴共享)
  let subVlineMarks: any[] = []
  if (externalDrawings && externalDrawings.length > 0) {
    const drawMarks = drawingsToMarks(externalDrawings, dateIndexMap, dates)
    markLineData.push(...drawMarks.markLine)
    markAreaData.push(...drawMarks.markArea)
    subVlineMarks = drawMarks.subMarkLine
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

  // ===== 融易主图叠加 (R5): 五层独立开关 (Pine OPEN_*) =====
  // (visualMaps 需提前声明: 主图叠加与副图都会注入分段色 visualMap)
  const visualMaps: any[] = []
  if (showRYOverlay) {
    const pushSegVisualMap = (bull: string, bear: string) => {
      visualMaps.push({
        show: false, seriesIndex: series.length - 1, dimension: 1,
        pieces: [
          { min: 1, max: 1, color: bull },
          { min: -1, max: -1, color: bear },
        ],
      })
    }
    // 1. 牛熊通道三条黄线 (牛/牛熊/熊; 牛熊线宽 2) — OPEN_BULL_BEAR_LINE
    if (showRYChannel) {
      const ryChannelLine = (key: keyof OHLC, name: string, width: number) => ({
        name, type: 'line',
        data: data.map(d => (d[key] != null ? Number(d[key]) : '-')),
        smooth: false, symbol: 'none', animation: false, silent: true, z: 2,
        lineStyle: { width, color: RY_CHANNEL }, itemStyle: { color: RY_CHANNEL },
      })
      series.push(ryChannelLine('ry_upper', '牛线', 1))
      series.push(ryChannelLine('ry_mid', '牛熊线', 2))
      series.push(ryChannelLine('ry_lower', '熊线', 1))
    }

    // 2. 中轨 EMA24 (分段色: MACD 快线正负 → 二维 [值, trend] + visualMap) + 每根刻度竖线 — OPEN_MIDDLE_BAND_LINE
    // encode.y=0: Y 轴取第 0 维 (价格); 第 1 维 trend 只供 visualMap 分段色 —
    // 二维 data 默认 y 取末维 (±1) 会把 Y 轴拉爆到 0~价格上限
    if (showRYMid) {
      series.push({
        name: '中轨', type: 'line', z: 2, silent: true, animation: false,
        data: data.map(d => (d.ry_ema_mid != null
          ? [Number(d.ry_ema_mid), (d.ry_mid_trend ?? 0) >= 0 ? 1 : -1] : '-')),
        encode: { y: 0 },
        smooth: false, symbol: 'none',
        lineStyle: { width: 2 },
      })
      pushSegVisualMap(RY_MID_BULL, RY_MID_BEAR)
      series.push(buildRyMidTickSeries(data))
    }

    // 3. K/K2/K3 通道线 (trend=1 画 up 多头线 / -1 画 dn 空头线, 分段色; encode.y=0 同中轨)
    const kChannelLine = (trendKey: keyof OHLC, upKey: keyof OHLC, dnKey: keyof OHLC, name: string) => ({
      name, type: 'line', z: 2, silent: true, animation: false,
      data: data.map(d => {
        const t = d[trendKey] as number | null | undefined
        const v = t === 1 ? d[upKey] : t === -1 ? d[dnKey] : null
        return v == null ? '-' : [Number(v), t === 1 ? 1 : -1]
      }),
      encode: { y: 0 },
      smooth: false, symbol: 'none',
      lineStyle: { width: 2 },
    })
    // — OPEN_K 核心层 / OPEN_K2 趋势层 / OPEN_K3 战略层 —
    if (showRYK) {
      series.push(kChannelLine('k_trend', 'k_up', 'k_dn', '波段'))
      pushSegVisualMap(RY_K_BULL, RY_K_BEAR)
    }
    if (showRYK2) {
      series.push(kChannelLine('k2_trend', 'k2_up', 'k2_dn', '趋势'))
      pushSegVisualMap(RY_K_BULL, RY_K_BEAR)
    }
    if (showRYK3) {
      series.push(kChannelLine('k3_trend', 'k3_up', 'k3_dn', '战略'))
      pushSegVisualMap(RY_K_BULL, RY_K_BEAR)
    }

    // 4. K/K2/K3 趋势填充 (Pine fill(ohlc4, 轨道) t80) — 随各自通道层开关
    if (showRYK) series.push(buildRyTrendFillSeries(data, 'k_trend', 'k_up', 'k_dn', RY_K_FILL_BULL, RY_K_FILL_BEAR))
    if (showRYK2) series.push(buildRyTrendFillSeries(data, 'k2_trend', 'k2_up', 'k2_dn', RY_K_FILL_BULL, RY_K_FILL_BEAR))
    if (showRYK3) series.push(buildRyTrendFillSeries(data, 'k3_trend', 'k3_up', 'k3_dn', RY_K_FILL_BULL, RY_K_FILL_BEAR))

    // 4.5 FVG (公平价值缺口) — Pine 主图模块无独立开关 (恒渲染), 跟随融易主图任一层
    const fvgBoxes = data[data.length - 1]?.fvg_list
    if (fvgBoxes != null && fvgBoxes.length > 0) {
      series.push(buildRyFvgSeries(data, dateIndexMap))
    }

    // 5. 梯形菱形信号 + 多指标背离计数标签 (markPoint)
    //    工作台 UI 开关 (showRyDiamond/showRyDivergence) 控制显隐;
    //    Pine 无独立开关 (恒渲染), 开关属工作台 UI 层 (默认开)。
    data.forEach(d => {
      if (showRyDiamond && d.ry_top_signal === true && d.ry_top_price != null) {
        markPointData.push({
          name: `ryT${d.date}`, coord: [d.date, d.ry_top_price],
          symbol: 'diamond', symbolSize: compact ? 5 : 7, symbolOffset: [0, '-70%'],
          itemStyle: { color: RY_MID_BEAR }, label: { show: false }, z: 100, zlevel: 10,
        })
      }
      if (showRyDiamond && d.ry_btm_signal === true && d.ry_btm_price != null) {
        markPointData.push({
          name: `ryB${d.date}`, coord: [d.date, d.ry_btm_price],
          symbol: 'diamond', symbolSize: compact ? 5 : 7, symbolOffset: [0, '70%'],
          itemStyle: { color: RY_MID_BULL }, label: { show: false }, z: 100, zlevel: 10,
        })
      }
      if (showRyDivergence && d.div_top_count != null && d.div_top_count > 0) {
        markPointData.push({
          name: `dvT${d.date}`, coord: [d.date, d.high],
          symbol: 'rect', symbolSize: [15, 12], symbolOffset: [0, '-130%'],
          itemStyle: { color: RY_DIV_TOP_BG }, z: 100, zlevel: 10,
          label: {
            show: true, formatter: String(d.div_top_count), position: 'inside',
            color: '#FFFFFF', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
          },
        })
      }
      if (showRyDivergence && d.div_btm_count != null && d.div_btm_count > 0) {
        markPointData.push({
          name: `dvB${d.date}`, coord: [d.date, d.low],
          symbol: 'rect', symbolSize: [15, 12], symbolOffset: [0, '130%'],
          itemStyle: { color: RY_DIV_BTM_BG }, z: 100, zlevel: 10,
          label: {
            show: true, formatter: String(d.div_btm_count), position: 'inside',
            color: '#111111', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
          },
        })
      }
    })

    // markPoint 回填: mainMarkExtras 在主 K 线系列创建时求值, 常规图表无 markers
    // → markPointData 当时为空, markPoint 固化为 undefined, 其后 ry 段 push 的
    // 菱形/背离方块全部丢失 (数据有信号但图上不可见)。此处统一补挂;
    // data 传数组引用, 若后续段再 push 也继续生效。
    if (markPointData.length > 0 && series[0] != null && series[0].markPoint == null) {
      series[0].markPoint = { data: markPointData, animation: false }
    }
  }

  // ===== 子图区域 =====
  let curTop = topPad + candleAvail + candleBottomPad
  // (visualMaps 已在融易主图叠加段声明)

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
      // TV 副图实测 (对拍 2026-10-23): RSI+ 4 刻度 (0/-0.2/-0.4/-0.6)、
      // MACD+ 5 刻度 (-40~40 间隔 20) → splitNumber 4; 网格为浅色虚线
      splitNumber: 4,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: CT().grid, type: 'dashed' } },
      axisLabel: {
        show: true, color: CT().text, fontSize: 9,
        fontFamily: 'JetBrains Mono, monospace',
      },
    })

    xAxisIndices.push(xAxisIdx)

    const seriesStart = series.length
    const subSeries = def.buildSeries(data, { compact, volumeCompare, rsiZeroAxis })
    // 垂直线副图联动: vline 挂到本副图首个 series (已有 markLine 如 MACD+ 零轴则合并 data,
    // 条目级 lineStyle/label 覆盖父级, 零轴样式不受影响)
    if (subVlineMarks.length > 0 && subSeries.length > 0) {
      const first = subSeries[0] as any
      const existing = first.markLine
      first.markLine = existing
        ? { ...existing, data: [...(existing.data ?? []), ...subVlineMarks] }
        : { silent: true, symbol: 'none', animation: false, data: subVlineMarks }
    }
    subSeries.forEach((s: any) => {
      series.push({ ...s, xAxisIndex: xAxisIdx, yAxisIndex: yAxisIdx })
    })
    // 副图级 visualMap 机制保留 (seriesIndex 需全局索引, 此处回填);
    // RSI+ 已改 custom series 自绘分色, 当前无副图再走此路径
    const vm = def.buildVisualMap?.(data, Array.from({ length: series.length - seriesStart }, (_, k) => seriesStart + k))
    if (vm) visualMaps.push(...vm)

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
      // filterMode 默认 'filter': x 轴 filter 后数据 = X 窗口内 → min/max 函数收到
      // 窗口数据范围 (贴身默认); 放大第二段 (窗口收窄) 也依赖 filter 让轴跟随窗口数据。
      // (第 31 轮曾设 'none' 配合池化 — 该方案已废, 'none' 会让函数收到全历史范围)
      zoomOnMouseWheel: false,
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
    })
  }

  // 全 series 禁用 hover emphasis (ECharts 5.3+): tooltip axisTrigger 会对命中类目
  // 的 series dispatch highlight, line/candlestick 的 emphasis 重绘走独立合成路径,
  // 1px 线变宽变纯 (牛熊黄线 1px→2px 观感 + 悬停时出现 ~2600 个纯黄像素) —
  // 视觉呈现为『跟随十字的指标高亮』, 用户指定 2026-10-25 去除。仅禁高亮视觉,
  // 鼠标事件/十字联动不受影响。注: hoverLayerThreshold 在 ECharts 5 已移除无效。
  for (const s of series) (s as any).emphasis = { disabled: true }

  return {
    animation: false,
    backgroundColor: THEME.bg,
    tooltip: {
      // richText: 走 canvas 渲染, 无 DOM 依赖 — 手动 dispatch updateAxisPointer (图间十字联动)
      // 时 HTML 模式的 tooltip DOM 为 null 会抛异常, 中断 axisPointer 渲染导致联动十字不显示。
      // 本组件 tooltip 为"隐形设计"(空 formatter, 仅借 tooltip 系统驱动十字光标), richText 无观感差异。
      renderMode: 'richText',
      trigger: 'axis',
      axisPointer: { type: 'cross', crossStyle: { color: RY_CROSSHAIR } },
      backgroundColor: 'transparent',
      borderWidth: 0,
      textStyle: { fontSize: 0 },
      formatter: () => '',
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: {
        // 无底色 (用户指定 2026-10-25): 深蓝底块 (#1E3A8A) 在悬停 K 线正下方形成“高亮块”观感, 取消之;
        // 白字直接落在深色轴带上, 可读性不受影响 (策略页 StrategyNavChart 未动, 保持蓝底)
        backgroundColor: 'transparent',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
      },
    },
    graphic: (() => {
      // X 轴背景带 (TV 底轴色带, 像素级校对 2026-10-22): 主图 grid 下方的标签隔离带
      const g: any[] = []
      const cw = xLabelMetrics.current.containerWidth
      if (cw > 0) {
        g.push({
          type: 'rect', silent: true, z: 0,
          left, top: topPad + candleAvail,
          shape: { width: Math.max(cw - left - right, 50), height: candleBottomPad },
          style: { fill: 'rgba(255,255,255,0.03)' },
        })
      }
      return g.length > 0 || infoGraphics.length > 0 ? [...g, ...infoGraphics] : undefined
    })(),
    visualMap: visualMaps.length > 0 ? visualMaps : undefined,
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
  showRyDiamond = true,
  showRyDivergence = true,
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
  // X 轴 TV 式刻度密度 + 轴带宽度: dataZoom/resize 监听实时更新 (见 buildOption xLabelMetrics)
  const xLabelMetricsRef = useRef({ axisWidth: 824, visibleCount: 60, containerWidth: 930 })
  const userZoomRef = useRef<{ start: number; end: number } | null>(null)
  // 「往左加载更多」前插检测: 记录上次 setOption 时的数据, 判断新数据是否在头部前插了更早历史
  const prevDataRef = useRef<OHLC[]>([])
  // Y 轴(价格/指标)手动缩放窗口 per grid (TV 同款, 主图 0 + 副图 1..N):
  // 刻度区滚轮/拖拽缩放、图区内上下拖拽平移后记录, setOption 重建时恢复;
  // 重置按钮 / 双击 / 换股后清空 → 回落默认全窗口 [0,100] (数据贴身)。
  const yZoomByGridRef = useRef<Map<number, { start: number; end: number }>>(new Map())
  // Y 轴 pad (第 33 轮): 缩小方向轴 padding per grid (单位 = 数据范围 Δ 的倍数),
  // {lo:0,hi:0} 缺省 = 贴身; 主图 grid 0 由 axisMin/Max 函数读取, 无上限 = 无限小;
  // 重置/双击清空。换股保留 (TV 同款: 换标的保持缩放状态)。
  const yPadRef = useRef<Map<number, { lo: number; hi: number }>>(new Map())
  // windowPriceRange (effect 闭包) 读取的 priceLines 最新值
  const priceLinesRef = useRef(priceLines)
  priceLinesRef.current = priceLines
  // dataZoom 监听只在图表创建时注册一次, 直接调用会一直执行「创建那次渲染」的 updateCompactPresentation:
  // 它的 data/dateIndexMap/markers 停在旧标的, 会把上一只的买卖标记 merge 回新标的图上。
  // 与 dataRef/getInfoBarHTMLRef 同法, 经 ref 取最新一次渲染的函数。
  const updateCompactPresentationRef = useRef<() => void>(() => {})
  // 竖虚线(crosshair)是否可见: 控制信息栏「至今」字段的显隐。鼠标移出图表区即 false。
  const hoverActiveRef = useRef(false)

  // Y 轴价格缩放: 重置按钮 (TV 同款「A」) → 全部 grid 恢复默认 (全窗口 + 无 pad = 贴身)
  const resetYPrice = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    yPadRef.current.clear()
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
    yPadRef.current.clear()
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
    // TV 行为: 鼠标移出图表后信息栏回落到最新 K 线; hover 残留索引仅在悬停中生效。
    // (handlePointerLeave 只清 hoverActiveRef, 若无条件用 infoIdxRef 会残留旧悬停 bar)
    let idx = hoverActiveRef.current ? infoIdxRef.current : data.length - 1
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

    // 第二行: MA + BOLL + 融易主图数值 (五层独立开关各自显示)
    const ryAny = RY_INFO_KEYS.some(k => activeIndicators.includes(k))
    if (showMA || (d.ry_mid != null && ryAny)) {
      html += `<div style="display:flex;align-items:center;gap:10px;padding:0 8px;font:11px 'JetBrains Mono',monospace;select:none;min-height:20px;flex-wrap:wrap">`
      if (showMA) {
        if (d.ma5 != null) html += `<span style="color:${THEME.ma5}">MA5:${Number(d.ma5).toFixed(2)}</span>`
        if (d.ma10 != null) html += `<span style="color:${THEME.ma10}">MA10:${Number(d.ma10).toFixed(2)}</span>`
        if (d.ma20 != null) html += `<span style="color:${THEME.ma20}">MA20:${Number(d.ma20).toFixed(2)}</span>`
        if (d.ma60 != null) html += `<span style="color:${THEME.ma60}">MA60:${Number(d.ma60).toFixed(2)}</span>`
        if (d.boll_upper != null && activeIndicators.includes('boll')) {
          html += `<span style="color:#E879F9">BOLL:${Number(d.boll_upper).toFixed(2)}/${Number(d.ma20).toFixed(2)}/${Number(d.boll_lower).toFixed(2)}</span>`
        }
      }
      if (activeIndicators.includes('ry_channel') && d.ry_mid != null) {
        html += `<span style="color:${RY_CHANNEL}">牛熊:${Number(d.ry_upper).toFixed(2)}/${Number(d.ry_mid).toFixed(2)}/${Number(d.ry_lower).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_mid')) {
        if (d.ry_ema_mid != null) {
          const mc = d.ry_mid_trend != null && d.ry_mid_trend > 0 ? RY_MID_BULL : d.ry_mid_trend != null && d.ry_mid_trend < 0 ? RY_MID_BEAR : RY_MID_FLAT
          html += `<span style="color:${mc}">中轨:${Number(d.ry_ema_mid).toFixed(2)}</span>`
        }
      }
      if (activeIndicators.includes('ry_k')) {
        const kv = d.k_trend === 1 ? d.k_up : d.k_trend === -1 ? d.k_dn : null
        if (kv != null) html += `<span style="color:${d.k_trend === 1 ? RY_MID_BULL : RY_MID_BEAR}">波段:${Number(kv).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_k2')) {
        const k2v = d.k2_trend === 1 ? d.k2_up : d.k2_trend === -1 ? d.k2_dn : null
        if (k2v != null) html += `<span style="color:${d.k2_trend === 1 ? RY_MID_BULL : RY_MID_BEAR}">趋势:${Number(k2v).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_k3')) {
        const k3v = d.k3_trend === 1 ? d.k3_up : d.k3_trend === -1 ? d.k3_dn : null
        if (k3v != null) html += `<span style="color:${d.k3_trend === 1 ? RY_MID_BULL : RY_MID_BEAR}">战略:${Number(k3v).toFixed(2)}</span>`
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
    // 页面 CSS zoom (tf-page-zoom) 下 Chrome 的 offsetX 是显示坐标, zrender 当布局
    // 坐标用 → 十字光标/点击/拖拽整体左偏、右侧区域悬停不到。垫片在 capture 阶段
    // 重定义 offsetX/offsetY 为布局坐标; 无 zoom 时零开销退化 (详见 echartsZoomFix.ts)。
    const removeZoomFix = installEChartsZoomFix(el)

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
    /** 主图窗口内数据范围 (含 priceLines) — pad 缩放的基准。 */
    const windowPriceRange = () => {
      const opt = chart.getOption() as any
      const xz = opt?.dataZoom?.[0]
      const n = dataRef.current.length
      if (!n) return null
      const i0 = Math.max(0, Math.floor(((xz?.start ?? 0) / 100) * (n - 1)))
      const i1 = Math.min(n - 1, Math.ceil(((xz?.end ?? 100) / 100) * (n - 1)))
      let lo = Infinity
      let hi = -Infinity
      for (let i = i0; i <= i1; i++) {
        const d = dataRef.current[i]
        if (d.high != null) { const v = Number(d.high); if (v > hi) hi = v }
        if (d.low != null) { const v = Number(d.low); if (v < lo) lo = v }
      }
      for (const line of (priceLinesRef.current ?? [])) {
        if (!Number.isFinite(line.value) || line.value <= 0) continue
        if (line.value > hi) hi = line.value
        if (line.value < lo) lo = line.value
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null
      return { lo, hi }
    }
    /** 把 grid g 的 Y 窗口以锚点比例(anchorRatio: 0=底 1=顶)缩放 factor 倍 (factor>1 = 收窄 = 放大)。
     *  第 33 轮两段式: 主图缩小 = pad 扩展 (无上限); 放大先消 pad 再收 dataZoom 窗口; 副图纯窗口段。 */
    const scaleYWindow = (g: number, anchorRatio: number, factor: number) => {
      if (g === 0) {
        const comp = (chart as any).getModel().getComponent('yAxis', 0)
        const axis = comp?.coordinateSystem ? ((comp.coordinateSystem.getAxis?.()) ?? (comp as any).axis) : null
        const ext = axis?.scale?.getExtent?.() as [number, number] | undefined
        const dRange = windowPriceRange()
        if (ext && dRange && ext[1] > ext[0]) {
          const [A0, A1] = ext
          const { lo: dLo, hi: dHi } = dRange
          const dSpan = dHi - dLo
          if (dSpan > 0) {
            const P = A0 + anchorRatio * (A1 - A0)
            if (factor < 1) {
              // 缩小: 轴范围以鼠标锚扩展 (无上限 = 无限小)
              const f = 1 / factor
              const nA0 = P - (P - A0) * f
              const nA1 = P + (A1 - P) * f
              yPadRef.current.set(0, {
                lo: Math.max(0, (dLo - nA0) / dSpan),
                hi: Math.max(0, (nA1 - dHi) / dSpan),
              })
              // pad 段窗口必须回全轴 [0,100] (filter 交互), 触发轴重算
              yZoomByGridRef.current.delete(0)
              chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + g, start: 0, end: 100 })
              return
            }
            const pad = yPadRef.current.get(0)
            if (pad && (pad.lo > 0 || pad.hi > 0)) {
              // 放大第一段: 消 pad (clamp 到贴身)
              const f = 1 / factor
              const nA0 = Math.max(dLo, P - (P - A0) * f)
              const nA1 = Math.min(dHi, P + (A1 - P) * f)
              yPadRef.current.set(0, { lo: (dLo - nA0) / dSpan, hi: (nA1 - dHi) / dSpan })
              chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + g, start: 0, end: 100 })
              return
            }
            // pad 已贴身 → 落到窗口段
          }
        }
      }
      // 窗口段 (副图全部 / 主图贴身后放大): dataZoom 收窄 (filter 让轴=窗口内数据)
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
        mode: 'pan', grid: g, hasY: !!yz || (g === 0 && !!yPadRef.current.get(0)),
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
        // pad 段 (第 33 轮): 主图缩小后垂直拖 = 轴范围整体平移 (保持宽, clamp 到贴身外)
        const pad0 = drag.grid === 0 ? yPadRef.current.get(0) : null
        if (pad0 && (pad0.lo > 0 || pad0.hi > 0)) {
          const comp = (chart as any).getModel().getComponent('yAxis', 0)
          const axis = comp?.coordinateSystem ? ((comp.coordinateSystem.getAxis?.()) ?? (comp as any).axis) : null
          const ext = axis?.scale?.getExtent?.() as [number, number] | undefined
          const dRange = windowPriceRange()
          if (ext && dRange && dRange.hi > dRange.lo) {
            const dSpan = dRange.hi - dRange.lo
            const total = ext[1] - ext[0]
            const shift = (dy / drag.gh) * total
            yPadRef.current.set(0, {
              lo: Math.max(0, pad0.lo + shift / dSpan),
              hi: Math.max(0, pad0.hi - shift / dSpan),
            })
            chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + drag.grid, start: 0, end: 100 })
          }
        } else {
          const w = drag.e0Y - drag.s0Y
          const d = (dy / drag.gh) * w
          const sN = Math.max(0, Math.min(100 - w, drag.s0Y + d))
          yZoomByGridRef.current.set(drag.grid, { start: sN, end: sN + w })
          chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1 + drag.grid, start: sN, end: sN + w })
        }
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
      const visibleCount = Math.max(1, Math.round(total * (zoom.end - zoom.start) / 100))
      // X 轴刻度密度实时更新 (interval 闭包在每次轴渲染时重新调用, 无需 setOption)
      xLabelMetricsRef.current = { axisWidth: Math.max(el.clientWidth - 46 - 60, 200), visibleCount, containerWidth: el.clientWidth }
      const newCompact = visibleCount > COMPACT_THRESHOLD
      if (newCompact !== compactRef.current) {
        compactRef.current = newCompact
        updateCompactPresentationRef.current()
      }
    })

    const ro = new ResizeObserver(() => {
      const el2 = containerRef.current
      if (el2) {
        xLabelMetricsRef.current = {
          ...xLabelMetricsRef.current,
          containerWidth: el2.clientWidth,
          axisWidth: Math.max(el2.clientWidth - 46 - 60, 200),
        }
      }
      chart.resize()
    })
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
      removeZoomFix()
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
    // 轴带/刻度密度用实时宽度 (chart.getWidth() 含左右边距修正前真实画布宽; 测试 mock 无此 API)
    const w = typeof chart.getWidth === 'function' ? chart.getWidth() : 0
    if (w > 0) xLabelMetricsRef.current = { ...xLabelMetricsRef.current, containerWidth: w }

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
      showRyDiamond,
      showRyDivergence,
      xLabelMetricsRef,
      _symbol,
      yPadRef.current,
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
    // 显式归位全窗口 [0,100], 否则换股后旧标的的价格窗口会残留到新标的上。
    // (主图 pad 保留 — TV 同款: 换标的保持用户缩放状态)
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
  }, [data, markers, ranges, priceLines, linkedPrice, showMA, showMarkersProp, activeIndicators, volumeCompare, addedDate, chartStyle, rsiZeroAxis, externalDrawings, showRyDiamond, showRyDivergence, chartHeight, dates, dateIndexMap, initialZoom, theme])

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
    const ryAny = RY_INFO_KEYS.some(k => activeIndicators.includes(k))
    if (showMA || (d.ry_mid != null && ryAny)) {
      html += `<div style="display:flex;align-items:center;gap:10px;padding:0 8px;font:11px 'JetBrains Mono',monospace;min-height:20px;flex-wrap:wrap">`
      if (showMA) {
        if (d.ma5 != null) html += `<span style="color:${THEME.ma5}">MA5:${Number(d.ma5).toFixed(2)}</span>`
        if (d.ma10 != null) html += `<span style="color:${THEME.ma10}">MA10:${Number(d.ma10).toFixed(2)}</span>`
        if (d.ma20 != null) html += `<span style="color:${THEME.ma20}">MA20:${Number(d.ma20).toFixed(2)}</span>`
        if (d.ma60 != null) html += `<span style="color:${THEME.ma60}">MA60:${Number(d.ma60).toFixed(2)}</span>`
        if (d.boll_upper != null && activeIndicators.includes('boll')) {
          html += `<span style="color:#E879F9">BOLL:${Number(d.boll_upper).toFixed(2)}/${Number(d.ma20).toFixed(2)}/${Number(d.boll_lower).toFixed(2)}</span>`
        }
      }
      if (activeIndicators.includes('ry_channel') && d.ry_mid != null) {
        html += `<span style="color:${RY_CHANNEL}">牛熊:${Number(d.ry_upper).toFixed(2)}/${Number(d.ry_mid).toFixed(2)}/${Number(d.ry_lower).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_mid') && d.ry_ema_mid != null) {
        const mc = d.ry_mid_trend != null && d.ry_mid_trend > 0 ? RY_MID_BULL : d.ry_mid_trend != null && d.ry_mid_trend < 0 ? RY_MID_BEAR : RY_MID_FLAT
        html += `<span style="color:${mc}">中轨:${Number(d.ry_ema_mid).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_k')) {
        const kv = d.k_trend === 1 ? d.k_up : d.k_trend === -1 ? d.k_dn : null
        if (kv != null) html += `<span style="color:${d.k_trend === 1 ? RY_MID_BULL : RY_MID_BEAR}">波段:${Number(kv).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_k2')) {
        const k2v = d.k2_trend === 1 ? d.k2_up : d.k2_trend === -1 ? d.k2_dn : null
        if (k2v != null) html += `<span style="color:${d.k2_trend === 1 ? RY_MID_BULL : RY_MID_BEAR}">趋势:${Number(k2v).toFixed(2)}</span>`
      }
      if (activeIndicators.includes('ry_k3')) {
        const k3v = d.k3_trend === 1 ? d.k3_up : d.k3_trend === -1 ? d.k3_dn : null
        if (k3v != null) html += `<span style="color:${d.k3_trend === 1 ? RY_MID_BULL : RY_MID_BEAR}">战略:${Number(k3v).toFixed(2)}</span>`
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
