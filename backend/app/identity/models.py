"""身份域模型 — agti 生产库用户的只读快照。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class IdentityUser:
    """登录 / 会话刷新用的身份快照 (sys_user + 有效角色聚合)。

    roles: 有效 role_key 元组 (停用/过期授权已被 SQL 过滤剔除, 多角色取并集)。
    password_hash: 仅登录校验路径携带 (bcrypt $2b$12$);
                   刷新/展示路径不查询不落盘, 避免哈希扩散。
    """

    user_id: int
    user_name: str
    nick_name: str
    roles: tuple[str, ...] = ()
    password_hash: str | None = None

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles


@dataclass(frozen=True, slots=True)
class IdentityHealth:
    """身份库连接池健康探测结果 (运维指标 / 告警用)。"""

    ok: bool
    latency_ms: float = 0.0
    error: str | None = None
