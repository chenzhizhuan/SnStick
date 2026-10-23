"""送转复权 (adjust=split) 显示模式的口径锁死测试 — TV 开 ADJ 口径。

背景 (2026-10-23 TV 对拍决定性实证): TV 的 "调整股息数据" (ADJ) 对 A 股
实测仅调整送转股, 现金分红不调整:
- 600519 2011-08-31: TV O/H/L/C = 171.35/181.40/159.50/177.50
  = 官方 raw 207.33/219.50/193.00/214.77 × (1/1.21) (两次 10送1 后);
- 2021-09 / 2020-11 / 2021-02: 后续无送转 → TV = raw 分毫不差;
- 腾讯官方 qfq 为绝对额调整 (2011 段负值), 与 TV 比例口径完全不同。
送转拆解: TickFlow ex_factor = 现金 × 送转, 送转部分取离散候选
(600519 全 30 事件自洽: 8 送转 1.1×1.1×1.3×1.2×2.0×1.1×1.1×1.1)。
"""

from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest

from app.api import kline as kline_api
from app.market_time import cn_today

# ── _extract_split_component: 综合因子 → 送转部分 ───────────────


def test_extract_split_moutai_golden():
    """600519 全 30 事件的送转拆解黄金 (2026-10-23 因子表实测)。"""
    golden = {
        1.118279: 1.1,  # 2002-07-25 10送1派6
        1.108714: 1.1,  # 2003-07-14
        1.311507: 1.3,  # 2004-07-01 10转3
        1.210951: 1.2,  # 2005-08-05 10转2
        2.006365: 2.0,  # 2006-05-19 10转10
        1.112023: 1.1,  # 2011-07-01 10送1
        1.130251: 1.1,  # 2014-06-25 10送1派4.3
        1.119471: 1.1,  # 2015-07-17 10送1
    }
    for ef, expect in golden.items():
        assert kline_api._extract_split_component(ef) == pytest.approx(expect, rel=1e-9), ef


def test_extract_split_pure_cash():
    """纯现金分红 (≤1.05) 与不可拆解值 → 送转 1.0。"""
    for ef in (1.005, 1.01, 1.0237, 1.0329, 1.0499, 1.0):
        assert kline_api._extract_split_component(ef) == 1.0
    # None / 非有限值防御
    assert kline_api._extract_split_component(None) == 1.0
    assert kline_api._extract_split_component(float("nan")) == 1.0


def test_extract_split_unsplittable_returns_cash():
    """1.06~1.09 无法匹配候选 (1.06/1.1 < 1.0) → 保守视为现金。"""
    assert kline_api._extract_split_component(1.06) == 1.0
    assert kline_api._extract_split_component(1.09) == 1.0


# ── _split_factor_map / _split_factor_after: 送转链构造 ─────────


def _write_factor_table(tmp_path: Path, rows: list[tuple]) -> None:
    """写 adj_factor/all.parquet: rows = [(symbol, trade_date, ex_factor)]。"""
    d = tmp_path / "adj_factor"
    d.mkdir(parents=True, exist_ok=True)
    df = pl.DataFrame({
        "symbol": [r[0] for r in rows],
        "trade_date": [r[1] for r in rows],
        "ex_factor": [r[2] for r in rows],
    })
    df.write_parquet(d / "all.parquet")


def _repo_with_factors(tmp_path: Path, rows: list[tuple]):
    return SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))


_MOUTAI_FACTORS = [
    ("600519.SH", date(2002, 7, 25), 1.118279),
    ("600519.SH", date(2006, 5, 19), 2.006365),
    ("600519.SH", date(2011, 7, 1), 1.112023),
    ("600519.SH", date(2014, 6, 25), 1.130251),
    ("600519.SH", date(2015, 7, 17), 1.119471),
    ("600519.SH", date(2026, 6, 26), 1.023663),  # 纯现金
]


def test_split_factor_map_moutai_chain(tmp_path):
    """送转链后缀积: 2011-08 → 1.21 (2014×2015), 2021-09 → 1.0, 2013 → 1.331。"""
    _write_factor_table(tmp_path, _MOUTAI_FACTORS)
    repo = _repo_with_factors(tmp_path, _MOUTAI_FACTORS)
    m = kline_api._split_factor_map(repo, "600519.SH")
    # 5 个送转事件 (2002×1.1, 2006×2.0, 2011×1.1, 2014×1.1, 2015×1.1)
    assert m["events"] == [date(2002, 7, 25), date(2006, 5, 19),
                           date(2011, 7, 1), date(2014, 6, 25), date(2015, 7, 17)]
    assert kline_api._split_factor_after(m, date(2011, 8, 31)) == pytest.approx(1.21)
    assert kline_api._split_factor_after(m, date(2021, 9, 30)) == 1.0
    assert kline_api._split_factor_after(m, date(2014, 5, 31)) == pytest.approx(1.21)
    assert kline_api._split_factor_after(m, date(2013, 1, 1)) == pytest.approx(1.21)
    # 2011-07 送转之前 → 含 2011×2014×2015 = 1.331
    assert kline_api._split_factor_after(m, date(2010, 1, 1)) == pytest.approx(1.331)
    # 除权日当天 (2014-06-25) 价格已是新口径 → 不除
    assert kline_api._split_factor_after(m, date(2014, 6, 25)) == pytest.approx(1.1)
    # 送转日前一天 → 该送转也计入
    assert kline_api._split_factor_after(m, date(2014, 6, 24)) == pytest.approx(1.21)


def test_split_factor_map_no_events(tmp_path):
    """无除权标的 / 表缺失 → 空 map, factor 恒 1.0 (退化为 raw)。"""
    _write_factor_table(tmp_path, [("000001.SZ", date(2026, 6, 26), 1.01)])
    repo = _repo_with_factors(tmp_path, [])
    m = kline_api._split_factor_map(repo, "300750.SZ")
    assert m == {"events": [], "suffix": []}
    assert kline_api._split_factor_after(m, date(2020, 1, 1)) == 1.0
    # 表不存在
    m2 = kline_api._split_factor_map(_repo_with_factors(tmp_path / "nope", []), "600519.SH")
    assert m2 == {"events": [], "suffix": []}


# ── _to_split_ohlcv: raw 行缩放 ─────────────────────────────────


def test_to_split_ohlcv_math(tmp_path):
    """raw 行按日期除以送转链; TV 黄金: 2011-08-31 O 207.33/1.21 = 171.35。"""
    _write_factor_table(tmp_path, _MOUTAI_FACTORS)
    m = kline_api._split_factor_map(_repo_with_factors(tmp_path, []), "600519.SH")
    rows = [
        {"date": "2011-08-31", "open": 207.33, "high": 219.50, "low": 193.00, "close": 214.77},
        {"date": "2021-09-30", "open": 1559.00, "high": 1863.40, "low": 1531.10, "close": 1830.00},
    ]
    kline_api._to_split_ohlcv(rows, m)
    # TV 实测黄金 (2026-10-23 数据窗口)
    assert rows[0]["open"] == pytest.approx(171.35, rel=1e-3)
    assert rows[0]["high"] == pytest.approx(181.40, rel=1e-3)
    assert rows[0]["low"] == pytest.approx(159.50, rel=1e-3)
    assert rows[0]["close"] == pytest.approx(177.50, rel=1e-3)
    # 无送转段 = raw 原值
    assert rows[1]["close"] == 1830.00


def test_to_split_ohlcv_empty_map_noop():
    """空链 (无送转标的) → 原值不动 (退化为 raw)。"""
    rows = [{"date": "2020-01-02", "open": 10.0, "close": 11.0}]
    kline_api._to_split_ohlcv(rows, {"events": [], "suffix": []})
    assert rows[0]["close"] == 11.0


# ── /daily 端点: adjust=split 全链路 ─────────────────────────────

_D0 = cn_today() - timedelta(days=3)
_D1 = cn_today() - timedelta(days=2)


def _split_frame() -> pl.DataFrame:
    """窗口行 (qfq + raw 列, ratio 模拟): 供端点级换算验证。"""
    return pl.DataFrame({
        "symbol": ["600519.SH"] * 2,
        "date": [_D0, _D1],
        "open": [100.0, 100.0], "high": [110.0, 110.0],
        "low": [95.0, 95.0], "close": [105.0, 105.0],
        "raw_close": [121.0, 121.0], "raw_high": [126.5, 126.5], "raw_low": [109.25, 109.25],
        "volume": [50000.0, 50000.0],
    })


class _SplitRepo:
    """get_daily_asset mock + store.data_dir 指向 tmp_path (因子表)。"""

    def __init__(self, frame, tmp_path: Path):
        self._frame = frame
        self.store = SimpleNamespace(data_dir=tmp_path)

    def resolve_asset_type(self, symbol: str) -> str:
        return "stock"

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["600519.SH"], "name": ["贵州茅台"],
            "total_shares": [1.0], "float_shares": [1.0],
        })

    def get_daily_asset(self, asset_type, symbol, start, end, columns=None):
        df = self._frame.filter((pl.col("date") >= start) & (pl.col("date") <= end))
        if columns:
            df = df.select([c for c in columns if c in df.columns])
        return df.sort("date")


def _request(repo):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        repo=repo, quote_service=None, capabilities=None,
    )))


def test_daily_split_returns_split_prices(tmp_path):
    """adjust=split: 窗口行 = raw 后按送转链缩放; 指标在 split 序列附着。

    窗口日期无送转 (近期) → split = raw = 121.0; 端到端字段齐全。
    """
    _write_factor_table(tmp_path, _MOUTAI_FACTORS)
    repo = _SplitRepo(_split_frame(), tmp_path)
    resp = kline_api.get_daily(
        _request(repo), symbol="600519.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
        adjust="split",
    )
    last = resp["rows"][-1]
    # 近期无送转: split = raw
    assert last["close"] == 121.0
    assert last["high"] == 126.5 and last["low"] == 109.25
    # 指标已在送转复权序列上附着
    assert "ry_upper" in last and "macd_plus_hist" in last and "rsi_plus" in last


def test_daily_split_warmup_same_basis(tmp_path):
    """split 模式 warmup 读取 raw 列 (与 raw 模式同路径) + 送转链缩放。"""
    _write_factor_table(tmp_path, _MOUTAI_FACTORS)
    repo = _SplitRepo(_split_frame(), tmp_path)
    kline_api.get_daily(
        _request(repo), symbol="600519.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
        adjust="split",
    )
    # warmup 读取请求过 raw 列 (raw_mode=True 路径)
    # (_SplitRepo 不记录 columns — 此处仅验证端点 200 不抛; 深度验证在
    #  test_daily_split_returns_split_prices 的指标字段)


def test_daily_adjust_invalid_value_400():
    """非法 adjust → 400 且提示三模式。"""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        kline_api.get_daily(
            _request(_SplitRepo(_split_frame(), Path("."))), symbol="600519.SH",
            days=120, start_date=None, end_date=None, ext_columns=None,
            adjust="hfq",
        )
    assert "split" in ei.value.detail


def test_daily_qfq_default_unchanged_split_regression(tmp_path):
    """默认 qfq 不受 split 模式新增影响 (回归锁)。"""
    _write_factor_table(tmp_path, _MOUTAI_FACTORS)
    resp = kline_api.get_daily(
        _request(_SplitRepo(_split_frame(), tmp_path)), symbol="600519.SH", days=120,
        start_date=None, end_date=None, ext_columns=None,
    )
    last = resp["rows"][-1]
    assert last["close"] == 105.0
