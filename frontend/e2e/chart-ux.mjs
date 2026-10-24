// 图表模块 UX 端到端测试 (Playwright, 无头 Chromium)
// ─────────────────────────────────────────────────────────────────────────────
// 用途: 发布上线前的用户旅程验收 (2026-10-25 用户要求的 UX 单元测试)。
// 运行: node frontend/e2e/chart-ux.mjs
//   环境变量: CHART_URL (默认 http://221.237.179.2:13483)
//             CHART_USER (默认 admin)  CHART_PASS (默认 SnS3.14@W)
// 依赖: playwright 包 — 不入 package.json (避免 Docker 生产镜像膨胀),
//   运行时从 npx 缓存解析 (首次可 `npx playwright --version` 触发缓存安装),
//   或设 PLAYWRIGHT_DIR 指向已有 node_modules。浏览器复用本机 ms-playwright。
//
// 覆盖 (T1-T11):
//   T1  加载与默认视图 (数据渲染/双窗格/无致命控制台错误)
//   T2  信息栏标签 (牛熊: 前缀, 本轮改版点)
//   T3  现价标签完整显示 (右缘不裁切, 本轮改版点)
//   T4  Y 轴双向缩放 (缩小→内容收缩; 放大→内容扩张; A 重置→复原, 本轮改版点)
//   T5  跨窗格十字联动 (对端窗格水平+垂直线; 轴标签无蓝底块)
//   T6  悬停无 emphasis 高亮 (纯黄像素 = 0)
//   T7  指标开关 (波段 层开/关渲染变化)
//   T8  周期切换 (1小时 → 日线 → 回)
//   T9  复权切换 (前复权/不复权 按钮态与数据)
//   T10 刷新恢复 (布局与标的保持)
//   T11 控制台无新增致命错误
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_DIR) {
    const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR, 'package.json'))
    return req('playwright')
  }
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm-cache', '_npx'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    path.join(os.homedir(), '.cache', 'npm-cache', '_npx'),
    path.join(os.homedir(), '.cache', 'TeleAgent', 'npm-cache', '_npx'),
  ].filter(Boolean)
  for (const npxRoot of candidates) {
    if (!fs.existsSync(npxRoot)) continue
    for (const d of fs.readdirSync(npxRoot)) {
      const p = path.join(npxRoot, d, 'node_modules', 'playwright')
      if (fs.existsSync(path.join(p, 'package.json'))) {
        const req = createRequire(path.join(p, 'package.json'))
        return req('playwright')
      }
    }
  }
  const req = createRequire(path.join(process.cwd(), 'package.json'))
  return req('playwright')
}

const BASE = process.env.CHART_URL || 'http://221.237.179.2:13483'
const USER = process.env.CHART_USER || 'admin'
const PASS = process.env.CHART_PASS || 'SnS3.14@W'

const results = []
const knownErr = /部分前端扩展加载失败|Failed to load resource|net::|favicon/i
let consoleErrors = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { chromium } = resolvePlaywright()
  // 浏览器: 复用本机已装 chromium (npx 缓存的 playwright 与已装浏览器 build 号
  // 可能不匹配, 用 executablePath 直连任意已装 build, CDP 协议向前兼容)
  const pwRoot = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
  let executablePath
  for (const d of ['chromium-1248', 'chromium-1140']) {
    const exe = path.join(pwRoot, d, 'chrome-win', 'chrome.exe')
    if (fs.existsSync(exe)) { executablePath = exe; break }
  }
  const browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1920, height: 963 } })
  page.on('console', m => {
    if (m.type() === 'error' && !knownErr.test(m.text())) consoleErrors.push(m.text())
  })

  // ── 登录 (会话不存在时; 登录页 = /login, 账号登录形态) ──
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 })
  await sleep(1500)
  let needLogin = true
  try {
    // 已登录: 首页加载完成后出现应用壳 (侧栏/看板文字), 不再停在 加载中/登录
    await page.waitForFunction(() => {
      const t = document.body.innerText
      return !t.includes('加载中') && (t.includes('看板') || t.includes('图表'))
    }, { timeout: 8000 })
    needLogin = false
  } catch { needLogin = true }
  if (needLogin) {
    await page.goto(BASE + '/login', { waitUntil: 'load', timeout: 60000 })
    await page.waitForSelector('input[type=password]:visible', { timeout: 15000 })
    await page.locator('input:visible').first().fill(USER)
    await page.locator('input[type=password]:visible').first().fill(PASS)
    const loginBtn = page.locator('button:visible', { hasText: /登录/ }).first()
    if (await loginBtn.count() > 0) await loginBtn.click()
    else await page.keyboard.press('Enter')
    try {
      await page.waitForURL(u => !String(u).includes('login'), { timeout: 20000 })
    } catch {
      const tip = await page.evaluate(() => document.body.innerText.slice(0, 120))
      record('T0 登录', false, `登录未跳转: ${tip.replace(/\n/g, ' ')}`)
      await browser.close()
      process.exit(1)
    }
    await sleep(1500)
  }

  // ── T1 加载与默认视图 ──
  await page.goto(BASE + '/chart', { waitUntil: 'load', timeout: 60000 })
  try {
    await page.waitForFunction(() => {
      const t = document.body.innerText
      return t.includes('开') && t.includes('收') && /\d{3,}\.\d{2}/.test(t)
    }, { timeout: 45000 })
  } catch {
    record('T1 加载与默认视图', false, '数据未加载 (信息栏无 OHLC)')
  }
  await sleep(4000)
  const paneInfo = await page.evaluate(() => {
    const doms = document.querySelectorAll('[_echarts_instance_]')
    return Array.from(doms).map(d => {
      const r = d.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), canvases: d.querySelectorAll('canvas').length }
    })
  })
  const t1ok = paneInfo.length >= 2 && paneInfo.every(p => p.canvases >= 1 && p.w > 400)
  record('T1 加载与默认视图', t1ok,
    t1ok ? `${paneInfo.length} 窗格 ${paneInfo.map(p => p.w + 'x' + p.h).join(', ')}` : JSON.stringify(paneInfo))
  const leftPane = paneInfo[0]
  const rightPane = paneInfo[1]

  // ── T2 信息栏标签 (牛熊:) ──
  const infoText = await page.evaluate(() => document.body.innerText)
  record('T2 信息栏标签 牛熊:', /牛熊:\s*\d/.test(infoText) && !/牛:\d/.test(infoText),
    /牛熊:\d/.test(infoText) ? '前缀已切换' : '未见牛熊: 前缀')

  const scanIn = fn => page.evaluate(fn)

  // ── T3 现价标签完整显示 ──
  const tagScan = await scanIn(() => {
    const doms = document.querySelectorAll('[_echarts_instance_]')
    const cv = doms[0].querySelector('canvas')
    const w = cv.width, h = cv.height
    const ctx = cv.getContext('2d')
    const colors = [[149, 48, 48], [199, 64, 64], [34, 116, 76], [45, 155, 101]]
    const tol = 16
    const x0 = Math.max(0, w - 140)
    let found = 0, maxX = -1, minX = 1e9
    const img = ctx.getImageData(x0, 0, w - x0, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - x0; x++) {
        const i = (y * (w - x0) + x) * 4
        for (const [r, g, b] of colors) {
          if (Math.abs(img.data[i] - r) <= tol && Math.abs(img.data[i + 1] - g) <= tol && Math.abs(img.data[i + 2] - b) <= tol) {
            found++
            const gx = x0 + x
            if (gx > maxX) maxX = gx
            if (gx < minX) minX = gx
            break
          }
        }
      }
    }
    return { w, h, found, maxX, minX }
  })
  const t3ok = tagScan.found > 200 && tagScan.maxX <= tagScan.w - 3
  record('T3 现价标签完整显示', t3ok,
    `标签像素 ${tagScan.found}, x ${tagScan.minX}..${tagScan.maxX} / canvas ${tagScan.w}`)

  // ── T4 Y 轴双向缩放 ──
  // 量度: 主窗格 canvas 中部区域非透明像素数 (画布背景透明, 内容带 alpha;
  // 缩放改变 K 线高度 → 数量变化)
  const regionCount = () => scanIn(() => {
    const doms = document.querySelectorAll('[_echarts_instance_]')
    const cv = doms[0].querySelector('canvas')
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    const x0 = Math.floor(w * 0.3), x1 = Math.floor(w * 0.75)
    const img = ctx.getImageData(x0, 4, x1 - x0, h - 8)
    let cnt = 0
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] > 30) cnt++
    }
    return cnt
  })
  const bandX = leftPane.x + leftPane.w - 55
  const bandY = leftPane.y + Math.floor(leftPane.h * 0.45)
  const c0 = await regionCount()
  await page.mouse.move(bandX, bandY)
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await sleep(120) }
  await sleep(600)
  const cOut = await regionCount()
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, -120); await sleep(120) }
  await sleep(600)
  const cIn = await regionCount()
  const btnA = page.getByRole('button', { name: 'A', exact: true }).first()
  if (await btnA.count() > 0) { await btnA.click(); await sleep(900) }
  const cReset = await regionCount()
  const t4a = cOut < c0 * 0.88
  const t4b = cIn > cOut * 1.25
  const t4c = Math.abs(cReset - c0) < c0 * 0.2
  record('T4a Y轴缩小 (关键回归点)', t4a, `内容像素 ${c0} → ${cOut} (${(cOut / c0 * 100).toFixed(0)}%)`)
  record('T4b Y轴放大', t4b, `→ ${cIn} (${(cIn / cOut * 100).toFixed(0)}%)`)
  record('T4c A重置复原', t4c, `→ ${cReset} (${(cReset / c0 * 100).toFixed(0)}%)`)

  // ── T5 跨窗格十字联动 + 轴标签无蓝底 ──
  await page.mouse.move(leftPane.x + Math.floor(leftPane.w * 0.72), leftPane.y + Math.floor(leftPane.h * 0.35), { steps: 6 })
  await sleep(900)
  const crossScan = await scanIn(() => {
    const doms = document.querySelectorAll('[_echarts_instance_]')
    let vertical = 0, horizontal = 0, blue = 0
    doms[1].querySelectorAll('canvas').forEach(cv => {
      const ctx = cv.getContext('2d')
      const w = cv.width, h = cv.height
      const img = ctx.getImageData(0, 0, w, h)
      const d = img.data
      // 垂直线: 逐列统计 (十字色 + alpha; 阈值 12% 高度 — 虚线 4/4 采样后约 50%)
      for (let x = 0; x < w; x++) {
        let c = 0
        for (let y = 0; y < h; y += 2) {
          const i = (y * w + x) * 4
          if (d[i + 3] > 100 && d[i] > 140 && d[i] < 215 && d[i + 1] > 140 && d[i + 1] < 215 && d[i + 2] > 150) c++
        }
        if (c > h * 0.12) vertical++
      }
      // 水平线: 逐行 (阈值 12% 宽度 — 线只跨 grid 宽非全宽, 虚线采样)
      for (let y = 0; y < h; y++) {
        let c = 0
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4
          if (d[i + 3] > 100 && d[i] > 140 && d[i] < 215 && d[i + 1] > 140 && d[i + 1] < 215 && d[i + 2] > 150) c++
        }
        if (c > w * 0.12) horizontal++
      }
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 100 && Math.abs(d[i] - 30) <= 20 && Math.abs(d[i + 1] - 58) <= 20 && Math.abs(d[i + 2] - 138) <= 25) blue++
      }
    })
    return { vertical, horizontal, blue }
  })
  record('T5 跨窗格十字联动 (垂直+水平)', crossScan.vertical >= 1 && crossScan.horizontal >= 1,
    `对端窗格 垂直线列 ${crossScan.vertical}, 水平线行 ${crossScan.horizontal}`)
  record('T5b 轴标签无蓝底块', crossScan.blue === 0, `蓝像素 ${crossScan.blue}`)

  // ── T6 悬停无 emphasis 高亮 ──
  const yellowScan = await scanIn(() => {
    const doms = document.querySelectorAll('[_echarts_instance_]')
    let n = 0
    doms.forEach(dom => dom.querySelectorAll('canvas').forEach(cv => {
      const ctx = cv.getContext('2d')
      const w = cv.width, h = cv.height
      const d = ctx.getImageData(0, 0, w, h).data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 200 && Math.abs(d[i] - 255) <= 12 && Math.abs(d[i + 1] - 224) <= 14 && Math.abs(d[i + 2] - 23) <= 14) n++
      }
    }))
    return n
  })
  record('T6 悬停无 emphasis 高亮', yellowScan === 0, `纯黄像素 ${yellowScan}`)

  // ── T7 指标开关 (波段) ──
  const before7 = await regionCount()
  const btnBand = page.getByRole('button', { name: '波段', exact: true }).first()
  await btnBand.click()
  await sleep(1200)
  const afterOn7 = await regionCount()
  await btnBand.click()
  await sleep(1200)
  const afterOff7 = await regionCount()
  const t7ok = Math.abs(afterOn7 - before7) > 300 && Math.abs(afterOff7 - afterOn7) > 300
  record('T7 指标开关 波段', t7ok, `关${before7} → 开${afterOn7} → 关${afterOff7}`)

  // ── T8 周期切换 (1小时 → 天/日线 → 回; 选项标签为 单字「天」) ──
  const periodBtn = page.getByRole('button', { name: /^1小时/ }).first()
  let t8ok = false, t8d = ''
  if (await periodBtn.count() > 0) {
    await periodBtn.click()
    await sleep(600)
    const opt = page.locator('button', { hasText: /^天$/ }).last()
    if (await opt.count() > 0) {
      await opt.click()
      await sleep(4000)
      // 按钮文本变为「天」即切换生效 (SingleSelect 选项在应用根内非 body portal)
      const dayBtn = page.getByRole('button', { name: /^天$/ }).first()
      const switched = (await dayBtn.count()) > 0
      if (switched) {
        await dayBtn.click()
        await sleep(600)
        const optBack = page.locator('button', { hasText: /^1小时$/ }).last()
        if (await optBack.count() > 0) { await optBack.click(); await sleep(3500) }
      }
      t8ok = switched
      t8d = switched ? '切换生效 (1小时→天→回)' : '周期按钮未变化'
    } else t8d = '下拉面板未见「天」选项'
  } else t8d = '未找到 1小时 按钮'
  record('T8 周期切换', t8ok, t8d)

  // ── T9 复权切换 (直接 DOM 查询; active 类 = bg-accent) ──
  const adjustState = () => scanIn(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => ['前复权', '不复权', '送转复权'].includes((b.textContent || '').trim()))
    const map = {}
    btns.forEach(b => { map[b.textContent?.trim()] = /bg-accent/.test(b.className || '') })
    return map
  })
  let t9ok = false, t9d = ''
  const s0 = await adjustState()
  if (s0['前复权'] !== undefined) {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '不复权')
      btn?.click()
    })
    await sleep(3500)
    const s1 = await adjustState()
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '前复权')
      btn?.click()
    })
    await sleep(3500)
    const s2 = await adjustState()
    t9ok = s0['前复权'] === true && s1['不复权'] === true && s1['前复权'] === false && s2['前复权'] === true
    t9d = `初始前复权=${s0['前复权']}, 切后不复权=${s1['不复权']}, 复原=${s2['前复权']}`
  } else t9d = '未找到复权按钮'
  record('T9 复权切换', t9ok, t9d)

  // ── T10 刷新恢复 ──
  await page.reload({ waitUntil: 'load' })
  try {
    await page.waitForFunction(() => {
      const t = document.body.innerText
      return t.includes('开') && /\d{3,}\.\d{2}/.test(t)
    }, { timeout: 45000 })
  } catch { /* 由下方断言判 */ }
  await sleep(4000)
  const afterReload = await page.evaluate(() => ({
    panes: document.querySelectorAll('[_echarts_instance_]').length,
    // 标的保持: 搜索框 placeholder 反映当前标的 (input value 不入 innerText)
    symbolPlaceholders: Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null).map(i => i.placeholder || '').filter(p => p.includes('600519')).length,
    hasNiuXiong: /牛熊:\s*\d/.test(document.body.innerText),
  }))
  const t10ok = afterReload.panes >= 2 && afterReload.symbolPlaceholders >= 1 && afterReload.hasNiuXiong
  record('T10 刷新恢复', t10ok, `窗格 ${afterReload.panes}, 标的框 ${afterReload.symbolPlaceholders}, 信息栏${afterReload.hasNiuXiong ? '在' : '失'}`)

  if (consoleErrors.length > 0) {
    record('T11 控制台无新增致命错误', false, `${consoleErrors.length} 条: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 200)}`)
  } else {
    record('T11 控制台无新增致命错误', true)
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n═══ 图表模块 UX 验收: ${results.length - failed.length}/${results.length} 通过 ═══`)
  await browser.close()
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
