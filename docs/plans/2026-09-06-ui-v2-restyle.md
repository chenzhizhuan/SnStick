---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '20aa96c3-f066-4dd0-8b39-e0d03b651a4d'
  PropagateID: '20aa96c3-f066-4dd0-8b39-e0d03b651a4d'
  ReservedCode1: '642250e9-c191-47be-886e-9f72afcb6c7c'
  ReservedCode2: '642250e9-c191-47be-886e-9f72afcb6c7c'
---

# SnStick UI v2.0 视觉升级实施计划（纯黑玻璃 + 扇形卡组）

> **For implementer:** 本任务为纯视觉改造。遵循项目既有约定（`docs/design/ui-restyle-plan.md`）：纯视觉调整采用「类型检查 + 构建 + 离线 QA 样板 + 截图」验证，不添加镜像样式单元测试（前端无单测框架，不为样式引入测试框架）。每个任务验证通过后立即提交，只 `git add` 该任务涉及的文件。

**Goal:** 将前端视觉升级为 v2.0——纯黑玻璃底、选中元素品牌渐变+外发光、策略页扇形卡组（coverflow）——功能、数据、交互逻辑零变更。

**Architecture:** 视觉决策全部收敛在 CSS 层（`index.css` token 变量 + `workstation.css`/`strategy-studio.css` 材质规则）；扇形排布通过 `StrategyCard` 新增纯展示属性 `data-fan`（tier 由 `Screener.tsx` 按与选中策略的距离计算），交互只复用既有 `setActiveStrategy` 状态，不新增任何数据请求。

**Tech Stack:** React 18 + TypeScript + Tailwind + 现有 CSS 变量体系；验证用 tsc / vite build / `frontend/qa` 离线样板（3012 组件页、3013 策略页）/ Playwright 检查脚本 `qa/check-strategy.cjs`。

**设计文档:** `docs/plans/2026-09-06-ui-v2-restyle-design.md`（已提交 b4ac68d）

**工作目录:** 所有命令在 `frontend/` 目录执行（PowerShell）。

---

## Task 0: 前置条件（基线提交决策 + 依赖确认）

**说明:** v1.1 的改动（index.css、workstation.css、strategy-studio.css、Screener.tsx、StrategyCard.tsx 等 16 修改 + 5 未跟踪文件）**尚未提交**。v2.0 会改这些文件的同类位置，必须先把 v1.1 作为基线提交，否则 v2.0 提交会混入 v1.1 未验收内容。

**Step 1:** 与用户确认是否先提交 v1.1 基线（推荐：是，作为独立 commit）。
**Step 2:** 确认依赖已安装：`Test-Path node_modules` → 应为 True；否则先 `pnpm install`。
**Step 3:** 基线构建确认（v1.1 状态可构建）：

```powershell
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
```

Expected: 两条命令均无错误退出（构建约 2736 模块）。

**Step 4:** 若用户同意，提交 v1.1 基线：

```powershell
git add frontend/index.html frontend/src/components/Layout.tsx frontend/src/components/Logo.tsx frontend/src/components/Modal.tsx frontend/src/components/PageHeader.tsx frontend/src/components/screener/StrategyCard.tsx frontend/src/components/stock-table/StockDataTable.tsx frontend/src/index.css frontend/src/lib/theme.ts frontend/src/main.tsx frontend/src/pages/Auth.tsx frontend/src/pages/Onboarding.tsx frontend/src/pages/Screener.tsx frontend/tailwind.config.ts frontend/vite.config.d.ts frontend/vite.config.ts docs/SnStick-UI-UX-Design-Spec.md docs/design/ frontend/public/brand/ frontend/qa/ frontend/src/styles/
git commit -m "style: v1.1 蓝青玻璃基线（策略页样板，待用户视觉验收）"
```

注意：`frontend/dist/`、`tsconfig.tsbuildinfo` 等构建产物不入库；`frontend/vite.config.ts` 含用户既有修改，原样保留。

---

## Task 1: index.css — v2.0 暗色 token（纯黑底/品牌端点/浓渐变/发光变量）

**Files:**
- Modify: `frontend/src/index.css`

**Step 1: 修改 `:root`（浅色）品牌端点 + 浅色发光**

将 `:root` 块中（约 22-24 行）：

```css
  --brand-blue: 18 96 255;
  --brand-cyan: 0 191 239;
  --brand-mint: 18 221 186;
```

改为：

```css
  --brand-blue: 40 123 255;
  --brand-cyan: 0 191 239;
  --brand-mint: 16 185 129;
```

在 `:root` 的 `--glass-selected` 行之后新增一行：

```css
  --glow-brand: 0 0 18px rgb(var(--brand-blue) / .18), 0 0 6px rgb(var(--brand-cyan) / .14);
```

**Step 2: 重写 `html.dark` 块**（整体替换约 39-57 行）：

```css
html.dark {
  color-scheme: dark;
  --base: 0 0% 0%;
  --surface: 220 14% 7%;
  --elevated: 220 12% 11%;
  --border: 213 9% 25%;
  --fg-primary: 210 17% 94%;
  --fg-secondary: 212 12% 77%;
  --fg-muted: 213 10% 63%;
  --accent: 211 100% 73%;
  --glass-sheen: linear-gradient(145deg, rgb(255 255 255 / .075), rgb(255 255 255 / .012) 42%, transparent 70%);
  --glass-body: hsl(var(--surface) / .95);
  --glass-selected: linear-gradient(160deg, rgb(var(--brand-blue) / .55), rgb(var(--brand-cyan) / .28) 52%, rgb(var(--brand-mint) / .38));
  --glass-line: rgb(255 255 255 / .17);
  --shadow-panel: inset 0 1px 0 var(--glass-line), 0 4px 18px rgb(0 0 0 / .10);
  --shadow-float: inset 0 1px 0 var(--glass-line), 0 18px 52px rgb(0 0 0 / .34);
  --focus-color: #83c1ff;
  --glow-brand: 0 0 24px rgb(var(--brand-blue) / .30), 0 0 8px rgb(var(--brand-cyan) / .25);
  --control-primary: linear-gradient(115deg, #1754c7, #126184);
}
```

变更点：`--base` 纯黑、`--surface`/`--elevated` 近黑微冷、品牌端点、`--glass-selected` 改 160deg + 浓度 55/28/38、新增 `--glow-brand`。其余变量原值保留。

**Step 3: 验证**

```powershell
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
```

Expected: 均成功。

**Step 4: 提交**

```powershell
git add frontend/src/index.css
git commit -m "style: v2.0 暗色 token — 纯黑底/品牌端点/浓选中渐变/发光变量"
```

---

## Task 2: workstation.css — 选中态发光 + 降级

**Files:**
- Modify: `frontend/src/styles/workstation.css`

**Step 1: 导航当前项发光** — 将（约 10-14 行）：

```css
.sn-navigation :where(nav a[aria-current='page'], nav button.bg-elevated) {
  background-color: hsl(var(--elevated));
  background-image: var(--glass-selected), var(--glass-sheen);
  box-shadow: inset 0 1px 0 var(--glass-line), inset 0 0 0 1px rgb(var(--brand-blue) / .22);
}
```

改为：

```css
.sn-navigation :where(nav a[aria-current='page'], nav button.bg-elevated) {
  background-color: hsl(var(--elevated));
  background-image: var(--glass-selected), var(--glass-sheen);
  box-shadow: inset 0 1px 0 var(--glass-line), inset 0 0 0 1px rgb(var(--brand-blue) / .22), var(--glow-brand);
}
```

**Step 2: 选中策略卡发光** — 将（约 45-50 行）`.sn-strategy-card--active` 的 `box-shadow` 行替换为：

```css
  box-shadow: var(--glow-brand), inset 0 1px 0 rgb(255 255 255 / .23), inset 0 -1px 0 rgb(var(--brand-cyan) / .14);
```

**Step 3: 透明度敏感降级** — 将（约 96-98 行）：

```css
@media (prefers-reduced-transparency: reduce) {
  .sn-navigation { backdrop-filter: none; background-color: hsl(var(--surface)); }
}
```

改为：

```css
@media (prefers-reduced-transparency: reduce) {
  .sn-navigation { backdrop-filter: none; background-color: hsl(var(--surface)); }
  .sn-strategy-card--active,
  .sn-navigation :where(nav a[aria-current='page'], nav button.bg-elevated) { box-shadow: none; }
}
```

**Step 4: 验证 + 提交**

```powershell
node node_modules/vite/bin/vite.js build
git add frontend/src/styles/workstation.css
git commit -m "style: 选中态品牌发光（策略卡/导航项）+ 减透明度降级"
```

---

## Task 3: 阶段一视觉验证（3012 组件样板 + 截图）

**Step 1: 后台启动组件样板服务**（工作目录 `frontend/`，按平台后台模板）：

```powershell
node node_modules/vite/bin/vite.js --config qa/vite.config.ts
```

**Step 2: 浏览器检查** `http://127.0.0.1:3012/qa/ui-preview.html`：
- 切换暗色主题：页面底色应为纯黑；选中策略卡、导航当前项有蓝青外发光
- 玻璃卡（白 6% 级半透）在纯黑上文字可读；表格实体底不发光
- 切浅色主题：克制冷色，仅品牌端点更新，无脏灰光晕
- 390px 容器：无横向溢出
- 截图存档 `.temp/`，如发现对比度问题，微调 token 后重新构建并纳入本任务提交

**Step 3: 停止后台服务。**

---

## Task 4: StrategyCard — 新增 data-fan 纯展示属性

**Files:**
- Modify: `frontend/src/components/screener/StrategyCard.tsx`

**Step 1:** `StrategyCardProps` 接口（约 96-97 行 `timeframeBadge` 之后）新增：

```tsx
  /** 扇形层级（coverflow 视觉）；mini/hidden 密度不传 */
  fanTier?: string
```

**Step 2:** 解构参数（约 100-102 行）加入 `fanTier`：

```tsx
export function StrategyCard({
  name, description, source, active, count, expiredCount,
  loading, cardSize, fanTier,
  onRun, disabled, onSettings, monitored, onToggleMonitor, timeframeBadge,
}: StrategyCardProps) {
```

**Step 3:** `motion.div`（约 123 行 `data-density={cardSize}` 之后）新增：

```tsx
      data-fan={fanTier}
```

（React 对 `undefined` 属性自动省略，mini/hidden 不受影响。）

**Step 4: 验证 + 提交**

```powershell
node node_modules/typescript/bin/tsc -b
git add frontend/src/components/screener/StrategyCard.tsx
git commit -m "feat(ui): StrategyCard 透传 data-fan 扇形层级属性"
```

---

## Task 5: strategy-studio.css — 扇形卡组 + 玻璃卡重绘 + 箭头 + 详情卡渐变

**Files:**
- Modify: `frontend/src/styles/strategy-studio.css`

**Step 1: 容器加宽留出箭头空间** — `.sn-strategy-gallery:not([data-density='mini'])` 的 `padding: 36px 12px 38px` 改为：

```css
  padding: 48px 56px 50px;
```

**Step 2: 重绘普通卡（银灰实体 → 纯黑玻璃）** — 将卡片基础规则（约 32-47 行）整体替换为：

```css
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card {
  flex: 0 0 184px;
  min-width: 0;
  height: 244px;
  padding: 46px 18px 22px;
  border-radius: 12px;
  display: flex;
  align-items: stretch;
  scroll-snap-align: center;
  background-color: rgb(255 255 255 / .05);
  background-image: linear-gradient(165deg, rgb(255 255 255 / .09), rgb(255 255 255 / .02) 40%, transparent 68%);
  border: 1px solid rgb(255 255 255 / .14);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / .12), 8px 15px 26px rgb(0 0 0 / .40);
  opacity: .55;
  z-index: 1;
  rotate: y 0deg;
  transition: rotate 220ms ease, translate 220ms ease, scale 220ms ease, opacity 220ms ease, border-color 180ms ease, box-shadow 220ms ease;
}
```

**Step 3: 替换原 `--active` 特写规则（约 57-63 行）为扇形层级规则：**

```css
/* Coverflow tiers: tier 由 Screener 按与选中策略的距离计算，data-fan 仅为视觉属性 */
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='near-left'] { rotate: y -26deg; scale: .95; opacity: .92; z-index: 10; }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='near-right'] { rotate: y 26deg; scale: .95; opacity: .92; z-index: 10; }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='mid-left'] { rotate: y -38deg; scale: .88; opacity: .78; z-index: 5; }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='mid-right'] { rotate: y 38deg; scale: .88; opacity: .78; z-index: 5; }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='far-left'] { rotate: y -46deg; }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='far-right'] { rotate: y 46deg; }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='center'] {
  rotate: y 0deg;
  scale: 1.06;
  translate: 0 -12px;
  opacity: 1;
  z-index: 20;
  background-color: #0d1b2e;
  background-image: linear-gradient(168deg, rgb(40 123 255 / .92), rgb(0 191 239 / .52) 52%, rgb(16 185 129 / .70));
  border-color: rgb(0 191 239 / .60);
  box-shadow: var(--glow-brand), inset 0 1px 0 rgb(255 255 255 / .30), 12px 22px 38px rgb(0 0 0 / .48);
}
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='center'] .text-muted { color: rgb(255 255 255 / .92); }
```

注：`.sn-strategy-card--active`（workstation.css）与 center 规则同时命中时，本块选择器特异性更高（0-4-0 > 0-1-0），center 渐变与发光生效。

**Step 4: 悬停/焦点归正** — 将原 hover 规则（约 64-65 行）替换为：

```css
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card:hover,
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card:focus-within { rotate: y 0deg; translate: 0 -8px; border-color: rgb(0 191 239 / .45); }
```

**Step 5: 详情参数卡升级为品牌横向渐变 + 发光** — `.sn-strategy-focus`（约 89-102 行）的 `border`、`background`、`box-shadow` 三行替换为：

```css
  border: 1px solid rgb(0 191 239 / .50);
  background: linear-gradient(115deg, rgb(40 123 255 / .78), rgb(0 191 239 / .38) 52%, rgb(16 185 129 / .58)), hsl(var(--surface));
  box-shadow: var(--glow-brand), inset 0 1px 0 rgb(255 255 255 / .34), 0 14px 28px rgb(0 0 0 / .22);
```

**Step 6: 新增箭头样式**（追加在 `.sn-strategy-focus` 规则组之后）：

```css
/* Coverflow 箭头：仅 normal/large 密度渲染，窄屏隐藏 */
.sn-fan-arrow {
  position: absolute;
  top: 50%;
  translate: 0 -50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  color: #dff3ff;
  border: 1px solid rgb(255 255 255 / .18);
  background: rgb(255 255 255 / .07);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / .18), 0 6px 16px rgb(0 0 0 / .35);
  z-index: 30;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease;
}
.sn-fan-arrow:hover:not(:disabled) { background: rgb(255 255 255 / .14); border-color: rgb(0 191 239 / .5); }
.sn-fan-arrow:disabled { opacity: .35; cursor: default; }
.sn-fan-arrow--prev { left: 6px; }
.sn-fan-arrow--next { right: 6px; }
html:not(.dark) .sn-fan-arrow { color: #24435c; border-color: rgb(0 0 0 / .10); background: rgb(255 255 255 / .72); }
```

**Step 7: 浅色主题适配** — 现有浅色卡规则（约 127-131 行）保持不变；紧随其后追加浅色 center 卡与详情卡：

```css
html:not(.dark) .sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card[data-fan='center'] { background-color: #eef4fa; box-shadow: var(--glow-brand), 8px 15px 26px rgb(30 48 66 / .18); }
html:not(.dark) .sn-strategy-focus { background: linear-gradient(115deg, rgb(40 123 255 / .16), rgb(0 191 239 / .10) 52%, rgb(16 185 129 / .14)), hsl(var(--surface)); border-color: hsl(var(--border)); box-shadow: var(--shadow-panel); }
```

**Step 8: 窄屏与减动效** — `@media (max-width: 720px)` 块内追加一行：

```css
  .sn-fan-arrow { display: none; }
```

`@media (prefers-reduced-motion: reduce)` 块（约 140-142 行）替换为：

```css
@media (prefers-reduced-motion: reduce) {
  .sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card { rotate: none; translate: none; scale: none; transition: none; }
}
```

**Step 9: 验证 + 提交**

```powershell
node node_modules/vite/bin/vite.js build
git add frontend/src/styles/strategy-studio.css
git commit -m "style: 策略页扇形卡组（coverflow 层级/玻璃重绘/箭头/详情卡渐变）"
```

---

## Task 6: Screener.tsx — 扇形交互（tier 计算/箭头/键盘/滚动居中）

**Files:**
- Modify: `frontend/src/pages/Screener.tsx`

**Step 1: 图标导入** — 第 4 行 lucide 导入追加 `ChevronLeft, ChevronRight`：

```tsx
import { ScanSearch, Clock, TrendingUp, Star, Filter, Layers, Network, Sparkles, RefreshCw, Settings2, Store, RotateCcw, X, ChevronLeft, ChevronRight } from 'lucide-react'
```

**Step 2: 组件内新增扇形工具逻辑**（放在 `displayPool` 定义之后；`activeIndex` 依赖 `displayPool` 与 `activeStrategy`）：

```tsx
  // ===== 扇形卡组（coverflow）：tier 计算 + 邻居选中 + 居中滚动 =====
  const fanActiveIndex = activeStrategy ? displayPool.indexOf(activeStrategy) : -1
  const fanTierOf = (offset: number): string => {
    const side = offset < 0 ? 'left' : 'right'
    const d = Math.abs(offset)
    if (d === 0) return 'center'
    if (d === 1) return `near-${side}`
    if (d === 2) return `mid-${side}`
    return `far-${side}`
  }
  const selectFanNeighbor = useCallback((delta: number) => {
    const base = fanActiveIndex >= 0 ? fanActiveIndex : (delta > 0 ? -1 : 1)
    const next = displayPool[base + delta]
    if (next) setActiveStrategy(next)
  }, [fanActiveIndex, displayPool])
  const fanEnabled = cardSize === 'normal' || cardSize === 'large'
  const galleryRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!fanEnabled) return
    galleryRef.current?.querySelector<HTMLElement>(".sn-strategy-card[data-fan='center']")?
      .scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeStrategy, cardSize, fanEnabled, displayPool.length])
```

**Step 3: 卡片渲染传 tier** — `<div className={...sn-strategy-gallery...}>` 加 ref 与键盘处理（约 806 行）：

```tsx
          <div
            ref={galleryRef}
            className={`sn-strategy-gallery ${cardWrapCls(cardSize)}`}
            data-density={cardSize}
            tabIndex={fanEnabled ? 0 : undefined}
            role={fanEnabled ? 'group' : undefined}
            aria-label={fanEnabled ? '策略卡组，左右方向键切换策略' : undefined}
            onKeyDown={fanEnabled ? (e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); selectFanNeighbor(1) }
              if (e.key === 'ArrowLeft') { e.preventDefault(); selectFanNeighbor(-1) }
            } : undefined}
          >
```

`displayPool.map` 内（约 807 行起）给 `StrategyCard` 新增（`index` 来自 map 回调参数，将 `displayPool.map(id =>` 改为 `displayPool.map((id, index) =>`）：

```tsx
                  fanTier={fanEnabled ? fanTierOf(index - fanActiveIndex) : undefined}
```

**Step 4: 箭头按钮** — 在 gallery `</div>` 之后、`</section>`（约 830-831 行）之前插入：

```tsx
            {fanEnabled && displayPool.length > 1 && (
              <>
                <button type="button" className="sn-fan-arrow sn-fan-arrow--prev"
                  onClick={() => selectFanNeighbor(-1)} disabled={fanActiveIndex <= 0} aria-label="上一个策略">
                  <ChevronLeft size={18} />
                </button>
                <button type="button" className="sn-fan-arrow sn-fan-arrow--next"
                  onClick={() => selectFanNeighbor(1)} disabled={fanActiveIndex >= displayPool.length - 1} aria-label="下一个策略">
                  <ChevronRight size={18} />
                </button>
              </>
            )}
```

**约束（不得越界）:** 不改 `handleRun`、不新增 API 调用/查询键/存储；`selectFanNeighbor` 仅调用既有 `setActiveStrategy`；不删除任何既有属性与回调。

**Step 5: 验证 + 提交**

```powershell
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
git add frontend/src/pages/Screener.tsx
git commit -m "feat(ui): 策略卡组扇形交互（箭头切换/键盘/居中滚动，复用既有选中状态）"
```

---

## Task 7: 离线策略页 QA 验收（3013 + Playwright + 截图）

**Step 1: 后台启动策略页样板**（`frontend/` 目录）：

```powershell
node node_modules/vite/bin/vite.js --config qa/strategy.vite.config.ts
```

访问 `http://127.0.0.1:3013/qa/strategy-page.html`。

**Step 2: 自动检查（已装 Playwright 时）：**

```powershell
node qa/check-strategy.cjs
```

输出深/浅/窄屏截图到 `docs/design/`，检查页面状态与 JS 错误。

**Step 3: 手动核对清单：**
- 暗色：纯黑底、扇形层级正确（居中卡渐变+发光、两侧递减透视）、左右箭头可用且边界禁用
- 点击侧卡 → 居中并选中；键盘 ←/→ 切换；悬停侧卡归正
- 选中卡操作完整：参数设置弹窗开/关（Esc、焦点返回）、运行选股回调、监控图标
- 密度切换：紧凑（自动换行不扇形、无箭头）、隐藏（卡区整体消失）
- 浅色主题、390px 容器无溢出、无未捕获 JS 错误
- 发现问题：修复 → 重建 → 重验，修复随本任务提交

**Step 4: 停止后台服务。截图归档 `docs/design/`（覆盖 v1.1 样板命名或新增 v2 前缀）。**

```powershell
git add docs/design/
git commit -m "docs: v2.0 策略页样板截图与验收记录"
```

---

## Task 8: 设计规范升版 v2.0

**Files:**
- Modify: `docs/SnStick-UI-UX-Design-Spec.md`

**Step 1: 定点修订**（不重写全文，逐节改）：
- 版本头：`1.1 · 策略页视觉校正` → `2.0 · 纯黑玻璃与扇形卡组`
- §3.1 暗色列：`--base 210 8% 6%` → `0 0% 0%`；`--surface`/`--elevated` 同步新值
- §2.2 品牌渐变表：端点更新为 `#287BFF / #00BFEF / #10B981`
- §3.3 浓度控制：选中态改 55%/28%/38%（160deg），删除"避免铺满饱和渐变"对选中卡的约束
- §4 玻璃材质：新增"发光层"行（`--glow-brand`，范围：选中策略卡/导航当前项/详情参数卡）
- §7.2：删除"不使用大范围蓝色外发光"，替换为发光范围与降级说明
- §15 或新增 §16：记录扇形层级（near/mid/far/center 参数）、箭头与键盘交互、密度兼容、降级路径
- §14.3 追加 v2.0 验收记录行（构建结果、QA 清单结果、截图文件名）

**Step 2: 提交**

```powershell
git add docs/SnStick-UI-UX-Design-Spec.md
git commit -m "docs: UI 规范升版 v2.0（纯黑玻璃/发光/扇形卡组）"
```

---

## Task 9: 收尾 — 用户视觉验收

- 告知用户启动方式：`.\dev.ps1`（完整应用）或 3013 离线样板
- 用户确认视觉效果后，本计划完结；如需微调（发光浓度/扇形角度/渐变配比），按「改 token → 重建 → 重截图」小循环处理
- 未验证事项如实记录（真实后端联调、全应用端到端、移动 viewport——同 v1.1 §14.3 边界）

## 回退

- 任一任务异常：`git revert` 对应 commit 即可，无数据迁移、无配置升级、无新依赖
- 禁止全仓 reset（会波及用户未提交的 v1.1 之外的文件）

> AI生成