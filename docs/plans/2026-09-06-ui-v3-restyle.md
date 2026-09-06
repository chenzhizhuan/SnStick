---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '476c9c16-d071-4c6a-8b9c-d9cea4bc5f2f'
  PropagateID: '476c9c16-d071-4c6a-8b9c-d9cea4bc5f2f'
  ReservedCode1: 'b10a04df-f6c0-4545-859b-cee4b530a054'
  ReservedCode2: 'b10a04df-f6c0-4545-859b-cee4b530a054'
---

# SnStick UI v3.0 实施计划（靛蓝深空 · 功能零变更）

> **For implementer:** 纯视觉重构。沿用项目既有验证方式：类型检查 + 构建 + 离线 QA 样板（3012/3013）+ 浏览器实测截图对比参考图。每任务验证通过即提交，只 add 该任务文件。视觉规范权威：`docs/SnStick-UI-UX-Design-Spec.md` v3.0。

**Goal:** 将 v2.0（纯黑+蓝青渐变+扇形+强发光）重构为 v3.0「靛蓝深空」B 端数据平台风格：分层实色深蓝紫黑底、单一靛蓝品牌实色、深底亮字标签、规整网格策略卡、克制发光。功能、路由、数据、回调零变更。

**Architecture:** 改动收敛在 4 个样式层文件 + 1 个图表色板文件：`index.css`（token）、`workstation.css`（全局组件材质）、`strategy-studio.css`（策略页专项，整体重写为网格）、`theme.ts`（ECharts 画布色板）；外加 `Screener.tsx`/`StrategyCard.tsx` 移除本会话新增的扇形交互代码（恢复既有回调结构）。用户已确认：策略卡回归规整网格（ref-06 范式）。

**Tech Stack:** React 18 + TS + Tailwind（HSL CSS 变量体系）+ ECharts。验证命令在 `frontend/` 执行。

**taste-skill 旋钮:** VARIANCE 3 / MOTION 2 / DENSITY 8。纪律：色彩一致性锁（全站唯一强调色 #6366F1）、形状一致性锁（卡片 8px/按钮 6px/标签 4px）、无纯黑纯白、无大面积渐变、发光仅选中态 8px、对比度 AA。

---

## Task 1: index.css — v3.0 token 焕新

**Files:** Modify `frontend/src/index.css`

**要点（暗色 `html.dark` 整块重写）：**

```css
html.dark {
  color-scheme: dark;
  --base: 229 27% 8%;          /* L0 #0F111A */
  --surface: 230 25% 13%;      /* L2 #191C2A */
  --elevated: 228 26% 16%;     /* L2.5 #1E2233 */
  --border: 227 24% 19%;       /* #252A3D */
  --fg-primary: 214 32% 91%;   /* #E2E8F0 */
  --fg-secondary: 215 20% 65%; /* #94A3B8 */
  --fg-muted: 215 16% 47%;     /* #64748B */
  --accent: 239 84% 67%;       /* #6366F1 */
  --bull: 4 87% 60%;           /* 不变 */
  --bear: 152 67% 45%;         /* 不变 */
  --warning: 32 95% 50%;       /* 不变 */
  --danger: 4 87% 60%;         /* 不变 */
  --brand-blue: 99 102 241;    /* #6366F1 靛蓝（唯一品牌色） */
  --brand-cyan: 129 140 248;   /* #818CF8 hover 亮靛蓝 */
  --brand-mint: 79 70 229;     /* #4F46E5 激活深靛蓝 */
  --selected-bg: 230 32% 22%;  /* L3 #262B4A 选中底 */
  --radius-card: 8px;
  --radius-control: 6px;
  --radius-input: 6px;
  --radius-dialog: 16px;
  --glass-sheen: none;                              /* 玻璃高光退役 */
  --glass-body: hsl(var(--surface));                /* 实色 */
  --glass-selected: linear-gradient(0deg, rgb(var(--brand-blue) / .12), rgb(var(--brand-blue) / .12)); /* 平色靛蓝薄底 */
  --glass-line: rgb(255 255 255 / .08);
  --shadow-panel: 0 2px 8px rgb(0 0 0 / .20);
  --shadow-float: 0 12px 32px rgb(0 0 0 / .45);
  --focus-color: #818cf8;
  --glow-brand: 0 0 8px rgb(var(--brand-blue) / .30);  /* 发光收敛 */
  --control-primary: none;                           /* 实色按钮，背景色在组件层 */
}
```

**亮色 `:root` 同步更新**（保持结构、换靛蓝系）：`--accent: 245 78% 52%`（#4F46E5 亮色版），品牌 RGB 三元组同暗色；`--selected-bg: 239 84% 94%`；`--glass-selected` 亮色平色 `rgb(99 102 241 / .08)`；`--glow-brand: 0 0 8px rgb(var(--brand-blue) / .15)`；`--control-primary: none`；radius 同步 8/6/6/16；浅色底色微调偏冷：`--base: 220 20% 97%`、`--elevated: 220 14% 95%`、`--border: 227 15% 88%`。

**验证:** `tsc -b` + `vite build` → **提交** `style: v3.0 token — 靛蓝深空四层底色/实色品牌/发光收敛`

## Task 2: workstation.css — 全局组件材质重绘

**Files:** Modify `frontend/src/styles/workstation.css`

1. **去渐变铺底**：`.sn-workstation` radial 背景删除（保留类名空规则或删规则）；`.sn-navigation` 背景改 `hsl(var(--surface))` 纯色（去 sheen/radial），侧栏右边框 1px var(--border)。
2. **导航选中态**：背景 `hsl(var(--selected-bg))`、文字白、左侧 2px `#6366F1` 指示条（复用既有 `.bg-accent.absolute` 竖条选择器改为实色靛蓝）、`box-shadow: var(--glow-brand)`（8px 克制版）。
3. **页头**：`.sn-page-header` 纯 `hsl(var(--base))` + 底部 1px 边框（去 sheen/内高光）。
4. **卡片**：`.rounded-card.bg-surface` 族 → 实色 surface + `border: 1px hsl(var(--border))` + `--shadow-panel`；去 `--glass-sheen`。
5. **策略卡**：`.sn-strategy-card` 实色 + border；hover 边框 `hsl(var(--fg-muted) / .50)`；`.sn-strategy-card--active`：border `hsl(var(--accent) / .55)`、bg `rgb(var(--brand-blue) / .10)`、`box-shadow: var(--glow-brand)`（替代旧强发光组合）。
6. **按钮**：`button.bg-accent` 族 → `background-color: #6366F1`、`background-image: none`、hover 由既有 transition 生效（如需明确 hover 色，加 `filter: brightness(1.1)` 级规则，不改事件）；`.bg-accent.text-white` 检查用同实色。
7. **表格**：thead `hsl(var(--elevated))`；th 色 fg-secondary；行 hover（如组件层有）随 token 自动变。
8. **弹窗**：`.sn-dialog` 实色 surface + `--shadow-float`。
9. **认证页反射** `.sn-auth-reflection`：radial 渐变删除。
10. **浅色策略卡来源标签加深**（amber/purple/teal 三行）保留（无障碍修正，属 v3.0 标签系统浅色变体）。
11. `prefers-reduced-transparency` 降级块保留并适配新选择器。

**验证:** `vite build` → **提交** `style: v3.0 全局组件材质 — 分层实色/靛蓝选中态/发光收敛`

## Task 3: 策略页回归网格（CSS 重写 + 移除扇形交互）

**Files:** Modify `frontend/src/styles/strategy-studio.css`（整体重写）、`frontend/src/pages/Screener.tsx`、`frontend/src/components/screener/StrategyCard.tsx`

### 3a. StrategyCard.tsx — 移除本会话新增的扇形属性
- interface 删 `fanTier?: string`；解构删 `fanTier`；motion.div 删 `data-fan={fanTier}`。

### 3b. Screener.tsx — 移除扇形交互（恢复至 v2.0 前的调用结构）
- lucide 导入删 `ChevronLeft, ChevronRight`；
- 删扇形逻辑块（`fanActiveIndex`/`fanTierOf`/`selectFanNeighbor`/`fanEnabled`/`galleryRef`/居中滚动 useEffect）；
- JSX：拆掉 `sn-fan-cluster` 包裹层；gallery div 恢复简单形态（去 ref/tabIndex/role/aria-label/onKeyDown）；`displayPool.map((id, index)` 恢复 `displayPool.map(id`，删 `fanTier` 传参；删左右箭头 JSX 块。
- 保留：handleRun、activeStrategy、全部回调、密度模式、筛选逻辑（零功能变更）。

### 3c. strategy-studio.css — 整体重写为网格范式（ref-06）

```css
/* 骨架 */
.sn-strategy-stage { position: relative; }
.sn-screener { min-height: 100%; background: hsl(var(--base)); }
.sn-screener > .sn-page-header { align-items: flex-start; flex-wrap: wrap; gap: 20px; padding: 24px 28px 18px; background: transparent; border: 0; box-shadow: none; }
.sn-screener > .sn-page-header h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.sn-screener-body { padding-bottom: 32px; }

/* 网格卡组（normal/large）；mini 保持原换行、hidden 不渲染 */
.sn-strategy-gallery:not([data-density='mini']) {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
  gap: 16px;
  padding: 8px 0 20px;
}
.sn-strategy-gallery[data-density='large'] { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }

/* 单卡：实色面板 */
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 148px;
  padding: 14px 16px;
  border-radius: var(--radius-card);
  background-color: hsl(var(--surface));
  border: 1px solid hsl(var(--border));
  box-shadow: var(--shadow-panel);
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
}
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card:hover { border-color: hsl(var(--fg-muted) / .50); }
.sn-strategy-gallery:not([data-density='mini']) .sn-strategy-card--active {
  border-color: hsl(var(--accent) / .60);
  background-color: rgb(var(--brand-blue) / .10);
  box-shadow: var(--glow-brand);
}
```

- 卡内排版：名称 `14px/500` fg-primary（.truncate 保留单行）；命中数 `.font-mono 20px/600` + 「只」12px muted；描述 12px fg-secondary `line-clamp-2`；徽章沿用组件内 Tailwind 类（bg-*-500/10 + text-*-400 本就是深底亮字范式）；设置/监控小按钮 `absolute top-2 right-2 / right-8`，28px 热区，hover bg-elevated。
- 失效数徽章（红 -N）沿用组件类，颜色随 token。
- **当前策略面板 `.sn-strategy-focus`**：实色 surface 卡 + border + 8px 圆角 + padding 20px 24px；去渐变/发光/文件夹页签（::before 删除）；eyebrow 12px fg-secondary；h2 18px/600；按钮组：参数设置 = 次按钮（surface+border）、运行选股 = 主按钮（#6366F1 实底白字）；按钮 padding 8px 16px、圆角 6px。
- **结果区 `.sn-screener-results`**：实色 surface + border + 8px 圆角 + padding 16px；`:empty` 隐藏保留。
- **删除全部**：perspective/rotate/scale/translate 过渡、负 margin、coverflow tiers、far 隐字、箭头样式族、`.sn-fan-cluster`、玻璃 ::before 高光、浅色专用渐变卡（浅色卡直接随 token 生效）。
- **媒体查询**：≤720px gallery `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`、focus 纵向堆叠、padding 16px；`prefers-reduced-motion` 仅留 `transition: none`。

**验证:** `tsc -b` + `vite build` → **提交** `feat(ui): 策略卡回归规整网格（v3.0 靛蓝面板，移除扇形）`

## Task 4: theme.ts 图表色板 + Tailwind 圆角核对

**Files:** Modify `frontend/src/lib/theme.ts`；检查 `frontend/tailwind.config.ts`

- DARK：text `#94A3B8`、textStrong `#E2E8F0`、grid `rgba(148,163,184,0.10)`、border `#2E3348`、crosshair `rgba(148,163,184,0.35)`、crosshairLabelBg `#262B4A`、tooltipBg `rgba(30,34,51,0.98)`、tooltipBorder `rgba(148,163,184,0.15)`、tooltipText `#E2E8F0`、infoBarBg `rgba(25,28,42,0.92)`、zoomFill `rgba(99,102,241,0.15)`、fillSubtle `rgba(148,163,184,0.05)`。
- LIGHT：text `#5A6474`、textStrong `#1A1F2E`、crosshairLabelBg `#4F46E5`、zoomFill `rgba(79,70,229,0.10)`、infoBarBg `rgba(244,245,250,0.95)`，其余微调对齐。
- 核对 tailwind.config.ts 圆角 token 映射（rounded-card/btn/input/dialog → CSS 变量），值变更在 index.css 已完成；确认无硬编码 12px 遗留。
- 涨跌/指标序列色不在此文件（语义色双主题一致），零触碰。

**验证:** `tsc -b` + `vite build` → **提交** `style: 图表画布色板对齐 v3.0（靛蓝深空）`

## Task 5: 全量验证 + 并排对比 + 截图归档

1. 启动 3013 离线样板（若端口被用户进程占用则复用其 HMR，注意触发文件 watcher 刷新；必要时提醒用户强刷）。
2. 浏览器实测清单（暗色优先）：四层底色递进、导航选中态（靛蓝底+左条+8px 发光）、网格策略卡（hover/选中）、当前策略面板（次/主按钮）、参数弹窗开/关、表格不发光、紧凑模式、浅色主题、390px 无溢出、无 JS 错误。
3. 截图：暗色全页、浅色全页、390px，与 `docs/design/reference/ref-06-skill-center.png` 并排目视对比（底色倾向/品牌色密度/信息密度/控件精致度四项）。
4. 归档 `docs/design/strategy-page-v3-dark.png` 等，提交 `docs: v3.0 验收截图`。
5. 更新规范 §11 实施状态（勾选四步完成），提交。

## 红线（每任务自查）

- 不改：路由、菜单、表格列、参数、查询键、事件处理、存储、涨跌红绿、Logo 资产、vite.config.ts。
- 扇形移除是用户显式批准的交互还原（恢复到 v2.0 之前的调用结构），非静默功能删改。
- 回退：逐任务 `git revert`；无数据迁移、无新依赖、无后端改动。

> AI生成