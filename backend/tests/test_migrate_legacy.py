"""存量单密码数据 → users/local/ 迁移脚本测试 (v2.3 §5.3, 零网络)。

覆盖:
  1. 未互通 (桌面版/未配置 agti_dsn): no-op, 不产生迁移
  2. dry-run: 只列计划不落盘
  3. apply: 用户工件从 data/user_data/ + data/strategies/ 迁到 users/local/
  4. 幂等: 重复执行不覆盖已存在的 users/local 目标
  5. 全局保留项不迁: auth.json / sessions.json / secrets.json
  6. preferences.json 拆分: 部署级键留全局层, 用户级键搬用户层
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.config import settings
from app.identity import migrate_legacy


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    yield tmp_path


def _enable_identity(enabled: bool = True):
    return patch("app.identity.pool.is_enabled", return_value=enabled)


def _make_legacy_data(data_dir: Path) -> None:
    """构造一份存量单密码数据 (模拟服务端互通前的布局)。"""
    old = data_dir / "user_data"
    old.mkdir(parents=True, exist_ok=True)
    # 用户工件
    (old / "watchlist.parquet").write_bytes(b"fake-parquet")
    (old / "watchlist_groups.json").write_text('{"groups": []}', encoding="utf-8")
    (old / "monitor_rules").mkdir()
    (old / "monitor_rules" / "rule1.json").write_text("{}", encoding="utf-8")
    (old / "lots").mkdir()
    (old / "custom_signals").mkdir()
    (old / "custom_signals" / "sig1.json").write_text("{}", encoding="utf-8")
    (old / "custom_factors").mkdir()
    (old / "strategy_overrides").mkdir()
    (old / "research_candidates.json").write_text("[]", encoding="utf-8")
    (old / "ai_reports.json").write_text("[]", encoding="utf-8")
    (old / "ai_stock_reports.json").write_text("[]", encoding="utf-8")
    (old / "ai_market_recaps.json").write_text("[]", encoding="utf-8")
    # 全局保留项 (绝不迁移)
    (old / "auth.json").write_text('{"salt": "x"}', encoding="utf-8")
    (old / "sessions.json").write_text("[]", encoding="utf-8")
    (old / "secrets.json").write_text("{}", encoding="utf-8")
    # preferences: 部署级 + 用户级混合
    (old / "preferences.json").write_text(
        json.dumps(
            {
                "realtime_data_provider": "tickflow",  # 部署级
                "nav_order": ["a", "b"],  # 用户级
                "onboarding_completed": True,  # 用户级
            }
        ),
        encoding="utf-8",
    )
    # data/strategies/ (桌面版历史位置, 互通形态迁用户根)
    strategies = data_dir / "strategies"
    strategies.mkdir(parents=True, exist_ok=True)
    (strategies / "custom").mkdir()
    (strategies / "custom" / "my_strat.py").write_text("# strategy", encoding="utf-8")


# ── 未互通 no-op ─────────────────────────────────────────────

class TestNotEnabled:
    def test_desktop_mode_skips(self, _isolated_data_dir):
        """未互通 (桌面版): no-op, 不产生迁移。"""
        _make_legacy_data(_isolated_data_dir)
        with _enable_identity(False):
            result = migrate_legacy.run(_isolated_data_dir, apply=True)
        assert result["skipped"] is True
        assert result["reason"].startswith("identity not enabled")
        # 原文件原样保留
        assert (_isolated_data_dir / "user_data" / "watchlist.parquet").exists()
        assert not (_isolated_data_dir / "users").exists()


# ── dry-run ──────────────────────────────────────────────────

class TestDryRun:
    def test_dry_run_does_not_touch(self, _isolated_data_dir):
        """dry-run: 只列计划, 不落盘。"""
        _make_legacy_data(_isolated_data_dir)
        with _enable_identity(True):
            result = migrate_legacy.run(_isolated_data_dir, apply=False)
        assert result["skipped"] is False
        assert result["apply"] is False
        assert result["planned"] >= 10
        # 源文件未被移动
        assert (_isolated_data_dir / "user_data" / "watchlist.parquet").exists()
        assert not (_isolated_data_dir / "users" / "local").exists()


# ── apply: 用户工件迁移 ──────────────────────────────────────

class TestApply:
    def test_user_artifacts_migrated(self, _isolated_data_dir):
        """apply: 用户工件迁到 users/local/, 源目录移除。"""
        _make_legacy_data(_isolated_data_dir)
        with _enable_identity(True):
            result = migrate_legacy.run(_isolated_data_dir, apply=True)
        assert result["skipped"] is False
        assert result["apply"] is True
        local = _isolated_data_dir / "users" / "local"
        # 用户工件已迁
        assert (local / "watchlist.parquet").exists()
        assert (local / "watchlist_groups.json").exists()
        assert (local / "monitor_rules" / "rule1.json").exists()
        assert (local / "lots").is_dir()
        assert (local / "custom_signals" / "sig1.json").exists()
        assert (local / "custom_factors").is_dir()
        assert (local / "strategy_overrides").is_dir()
        assert (local / "research_candidates.json").exists()
        assert (local / "ai_reports.json").exists()
        assert (local / "ai_stock_reports.json").exists()
        assert (local / "ai_market_recaps.json").exists()
        # data/strategies/ 整目录迁入
        assert (local / "strategies" / "custom" / "my_strat.py").exists()
        assert not (_isolated_data_dir / "strategies").exists()

    def test_global_kept_in_place(self, _isolated_data_dir):
        """全局保留项绝不迁移。"""
        _make_legacy_data(_isolated_data_dir)
        with _enable_identity(True):
            migrate_legacy.run(_isolated_data_dir, apply=True)
        old = _isolated_data_dir / "user_data"
        assert (old / "auth.json").exists()
        assert (old / "sessions.json").exists()
        assert (old / "secrets.json").exists()
        assert not (_isolated_data_dir / "users" / "local" / "auth.json").exists()

    def test_preferences_split(self, _isolated_data_dir):
        """preferences 拆分: 用户级键搬用户层, 部署级键留全局层。"""
        _make_legacy_data(_isolated_data_dir)
        with _enable_identity(True):
            migrate_legacy.run(_isolated_data_dir, apply=True)
        local_pref = _isolated_data_dir / "users" / "local" / "preferences.json"
        global_pref = _isolated_data_dir / "user_data" / "preferences.json"
        assert local_pref.exists()
        user_part = json.loads(local_pref.read_text(encoding="utf-8"))
        assert user_part["nav_order"] == ["a", "b"]
        assert user_part["onboarding_completed"] is True
        assert "realtime_data_provider" not in user_part
        deploy_part = json.loads(global_pref.read_text(encoding="utf-8"))
        assert deploy_part["realtime_data_provider"] == "tickflow"
        assert "nav_order" not in deploy_part

    def test_idempotent(self, _isolated_data_dir):
        """幂等: 重复执行不重复搬、不覆盖。"""
        _make_legacy_data(_isolated_data_dir)
        with _enable_identity(True):
            migrate_legacy.run(_isolated_data_dir, apply=True)
            second = migrate_legacy.run(_isolated_data_dir, apply=True)
        assert second["planned"] == 0
        assert second["moved"] == []
        local = _isolated_data_dir / "users" / "local"
        assert (local / "watchlist.parquet").exists()


# ── 容错: 部分数据缺失 ───────────────────────────────────────

class TestPartial:
    def test_no_legacy_data(self, _isolated_data_dir):
        """全新部署 (无 user_data/ 无 strategies/): 空计划, 不报错。"""
        with _enable_identity(True):
            result = migrate_legacy.run(_isolated_data_dir, apply=True)
        assert result["skipped"] is False
        assert result["planned"] == 0

    def test_missing_entries_skipped(self, _isolated_data_dir):
        """部分工件缺失: 只迁存在的, 不报错。"""
        old = _isolated_data_dir / "user_data"
        old.mkdir(parents=True, exist_ok=True)
        (old / "watchlist.parquet").write_bytes(b"x")
        with _enable_identity(True):
            result = migrate_legacy.run(_isolated_data_dir, apply=True)
        assert result["planned"] == 1
        assert (_isolated_data_dir / "users" / "local" / "watchlist.parquet").exists()


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-q"]))