/**
 * ECharts 事件坐标矫正垫片 — 修复页面 CSS zoom 下指针交互整体偏移。
 *
 * 背景: 应用「界面缩放」用 CSS zoom 作用于 <html> (index.html 的 tf-page-zoom,
 * 默认 0.9)。Chrome 在 zoom 容器内给鼠标事件的 offsetX/offsetY 是「显示坐标」,
 * 而 zrender 把它当「布局坐标」用 (zrender/lib/core/event.js 的 clientToLocal
 * 直接取 e.offsetX) → ECharts 画布布局宽 ≠ 显示宽时, 十字光标/点击/拖拽/缩放
 * 整体向左偏移 (1-zoom)×x, 图表右侧 (1-zoom)×宽度 的区域内永远悬停不到:
 * 表现为「十字光标移动不到最右侧一根K线」、点击坐标偏左、拖拽缩放中心偏移。
 *
 * 方案: 在 ECharts 容器上以 capture 阶段监听鼠标事件 (先于 zrender 在内部
 * 元素上的 target 阶段监听), 用 clientX/Y - canvas 显示 rect (跨浏览器恒为
 * 显示坐标) 换算成布局坐标后重定义事件的 offsetX/offsetY — zrender 后续
 * 读到的即为正确布局坐标。无 zoom 时 (显示==布局) 不做任何事, 零开销退化。
 *
 * 浏览器兼容: 不依赖 offsetX 的浏览器差异语义 — clientX/getBoundingClientRect
 * 在 Chrome/Firefox/Safari 的 CSS zoom 下均返回显示坐标; Firefox <126 不支持
 * CSS zoom (因子恒 1, 自动跳过)。事件属性重定义失败时静默退化原行为。
 */

/** 需要矫正的鼠标类事件 (zrender canvas proxy 监听的同名集合) */
const FIX_EVENTS: (keyof HTMLElementEventMap)[] = [
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'wheel',
]

/**
 * 在 ECharts 容器上安装坐标矫正垫片。
 *
 * @param host ECharts 初始化容器 (echarts.init 传入的元素); 垫片挂它的
 *             capture 阶段, 覆盖其内 zrender 创建的全部监听目标。
 * @returns 卸载函数 (容器销毁/图表重建时调用)。
 */
export function installEChartsZoomFix(host: HTMLElement): () => void {
  const fix = (e: Event) => {
    // ECharts canvas renderer: 画布是 host 内唯一的 canvas; 尚未创建时跳过。
    const canvas = host.querySelector('canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const kx = rect.width > 0 ? canvas.clientWidth / rect.width : 1
    const ky = rect.height > 0 ? canvas.clientHeight / rect.height : 1
    if (Math.abs(kx - 1) < 0.001 && Math.abs(ky - 1) < 0.001) return
    const me = e as MouseEvent
    const ox = (me.clientX - rect.left) * kx
    const oy = (me.clientY - rect.top) * ky
    try {
      Object.defineProperty(e, 'offsetX', { get: () => ox })
      Object.defineProperty(e, 'offsetY', { get: () => oy })
    } catch { /* 属性不可重定义的环境: 静默退化 (保持原偏移行为) */ }
  }

  for (const type of FIX_EVENTS) {
    host.addEventListener(type, fix, true)
  }
  return () => {
    for (const type of FIX_EVENTS) {
      host.removeEventListener(type, fix, true)
    }
  }
}
