"""日K /daily 空库兜底路径回归: 请求历史区间必须按 [start,end] 裁剪, 而非 tail(days)。

背景: 图表工作台「往左加载更多」用 start_date/end_date 请求更早的历史区间。
此前 repo 查不到该区间时, 兜底实时拉取走 `enriched.tail(days)` 返回最近 N 根,
导致前端永远拿不到更早的 K 线 (#图表工作台往左加载)。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import polars as pl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.kline import router


class _FakeQuoteService:
    def get_enriched_today(self):
        return pl.DataFrame(), None


class _FakeRepo:
    def __init__(self, daily: pl.DataFrame) -> None:
        self._daily = daily

    def resolve_asset_type(self, symbol: str) -> str:
        return "stock"

    def get_daily_asset(self, asset_type: str, symbol: str, start, end, columns=None) -> pl.DataFrame:
        if self._daily.is_empty():
            return self._daily
        return self._daily.filter(
            (pl.col("symbol") == symbol)
            & (pl.col("date") >= start)
            & (pl.col("date") <= end)
        )

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": [],
            "name": [],
            "total_shares": [],
            "float_shares": [],
        })


def _client(daily_frame: pl.DataFrame) -> tuple[TestClient, _FakeRepo]:
    repo = _FakeRepo(daily_frame)
    app = FastAPI()
    app.include_router(router)
    app.state.repo = repo
    app.state.quote_service = _FakeQuoteService()
    return TestClient(app), repo


def test_fallback_fetches_range_and_clips_to_window(monkeypatch) -> None:
    """repo 无该区间数据 → 兜底按 start_time/end_time 实时拉取, 返回严格落在窗口内的历史 K。"""
    from app.api import kline as kline_api

    captured: list[dict] = []

    def fake_sync(symbols, count=None, batch_size=None, rpm=None,
                  start_time=None, end_time=None, on_chunk_done=None, failed_out=None):
        captured.append({"count": count, "start_time": start_time, "end_time": end_time})
        return _daily_window(symbols[0], date(2024, 1, 1), date(2025, 9, 10))

    monkeypatch.setattr(kline_api.kline_sync, "sync_daily_batch", fake_sync)

    client, _ = _client(pl.DataFrame())  # 库内无数据 → 走兜底

    resp = client.get("/api/kline/daily", params={
        "symbol": "600000.SH",
        "start_date": "2024-04-29",
        "end_date": "2025-09-10",
    })

    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "live"
    assert len(captured) == 1
    # 必须按时间区间拉取, 而不是 count=days+30 的 tail 回溯
    assert captured[0]["count"] is None
    assert captured[0]["start_time"] == datetime(2024, 4, 29, 0, 0, 0) - timedelta(days=150)
    assert captured[0]["end_time"] == datetime(2025, 9, 10, 23, 59, 59, 999999)

    rows = body["rows"]
    assert rows, "兜底实时拉取后应返回该窗口的历史 K 线"
    dates = [r["date"] for r in rows]
    assert min(dates) >= "2024-04-29", f"最早日应 >= 请求窗口起点, 实际 {min(dates)}"
    assert max(dates) <= "2025-09-10", f"最晚日应 <= 请求窗口终点, 实际 {max(dates)}"
    # 不应再是「最近 N 根」: 请求窗口最早日期之前不应出现 2026 年数据
    assert not any(d > "2025-09-10" for d in dates)


def test_fallback_warmup_rows_are_dropped(monkeypatch) -> None:
    """warmup 段(窗口前 150 天)仅用于指标计算, 不得出现在返回结果里。"""
    from app.api import kline as kline_api

    def fake_sync(symbols, count=None, batch_size=None, rpm=None,
                  start_time=None, end_time=None, on_chunk_done=None, failed_out=None):
        # 返回覆盖 2024-01-01 起(含窗口前 warmup 段)到 2025-09-10 的数据
        return _daily_window(symbols[0], date(2024, 1, 1), date(2025, 9, 10))

    monkeypatch.setattr(kline_api.kline_sync, "sync_daily_batch", fake_sync)

    client, _ = _client(pl.DataFrame())
    resp = client.get("/api/kline/daily", params={
        "symbol": "600000.SH",
        "start_date": "2024-04-29",
        "end_date": "2025-09-10",
    })

    assert resp.status_code == 200
    dates = [r["date"] for r in resp.json()["rows"]]
    assert all("2024-04-29" <= d <= "2025-09-10" for d in dates)
    assert "2024-01-15" not in dates  # warmup 数据必须被裁剪


def test_existing_data_skips_fallback(monkeypatch) -> None:
    """库内已有区间数据时走 enriched 路径, 不触发实时拉取, source=enriched。"""
    from app.api import kline as kline_api

    called = {"n": 0}

    def fake_sync(*args, **kwargs):
        called["n"] += 1
        return pl.DataFrame()

    monkeypatch.setattr(kline_api.kline_sync, "sync_daily_batch", fake_sync)

    frame = _daily_window("600000.SH", date(2026, 1, 1), date(2026, 9, 30))
    client, _ = _client(frame)
    resp = client.get("/api/kline/daily", params={
        "symbol": "600000.SH",
        "start_date": "2026-03-01",
        "end_date": "2026-09-30",
    })

    assert resp.status_code == 200
    assert resp.json()["source"] == "enriched"
    assert called["n"] == 0
    assert len(resp.json()["rows"]) > 0


def _daily_window(symbol: str, start: date, end: date) -> pl.DataFrame:
    """生成 [start, end] 的日 K 序列, 列与 kline_sync 输出一致。"""
    rows = []
    d = start
    while d <= end:
        rows.append({
            "symbol": symbol,
            "date": d,
            "open": 10.0,
            "high": 10.5,
            "low": 9.8,
            "close": 10.2,
            "volume": 1_000_000.0,
            "amount": 10_000_000.0,
        })
        d += timedelta(days=1)
    return pl.DataFrame(rows)