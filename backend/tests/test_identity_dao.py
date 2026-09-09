"""身份域单元测试 (零网络)。

不连任何真实数据库 —— 用内存 SQLite 复刻 agti 三表结构与过滤语义,
直接验证 DAO 的 SQL 行为 (有效性过滤/到期判断/多角色并集/无角色用户)。

SQLite 与 PG 的关键差异在测试内处理:
  - $1 占位符 → ?
  - FILTER (WHERE ...) 聚合 → SQLite 3.30+ 支持, 直接可用
  - now() → SQLite 的 datetime('now') 兼容 CURRENT_TIMESTAMP 同义
说明: 测试 SQL 由 DAO 常量机械替换占位符得到, 与生产 SQL 语义一致。
"""
from __future__ import annotations

import sqlite3

import pytest

# ── 测试用 SQL (DAO 生产 SQL 的 SQLite 方言版, 占位符 $1→?) ──────────
SQL_BY_NAME = """
SELECT u.user_id, u.user_name, u.nick_name, u.password,
       array_agg(r.role_key) FILTER (WHERE r.role_key IS NOT NULL) AS roles
FROM sys_user u
LEFT JOIN sys_user_role ur ON ur.user_id = u.user_id
LEFT JOIN sys_role r
       ON r.role_id = ur.role_id
      AND r.status = '0' AND r.del_flag = '0'
      AND (ur.expire_time IS NULL OR ur.expire_time >= now())
WHERE u.status = '0' AND u.del_flag = '0' AND u.user_name = ?
GROUP BY u.user_id
"""


def _make_db() -> sqlite3.Connection:
    """复刻 agti 三表最小 schema + 代表性数据。"""
    conn = sqlite3.connect(":memory:")

    # SQLite 无 PG 的 array_agg 聚合, 注册等价实现 (FILTER 子句 SQLite 3.30+ 原生支持)。
    # 注意: finalize 只能返回 SQLite 原生类型 (str/int/bytes/None), 不能返回 list,
    # 故用逗号拼接字符串, 测试断言时 split 还原。
    class _ArrayAgg:
        def __init__(self):
            self.items: list = []

        def step(self, value):
            if value is not None:
                self.items.append(value)

        def finalize(self):
            return ",".join(self.items) if self.items else None

    conn.create_aggregate("array_agg", 1, _ArrayAgg)
    conn.executescript(
        """
        CREATE TABLE sys_user (
            user_id INTEGER PRIMARY KEY,
            user_name TEXT, nick_name TEXT, password TEXT,
            status TEXT DEFAULT '0', del_flag TEXT DEFAULT '0'
        );
        CREATE TABLE sys_user_role (
            user_id INTEGER, role_id INTEGER,
            grant_time TEXT, expire_time TEXT
        );
        CREATE TABLE sys_role (
            role_id INTEGER PRIMARY KEY,
            role_name TEXT, role_key TEXT, status TEXT DEFAULT '0',
            del_flag TEXT DEFAULT '0'
        );
        """
    )
    # 角色: 7 档 + 一个停用角色 99 (应被过滤)
    roles = [
        (1, "超级版", "admin"), (2, "体验版", "common"), (3, "标准版", "standard"),
        (4, "高级版", "premium"), (5, "企业版", "enterprise"), (6, "导师版", "mentor"),
        (7, "服务商", "agent"), (99, "已停用", "disabled"),
    ]
    conn.executemany(
        "INSERT INTO sys_role (role_id, role_name, role_key) VALUES (?,?,?)", roles
    )
    conn.execute("UPDATE sys_role SET status='1' WHERE role_id=99")
    # 用户 1: 正常 + admin (无到期限制)
    conn.execute(
        "INSERT INTO sys_user VALUES (1,'zhuange','专哥','$2b$12$xxx','0','0')"
    )
    conn.execute(
        "INSERT INTO sys_user_role VALUES (1,1,NULL,NULL)"
    )
    # 用户 2: 多角色并集 (premium + standard)
    conn.execute(
        "INSERT INTO sys_user VALUES (2,'multi','多角色','$2b$12$yyy','0','0')"
    )
    conn.execute("INSERT INTO sys_user_role VALUES (2,4,NULL,NULL)")
    conn.execute("INSERT INTO sys_user_role VALUES (2,3,NULL,NULL)")
    # 用户 3: 订阅已过期 (expire_time < now) → 角色被过滤, 用户仍存在
    conn.execute(
        "INSERT INTO sys_user VALUES (3,'expired','过期哥','$2b$12$zzz','0','0')"
    )
    conn.execute(
        "INSERT INTO sys_user_role VALUES (3,4,NULL,'2020-01-01 00:00:00')"
    )
    # 用户 4: 停用 (status='1') → 整体查不到
    conn.execute(
        "INSERT INTO sys_user VALUES (4,'disabled','停用哥','$2b$12$ddd','1','0')"
    )
    # 用户 5: 已删除 (del_flag='2') → 整体查不到
    conn.execute(
        "INSERT INTO sys_user VALUES (5,'deleted','删哥','$2b$12$eee','0','2')"
    )
    # 用户 6: 无任何角色 → roles 为 NULL (14 个存量用户场景)
    conn.execute(
        "INSERT INTO sys_user VALUES (6,'norole','无角色哥','$2b$12$fff','0','0')"
    )
    # 用户 7: 授权到停用角色 99 → 角色被过滤
    conn.execute(
        "INSERT INTO sys_user VALUES (7,'badrole','坏角色哥','$2b$12$ggg','0','0')"
    )
    conn.execute("INSERT INTO sys_user_role VALUES (7,99,NULL,NULL)")
    # 用户 8: 未来到期 (expire_time > now) → 有效
    conn.execute(
        "INSERT INTO sys_user VALUES (8,'future','未来哥','$2b$12$hhh','0','0')"
    )
    conn.execute(
        "INSERT INTO sys_user_role VALUES (8,3,NULL,'2099-01-01 00:00:00')"
    )
    return conn


def _sqlite_now(sql: str) -> str:
    """把 PG 的 now() 翻译成 SQLite 可执行形式。"""
    return sql.replace("now()", "CURRENT_TIMESTAMP")


def _roles(col) -> list[str]:
    """聚合列 (None 或逗号串) → 角色 list。"""
    if not col:
        return []
    return col.split(",")


class TestUserByQuery:
    """验证 DAO SQL 的用户有效性过滤 + 角色聚合语义。"""

    def test_normal_user_with_admin_role(self):
        conn = _make_db()
        row = conn.execute(_sqlite_now(SQL_BY_NAME), ("zhuange",)).fetchone()
        assert row is not None
        assert row[0] == 1
        assert row[3] == "$2b$12$xxx"
        assert _roles(row[4]) == ["admin"]

    def test_multi_role_union(self):
        conn = _make_db()
        row = conn.execute(_sqlite_now(SQL_BY_NAME), ("multi",)).fetchone()
        assert sorted(_roles(row[4])) == ["premium", "standard"]

    def test_expired_grant_filtered_but_user_found(self):
        """订阅过期: 用户仍可登录 (但无角色 → 走无角色策略)。"""
        conn = _make_db()
        row = conn.execute(_sqlite_now(SQL_BY_NAME), ("expired",)).fetchone()
        assert row is not None  # 用户查得到
        assert _roles(row[4]) == []  # 角色被过滤光

    def test_disabled_user_not_found(self):
        conn = _make_db()
        assert conn.execute(_sqlite_now(SQL_BY_NAME), ("disabled",)).fetchone() is None

    def test_deleted_user_not_found(self):
        conn = _make_db()
        assert conn.execute(_sqlite_now(SQL_BY_NAME), ("deleted",)).fetchone() is None

    def test_no_role_user_roles_null(self):
        conn = _make_db()
        row = conn.execute(_sqlite_now(SQL_BY_NAME), ("norole",)).fetchone()
        assert row is not None
        assert _roles(row[4]) == []

    def test_grant_to_disabled_role_filtered(self):
        conn = _make_db()
        row = conn.execute(_sqlite_now(SQL_BY_NAME), ("badrole",)).fetchone()
        assert row is not None
        assert _roles(row[4]) == []

    def test_future_expire_valid(self):
        conn = _make_db()
        row = conn.execute(_sqlite_now(SQL_BY_NAME), ("future",)).fetchone()
        assert _roles(row[4]) == ["standard"]

    def test_unknown_user_not_found(self):
        conn = _make_db()
        assert conn.execute(_sqlite_now(SQL_BY_NAME), ("ghost",)).fetchone() is None


class TestModels:
    """IdentityUser 数据类行为。"""

    def test_is_admin(self):
        from app.identity.models import IdentityUser

        u = IdentityUser(user_id=1, user_name="a", nick_name="A", roles=("admin", "premium"))
        assert u.is_admin is True
        u2 = IdentityUser(user_id=2, user_name="b", nick_name="B", roles=("premium",))
        assert u2.is_admin is False

    def test_password_hash_optional(self):
        from app.identity.models import IdentityUser

        u = IdentityUser(user_id=1, user_name="a", nick_name="A")
        assert u.password_hash is None


class TestDaoNoPool:
    """身份库未配置时 DAO 抛 IdentityUnavailableError (与「用户不存在」区分)。"""

    @pytest.mark.asyncio
    async def test_get_user_by_name_no_pool_raises(self, monkeypatch):
        from app.identity import dao
        from app.identity import pool as pool_mod

        async def _none():
            return None

        monkeypatch.setattr(pool_mod, "get_pool", _none)
        with pytest.raises(dao.IdentityUnavailableError):
            await dao.get_user_by_name("zhuange")

    @pytest.mark.asyncio
    async def test_get_user_by_id_no_pool_raises(self, monkeypatch):
        from app.identity import dao
        from app.identity import pool as pool_mod

        async def _none():
            return None

        monkeypatch.setattr(pool_mod, "get_pool", _none)
        with pytest.raises(dao.IdentityUnavailableError):
            await dao.get_user_by_id(1)


class TestPoolDisabled:
    """连接池未配置时的 no-op 行为。"""

    @pytest.mark.asyncio
    async def test_get_pool_none_when_disabled(self, monkeypatch):
        from app.identity import pool

        monkeypatch.setattr(pool, "is_enabled", lambda: False)
        assert (await pool.get_pool()) is None

    @pytest.mark.asyncio
    async def test_health_check_not_configured(self, monkeypatch):
        from app.identity import pool

        monkeypatch.setattr(pool, "is_enabled", lambda: False)
        h = await pool.health_check()
        assert h.ok is False
        assert "not configured" in (h.error or "")

    @pytest.mark.asyncio
    async def test_health_check_db_down_returns_false(self, monkeypatch):
        """配置了但连接失败 → ok=False + 错误信息 (供告警, 不抛异常)。"""
        from app.identity import pool

        class _FakePool:
            """模拟 asyncpg Pool.acquire() 的异步上下文管理器协议。"""

            class _AcquireCM:
                async def __aenter__(self):
                    raise RuntimeError("connection refused")

                async def __aexit__(self, *exc):
                    return False

            def acquire(self):
                return self._AcquireCM()

        async def _pool():
            return _FakePool()

        monkeypatch.setattr(pool, "is_enabled", lambda: True)
        monkeypatch.setattr(pool, "get_pool", _pool)
        h = await pool.health_check()
        assert h.ok is False
        assert "connection refused" in (h.error or "")
