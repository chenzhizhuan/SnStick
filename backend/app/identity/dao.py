"""agti 库只读 DAO — 登录/身份查询 (sys_user / sys_user_role / sys_role)。

SQL 语义严格复刻 AGTi 登录蓝本 (module_admin/dao/user_dao.py):
  - 用户有效性: status='0' (正常) AND del_flag='0' (未删除)
  - 角色有效性: r.status='0' AND r.del_flag='0'
                AND (ur.expire_time IS NULL OR ur.expire_time >= now())
    —— sys_user_role 的 expire_time 即订阅到期机制, 过期授权视为无角色。
  - 多角色取并集 (实测 105 个多角色用户)。

严格只读: 所有方法只发 SELECT。statement_timeout 由连接池注入双保险。
"""
from __future__ import annotations

import logging

from app.identity.models import IdentityUser

logger = logging.getLogger(__name__)

# 身份库未配置 / 连接池不可用时, 查询无法执行。
# 这是「基础设施缺失」, 与「用户不存在」语义不同 —— 调用方需区分处理
# (M2 登录链路: 池未就绪时应整体降级为「暂不可登录」, 而非误判用户不存在)。
class IdentityUnavailableError(RuntimeError):
    """身份库不可用 (未启用 / 连接池未就绪)。"""

# 登录路径: 用户 + 密码哈希 + 有效角色 (一条 SQL 出全部登录所需信息)
_SQL_USER_BY_NAME = """
SELECT u.user_id, u.user_name, u.nick_name, u.password,
       array_agg(r.role_key) FILTER (WHERE r.role_key IS NOT NULL) AS roles
FROM sys_user u
LEFT JOIN sys_user_role ur ON ur.user_id = u.user_id
LEFT JOIN sys_role r
       ON r.role_id = ur.role_id
      AND r.status = '0' AND r.del_flag = '0'
      AND (ur.expire_time IS NULL OR ur.expire_time >= now())
WHERE u.status = '0' AND u.del_flag = '0' AND u.user_name = $1
GROUP BY u.user_id
"""

# 刷新/展示路径: 不查 password, 哈希不扩散
_SQL_USER_BY_ID = """
SELECT u.user_id, u.user_name, u.nick_name,
       array_agg(r.role_key) FILTER (WHERE r.role_key IS NOT NULL) AS roles
FROM sys_user u
LEFT JOIN sys_user_role ur ON ur.user_id = u.user_id
LEFT JOIN sys_role r
       ON r.role_id = ur.role_id
      AND r.status = '0' AND r.del_flag = '0'
      AND (ur.expire_time IS NULL OR ur.expire_time >= now())
WHERE u.status = '0' AND u.del_flag = '0' AND u.user_id = $1
GROUP BY u.user_id
"""


def _to_user(row, *, with_password: bool) -> IdentityUser | None:
    """asyncpg Record → IdentityUser; 角色聚合列可能为 NULL (无角色用户)。"""
    if row is None:
        return None
    roles_raw = row["roles"]
    roles = tuple(roles_raw) if roles_raw else ()
    return IdentityUser(
        user_id=row["user_id"],
        user_name=row["user_name"],
        nick_name=row["nick_name"] or row["user_name"],
        roles=roles,
        password_hash=row["password"] if with_password else None,
    )


async def get_user_by_name(username: str) -> IdentityUser | None:
    """按用户名取有效用户 (含密码哈希, 登录校验用)。

    用户不存在 / 停用 / 已删除 → None (调用方需配合 dummy bcrypt 防枚举)。
    身份库未配置 / 连接池不可用 → IdentityUnavailableError (与「无用户」区分)。
    """
    from app.identity import pool as identity_pool

    pool = await identity_pool.get_pool()
    if pool is None:
        raise IdentityUnavailableError("identity db not configured")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_SQL_USER_BY_NAME, username)
    return _to_user(row, with_password=True)


async def get_user_by_id(user_id: int) -> IdentityUser | None:
    """按用户 ID 取有效用户 (不含密码, 刷新/展示用)。

    身份库未配置 / 连接池不可用 → IdentityUnavailableError (与「无用户」区分)。
    """
    from app.identity import pool as identity_pool

    pool = await identity_pool.get_pool()
    if pool is None:
        raise IdentityUnavailableError("identity db not configured")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_SQL_USER_BY_ID, user_id)
    return _to_user(row, with_password=False)
