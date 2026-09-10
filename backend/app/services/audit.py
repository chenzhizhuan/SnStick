"""平台审计服务 — 登录 / 权限拒绝 / 管理操作事件 JSONL 落盘 (方案 B)。

设计 (对应 v2.2 设计文档 §7 审计与 v2.3 验收标准 P117):
  - 事件分类: security 登录成功/失败/锁定 · access 权限拒绝 · admin 管理操作
  - 落盘: data/audit/YYYY-MM-DD.jsonl, 按天滚动 (当天文件末尾追加)
  - 内存缓冲: 异步写盘 (threading + 单一 writer 线程), 高频事件不阻塞事件循环
  - 多进程安全: 同一文件由 writer 线程独占追加, 进程内串行, 不跨进程 (单容器部署)
  - 事件结构: ts (ISO8601) / level (info|warn) / category / event / actor / detail
  - 永不因审计失败阻断业务: 写盘失败仅计数 + 日志, 不抛异常

度量 (供 /api/admin/metrics):
  - login_ok / login_fail / login_locked / logout / no_perm / admin_op
    各自累计计数 + 最近事件时间戳 (进程内, 重启清零; 跨天文件仍可追溯)
  - 可用性: last_write_ok_ts / last_write_fail_ts / write_fail_count / queue_size
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# ── 事件类别 ──────────────────────────────────────────────
CAT_SECURITY = "security"   # 登录成功/失败/锁定/登出
CAT_ACCESS = "access"       # 权限拒绝 NO_PERM
CAT_ADMIN = "admin"         # 管理操作 (admin:manage)

# ── 事件类型 ──────────────────────────────────────────────
EVT_LOGIN_OK = "login_ok"
EVT_LOGIN_FAIL = "login_fail"
EVT_LOGIN_LOCKED = "login_locked"
EVT_LOGOUT = "logout"
EVT_NO_PERM = "no_perm"
EVT_ADMIN_ACTION = "admin_action"

# ── 内存态 ────────────────────────────────────────────────
# metric key -> (count, last_ts)
_metrics: dict[str, tuple[int, float]] = {}
_metrics_lock = threading.Lock()

_write_queue: queue.Queue = queue.Queue(maxsize=2000)
_writer_started = False
_writer_lock = threading.Lock()


def _audit_dir() -> Path:
    from app.config import settings
    return settings.data_dir / "audit"


def _today_file() -> Path:
    return _audit_dir() / f"{datetime.now().strftime('%Y-%m-%d')}.jsonl"


def _bump_metric(key: str) -> None:
    with _metrics_lock:
        cnt, _ = _metrics.get(key, (0, 0.0))
        _metrics[key] = (cnt + 1, time.time())


# ── 写盘线程 ──────────────────────────────────────────────
def _writer_loop() -> None:
    while True:
        try:
            item = _write_queue.get(timeout=30)
        except queue.Empty:
            continue
        _write_item(item)


def _write_item(rec: dict) -> None:
    """写一条审计记录到今日 JSONL (追加)。失败仅计数, 不抛。"""
    try:
        p = _today_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
        _bump_metric("write_ok")
    except Exception as e:  # noqa: BLE001
        logger.warning("audit write failed: %s", e)
        _bump_metric("write_fail")


def _ensure_writer() -> None:
    global _writer_started
    with _writer_lock:
        if _writer_started:
            return
        _writer_started = True
        t = threading.Thread(target=_writer_loop, daemon=True, name="audit-writer")
        t.start()


# ── 对外 API ──────────────────────────────────────────────
def _record(category: str, evt: str, level: str, actor: str, detail: str) -> None:
    """入队审计事件 (异步写盘)。"""
    rec = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "level": level,
        "category": category,
        "event": evt,
        "actor": actor,
        "detail": detail,
    }
    _bump_metric(evt)
    try:
        _write_queue.put_nowait(rec)
    except queue.Full:
        _bump_metric("queue_full")
        logger.warning("audit queue full, dropping event: %s", evt)
        return
    _ensure_writer()


def login_ok(username: str, ip: str = "") -> None:
    _record(CAT_SECURITY, EVT_LOGIN_OK, "info", username or "-", f"login ok ip={ip or '-'}")


def login_fail(username: str, ip: str = "", reason: str = "") -> None:
    _record(CAT_SECURITY, EVT_LOGIN_FAIL, "warn", username or "-", f"login fail ip={ip or '-'} {reason}".strip())


def login_locked(username: str, ip: str = "", wait: int = 0) -> None:
    _record(CAT_SECURITY, EVT_LOGIN_LOCKED, "warn", username or "-", f"login locked ip={ip or '-'} wait={wait}s")


def logout(username: str = "") -> None:
    _record(CAT_SECURITY, EVT_LOGOUT, "info", username or "-", "logout")


def no_perm(username: str, path: str, perm: str) -> None:
    """权限拒绝事件 (NO_PERM)。由 require_perm 在 403 前调用。"""
    _record(CAT_ACCESS, EVT_NO_PERM, "warn", username or "-", f"no_perm {perm} {path}")


def admin_action(username: str, action: str, detail: str = "") -> None:
    _record(CAT_ADMIN, EVT_ADMIN_ACTION, "info", username or "-", f"{action} {detail}".strip())


# ── 查询 ──────────────────────────────────────────────────
def read_audit(day: str | None = None, limit: int = 200, category: str | None = None) -> list[dict]:
    """读某天审计记录 (默认今天)。倒序 (最新在前)。limit 截断。"""
    p = _today_file() if not day else _audit_dir() / f"{day}.jsonl"
    if not p.exists():
        return []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except Exception as e:  # noqa: BLE001
        logger.warning("audit read failed: %s", e)
        return []
    out: list[dict] = []
    for ln in reversed(lines):
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if category and rec.get("category") != category:
            continue
        out.append(rec)
        if len(out) >= limit:
            break
    return out


def get_metrics() -> dict:
    """进程内审计/会话指标 (admin metrics 用)。"""
    with _metrics_lock:
        snap = {k: {"count": c, "last_ts": t} for k, (c, t) in _metrics.items()}
    return snap


def queue_size() -> int:
    """待写盘审计事件数 (admin metrics 健康度)。"""
    return _write_queue.qsize()


def today_str() -> str:
    """今日日期串 YYYY-MM-DD。"""
    return datetime.now().strftime("%Y-%m-%d")