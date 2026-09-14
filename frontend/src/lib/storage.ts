/**
 * 集中管理所有 localStorage 持久化。
 *
 * - key 在此注册，各页面只通过 storage.xxx.get/set 调用。
 * - 类型安全，不再散落 try/catch。
 *
 * 用户命名空间 (v2.3 多用户隔离前端侧):
 *   - 桌面版 / 单密码形态: 用户级 key 与全局 key 相同, 零改动。
 *   - 互通形态: 用户级 key 动态加前缀 `u:<user_id>:`, 账号 A 的策略池/草稿/
 *     回测残留不会出现在账号 B 的页面上; 登录身份变化时清空旧前缀数据
 *     (main.tsx 统一处理)。
 */

/** 当前用户级 key 前缀 ('u:<uid>:' 或 '' = 桌面版/未登录)。 */
let _userPrefix = ''

/** 设置当前用户前缀 (登录后身份快照就绪时调用; '' = 桌面版/单密码形态)。 */
export function setActiveUserKeyPrefix(prefix: string) {
  _userPrefix = prefix || ''
}

/** 已知用户级裸 key 常量 (不走 storage 注册表, 直接读写的模块)。
 *  身份切换时一并清理, 防止旧账号残留串给新账号。 */
const RAW_USER_KEYS = [
  'mining_workbench_draft_v1',
  'mining_active_run_id',
  'walkforward_reconnect', 'walkforward_job_key',
  'optimizer_reconnect', 'optimizer_job_key',
  'backtest_reconnect',
]

/**
 * 清除"其他账号"的用户级数据 (身份变化时调用)。
 *
 * - 保留: 当前前缀 `u:<uid>:` 下所有 key (本人的策略池/草稿/回测残留);
 *         所有非 `u:` 开头的浏览器级偏好 (主题/列配置/告警声音等, 各账号共享)。
 * - 清除: 其他账号前缀 `u:<other_uid>:` 下的 key;
 *         升级前无前缀写入的用户级历史残留 (如 'strategy-pool')。
 *
 * 桌面版 (prefix='') : 只做无前缀用户级残留清理, 不碰任何 u: 前缀 key
 *                      (单用户形态不存在跨账号问题), 也不碰浏览器级偏好。
 */
export function clearUserScopedKeys(prefix: string) {
  try {
    const current = prefix || ''
    const dead: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k === null) continue
      if (k.startsWith('u:')) {
        // 用户级 key: 保留本人前缀, 清其他账号
        if (current && k.startsWith(current)) continue
        if (!current) continue   // 桌面版: 互通未启用, u: 前缀 key 不该存在, 保守不动
        dead.push(k)
      } else if (RAW_USER_KEYS.includes(k)) {
        // 无前缀用户级残留 (升级前旧数据): 清
        dead.push(k)
      }
    }
    for (const k of new Set(dead)) localStorage.removeItem(k)
  } catch { /* ignore */ }
}

/** 生成用户级实际 key: 桌面版无前缀; 互通形态 `u:<uid>:<key>`。 */
function userKey(key: string) {
  return _userPrefix ? `${_userPrefix}${key}` : key
}

/** 对外暴露用户级 key 拼接 (useLastStock 等裸 localStorage 模块复用)。 */
export function userKeyOf(key: string) {
  return userKey(key)
}

function kv<T>(key: string) {
  return {
    get(fallback: T): T {
      try {
        const raw = localStorage.getItem(key)
        if (raw !== null) return JSON.parse(raw) as T
      } catch { /* ignore */ }
      return fallback
    },
    set(val: T) {
      try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* ignore */ }
    },
    remove() {
      try { localStorage.removeItem(key) } catch { /* ignore */ }
    },
  }
}

/** 用户级 kv — 互通形态 key 带用户前缀, 桌面版与 kv() 完全等价。 */
function userKv<T>(key: string) {
  return {
    get(fallback: T): T {
      try {
        const raw = localStorage.getItem(userKey(key))
        if (raw !== null) return JSON.parse(raw) as T
      } catch { /* ignore */ }
      return fallback
    },
    set(val: T) {
      try { localStorage.setItem(userKey(key), JSON.stringify(val)) } catch { /* ignore */ }
    },
    remove() {
      try { localStorage.removeItem(userKey(key)) } catch { /* ignore */ }
    },
  }
}

export const storage = {
  /** 查询轮询 / SSE 配置 */
  queryConfig:          kv<unknown>('tf-stocks-query-config'),

  /** 策略池 (screener) — 统一池 (日线+分钟共用, 执行按各自声明周期路由)。
   *  用户级: 互通形态跨账号隔离 (A 的池不串给 B)。 */
  strategyPool:         userKv<string[]>('strategy-pool'),
  /** 旧分钟隔离池 — 仅作一次性迁移读取源, 迁移完成后移除该 key */
  strategyPoolMinute:   userKv<string[]>('strategy-pool-1m'),

  /** 自选列表列配置 */
  watchlistColumns:     kv<unknown[]>('watchlist_columns'),

  /** 个股日K信息条指标配置 */
  stockInfoBarFields:   kv<unknown[]>('stock_info_bar_fields'),

  /** 个股日K成交量对比设置 */
  stockVolumeCompare:   kv<{ enabled: boolean; days: number }>('stock_volume_compare'),

  /** 个股详情多日分时周期 */
  stockPreviewIntradayDays: kv<number>('stock_preview_intraday_days'),

  /** 个股详情外链 URL 模板 (支持 {code}/{market}/{symbol}; 留空关闭) */
  stockExternalTemplate: kv<string>('stock_external_template'),

  /** 策略结果列表列配置 */
  screenerResultColumns: kv<unknown[]>('screener_result_columns'),

  /** 自选列表视图模式 table | card (分组卡片为临时模式, 不持久化) */
  watchlistView:        kv<string>('watchlist_view'),

  /** 自选列表日K蜡烛图显示状态 */
  watchlistCandle:      kv<boolean>('watchlist_showCandle'),

  /** 自选列表分时图显示状态 */
  watchlistIntraday:    kv<boolean>('watchlist_showIntraday'),

  /** 策略结果列表日K蜡烛图显示状态 */
  screenerCandle:       kv<boolean>('screener_showCandle'),

  /** 策略结果列表分时图显示状态 */
  screenerIntraday:     kv<boolean>('screener_showIntraday'),

  /** 策略结果列表"策略"列标签展开状态 (false=默认收起: 每行首个+计数, 行内可单独展开) */
  screenerStrategyTags: kv<boolean>('screener_strategyTagsExpanded'),

  /** 自选列表板块筛选 */
  watchlistBoardFilter: kv<string[]>('watchlist_boardFilter'),

  /** 自选列表排除 ST 标的 (默认不排除) */
  watchlistExcludeST:    kv<boolean>('watchlist_excludeST'),

  /** 自选分组统计条配置 (metric: 统计指标, sort: 排序方式, card*: 分组卡片显示项) */
  watchlistGroupStats: kv<{ metric: string; sort: string; cardTopN?: number; cardColorBar?: boolean; cardRank?: boolean }>('watchlist_groupStats'),

  /** 异动监控: 主开关 (默认关, 开启后才轮询计算; 告警走监控中心规则) */
  abnormalEnabled:      kv<boolean>('abnormal_enabled'),

  /** 异动监控: 上次计算结果 (关闭开关后仍展示, 含 asof 计算时间戳) */
  abnormalLastResult:   kv<unknown>('abnormal_last_result'),

  /** Screener 卡片尺寸 */
  screenerCardSize:     kv<string>('screener-card-size'),

  /** 连板梯队板块筛选 */
  limitLadderBoard:     kv<string[]>('limit-ladder-board-filter'),

  /** 连板梯队 ext 字段配置 */
  limitLadderExtFields: kv<Record<string, any>>('limit-ladder-ext-fields'),

  /** 连板梯队 概念/行业 显示开关 */
  limitLadderShowExt:   kv<{ concept: boolean; industry: boolean }>('limit-ladder-show-ext'),

  /** 连板梯队 涨停/跌停 切换方向 */
  limitLadderDirection: kv<'up' | 'down'>('limit-ladder-direction'),

  /** 连板梯队 封单显示模式: vol=按成交量(手), amount=按金额(元) */
  limitLadderSealMode:  kv<'vol' | 'amount'>('limit-ladder-seal-mode'),

  /** 策略创建草稿（新建专用）。用户级: 草稿内容属于个人工作现场。 */
  strategyDraft: userKv<{ name: string; description: string; direction: string; style?: string; rules: string; code: string; step: number; strategyId: string; source?: 'ai' | 'custom' } | null>('strategy-draft'),

  /** 策略修改草稿（AI修改专用，不影响创建按钮）。用户级。 */
  strategyModify: userKv<{ name: string; description: string; direction: string; style?: string; rules: string; code: string; step: number; strategyId: string; source?: 'ai' | 'custom' } | null>('strategy-modify'),

  /** 策略构建器草稿（旧版兼容，逐渐废弃）。用户级。 */
  strategyBuilderDraft: userKv<{ name: string; description: string; direction: string; style?: string; rules: string; code: string; step: number; strategyId: string; source?: 'ai' | 'custom' } | null>('strategy-builder-draft'),

  /** 已保存策略的原始规则（策略ID → 规则文本）。用户级。 */
  strategyRules: userKv<Record<string, string>>('strategy-rules'),

  /** 策略回测快捷区间按钮配置 */
  strategyBacktestQuickRanges: kv<unknown>('strategy-backtest-quick-ranges'),

  /** 策略回测最后一次成功结果和参数。用户级: 回测残留属于个人工作现场。 */
  strategyBacktestLast: userKv<{
    selectedStrategy: string | null
    symbols: string
    assetType?: 'stock' | 'etf'
    start: string
    end: string
    matching: 'close_t' | 'open_t+1'
    entryFill: 'close_t' | 'open_t+1'
    exitFill: 'close_t' | 'open_t+1' | 'signal_next_minute'
    fees: string
    stampTax?: string
    slippage: string
    maxPositions: string
    maxExposure: string
    initialCapital: string
    positionSizing: 'equal' | 'score_weight'
    mode: 'position' | 'full'
    holdingDays: string
    minuteFill?: boolean
    regimeStates?: string[]
    regimeMinScore?: number | ''
    params?: Record<string, any>
    overrides?: Record<string, any>
    strategyConfigSignature?: string
    result: any
  } | null>('strategy-backtest-last'),

  /** 概念分析页面字段配置 */
  conceptAnalysisConfig: kv<Record<string, any>>('concept-analysis-config'),

  /** 行业分析页面字段配置 */
  industryAnalysisConfig: kv<Record<string, any>>('industry-analysis-config'),

  /** 数据页画像卡片显隐 (卡片key → 是否显示) */
  dataCardVisible: kv<Record<string, boolean>>('data-card-visible'),
  /** 数据页画像卡片顺序 (卡片key 数组, 长度=卡片总数) */
  dataCardOrder: kv<string[]>('data-card-order'),
} as const
