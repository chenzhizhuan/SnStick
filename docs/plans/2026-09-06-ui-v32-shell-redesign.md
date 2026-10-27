---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '74b4d583-4db0-4ed5-a45e-65c6d79399bb'
  PropagateID: '74b4d583-4db0-4ed5-a45e-65c6d79399bb'
  ReservedCode1: '82554e48-23da-44fa-858b-ea8cd66498c6'
  ReservedCode2: '82554e48-23da-44fa-858b-ea8cd66498c6'
---

# SnStick UI v3.2 布局重构设计（换壳：顶部品牌栏 + 分组导航）

> 日期：2026-09-06
> 状态：用户已确认方案 A（完整换壳）+ 业务域分组
> 前置：v3.1.1（颜色/材质/对比度已达标，用户反馈"只换了背景色，要布局也变，像一样新的网站"）
> 红线：路由、菜单项、表格列、参数、回调、徽标、悬浮卡、三态折叠、移动端抽屉全部保留

## 1. 问题

v3.x 只改了皮肤（token/材质/颜色），骨架（传统左侧边栏 + 简单页头）与旧版一致，观感仍是"老网站换配色"。参考系 Model-Flow 的代际特征是：顶部品牌栏 + 窄分组导航 + 统一页头模式 + 统计条。

## 2. 目标结构

```
┌────────────────────────────────────────────────┐
│ 顶栏 48px: Logo + 产品名 + 版本pill | 健康徽标 AI徽标 主题 折叠 │  ← 新增
├──────────┬─────────────────────────────────────┤
│ 导航 208px│  PageHeader（升级：标题/说明/操作组）      │
│ ─ 总览    │─────────────────────────────────────│
│ ─ 策略回测 │  页面内容                              │
│ ─ 市场分析 │                                     │
│ ─ 监控预警 │                                     │
│ ─ 数据复盘 │                                     │
│ 设置(底部) │                                     │
└──────────┴─────────────────────────────────────┘
```

外层容器已是 `display: grid`（14rem/3.5rem/0 三态列），加 `grid-template-rows: 48px 1fr`，顶栏 `grid-column: 1 / -1`。

## 3. 顶栏（新增，48px）

- 左：Logo 28px + 「赢在子午线」16px/600 + 版本 pill（`rounded bg-elevated px-1.5 text-[10px] font-mono`，useVersion 数据）
- 右：`DataSourceHealthBadge` + `AIConfigBadge`（从侧栏品牌块迁来，紧凑化）+ `ThemeToggle` + 桌面折叠按钮（三态循环）；移动端显示菜单按钮（Menu icon → 开抽屉）
- 背景 surface、底边框、无阴影；移动端抽屉打开时顶栏照常

## 4. 侧栏导航（重组为分组）

- 删除品牌块（已上移顶栏），aside 顶部直接开始分组菜单
- 分组（按业务域，用户确认）：
  - 总览：看板 `/`、自选 `/watchlist`
  - 策略与回测：策略 `/screener`、回测 `/backtest`、挖掘 `/mining`、持仓提醒 `/lots`
  - 市场分析：个股分析、连板梯队、概念分析、行业分析、财务分析、扩展分析 `/analysis/*`
  - 监控预警：监控中心、市场环境、异动监控
  - 数据与复盘：复盘、指数、数据
- 组标题：11px `text-muted/70 uppercase tracking-wider`，px-3 pt-4 pb-1；rail 态隐藏组标题
- 组内无可见项（nav_hidden 过滤后）→ 整组不渲染
- 保留：NavLink 结构、选中指示条、MonitorBadge、自选二级展开（watchlistGroups）、指数行情区、实时开关区、底部设置项、扩展菜单（getFrontendExtensionNavigation 归入"市场分析"组尾部，未匹配组的动态项归入"数据与复盘"尾部兜底）

## 5. PageHeader 升级（全站 20+ 页自动生效）

现状：单行（h1 + subtitle 内联 + right）。升级为参考系页头模式：

```
[标题 18px/600]  [titleExtra]            [right 操作组]
[subtitle 13px muted 单独一行]
```

- subtitle 移到标题下方独立行（不再是内联小尾巴）
- padding 20px 28px 14px；底边框保留
- 组件 props 不变（title/subtitle/titleExtra/right/className），零页面改动

## 6. 看板统计条（Dashboard 专项）

看板顶部新增横向指标条（ref-04 范式）：数据日期、策略数、监控规则数、未读预警、实时状态等 4-6 个指标卡（L2 卡 + 18px 等宽大数字 + 12px 标签），数据全部来自看板已有查询，不加新请求。

## 7. 不变项（红线）

- 三态折叠逻辑（expanded 14rem / rail 3.5rem / hidden+左缘悬浮）与 localStorage 键
- 移动端抽屉（<768px）与 ESC 关闭
- 指数悬浮卡（fixed 定位逃逸裁剪机制）
- 所有浮层（Toast/AlertToast/AI 气泡）、SSE 重连提示
- 菜单可隐藏偏好（nav_hidden）、菜单排序偏好（顺序在组内仍按现有 navItems 顺序渲染）
- 策略页网格（v3.0 已定稿）

## 8. 实施顺序（每步独立提交）

1. **顶栏 + grid 行**：新增 Topbar（Layout.tsx 内组件），gridTemplateRows 48px 1fr，品牌块迁顶栏，健康/AI 徽标迁顶栏
2. **导航分组**：nav 数组加 group 字段，nav 渲染改分组循环，删侧栏品牌块
3. **PageHeader 升级**：组件改双行结构
4. **看板统计条**：Dashboard.tsx 顶部加指标条
5. **全站走查**：3011 实测 + 截图对比参考系

## 9. 验收

- `tsc -b` + `vite build` 通过；3011 全应用无 JS 错误
- 顶栏 48px、品牌+版本+徽标+主题+折叠齐全；移动端菜单按钮开抽屉
- 导航 5 组、组内全部 17 项可见（无删除）；rail/hidden/抽屉三态正常
- PageHeader 双行结构全站生效（抽查 5 页）
- 看板统计条显示真实数据
- 并排截图对比 ref-01/04：结构相似度显著提升（"新网站"观感）

> AI生成