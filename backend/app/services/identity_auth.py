"""账号互通会话服务 — agti 用户名+密码登录, 会话本地化 (v2.3 会话模型)。

桌面版 / 未启用 agti 的部署: 本模块不参与 (api/auth.py 单密码路径保持不变)。

设计 (对应 v2.3「会话本地化 + 有界陈旧快照」):
  - 登录时查 agti 库 → 校验 bcrypt → 签发本地会话 token。
  - 会话 token 仅存 sha256 哈希 (sessions.json), 泄库不泄 token。
  - 会话携带「身份有界陈旧快照」: user_id/roles 等。
  - 快照刷新 = 惰性: 请求进入时若快照超 SNAPSHOT_TTL(300s) 且身份库可用,
    在请求内刷新; DB 不可用则跳过, 用陈旧快照继续服务 (DB 抖动零感知)。
  - 硬上限: 快照超 IDENTITY_MAX_AGE(24h) 未成功刷新 → 强制重登。
  - 会话数上限 5000 (防内存/磁盘膨胀)。
  - bcrypt 校验入线程池 (cost=12 ~250ms, 不阻塞事件循环)。

安全:
  - dummy bcrypt 防用户名枚举 (用户不存在也执行一次哈希)。
  - 双层限流: 账号 10min/5 次 + IP 5min/10 次 (内存计数, 与单密码限流分开)。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
import threading
import time
from pathlib import Path

from app.identity.dao import IdentityUnavailableError, get_user_by_id, get_user_by_name
from app.identity.models import IdentityUser

logger = logging.getLogger(__name__)

# ── 常量 (对应 v2.3) ──────────────────────────────
SESSION_TTL = 30 * 24 * 3600          # 会话有效期 30 天 (登录后保持)
SNAPSHOT_TTL = 300                    # 身份快照刷新周期 300s (惰性)
IDENTITY_MAX_AGE = 24 * 3600          # 快照硬上限 24h (强制重登)
SESSIONS_LIMIT = 5000                 # 会话数上限
_BCRYPT_ROUNDS = 12                   # 与 agti 一致
_ACCOUNT_MAX_FAILS = 5
_ACCOUNT_LOCK_SECONDS = 600
_IP_MAX_FAILS = 10
_IP_LOCK_SECONDS = 600
_DUMMY_HASH: bytes | None = None

# ── 内存态 ────────────────────────────────────────
# token_hash -> session dict
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()
# 限流: key -> (fails, until_ts)
_account_fails: dict[str, tuple[int, float]] = {}
_ip_fails: dict[str, tuple[int, float]] = {}
_fails_lock = threading.Lock()


# ── 基础 ──────────────────────────────────────────
def _session_file() -> Path:
    from app.config import settings
    return settings.data_dir / "user_data" / "sessions.json"


def _load_sessions() -> None:
    """启动时从磁盘恢复未过期会话 (进程重启不丢登录态)。"""
    global _sessions
    p = _session_file()
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("sessions.json malformed: %s", e)
        return
    now = time.time()
    valid = {}
    for h, s in (data.get("sessions") or {}).items():
        try:
            if s.get("expires_at", 0) > now:
                valid[h] = s
        except Exception:
            continue
    _sessions = valid


def _persist() -> None:
    """落盘 (持锁调用)。"""
    try:
        p = _session_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps({"sessions": _sessions}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        logger.warning("sessions persist failed: %s", e)


def _make_token() -> str:
    return secrets.token_urlsafe(32)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _bcrypt_hash(password: str) -> bytes:
    import bcrypt
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=_BCRYPT_ROUNDS))


async def _dummy_hash() -> None:
    """用户不存在时也执行一次 bcrypt, 防枚举 (恒定时间)。"""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = await asyncio.to_thread(_bcrypt_hash, secrets.token_urlsafe(8))


def _verify_bcrypt(password: str, stored: str | None) -> bool:
    import bcrypt
    try:
        if not stored:
            return False
        return bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# ── 会话核心 ─────────────────────────────────────────────────────
async def login(username: str, password: str) -> str | None:
    """用户名+密码登录, 成功返回 token, 失败返回 None。

    失败原因: 用户不存在/停用/删除/密码错误 (dummy bcrypt 掩盖枚举),
              以及「无有效角色」(订阅未开通/已过期, 方案 §3.4: 拒绝登录)。
    身份库不可用 → IdentityUnavailableError 冒泡 (路由转 503)。
    """
    try:
        user = await get_user_by_name(username)
    except IdentityUnavailableError:
        raise
    if user is None:
        await _dummy_hash()
        return None
    # 无有效角色 → 拒绝登录 (订阅未开通/已过期)。先查角色再验密码,
    # 避免对无角色账号也做 bcrypt (与 AGTi 蓝本一致: 无权限即拒)。
    if not user.roles:
        await _dummy_hash()
        return None
    ok = await asyncio.to_thread(_verify_bcrypt, password, user.password_hash)
    if not ok:
        return None
    return _create_session(user)


def _create_session(user: IdentityUser) -> str:
    token = _make_token()
    token_hash = _hash_token(token)
    now = time.time()
    with _sessions_lock:
        if len(_sessions) >= SESSIONS_LIMIT:
            oldest = min(_sessions, key=lambda k: _sessions[k]["created"])
            _sessions.pop(oldest, None)
        _sessions[token_hash] = {
            "user_id": user.user_id,
            "user_name": user.user_name,
            "nick_name": user.nick_name,
            "roles": list(user.roles),
            "created": now,
            "expires_at": now + SESSION_TTL,
            # 登录时身份来自实时查库, 即视为最新快照 (last_refresh=now),
            # 而非 0 —— 否则新会话会被硬上限误判为「快照超龄」而立即登出。
            "last_refresh": now,
        }
        _persist()
    return token


def _get_session(token: str) -> dict | None:
    if not token:
        return None
    h = _hash_token(token)
    with _sessions_lock:
        s = _sessions.get(h)
        if s is None:
            return None
        if s["expires_at"] <= time.time():
            _sessions.pop(h, None)
            _persist()
            return None
        return s


def revoke_session(token: str) -> None:
    h = _hash_token(token)
    with _sessions_lock:
        if _sessions.pop(h, None):
            _persist()


def is_valid_session(token: str) -> bool:
    """会话是否有效 (含硬上限检查)。"""
    s = _get_session(token)
    if s is None:
        return False
    if time.time() - s["last_refresh"] > IDENTITY_MAX_AGE:
        revoke_session(token)
        return False
    return True


def get_identity(token: str) -> dict | None:
    """取会话身份快照 (auth_middleware 注入用)。"""
    s = _get_session(token)
    if s is None:
        return None
    return {
        "user_id": s["user_id"],
        "user_name": s["user_name"],
        "nick_name": s["nick_name"],
        "roles": tuple(s["roles"]),
    }


async def refresh_session(token: str) -> bool:
    """惰性刷新: 快照超 SNAPSHOT_TTL 且身份库可用时, 重查库并更新。

    Returns:
      True  = 已刷新或无需刷新
      False = 用户已被停用/删除 (会话应失效)
    """
    s = _get_session(token)
    if s is None:
        return False
    now = time.time()
    if now - s["last_refresh"] < SNAPSHOT_TTL:
        return True
    try:
        user = await get_user_by_id(s["user_id"])
    except IdentityUnavailableError:
        return True  # DB 不可用: 保留陈旧快照 (抖动零感知)
    with _sessions_lock:
        if user is None:
            _sessions.pop(_hash_token(token), None)
            _persist()
            return False
        s["roles"] = list(user.roles)
        s["nick_name"] = user.nick_name
        s["last_refresh"] = now
    return True


# ── 双层限流 ─────────────────────────────────────────────────────
class _RateLimitError(Exception):
    def __init__(self, wait: int):
        self.wait = wait


def _check_fail(key: str, table: dict, max_fails: int, lock_seconds: int) -> None:
    with _fails_lock:
        _, until = table.get(key, (0, 0.0))
        now = time.time()
        if until > now:
            raise _RateLimitError(int(until - now))
        if until and until <= now:
            table.pop(key, None)


def _record_fail(key: str, table: dict, max_fails: int, lock_seconds: int) -> None:
    with _fails_lock:
        if len(table) > 1000:
            now = time.time()
            for stale in [k for k, (_, u) in table.items() if u <= now]:
                table.pop(stale, None)
        fails, until = table.get(key, (0, 0.0))
        fails += 1
        if fails >= max_fails:
            until = time.time() + lock_seconds
        table[key] = (fails, until)


def _clear_fail(key: str, table: dict) -> None:
    with _fails_lock:
        table.pop(key, None)


def check_login_rate_limit(username: str, ip: str) -> None:
    """双层限流: 账号 + IP 任一被锁则抛 _RateLimited。"""
    _check_fail(f"u:{username}", _account_fails, _ACCOUNT_MAX_FAILS, _ACCOUNT_LOCK_SECONDS)
    _check_fail(f"ip:{ip}", _ip_fails, _IP_MAX_FAILS, _IP_LOCK_SECONDS)


def record_login_fail(username: str, ip: str) -> None:
    _record_fail(f"u:{username}", _account_fails, _ACCOUNT_MAX_FAILS, _ACCOUNT_LOCK_SECONDS)
    _record_fail(f"ip:{ip}", _ip_fails, _IP_MAX_FAILS, _IP_LOCK_SECONDS)


def clear_login_fails(username: str, ip: str) -> None:
    _clear_fail(f"u:{username}", _account_fails)
    _clear_fail(f"ip:{ip}", _ip_fails)


# 模块加载时恢复会话
_load_sessions()