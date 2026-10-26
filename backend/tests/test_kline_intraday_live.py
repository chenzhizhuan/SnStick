# -*- coding: utf-8 -*-
"""intraday (15m/60m) 实时快照注入 — 现价标签 ● 徽记口径对齐日线端点。

第 35 轮 (2026-10-26): 用户复测发现 15分/1小时 周期现价标签无 ● 实时徽记
(日线源端点 4h/1d/2d/4d/1w/1M 有) — 根因: get_intraday 不注入实时行,
末根收盘停留在本地分钟K上次落盘轮 (≥60s 轮次), is_live 恒缺。
"""
from datetime import datetime

from app.api.kline import _current_intraday_bucket_start, _inject_intraday_live


def _bar(date: str, o, h, l, c, v=1000):
    return {"date": date, "open": o, "high": h, "low": l, "close": c, "volume": v, "amount": v * c}


def _live(price, date="2026-10-26"):
    return {
        "date": date, "open": 1325.0, "high": 1339.0, "low": 1324.0,
        "close": price, "volume": 999_999, "amount": 1_333_000_000, "is_live": True,
    }


class TestCurrentIntradayBucketStart:
    def test_morning_15m(self):
        now = datetime(2026, 10, 26, 10, 47)
        assert _current_intraday_bucket_start(15, now) == datetime(2026, 10, 26, 10, 45)

    def test_afternoon_60m(self):
        now = datetime(2026, 10, 26, 14, 20)
        assert _current_intraday_bucket_start(60, now) == datetime(2026, 10, 26, 14, 0)

    def test_bucket_start_exact(self):
        now = datetime(2026, 10, 26, 11, 15, 0)
        assert _current_intraday_bucket_start(15, now) == datetime(2026, 10, 26, 11, 15)

    def test_lunch_break_none(self):
        assert _current_intraday_bucket_start(15, datetime(2026, 10, 26, 12, 0)) is None

    def test_after_close_none(self):
        assert _current_intraday_bucket_start(15, datetime(2026, 10, 26, 15, 30)) is None

    def test_before_open_none(self):
        assert _current_intraday_bucket_start(15, datetime(2026, 10, 26, 9, 20)) is None


class TestInjectIntradayLive:
    def test_updates_current_bucket_close_and_marks_live(self):
        """末根=当前桶: close/high/low 并实时价, is_live=True; volume 不动 (日线累计≠桶量)。"""
        bars = [_bar("2026-10-26 11:15", 1330.0, 1335.0, 1329.0, 1332.0)]
        now = datetime(2026, 10, 26, 11, 25)
        out = _inject_intraday_live(bars, 15, _live(1338.5), now)
        assert len(out) == 1
        b = out[0]
        assert b["is_live"] is True
        assert b["close"] == 1338.5
        assert b["high"] == 1338.5            # max(1335.0, 1338.5)
        assert b["low"] == 1329.0             # min(1329.0, 1338.5)
        assert b["volume"] == 1000            # 桶量保持 (不写日线累计)
        assert b["open"] == 1330.0            # 桶内首笔不动

    def test_updates_low_when_live_below(self):
        bars = [_bar("2026-10-26 10:45", 1335.0, 1338.0, 1333.0, 1337.0)]
        out = _inject_intraday_live(bars, 15, _live(1331.2), datetime(2026, 10, 26, 10, 50))
        assert out[0]["low"] == 1331.2
        assert out[0]["high"] == 1338.0

    def test_appends_new_live_bucket_when_store_lags(self):
        """落盘滞后 (末根是上一桶): 追加退化实时桶 O=H=L=C=实时价 (TV 盘初同款)。"""
        bars = [_bar("2026-10-26 10:45", 1330.0, 1335.0, 1329.0, 1332.0)]
        now = datetime(2026, 10, 26, 11, 25)  # 当前桶 11:15, 末根是 10:45 → 滞后 2 桶
        out = _inject_intraday_live(bars, 15, _live(1338.5), now)
        assert len(out) == 2
        live_bar = out[-1]
        assert live_bar["date"] == "2026-10-26 11:15"
        assert live_bar["is_live"] is True
        assert live_bar["open"] == live_bar["high"] == live_bar["low"] == live_bar["close"] == 1338.5
        assert out[0].get("is_live") is not True   # 历史桶不标记

    def test_no_injection_off_session(self):
        """非连续竞价时段 (午休): 不注入 — 末根为完成桶, 无实时徽记 (TV 同款)。"""
        bars = [_bar("2026-10-26 11:15", 1330.0, 1335.0, 1329.0, 1332.0)]
        out = _inject_intraday_live(bars, 15, _live(1332.0), datetime(2026, 10, 26, 12, 30))
        assert out is bars
        assert "is_live" not in out[0]

    def test_no_injection_without_live_row(self):
        bars = [_bar("2026-10-26 11:15", 1330.0, 1335.0, 1329.0, 1332.0)]
        out = _inject_intraday_live(bars, 15, None, datetime(2026, 10, 26, 11, 25))
        assert out is bars

    def test_no_injection_invalid_price(self):
        bars = [_bar("2026-10-26 11:15", 1330.0, 1335.0, 1329.0, 1332.0)]
        out = _inject_intraday_live(bars, 15, _live(0), datetime(2026, 10, 26, 11, 25))
        assert out is bars

    def test_no_injection_when_last_bar_not_today(self):
        """实时快照是今天, 末根是昨天 (隔夜/数据断档): 不覆盖历史桶。"""
        bars = [_bar("2026-10-23 14:45", 1330.0, 1335.0, 1329.0, 1332.0)]
        out = _inject_intraday_live(bars, 15, _live(1338.5), datetime(2026, 10, 26, 11, 25))
        # 今天当前桶 11:15 与末根 (昨天) 不同 → 追加今天的实时桶
        assert len(out) == 2
        assert out[-1]["date"] == "2026-10-26 11:15"
        assert out[-1]["is_live"] is True
