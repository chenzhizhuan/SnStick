"""用户数据命名空间 — 请求级用户根解析 (v2.3 §5 分支阀门架构)。

背景 (v2.3 代码实证):
  data_dir 根目录下混居两类内容 —— 行情/缓存类 (kline_daily、financials 等,
  GB 级全局共享) 与用户工件类 (user_data/、strategies/ 等)。因此不可在
  data_dir 计算中插入 {user_id} 分段; 正确做法是 data_dir 全局不动, 新增独立
  用户根 data/users/{user_id}/, 用户工件调用点逐个切换 (分支阀门)。

用户根解析规则 (三分支):
  1. 未启用账号互通 (桌面版 / 未互通部署): 返回原 data/user_data/ ——
     桌面版零改动铁律 (v2.3 决策 #6), 所有用户工件路径与升级前完全一致。
  2. 互通形态 + 已登录: 返回 data/users/{user_id}/ (分支阀门)。
  3. 互通形态 + 后台/兜底 (无请求上下文): 返回 data/users/local/ ——
     服务端 local 降级模式 (迁移脚本把存量单密码数据归于此)。

上下文传播:
  - 请求路径: auth_middleware 校验身份后 set_context_user(), contextvar
    随请求传播到 services 层 (sync 线程池端点经 anyio to_thread 继承)。
  - 后台任务: 显式 user_scope(user_id) 上下文管理器逐用户执行 (M3-3d)。
"""
from __future__ import annotations

import contextvars
import logging
import re
import threading
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

# 显式用户根设置的时间: previous explicit root (None = 未设置)。worker 子进程
# 从 task dict 反序列化用户根后用 root_scope() 包裹执行 —— 子进程 contextvar
# 为空, 请求身份不可用, 必须显式传根 (v2.3 §5.2 子进程行: 父进程算好再传入)。
_explicit_root: contextvars.ContextVar[Path | None] = contextvars.ContextVar(
    "sns_explicit_user_root", default=None
)

# 当前请求用户 (None = 后台任务/未登录/桌面版)
_current_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "sns_user_id", default=None
)

# 显式 user_scope() 设置的 user_id (叠加在 contextvar 之上, 后台任务逐用户执行用)
# token 深度: 支持嵌套 scope 切换 (理论上不会发生, 防御性设计)
_scope_stack: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
    "sns_user_scope_stack", default=()
)

# local 降级目录名 (服务端单密码模式; 桌面版不走此分支)
LOCAL_USER_DIR = "local"

# user_id 目录名合法性: 数字 (agti user_id) 或 'local'。
# 防路径穿越: 拒绝 ../、绝对路径、Windows 保留名等。
_USER_DIR_RE = re.compile(r"^[1-9][0-9]{0,18}$")

_scandir_lock = threading.Lock()


def set_context_user(user_id: str | int | None) -> contextvars.Token | None:
    """中间件注入当前请求用户 (None = 清除)。返回 token 供恢复。"""
    if user_id is None:
        return None
    value = str(user_id)
    if not _USER_DIR_RE.match(value):
        logger.warning("invalid user_id for namespace: %r", value)
        return None
    return _current_user_id.set(value)


def reset_context_user(token: contextvars.ContextVar.Token | None) -> None:
    """中间件收尾恢复 (防协程泄漏到下一请求)。"""
    if token is not None:
        _current_user_id.reset(token)


def current_user_id() -> str | None:
    """当前上下文用户 id (显式 scope 优先, 其次请求 contextvar)。"""
    stack = _scope_stack.get()
    if stack:
        return stack[-1]
    return _current_user_id.get()


@contextmanager
def user_scope(user_id: str | int):
    """后台任务/worker 逐用户执行的作用域 (M3-3d)。

    with user_scope(105):
        watchlist.list_symbols()  # 读 data/users/105/watchlist.parquet

    嵌套规则: 内层覆盖外层 (栈顶生效)。
    """
    value = str(user_id)
    if not _USER_DIR_RE.match(value):
        raise ValueError(f"invalid user_id: {value!r}")
    token = _scope_stack.set(_scope_stack.get() + (value,))
    try:
        yield
    finally:
        _scope_stack.reset(token)


def identity_enabled() -> bool:
    """是否启用账号互通 (agti 身份库)。"""
    from app.identity import pool as identity_pool

    return identity_pool.is_enabled()


def user_root() -> Path:
    """当前上下文的用户工件根目录。

    三分支 (见模块 docstring); 返回值不建目录 (调用方 mkdir), 但保证
    互通形态下返回 data/users/<uid>/ 规范路径。

    显式根 (root_scope) 优先于 contextvar/scope —— worker 子进程场景。

    注意: 该函数面向「用户工件」(watchlist/strategies/preferences 用户层等);
    行情/缓存/密钥仍走 settings.data_dir 全局路径, 不得混用。
    """
    from app.config import settings

    explicit = _explicit_root.get()
    if explicit is not None:
        return explicit

    if not identity_enabled():
        # 分支 1: 桌面版 / 未互通部署 → 原路径, 零改动铁律
        return settings.data_dir / "user_data"

    uid = current_user_id()
    if uid is not None:
        # 分支 2: 互通 + 已登录 → data/users/{user_id}/
        return settings.data_dir / "users" / uid

    # 分支 3: 互通 + 无请求上下文 (启动期/后台未绑定用户) → local 降级
    return settings.data_dir / "users" / LOCAL_USER_DIR


@contextmanager
def root_scope(root: Path | str):
    """显式设置用户根的作用域 (worker 子进程 / 测试)。

    with root_scope(task_user_root):
        ...  # 其间 user_root()/user_subdir()/user_strategies_dir() 均以此为根

    嵌套规则: 内层覆盖外层, 退出恢复外层 (token reset)。root 为用户根本身
    (data/users/<uid>/ 或桌面版 data/user_data/), 不做合法性强校验
    (worker task 已由父进程校验)。
    """
    token = _explicit_root.set(Path(root))
    try:
        yield
    finally:
        _explicit_root.reset(token)


def user_root_for(user_id: str | int) -> Path:
    """显式指定用户的工件根 (不依赖上下文)。user_id 已正则校验。"""
    from app.config import settings

    value = str(user_id)
    if not _USER_DIR_RE.match(value):
        raise ValueError(f"invalid user_id: {value!r}")
    return settings.data_dir / "users" / value


def iter_user_roots() -> list[Path]:
    """枚举互通形态下所有用户的工件根 (后台任务多用户遍历入口)。

    返回 data/users/ 下所有合法 user_id 子目录; 目录不存在返回空列表
    (首次部署/无用户数据时后台任务静默跳过, 不报错)。
    仅互通形态有意义; 桌面版调用返回空列表 (单用户, 无遍历语义)。
    """
    from app.config import settings

    if not identity_enabled():
        return []

    users_dir = settings.data_dir / "users"
    if not users_dir.is_dir():
        return []

    roots: list[Path] = []
    with _scandir_lock:
        try:
            entries = list(users_dir.iterdir())
        except OSError as e:
            logger.warning("scan users dir failed: %s", e)
            return []

    for entry in entries:
        if not entry.is_dir():
            continue
        name = entry.name
        if not (_USER_DIR_RE.match(name) or name == LOCAL_USER_DIR):
            continue
        roots.append(entry)
    # 稳定顺序: local 最后 (降级目录优先级最低), 数字 id 升序
    roots.sort(key=lambda p: (p.name == LOCAL_USER_DIR, p.name))
    return roots


def user_id_of_root(root: Path) -> str | None:
    """从用户根路径反解 user_id (worker 子进程回传/审计用)。"""
    try:
        name = root.name
        if _USER_DIR_RE.match(name) or name == LOCAL_USER_DIR:
            return name
    except Exception:  # noqa: BLE001
        pass
    return None


# ── 领域模块兼容层 (M3-3c 分支阀门切换点) ─────────────────────
# 领域模块 (custom_signals/monitor_rules/lots/factors/config) 历史上以
# 函数参数 data_dir 拼接 user_data/ 子目录, 签名被 API/后台/测试广泛依赖,
# 不宜逐调用点改造 (v2.3 §5.2 领域模块行)。改为在 _dir() 等拼接点内部加
# 兼容层: data_dir == settings.data_dir (生产/桌面) 时按命名空间解析,
# 否则 (测试隔离的 tmp data_dir) 保持原拼接 —— 存量测试零改动。

# 生产 data_dir 的用户工件根, 由 main.py 启动时注入 (settings 依赖后置)。
# None = 尚未注入 (main.py 未启动, 如纯单元测试直接调用领域模块) → 走
# settings.data_dir 判定。
_production_data_dir: Path | None = None
_production_user_root: Path | None = None
_inject_lock = threading.Lock()


def set_production_roots(data_dir: Path, user_root_path: Path) -> None:
    """main.py 启动时注入生产 data_dir 与默认用户根 (供领域模块兼容层判定)。

    data_dir: settings.data_dir (行情根); user_root_path: 未登录/后台语境的
    默认用户根 (互通=data/users/local/, 桌面=data/user_data/)。
    """
    global _production_data_dir, _production_user_root
    with _inject_lock:
        _production_data_dir = Path(data_dir).resolve()
        _production_user_root = Path(user_root_path).resolve()


def reset_production_roots() -> None:
    """测试收尾清理注入状态 (防测试间泄漏)。"""
    global _production_data_dir, _production_user_root
    with _inject_lock:
        _production_data_dir = None
        _production_user_root = None


def user_subdir(data_dir: Path, *parts: str) -> Path:
    """领域模块兼容层: 把历史 "data_dir/user_data/<工件>" 拼接切到用户命名空间。

    规则 (与 user_root() 三分支一致):
      1. data_dir != 生产 data_dir (测试隔离目录): 原样拼接, 零改动。
      2. 未互通 (桌面版): user_root() == data_dir/user_data/ → 与原拼接一致。
      3. 互通形态: 返回当前上下文用户根下的同名子目录 —— data/users/<uid>/<工件>
         (登录请求 → 本人根; 后台无上下文 → local 降级; root_scope 显式根)。

    另识别「参数本身已是用户根」的调用 (engine._user_data_dir 反推路径):
    参数 == 当前用户根时直接在其下拼 parts, 不会再叠一层 user_data/。

    parts 为空时返回用户根本身 (不含 user_data 尾缀)。
    """
    from app.config import settings

    # 测试隔离判定: 生产 data_dir 未注入或传参 ≠ 生产 data_dir → 原样拼接。
    # 兼容 Windows 大小写与软链: 用 resolve() 归一后再比较。
    base: Path
    try:
        arg = Path(data_dir).resolve()
    except OSError:
        base = Path(data_dir) / "user_data"
    else:
        root = user_root()
        if arg == root.resolve():
            # 参数已是用户根 (如 engine 从 strategies/custom 反推) → 直接拼
            base = root
        else:
            prod = _production_data_dir
            if prod is None:
                # 注入缺位回退: main.py 未注入 (worker 子进程/纯单测) 用 settings 判定
                prod = settings.data_dir.resolve()
            if arg == prod:
                # 生产/桌面: 用户工件根按命名空间解析 (桌面版即 data/user_data/)
                base = user_root()
            else:
                # 测试或其他部署的隔离目录 → 历史行为
                base = Path(data_dir) / "user_data"
    if not parts:
        return base
    return base / Path(*parts)


def user_strategies_dir(data_dir: Path) -> Path:
    """策略目录 (strategies/{custom,ai,composite}) 的命名空间解析。

    历史位置 data_dir/strategies/ (v2.3 §5.1 用户创建类 → 迁用户根):
      1. 测试隔离目录: data_dir/strategies/ 原样返回 (存量测试零改动)。
      2. 桌面版: user_root()/strategies/ == data/user_data/strategies/。
         注意! 桌面版历史位置是 data_dir/strategies/ 而非 data/user_data/
         strategies/ —— 桌面版切到 user_root() 会改变现有用户的策略路径,
         违反零改动铁律。因此桌面版分支保持 data_dir/strategies/ 不动,
         仅互通形态迁 users/<uid>/strategies/ (由迁移脚本搬迁)。
      3. 互通形态: data/users/<uid>/strategies/。

    上层再拼 "custom"/"ai"/"composite" 子目录 (与 main.py/worker/_target_dir
    三处拼接保持同构)。
    """
    from app.config import settings

    try:
        arg = Path(data_dir).resolve()
    except OSError:
        return Path(data_dir) / "strategies"
    prod = _production_data_dir
    if prod is None:
        prod = settings.data_dir.resolve()
    if arg != prod:
        # 测试隔离目录 → 历史行为
        return Path(data_dir) / "strategies"
    if not identity_enabled():
        # 桌面版: strategies/ 历史就在 data_dir 根下, 保持不动 (零改动铁律)
        return Path(data_dir) / "strategies"
    # 互通形态: 策略随用户根隔离
    return user_root() / "strategies"
