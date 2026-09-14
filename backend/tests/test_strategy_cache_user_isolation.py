"""策略结果缓存 (strategy_cache) 用户隔离测试 (M3-3c / v2.3 数据命名空间)。

修复前: _cache_path 直接拼 data_dir/user_data/strategy_cache.json — 互通
形态下所有用户共用一个缓存文件, A 跑完 B 打开策略页即看到 A 的结果。
修复后: _cache_path 走 user_subdir → data/users/<uid>/strategy_cache.json。

桌面版/测试隔离目录零改动 (原路径不变)。
"""
from __future__ import annotations

from pathlib import Path

from app.services import strategy_cache


def _result(*symbols: str) -> dict:
    return {
        "total": len(symbols),
        "as_of": "2026-09-14",
        "rows": [{"symbol": symbol, "close": index + 1.0} for index, symbol in enumerate(symbols)],
    }


def _setup_production(monkeypatch, tmp_path: Path) -> None:
    """注入生产形态 (互通): data_dir + users/local 降级根。"""
    from app.config import settings
    from app.identity import user_context as uc

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    uc.set_production_roots(tmp_path, tmp_path / "users" / "local")
    monkeypatch.setattr(uc, "identity_enabled", lambda: True)


def test_write_and_read_isolated_per_user(monkeypatch, tmp_path):
    """互通形态: 两个用户各写各读, 互不可见, 文件分落在各自用户根下。"""
    from app.identity.user_context import user_scope

    _setup_production(monkeypatch, tmp_path)

    with user_scope(1):
        strategy_cache.write_cache(tmp_path, "2026-09-14", {"macd_golden": _result("000001.SZ")})

    with user_scope(101):
        strategy_cache.write_cache(tmp_path, "2026-09-14", {"boll_breakout": _result("600000.SH")})

    # 各自读回只看到自己的
    with user_scope(1):
        cached_1 = strategy_cache.read_cache(tmp_path)
    assert set(cached_1["results"]) == {"macd_golden"}

    with user_scope(101):
        cached_101 = strategy_cache.read_cache(tmp_path)
    assert set(cached_101["results"]) == {"boll_breakout"}

    # 文件落在各用户根下, 全局共享位置不再有
    assert (tmp_path / "users" / "1" / "strategy_cache.json").exists()
    assert (tmp_path / "users" / "101" / "strategy_cache.json").exists()
    assert not (tmp_path / "user_data" / "strategy_cache.json").exists()

    from app.identity.user_context import reset_production_roots
    reset_production_roots()


def test_cross_user_no_leak_via_read(monkeypatch, tmp_path):
    """用户 101 读不到用户 1 写入的缓存 (返回 None), 且写入不串目录。"""
    from app.identity.user_context import reset_production_roots, user_scope

    _setup_production(monkeypatch, tmp_path)

    with user_scope(1):
        strategy_cache.write_cache(tmp_path, "2026-09-14", {"macd_golden": _result("000001.SZ")})

    with user_scope(101):
        assert strategy_cache.read_cache(tmp_path) is None

    reset_production_roots()


def test_desktop_mode_unchanged(monkeypatch, tmp_path):
    """桌面版 (未互通): 路径保持 data_dir/user_data/strategy_cache.json。"""
    from app.identity.user_context import reset_production_roots

    from app.config import settings
    from app.identity import user_context as uc

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(uc, "identity_enabled", lambda: False)

    p = strategy_cache._cache_path(tmp_path)
    assert p == tmp_path / "user_data" / "strategy_cache.json"

    reset_production_roots()


def test_clear_cache_targets_current_user(monkeypatch, tmp_path):
    """clear_cache 只清当前用户的缓存文件, 不误删他人。"""
    from app.identity.user_context import reset_production_roots, user_scope

    _setup_production(monkeypatch, tmp_path)

    with user_scope(1):
        strategy_cache.write_cache(tmp_path, "2026-09-14", {"macd_golden": _result("000001.SZ")})
    with user_scope(101):
        strategy_cache.write_cache(tmp_path, "2026-09-14", {"boll_breakout": _result("600000.SH")})

    # 用户 101 清缓存 → 只清自己的
    with user_scope(101):
        strategy_cache.clear_cache(tmp_path)

    with user_scope(101):
        assert strategy_cache.read_cache(tmp_path) is None
    with user_scope(1):
        cached = strategy_cache.read_cache(tmp_path)
    assert set(cached["results"]) == {"macd_golden"}

    reset_production_roots()
