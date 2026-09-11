"""并发写 preferences.json 不得互相覆盖。

preferences.save 的 docstring 记着这个坑: "FastAPI 同步端点跑线程池, 并行 PUT
各自基于旧快照写盘会互相覆盖", 所以 save 的 read-modify-write 整段在 _SAVE_LOCK
里。set_realtime_quote_interval 是唯一一个绕开该锁、自己 load + write_text 的
setter —— PUT /api/settings/preferences/quote-interval 与任意另一个偏好 PUT
同时在飞时, 后者会被前者用旧快照整体覆盖掉。
"""
from __future__ import annotations

import json
import threading

import pytest

from app.services import preferences

_OTHER_KEY = "realtime_quotes_enabled"


@pytest.fixture
def prefs_path(tmp_path, monkeypatch):
    path = tmp_path / "preferences.json"
    # v2.3 数据命名空间: save/load 走 _user_path/_global_path 双层入口,
    # 不再经过旧兼容入口 _path —— patch 旧入口不会拦截写盘, 会污染真实
    # data/user_data/preferences.json (两层同路径去重, 桌面版行为不变)。
    monkeypatch.setattr(preferences, "_user_path", lambda: path)
    monkeypatch.setattr(preferences, "_global_path", lambda: path)
    preferences._invalidate_cache()
    yield path
    preferences._invalidate_cache()


def _read(path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_interval_setter_does_not_clobber_a_concurrent_save(prefs_path, monkeypatch):
    """轮询间隔写入与另一个偏好写入并发时, 两个键都要留下。

    用一个会在第一次调用时挂起的 _load_layer 替身制造交错: 间隔 setter 拿到快照后
    停住, 另一个 save 完整跑完, 然后间隔 setter 继续写盘。
    (v2.3 后 save() 直接调 _load_layer, 不再经过模块级 load, 拦截点随之迁移。)
    """
    preferences.save({_OTHER_KEY: False})

    first_load_entered = threading.Event()
    release_first_load = threading.Event()
    other_save_done = threading.Event()
    load_calls = []
    real_load_layer = preferences._load_layer

    def _load_layer_pausing_on_first_call(path) -> dict:
        snapshot = real_load_layer(path)
        load_calls.append(1)
        if len(load_calls) == 1:
            first_load_entered.set()
            release_first_load.wait(10)
        return snapshot

    monkeypatch.setattr(preferences, "_load_layer", _load_layer_pausing_on_first_call)

    def _set_interval() -> None:
        preferences.set_realtime_quote_interval(9.0)

    def _save_other() -> None:
        preferences.save({_OTHER_KEY: True})
        other_save_done.set()

    interval_thread = threading.Thread(target=_set_interval, name="set-interval")
    interval_thread.start()
    assert first_load_entered.wait(10), "间隔 setter 没有进入 _load_layer"

    other_thread = threading.Thread(target=_save_other, name="save-other")
    other_thread.start()
    # 有锁时另一个 save 会一直等到间隔 setter 写完 (这里超时是预期的);
    # 无锁时它会立刻写完, 随后被间隔 setter 的旧快照覆盖。
    other_save_done.wait(0.5)
    release_first_load.set()

    interval_thread.join(10)
    other_thread.join(10)
    assert not interval_thread.is_alive() and not other_thread.is_alive()

    monkeypatch.setattr(preferences, "_load_layer", real_load_layer)
    preferences._invalidate_cache()
    stored = _read(prefs_path)
    assert stored["realtime_quote_interval"] == 9.0
    assert stored[_OTHER_KEY] is True, "并发的偏好写入被间隔 setter 的旧快照覆盖了"


def test_interval_setter_keeps_existing_keys(prefs_path):
    """顺序场景: 写间隔不能丢掉文件里已有的其它偏好。"""
    preferences.save({_OTHER_KEY: True, "minute_sync_enabled": True})

    preferences.set_realtime_quote_interval(3.0)

    stored = _read(prefs_path)
    assert stored == {
        _OTHER_KEY: True,
        "minute_sync_enabled": True,
        "realtime_quote_interval": 3.0,
    }


def test_interval_setter_returns_value_and_refreshes_cache(prefs_path):
    """返回值与缓存失效行为保持不变。"""
    assert preferences.set_realtime_quote_interval(12.5) == 12.5
    assert preferences.get_realtime_quote_interval() == 12.5
