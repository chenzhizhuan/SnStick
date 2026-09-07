# 离线 UI 组件验收

## 完整策略页样板（新版）

在 frontend 目录执行 `node node_modules/vite/bin/vite.js --config qa/strategy.vite.config.ts`，访问 http://127.0.0.1:3013/qa/strategy-page.html 。点击策略卡查看选中材质、当前策略面板和结果表。

此入口直接挂载生产 Screener 页面，不复制组件逻辑。独立本地响应仅用于视觉检查，未支持的操作明确返回离线提示；不连接外部服务。3013 的本地存储与正式应用端口隔离。完整生产导航未挂载，顶栏为预览说明。

安装了 Playwright 与 Edge 的环境可运行 `node qa/check-strategy.cjs`；也可通过 `SNSTICK_PLAYWRIGHT` 指定已有 Playwright 包。该检查只允许本地 3013 请求，检查页面状态并输出深浅/窄屏截图到 docs/design。

## 旧版组件检查页

下方 3012 入口仅用于单独组件检查，不作为完整改版效果交付。

在 frontend 目录、依赖已安装的环境执行：

```powershell
node node_modules/vite/bin/vite.js --config qa/vite.config.ts
```

访问 http://127.0.0.1:3012/qa/ui-preview.html 。独立配置没有 API 代理；样例不导入应用入口或 API，CSP 限制连接到当前本地服务。

使用真实 Logo、PageHeader、StrategyCard、StockDataTable 和 Modal。可检查深浅主题、390px 容器、卡片密度、选中、监控图标、加载、空数据和弹窗焦点。所有数据均为明确标注的本地样例，导航仅显示提示，不执行业务操作。

此页不是生产页面替身或业务验收结果。390px 开关只缩窄样例容器；正式移动导航和 viewport 断点仍需在真实业务环境验证。

独立类型检查：`node node_modules/typescript/bin/tsc -p qa/tsconfig.json --noEmit`。
