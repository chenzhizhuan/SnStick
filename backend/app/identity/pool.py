"""身份库连接池 — asyncpg 只读连接生命周期管理。

设计:
  - 全局单例懒加载; 未配置 (agti_dsn 为空) 时一切调用退化为 no-op。
    桌面版 / 未启用账号互通的部署完全不建连接。
  - startup 预热 (min_size 条连接) + 探活; 失败仅警告不阻断主服务启动
    —— 身份库不可用不该导致行情/回测业务不可用 (v2.3 会话模型: DB 抖动零感知)。
  - shutdown 精确等待 in-flight 查询完成后关闭 (timeout 兜底)。
  - 池参数刻意小于 AGTi 侧 (pool 50), 只做登录/刷新查询, 4 连接足够:
    登录 bcrypt ~250ms + 查询 <10ms, 单机并发场景峰值 4 并发绰绰有余。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from app.identity.models import IdentityHealth

if TYPE_CHECKING:
    from asyncpg import Pool

logger = logging.getLogger(__name__)

_pool: Pool | None = None
_pool_lock = asyncio.Lock()


def is_enabled() -> bool:
    """是否启用了 agti 账号互通 (配置了 identity 数据库)。"""
    from app.config import settings

    return bool(settings.agti_dsn)


async def get_pool() -> Pool | None:
    """获取身份库连接池 (未启用返回 None)。"""
    if not is_enabled():
        return None
    global _pool
    if _pool is not None and not _pool.is_closing():
        return _pool
    async with _pool_lock:
        if _pool is not None and not _pool.is_closing():
            return _pool
        import asyncpg

        from app.config import settings

        dsn = settings.agti_dsn
        # 只读角色 + 语句超时: 双保险, 防 DAO 层意外写操作拖垮生产库
        server_settings = {"statement_timeout": str(settings.agti_query_timeout_ms)}
        # asyncpg 的 ssl 参数不接受 libpq 字符串模式, 这里做映射:
        #   空/prefer/allow → None (服务器支持则用, 当前 ssl=off 也能连)
        #   disable        → False (强制明文)
        #   require 等      → True (强制加密, AGTi 侧开通 SSL 后改 require)
        mode = settings.agti_sslmode
        if mode == "disable":
            ssl_arg = False
        elif mode in ("", "prefer", "allow"):
            ssl_arg = None
        else:  # require / verify-ca / verify-full
            ssl_arg = True
        try:
            _pool = await asyncpg.create_pool(
                dsn=dsn,
                min_size=settings.agti_pool_min,
                max_size=settings.agti_pool_max,
                command_timeout=settings.agti_query_timeout_ms / 1000.0,
                timeout=settings.agti_connect_timeout_s,
                ssl=ssl_arg,
                server_settings=server_settings,
            )
            logger.info(
                "identity pool ready (min=%d max=%d ssl=%s)",
                settings.agti_pool_min,
                settings.agti_pool_max,
                settings.agti_sslmode or "disable",
            )
        except Exception:
            _pool = None
            raise
        return _pool


async def close_pool() -> None:
    """关闭连接池 (应用 shutdown)。"""
    global _pool
    pool = _pool
    _pool = None
    if pool is not None and not pool.is_closing():
        await pool.close()


async def health_check() -> IdentityHealth:
    """探测身份库连通性 (指标暴露 + 告警用, 不用于请求路径)。"""
    pool = await get_pool()
    if pool is None:
        return IdentityHealth(ok=False, error="identity db not configured")
    t0 = time.perf_counter()
    try:
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return IdentityHealth(ok=True, latency_ms=(time.perf_counter() - t0) * 1000)
    except Exception as e:
        return IdentityHealth(
            ok=False,
            latency_ms=(time.perf_counter() - t0) * 1000,
            error=str(e),
        )
