"""K 线 / 同步 API。"""
from __future__ import annotations

import gzip
import json
import logging
import math
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.identity.permissions import P_DATA_WRITE, require_perm
from app.db_safe import is_valid_ext_ident
from app.indicators.intraday import (
    INTRADAY_PERIODS,
    attach_intraday_plus,
    resample_minutes,
    to_minute_start_semantics,
)
from app.indicators.pipeline import compute_enriched, compute_enriched_single
from app.indicators.plus import _T_LOOKBACK_DAILY, attach_plus_indicators
from app.indicators.rymain import attach_ry_main
from app.market_time import cn_now, cn_today, in_continuous_session
from app.price_limits import (
    is_no_limit_day,
    is_risk_warning_name,
    parse_listing_date,
    price_limit_pct,
)
from app.services import kline_sync, minute_adjust, trading_day

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/kline", tags=["kline"])


def _json_safe(obj):
    """把 nan/inf 换成 None, 保证 JSON 合法。

    gzip 路径原先 allow_nan=True, 会写出前端 JSON.parse 不能吃的 NaN/Infinity;
    未压缩路径走 Starlette allow_nan=False, 遇到非有限浮点整段 500。
    """
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def _gzip_payload(request: Request, payload: dict, *, pref_key: str) -> dict | Response:
    """大 JSON 响应的传输压缩: 偏好开启 + 客户端接受 gzip + 响应超阈值才压。

    分时/日K各自使用独立偏好键 (沿用已有 *_batch_compress 存储键保证兼容)。
    level 6 实测 13MB ≈ 290ms CPU 压掉 87%; level 9 要 2.5s 不可用。
    datetime → isoformat, 与 FastAPI jsonable_encoder 输出一致
    (前端 since 增量按字符串字典序比较, 格式必须与非压缩路径相同)。
    """
    from app.services import preferences as _prefs
    _getters = {
        "minute_batch_compress": _prefs.get_minute_batch_compress,
        "daily_batch_compress": _prefs.get_daily_batch_compress,
    }
    getter = _getters.get(pref_key)
    compress_on = False
    if getter is not None:
        try:
            compress_on = bool(getter())
        except Exception:  # 偏好读取异常按不压缩返回原样
            compress_on = False
    payload = _json_safe(payload)
    headers = getattr(request, "headers", None) or {}
    if compress_on and "gzip" in (headers.get("accept-encoding") or ""):
        raw = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
            default=lambda o: o.isoformat() if hasattr(o, "isoformat") else str(o),
        ).encode()
        if len(raw) > 1024:
            return Response(
                content=gzip.compress(raw, 6),
                media_type="application/json",
                headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
            )
    return payload


def _minute_allowed(capset) -> bool:
    """是否有分钟K权限 (TickFlow Pro+ 或 custom minute 源)。"""
    from app.tickflow.capabilities import Cap
    if capset.has(Cap.KLINE_MINUTE_BATCH):
        return True
    from app.services import preferences
    provider = preferences.get_minute_data_provider()
    _, fallback, error = kline_sync._resolve_minute_provider(provider)
    if error is not None:
        logger.warning("minute provider resolution failed while checking access: %s", error)
    return not fallback


@lru_cache(maxsize=8192)
def _name_pinyin_keys(name: str) -> tuple[str, ...]:
    """返回中文名称所有可能的拼音首字母串 (多音字展开为笛卡尔积)。

    '平安银行' -> ('PAYH',); '重庆百货' -> ('CQBH', 'CQMH', 'ZQBH', 'ZQMH')。
    非汉字字符原样保留: '万科A' -> ('WKA',)。
    股票名总量有限且不变, lru_cache 命中后单次查询 ≈ dict 查找, 全市场遍历 < 1ms。
    """
    from pypinyin import Style, pinyin
    if not name:
        return ()
    keys = [""]
    for group in pinyin(name, style=Style.FIRST_LETTER, heteronym=True):
        keys = [k + g.upper() for k in keys for g in group]
    return tuple(keys)


def _init_pinyin_dict() -> None:
    """加载 A 股高频多音字地名/词组词典, 使常见误读也能命中。

    pypinyin 默认词典对部分地名取常见读音 (如「重」→ chóng), 补充后「重庆」
    同时接受 zhòng/qìng (zq) 与 chóng/qīng (cq) 两种首字母, 与同花顺行为一致。
    幂等: 多次调用安全。
    """
    try:
        from pypinyin import load_phrases_dict
        # value 用二维 list: 每个字给一个或多个读音
        load_phrases_dict({
            "重庆": [["zhòng", "chóng"], ["qīng"]],
            "长安": [["cháng", "zhǎng"], ["ān"]],
            "长春": [["cháng", "zhǎng"], ["chūn"]],
            "长沙": [["cháng", "zhǎng"], ["shā"]],
            "长城": [["cháng", "zhǎng"], ["chéng"]],
            "长江": [["cháng", "zhǎng"], ["jiāng"]],
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("pypinyin phrases dict load failed (polyphone coverage may degrade): %s", exc)


_init_pinyin_dict()


def _match_pinyin(name: str, keyword: str) -> bool:
    """keyword 是否匹配 name 任一拼音首字母串的前缀 (支持多音字)。"""
    return any(k.startswith(keyword) for k in _name_pinyin_keys(name))


@router.get("/instruments/search")
def search_instruments(
    request: Request,
    q: str = Query("", min_length=0, max_length=50, description="搜索关键词"),
    limit: int = Query(20, ge=1, le=50),
    asset_types: str = Query("stock", description="逗号分隔的资产类型: stock,etf"),
):
    """模糊搜索标的 (代码 / 名称)。从内存 instruments 缓存中查。

    默认只搜股票, 保持既有调用方行为不变; 自选等场景传 asset_types=stock,etf
    可一并搜出 ETF, 结果附带 asset_type 字段供前端区分。
    """
    if not q.strip():
        return {"results": []}

    repo = request.app.state.repo
    import polars as pl

    types = [t.strip() for t in asset_types.split(",") if t.strip()]
    parts: list[pl.DataFrame] = []
    for t in types:
        df_t = repo.get_instruments_asset(t)
        if df_t.is_empty() or "symbol" not in df_t.columns:
            continue
        # dtype 全部归一到 Utf8: 股票/ETF 两份缓存来源不同 (ETF 含 legacy 合并), 防 concat SchemaError
        parts.append(df_t.with_columns([
            pl.col("symbol").cast(pl.Utf8).alias("symbol"),
            (pl.col("name").cast(pl.Utf8) if "name" in df_t.columns else pl.lit("")).alias("name"),
            (pl.col("code").cast(pl.Utf8) if "code" in df_t.columns else pl.lit("")).alias("code"),
            pl.lit(t).alias("asset_type"),
        ]).select(["symbol", "name", "code", "asset_type"]))
    if not parts:
        return {"results": []}
    df = pl.concat(parts, how="vertical")

    keyword = q.strip().upper()
    is_pinyin_query = keyword.isalpha() and keyword.isascii()

    # code/symbol 前缀优先，再 name 包含匹配
    prefix_mask = (
        pl.col("code").str.starts_with(keyword)
        | pl.col("symbol").str.to_uppercase().str.starts_with(keyword)
    )
    contains_mask = (
        pl.col("code").str.contains(keyword, literal=True)
        | pl.col("symbol").str.to_uppercase().str.contains(keyword, literal=True)
        | pl.col("name").str.contains(keyword, literal=True)
    )

    # 分层匹配: ① code/symbol 前缀 → ② 拼音首字母前缀(纯字母输入) → ③ 包含匹配
    prefix_hits = df.filter(prefix_mask).head(limit)
    if prefix_hits.height >= limit:
        matched = prefix_hits
    else:
        collected = [prefix_hits] if prefix_hits.height else []
        seen = set(prefix_hits["symbol"].to_list()) if prefix_hits.height else set()
        remaining = limit - prefix_hits.height

        # ② 拼音首字母前缀: 仅纯字母输入触发 (如 payh → 平安银行); 中文/代码输入零开销跳过
        if is_pinyin_query and remaining > 0:
            pinyin_rows = []
            for row in df.filter(~pl.col("symbol").is_in(seen)).iter_rows(named=True):
                if _match_pinyin(row["name"], keyword):
                    pinyin_rows.append(row)
                    if len(pinyin_rows) >= remaining:
                        break
            if pinyin_rows:
                collected.append(pl.DataFrame(pinyin_rows))
                seen.update(r["symbol"] for r in pinyin_rows)
                remaining -= len(pinyin_rows)

        # ③ 包含匹配补充
        if remaining > 0:
            contain_hits = df.filter(contains_mask & ~pl.col("symbol").is_in(seen)).head(remaining)
            if contain_hits.height:
                collected.append(contain_hits)

        matched = (
            pl.concat(collected, how="vertical") if len(collected) > 1
            else (collected[0] if collected else df.head(0))
        )
    rows = matched.select(["symbol", "name", "code", "asset_type"]).to_dicts()
    return {"results": rows}


@router.post("/instruments/names")
def instruments_names(request: Request, symbols: list[str]):
    """批量查标的名称 (股票 + ETF + 指数)。传入 symbol 列表, 返回 {symbol: name}。"""
    if not symbols:
        return {"names": {}}
    repo = request.app.state.repo
    return {"names": repo.get_name_map(symbols)}


def _get_stock_info(repo, symbol: str) -> dict:
    """从 instruments 内存缓存查标的名称 + 股本。

    该接口在个股弹窗打开时每秒被调用 (SSE invalidate 触发重拉), 走
    repo.get_instruments() 的 Polars 内存缓存按 symbol 过滤, 不再每请求
    DuckDB 扫 instruments parquet。列缺失时返回空 dict, 与旧 SQL 报错路径一致。
    """
    import polars as pl
    try:
        df = repo.get_instruments()
        needed = ("symbol", "name", "total_shares", "float_shares")
        if df.is_empty() or not all(c in df.columns for c in needed):
            return {}
        hit = df.filter(pl.col("symbol") == symbol).head(1)
        if hit.is_empty():
            return {}
        return {
            "name": hit["name"][0],
            "total_shares": hit["total_shares"][0],
            "float_shares": hit["float_shares"][0],
        }
    except Exception:  # noqa: BLE001
        return {}


def _get_asset_info(repo, symbol: str, asset_type: str) -> dict:
    """非股票标的 (ETF / 指数) 的名称信息 — 从对应 instruments 缓存查, 无股本概念。"""
    import polars as pl
    try:
        df = repo.get_instruments_asset(asset_type)
        if df.is_empty() or "symbol" not in df.columns or "name" not in df.columns:
            return {}
        hit = df.filter(pl.col("symbol") == symbol).head(1)
        if hit.is_empty():
            return {}
        return {"name": hit["name"][0]}
    except Exception:
        return {}


def _get_price_limit_info(
    repo,
    symbol: str,
    trade_date: date,
    asset_type: str,
    instrument_name: str | None,
) -> dict | None:
    """Return the date-aware limit rule and today's authoritative prices."""
    if asset_type == "index":
        return None

    info: dict = {
        "rate": price_limit_pct(
            symbol,
            trade_date,
            is_risk_warning=(
                asset_type == "stock" and is_risk_warning_name(instrument_name)
            ),
        ),
        "limit_up": None,
        "limit_down": None,
        "no_limit": False,
        "source": "rule",
    }
    if trade_date != cn_today():
        return info

    # instrument 行一次取出: 今日权威涨跌停价 + listing_date 窗口判定共用
    row: dict | None = None
    try:
        import polars as pl

        instruments = repo.get_instruments_asset(asset_type)
        available = [
            column
            for column in ("symbol", "limit_up", "limit_down", "listing_date")
            if column in instruments.columns
        ]
        if "symbol" in available and len(available) > 1:
            hit = instruments.filter(pl.col("symbol") == symbol).select(available).head(1)
            if not hit.is_empty():
                row = hit.to_dicts()[0]
    except Exception:
        row = None

    # 注册制新股上市初期无涨跌幅: listing_date 命中窗口时 no_limit=True,
    # 压过 rate 与维表值 (前端不再画涨跌停带, y 轴按实际数据自适应)
    if row is not None:
        listing = parse_listing_date(row.get("listing_date"))
        if listing is not None and is_no_limit_day(symbol, listing, trade_date):
            info["no_limit"] = True
            return info

    if trade_date != cn_today():
        return info

    if row is None:
        return info

    has_authoritative_price = False
    for field in ("limit_up", "limit_down"):
        value = row.get(field)
        if value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(numeric) and 0 < numeric < 10_000:
            info[field] = numeric
            has_authoritative_price = True
    if has_authoritative_price:
        info["source"] = "instrument"
    return info


def _get_previous_closes(
    repo,
    symbol: str,
    trade_dates: list[date],
    asset_type: str,
) -> dict[date, float | None]:
    """Return the previous trading day's adjusted close for each session."""
    if not trade_dates:
        return {}
    start = min(trade_dates) - timedelta(days=45)
    end = max(trade_dates)
    try:
        daily = repo.get_daily_asset(
            asset_type,
            symbol,
            start,
            end,
            columns=["date", "close"],
        ).sort("date")
    except Exception:
        daily = None
    if daily is None or daily.is_empty():
        return {trade_date: None for trade_date in trade_dates}

    closes: list[tuple[date, float]] = []
    for daily_date, close in daily.select(["date", "close"]).iter_rows():
        if close is None:
            continue
        numeric = float(close)
        if math.isfinite(numeric) and numeric > 0:
            closes.append((daily_date, numeric))

    result: dict[date, float | None] = {}
    for trade_date in trade_dates:
        result[trade_date] = next(
            (close for daily_date, close in reversed(closes) if daily_date < trade_date),
            None,
        )
    return result


@router.get("/daily")
def get_daily(
    request: Request,
    symbol: str = Query(..., description="标的代码,如 000001.SZ"),
    days: int = Query(120, ge=10, le=2000),
    start_date: Optional[str] = Query(None, description="起始日期 YYYY-MM-DD, 优先于 days"),
    end_date: Optional[str] = Query(None, description="截止日期 YYYY-MM-DD, 默认今天"),
    ext_columns: Optional[str] = Query(None, description="逗号分隔的 ext 列: config_id.field_name"),
    plus_lookback: Optional[int] = Query(
        None, ge=1, le=500,
        description="私有指标量级缩放窗口 (默认 50=日K档; 4h 周期客户端传 160)",
    ),
    ry_bar_minutes: Optional[int] = Query(
        None, ge=1, le=1440,
        description="融易 K2/K3 桶语义输入周期分钟数 (4h 面板传 240 → K2/K3=1天桶=当前级; 默认 None=日K档 4/8 根)",
    ),
    agg: Optional[str] = Query(
        None, description="聚合周期: 2d|4d|1w|1M — 在聚合 K 上重算私有指标 (Pine 周期语义; warmup 同口径聚合)",
    ),
    adjust: Optional[str] = Query(
        None, description="复权方式: qfq(前复权,默认) | raw(不复权,TV 关 ADJ 口径) | split(送转复权,TV 开 ADJ 口径 — 仅送转股调整, 现金分红不调)",
    ),
):
    """读取本地 enriched 表中某只股票的日 K。

    - 若 QuoteService 有实时行情, 追加/覆盖今日实时蜡烛
    - Free 用户: 若 enriched 表里没有该股票, 实时拉取 + 本地算 enriched 返回
    - ext_columns: 可选，动态 LEFT JOIN 扩展数据表，结果平铺到 stock_info.ext 下
      (key 为 "{config_id}__{field_name}")，供日K信息条等场景展示自定义字段
    - adjust=raw: 不复权显示模式 — OHLC 换算回原始价, 私有指标在 raw 序列上
      重算 (warmup 同口径), 对齐用户 TV 布局关 ADJ 的显示口径 (2026-10-23 对拍实证)
    - adjust=split: 送转复权模式 — raw 序列再按送转链缩放 (现金分红不调),
      对齐 TV 开 ADJ 的显示口径 (TV "调整股息数据" 实测仅调送转:
      600519 两次 10送1 后 2011-08 = raw×1/1.21 与 TV 分毫不差,
      2021-09/2020-11/2021-02 因后续无送转 = raw 亦分毫不差)
    """
    import polars as pl

    # 直调端点 (测试/内部调用) 时 FastAPI Query 默认对象会漏进来 —
    # 与 _resolve_plus_lookback 同款净化: 只认真实字符串, 其余 (Query 对象) 视为未传
    if agg is not None and not isinstance(agg, str):
        agg = None
    if agg is not None and agg not in _AGG_LOOKBACK:
        raise HTTPException(status_code=400, detail="agg 仅支持 2d | 4d | 1w | 1M")
    if adjust is not None and not isinstance(adjust, str):
        adjust = None
    if adjust is None:
        adjust = "qfq"
    if adjust not in _ADJUST_MODES:
        raise HTTPException(status_code=400, detail="adjust 仅支持 qfq | raw | split")
    split_mode = adjust == "split"
    # split 序列 = raw 序列按送转链缩放 → 复用 raw 换算路径
    raw_mode = adjust == "raw" or split_mode
    # agg 模式下 lookback 未传时按 Pine 量级标尺预设档推导 (1w/1M=10, 其余=50)
    if agg is not None and plus_lookback is None:
        plus_lookback = _AGG_LOOKBACK[agg]

    repo = request.app.state.repo
    split_map = _split_factor_map(repo, symbol) if split_mode else None
    # 未传 end_date 时用北京今天: 实时注入只在内存缓存命中时补当日 K,
    # 缓存冷时 parquet 当日行能否进结果取决于这个窗口右端。
    end = date.fromisoformat(end_date) if end_date else cn_today()
    if start_date:
        start = date.fromisoformat(start_date)
    else:
        start = end - timedelta(days=days)

    asset_type = repo.resolve_asset_type(symbol)
    stock_info = _get_stock_info(repo, symbol) if asset_type == "stock" else _get_asset_info(repo, symbol, asset_type)
    stock_name = stock_info.get("name")

    # 从 enriched 表读取 (已含前复权 OHLCV + 技术指标 + 信号); ETF/指数走独立存储
    df = repo.get_daily_asset(asset_type, symbol, start, end)

    if df.is_empty():
        # 库内无 [start, end] 数据 (图表「往左加载更多」请求了更早的历史区间):
        # 按请求窗口实时拉取, 而非 tail(days) 取最近 N 根 —— tail(days) 会把窗口外的
        # 历史请求静默替换成最近数据, 导致前端永远拿不到更早的 K 线。
        # 往前多拉 150 天作为指标 warmup (MA60 需要 ~60 交易日 ≈ 120 日历日), 最后裁剪回窗口。
        try:
            raw = kline_sync.sync_daily_batch(
                [symbol],
                start_time=datetime.combine(start - timedelta(days=150), datetime.min.time()),
                end_time=datetime.combine(end, datetime.max.time()),
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"TickFlow fetch failed: {e}") from e
        if raw.is_empty():
            return _gzip_payload(
                request,
                {"symbol": symbol, "name": stock_name, "stock_info": stock_info, "rows": []},
                pref_key="daily_batch_compress",
            )
        # 拉除权因子做前复权 (Starter+ 有权限), 否则空 df → compute_enriched 退回未复权
        factors = pl.DataFrame()
        capset = getattr(request.app.state, "capabilities", None)
        try:
            from app.tickflow.capabilities import Cap
            if capset and capset.has(Cap.ADJ_FACTOR):
                factors = kline_sync.fetch_adj_factor_single(symbol)
        except Exception as e:  # noqa: BLE001
            logger.debug("单股除权因子拉取失败 %s: %s", symbol, e)
        enriched = compute_enriched(raw, factors=factors)
        rows = enriched.filter((pl.col("date") >= start) & (pl.col("date") <= end)).to_dicts()
        if raw_mode:
            rows = _to_raw_ohlcv(rows)
        if split_mode:
            rows = _to_split_ohlcv(rows, split_map)
        # 即使 live 模式也尝试追加实时蜡烛
        rows = _maybe_inject_live_candle(request, symbol, rows, asset_type)
        # agg 模式: 聚合在 _attach_plus_with_warmup 内部完成 (全历史拼接聚合
        # 后在聚合 K 上重算私有指标, Pine 周期语义 + 桶边界全历史对齐)
        rows = _attach_plus_with_warmup(repo, asset_type, symbol, rows,
                                        lookback=_resolve_plus_lookback(plus_lookback),
                                        ry_bar_minutes=None if agg else ry_bar_minutes,
                                        agg=agg, raw_mode=raw_mode, ry_full_history=True,
                                        split_map=split_map)
        resp = {"symbol": symbol, "name": stock_name, "stock_info": stock_info, "rows": rows, "source": "live"}
        return _gzip_payload(
            request,
            _attach_ext(resp, repo, symbol, ext_columns),
            pref_key="daily_batch_compress",
        )

    rows = df.to_dicts()
    if raw_mode:
        rows = _to_raw_ohlcv(rows)
    if split_mode:
        rows = _to_split_ohlcv(rows, split_map)

    # 追加/覆盖今日实时蜡烛
    rows = _maybe_inject_live_candle(request, symbol, rows, asset_type)
    # agg 模式: 聚合在 _attach_plus_with_warmup 内部完成 (全历史拼接聚合后
    # 在聚合 K 上重算私有指标, Pine 周期语义 + 桶边界全历史对齐)
    rows = _attach_plus_with_warmup(repo, asset_type, symbol, rows,
                                    lookback=_resolve_plus_lookback(plus_lookback),
                                    ry_bar_minutes=None if agg else ry_bar_minutes,
                                    agg=agg, raw_mode=raw_mode, ry_full_history=True,
                                    split_map=split_map)

    resp = {"symbol": symbol, "name": stock_name, "stock_info": stock_info, "rows": rows, "source": "enriched"}
    return _gzip_payload(
        request,
        _attach_ext(resp, repo, symbol, ext_columns),
        pref_key="daily_batch_compress",
    )


# 私有化指标 (MACD+/RSI+/融易主图) 递推预热窗口: 250 日历日 ≈ 170 交易日,
# EMA60+RSI28(RMA28) 递推残差收敛深度 << 170 根, 量级标尺 50 窗口亦覆盖,
# 与全历史递推口径对齐 (fund 状态机在 warmup 段预收敛)。
# 融易主图 EMA110/ATR50 深度更长, 用 550 日历日 ≈ 380 交易日 warmup。
_PLUS_WARMUP_DAYS = 250
_RY_WARMUP_DAYS = 550


def _resolve_plus_lookback(plus_lookback) -> int:
    """plus_lookback 实参 → 有效档位。

    HTTP 路径 FastAPI 已解析成 int|None; 直调 (测试/内部调用) 时默认值是
    Query(None) 对象本身 — 真值判断 (or / if) 会把它当有效档位穿透到
    _sma_series 的比较运算炸 TypeError。此处只认正整数, 其余 (None /
    Query 对象 / 非法值) 回退日K默认档 50。
    """
    if isinstance(plus_lookback, int) and not isinstance(plus_lookback, bool) and plus_lookback > 0:
        return plus_lookback
    return _T_LOOKBACK_DAILY


def _resample_daily_rows(rows: list[dict], agg: str) -> list[dict]:
    """聚合日级行为更高粒度 K (2d/4d=每 N 交易日, 1w=自然周 ISO, 1M=自然月)。

    Pine 周期语义: 指标永远画在当前周期 K 上 — 聚合后只留 OHLCV/date/amount,
    公开指标由前端 enrichChartIndicators 现场重算, 私有指标 (plus/ry) 由
    _attach_plus_with_warmup(agg=...) 在聚合序列上重算 (warmup 日线同口径聚合)。
    date 取桶首根日期 (与前端 resampleDaily 口径一致, 字典序可比较)。
    is_live: 桶内任一行带实时标记 (当日实时蜡烛只出现在末行) → 桶继承,
    末根活动桶保留前端现价标签的实时徽记语义。
    """
    n = 0
    if agg.endswith("d") and agg[:-1].isdigit():
        n = int(agg[:-1])
    if n == 0 and agg not in ("1w", "1M"):
        return rows
    out: list[dict] = []
    cur: dict | None = None
    cur_key: tuple | None = None
    count = 0
    for r in rows:
        d = str(r.get("date"))[:10]
        key: tuple | None = None
        if agg in ("1w", "1M"):
            dd = date.fromisoformat(d)
            key = (dd.isocalendar()[0], dd.isocalendar()[1]) if agg == "1w" else (dd.year, dd.month)
            new_bucket = cur is None or key != cur_key
        else:
            new_bucket = cur is None or count >= n
        if new_bucket:
            if cur is not None:
                out.append(cur)
            cur = {
                "date": d,
                "open": r.get("open"), "high": r.get("high"),
                "low": r.get("low"), "close": r.get("close"),
                "volume": r.get("volume") or 0,
                "amount": r.get("amount"),
                "is_live": r.get("is_live") is True,
            }
            cur_key = key
            count = 1
        elif cur is not None:
            h, l = r.get("high"), r.get("low")
            if h is not None and (cur.get("high") is None or h > cur["high"]):
                cur["high"] = h
            if l is not None and (cur.get("low") is None or l < cur["low"]):
                cur["low"] = l
            cur["close"] = r.get("close")
            cur["volume"] = (cur.get("volume") or 0) + (r.get("volume") or 0)
            ca, ra = cur.get("amount"), r.get("amount")
            cur["amount"] = (ca + ra) if (ca is not None and ra is not None) else (ca if ca is not None else ra)
            if r.get("is_live") is True:
                cur["is_live"] = True
            count += 1
    if cur is not None:
        out.append(cur)
    return out


# agg 周期 → Pine 量级标尺预设档 (附图 f_getPresetLookback)
# 2026-10-23 TV 月线对拍实证修正: 1M → 10 (非 3) — TV 月线 hist=-66.90
# 对应 lookback=10 的 -67.15 (数据源级残差 0.25), lookback=3 给 -72.73 (差 5.83);
# 即 Pine 预设边界为「严格大于 1月」才落 3 档, 1M 周期本身在 ≤1月 档 (与 1w 同档)。
_AGG_LOOKBACK = {"1w": 10, "1M": 10, "2d": 50, "4d": 50}

# 复权方式合法值: qfq=前复权 (默认) / raw=不复权 (TV 关 ADJ 口径) /
# split=送转复权 (TV 开 ADJ 口径 — 仅按送转股调整, 现金分红不调整)
_ADJUST_MODES = ("qfq", "raw", "split")

# 送转比例候选 (10送X → 1+X/10 的离散值; 含 10转10=2.0, 10转5=1.5 等;
# A 股送转最小单位 10送1=1.1 — 不含 1.05 以免误拆纯现金大额分红)
_SPLIT_RATIO_CANDIDATES = (
    1.1, 1.15, 1.2, 1.25, 1.3, 1.33, 1.4, 1.5, 1.6, 1.8, 2.0,
    2.5, 3.0, 3.33, 4.0, 5.0, 6.0, 8.0, 10.0,
)
# 现金分红部分合理上界 (ex_factor/送转比例 ≤ 此值视为现金, 超出视为无法拆解)
_CASH_COMPONENT_MAX = 1.05
# 低于此阈值的 ex_factor 直接视为纯现金分红 (送转部分 1.0)
_SPLIT_DETECT_MIN = 1.05


def _extract_split_component(ex_factor: float) -> float:
    """从综合除权因子拆出送转 (split/bonus) 部分。

    TickFlow ex_factor = 现金部分 × 送转部分 (无明细列时):
    - ex_factor ≤ 1.05 → 纯现金分红, 送转 = 1.0;
    - 否则找最大的离散送转候选 s, 使商 ex_factor/s ∈ [1.0, 1.05] (现金合理域);
      找不到 → 保守视为现金 (送转 = 1.0)。
    600519 全 30 事件拆解自洽 (8 送转: 1.1×1.1×1.3×1.2×2.0×1.1×1.1×1.1,
    其余 22 条纯现金) — 2026-10-23 TV 对拍实证 (详见 test_kline_adjust_split)。
    """
    if ex_factor is None or not math.isfinite(ex_factor) or ex_factor <= _SPLIT_DETECT_MIN:
        return 1.0
    best = 1.0
    for s in _SPLIT_RATIO_CANDIDATES:
        if s > ex_factor:
            break
        q = ex_factor / s
        if 1.0 <= q <= _CASH_COMPONENT_MAX:
            best = max(best, s)
    return best


def _split_factor_map(repo, symbol: str) -> dict[str, list]:
    """构造送转复权查表: {symbol} 的 (事件日期列表, 后缀积列表)。

    返回 {"events": [d1, d2, ...], "suffix": [f1, f2, ...]} —
    suffix[i] = Π(events[i:] 的送转因子), 即日期 > events[i-1] 的行
    应除以的系数; 对行日期 d, i = bisect_right(events, d),
    factor_after(d) = suffix[i] (i == len 时为 1.0)。
    读表失败/无事件 → 空 dict (调用方按 factor=1 处理 = 退化为 raw)。
    """
    import bisect

    out = {"events": [], "suffix": []}
    try:
        import polars as pl  # noqa: PLC0415 — 与端点同款局部导入

        factors = pl.read_parquet(repo.store.data_dir / "adj_factor" / "all.parquet")
        factors = (factors.filter(pl.col("symbol") == symbol)
                   .select("trade_date", "ex_factor")
                   .sort("trade_date"))
        if factors.is_empty():
            return out
        events: list[date] = []
        splits: list[float] = []
        for r in factors.iter_rows(named=True):
            td = r.get("trade_date")
            ef = r.get("ex_factor")
            if td is None or ef is None:
                continue
            d = td if isinstance(td, date) else date.fromisoformat(str(td)[:10])
            s = _extract_split_component(float(ef))
            if s > 1.0:
                events.append(d)
                splits.append(s)
        # 后缀积 (含末尾哨兵 1.0)
        suffix = [1.0] * (len(splits) + 1)
        for i in range(len(splits) - 1, -1, -1):
            suffix[i] = splits[i] * suffix[i + 1]
        out["events"] = events
        out["suffix"] = suffix
        return out
    except Exception:  # noqa: BLE001 — 指数/ETF 或表缺失 → 空表退化
        logger.debug("送转链读取失败 %s", symbol, exc_info=True)
        return out


def _split_factor_after(split_map: dict, d: date) -> float:
    """行日期 d 的送转缩放系数 (d 之后所有送转的乘积)。"""
    import bisect

    events = split_map.get("events") or []
    if not events:
        return 1.0
    i = bisect.bisect_right(events, d)
    suffix = split_map.get("suffix") or []
    return suffix[i] if i < len(suffix) else 1.0


def _to_split_ohlcv(rows: list[dict], split_map: dict) -> list[dict]:
    """raw 行 → 送转复权 (TV ADJ 口径) 行 (原地改写)。

    输入 rows 已是 raw OHLC (_to_raw_ohlcv 之后)。每行按其日期除以
    「该日期之后所有送转事件的乘积」; 现金分红不调整 (与 TV 一致)。
    无送转事件的标的 = factor 1.0 → 序列与 raw 相同 (TV 无 ADJ 时也如此)。
    """
    if not split_map.get("events"):
        return rows
    for r in rows:
        d = r.get("date")
        if d is None:
            continue
        dd = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
        f = _split_factor_after(split_map, dd)
        if f == 1.0:
            continue
        for k in ("open", "high", "low", "close"):
            v = r.get(k)
            if v is not None:
                r[k] = v / f
    return rows


def _to_raw_ohlcv(rows: list[dict]) -> list[dict]:
    """前复权行 → 不复权 (raw) 行 (原地改写)。

    enriched 存储: open/high/low/close 为前复权, raw_close/raw_high/raw_low
    为原始价 (无 raw_open 列)。换算:
    - close ← raw_close; high/low ← raw_high/raw_low (列存在则直取, 精度更高);
    - open ← open × (raw_close/close) (行级复权比例反推);
    - 无 raw_close 或 close 无效 → 该行保持原值 (当日实时行 ratio=1, 前复权=raw)。
    指标附着发生在换算后的 raw 序列上 (EMA110/ATR50/SuperTrend 全部 raw 口径,
    对齐 TV request.security/主图取数)。volume/amount 不复权原样。
    """
    for r in rows:
        rc = r.get("raw_close")
        c = r.get("close")
        if rc is None or c is None or c == 0:
            continue
        for key, raw_key in (("close", "raw_close"), ("high", "raw_high"), ("low", "raw_low")):
            rv = r.get(raw_key)
            if rv is not None:
                r[key] = rv
        ratio = rc / c
        o = r.get("open")
        if o is not None:
            r["open"] = o * ratio
    return rows

# agg 周期 → 当前图表周期总分钟数 (rymain K2/K3 TV 高周期换算输入:
# K2=周期×4 → "1W"/"2W"/"4W"; K3=周期×8 → "2W"/"1M"/"2M")
_AGG_TF_MINUTES = {"2d": 2880, "4d": 5760, "1w": 10080, "1M": 43200}


def _daily_raw_ratio_map(repo, symbol: str, start: date, end: date) -> dict[str, float]:
    """日K行级复权比例表 (raw_close/close, 按日期) — 分钟 qfq→raw 反推用。

    分钟存储为 qfq 基准且无 raw 列 (marker 未迁移); 用同日日K行的
    raw_close/close 比例反推原始价。当日 ratio=1 两口径同价。
    读失败/缺 raw_close 列 (指数/ETF) 返回空表 → 调用方按原值处理。
    """
    try:
        df = repo.get_daily_asset("stock", symbol, start, end,
                                  columns=["date", "close", "raw_close"])
        if df.is_empty() or "raw_close" not in df.columns:
            return {}
        out: dict[str, float] = {}
        for r in df.to_dicts():
            c, rc = r.get("close"), r.get("raw_close")
            if c and rc and c > 0:
                out[str(r.get("date"))[:10]] = rc / c
        return out
    except Exception:  # noqa: BLE001
        logger.debug("分钟 raw 比例表读取失败 %s", symbol, exc_info=True)
        return {}


def _read_daily_warmup(repo, asset_type: str, symbol: str, start: date, end: date,
                       columns: list[str], raw_mode: bool):
    """读 warmup 历史; raw 模式追加 raw 列, 标的表缺 raw 列 (指数/ETF 无复权概念)
    或读失败时逐级降级回 qfq 口径 (warmup 不因 raw 模式丢失)。"""
    extra = ["raw_close", "raw_high", "raw_low"] if raw_mode else []
    if extra:
        try:
            return repo.get_daily_asset(asset_type, symbol, start, end, columns=columns + extra).sort("date")
        except Exception:  # noqa: BLE001 — 缺 raw 列的表退回 qfq warmup
            logger.debug("warmup raw 列读取失败, 退回 qfq: %s", symbol, exc_info=True)
    return repo.get_daily_asset(asset_type, symbol, start, end, columns=columns).sort("date")


def _attach_plus_with_warmup(
    repo, asset_type: str, symbol: str, rows: list[dict], lookback: int = _T_LOOKBACK_DAILY,
    ry_bar_minutes: Optional[int] = None,
    agg: Optional[str] = None,
    raw_mode: bool = False,
    ry_full_history: bool = False,
    split_map: Optional[dict] = None,
) -> list[dict]:
    """MACD+/RSI+ + 融易主图 附着 (带窗口前历史 warmup)。

    EMA/RMA 递推指标只在返回窗口内算会因 warmup 不足偏离全历史口径
    (原版 enriched 落盘值); 取窗口前历史前置递推对齐 (plus 用 250 日历日
    close, ry 主图用 550 日历日 OHLC)。
    历史读失败时退化为窗口内递推 (数值仍可用, 仅前期偏差)。
    lookback: 量级缩放窗口 (日K默认 50; 4h 周期前端传 160 — Pine 周期预设档)。
    ry_bar_minutes: 融易 K2/K3 桶语义输入周期 (4h 面板传 240; None=日K档)。
    agg: 聚合周期 (2d/4d/1w/1M) — rows 为窗口内原始日K行 (端点层不预
    聚合), 走 _attach_plus_with_agg_history 全历史拼接聚合后递推
    (Pine 语义: 指标画在聚合 K 上, 对齐 TV 全历史递推口径)。
    raw_mode: 不复权模式 — rows 已由端点层换算为 raw OHLC, warmup 历史
    同口径换算 (raw_close/high/low 列), 保证递推序列口径一致。
    ry_full_history: ry 主图 warmup 读全历史 (1990 起) — K2/K3 的 "4D"
    连续交易日桶从序列起点计数, 550 天暖机会使桶相位偏离 TV 全历史对齐
    (600519 实测: 日线 K2 1179.26 vs 全历史 1166.73, 熊线 1290.58 vs
    1290.59); 主 /daily 端点传 True, /daily/latest 高频路径保持 550 天。
    split_map: 送转复权链 (_split_factor_map 结果) — warmup 历史在 raw
    换算后同口径按送转链缩放, 保证递推序列与 TV 开 ADJ 口径一致。
    """
    if not rows:
        return rows
    # 直调端点 (测试) 时 FastAPI Query 默认对象会漏进来 — 与 _resolve_plus_lookback 同款净化
    if ry_bar_minutes is not None and not isinstance(ry_bar_minutes, int):
        ry_bar_minutes = None
    if agg:
        return _attach_plus_with_agg_history(
            repo, asset_type, symbol, rows, lookback=lookback,
            ry_bar_minutes=ry_bar_minutes, agg=agg, raw_mode=raw_mode,
            split_map=split_map,
        )
    # 日K (非 agg 非 4h): K2/K3 走 TV 高周期换算 (K2="4D" 连续 4 交易日桶 /
    # K3="1W" 自然周 — Pine request.security 语义); 4h/分钟周期传 ry_bar_minutes
    # (<1440) 走 rymain 分钟桶分支, tf_minutes 不参与
    is_minute_bar = isinstance(ry_bar_minutes, int) and ry_bar_minutes < 1440
    tf_minutes: Optional[int] = None if is_minute_bar else 1440
    warmup: list[float | None] = []
    warmup_rows: list[dict] = []
    try:
        first = rows[0].get("date")
        first_d = first if isinstance(first, date) else date.fromisoformat(str(first)[:10])
        hist = _read_daily_warmup(
            repo, asset_type, symbol,
            first_d - timedelta(days=_PLUS_WARMUP_DAYS), first_d - timedelta(days=1),
            ["date", "close"], raw_mode,
        )
        hist_dicts = hist.to_dicts()
        if raw_mode:
            # raw 口径 warmup: close ← raw_close (缺列/None 保持原值)
            for r in hist_dicts:
                rc = r.get("raw_close")
                if rc is not None:
                    r["close"] = rc
        if split_map:
            _to_split_ohlcv(hist_dicts, split_map)
        warmup = [float(r["close"]) if r.get("close") is not None else None for r in hist_dicts]
    except Exception:  # noqa: BLE001 — 预热读失败退化为窗口内递推
        logger.debug("plus warmup 读取失败 %s", symbol, exc_info=True)
    try:
        first = rows[0].get("date")
        first_d = first if isinstance(first, date) else date.fromisoformat(str(first)[:10])
        ry_start = date(1990, 1, 1) if ry_full_history else first_d - timedelta(days=_RY_WARMUP_DAYS)
        hist2 = _read_daily_warmup(
            repo, asset_type, symbol,
            ry_start, first_d - timedelta(days=1),
            ["date", "open", "high", "low", "close", "volume"], raw_mode,
        )
        warmup_rows = hist2.to_dicts()
        if raw_mode:
            _to_raw_ohlcv(warmup_rows)
        if split_map:
            _to_split_ohlcv(warmup_rows, split_map)
    except Exception:  # noqa: BLE001
        logger.debug("ry warmup 读取失败 %s", symbol, exc_info=True)
    attach_plus_indicators(rows, warmup_closes=warmup, lookback=lookback)
    attach_ry_main(rows, warmup_rows=warmup_rows, bar_minutes=ry_bar_minutes, tf_minutes=tf_minutes)
    return rows


def _attach_plus_with_agg_history(
    repo, asset_type: str, symbol: str, rows: list[dict],
    lookback: int, ry_bar_minutes: Optional[int], agg: str,
    raw_mode: bool = False,
    split_map: Optional[dict] = None,
) -> list[dict]:
    """    agg 模式附着: 指标画在聚合 K 上 (Pine 周期语义), 对齐 TV 全历史递推。

    rows 为窗口内原始日K行 (端点层不预聚合)。warmup 拉全历史原始日K
    (截止窗口首日前一日), 与窗口行拼接后一次性聚合:
    - 递推深度对齐 TV 全历史口径 — EMA110 (融易牛熊) 周线需 ~110 根、
      月线需上市以来全部月K; 按日历天数取 warmup 在聚合后根数不足
      (550 天 → 周线仅 ~76 根/月线 ~18 根), 会产生数十元的系统性偏差
      (实测周线牛线差 56 元 / 月线大量字段 null);
    - 桶边界从全历史起点连续计数 — 2d/4d 的计数分组不再依赖窗口起点,
      主请求与「往左加载更多」跨页桶边界稳定一致。
    在完整聚合序列上附着指标后, 切出窗口首日所在桶起的聚合 K 返回
    (窗口首日所在桶可能含窗口前数据 — 跨界桶, 与 TV 全历史分桶一致)。
    K2/K3 桶语义: _AGG_TF_MINUTES[agg] → rymain TV 高周期换算 (Pine
    request.security + f_resolveDynamicTimeframe: 周线 K2="4W" K3="2M" 等)。
    raw_mode: 不复权模式 — warmup 全历史同口径换算 (窗口行已在端点层
    换算), 聚合与递推全部在 raw 序列上进行。
    split_map: 送转复权链 — warmup 在 raw 换算后按送转链缩放 (与窗口行
    端点层处理同口径), 聚合与递推在送转复权序列上进行 (TV 开 ADJ 口径)。
    全历史读取失败时退化为窗口内聚合递推 (数值可用, 前期偏差)。
    """
    first = rows[0].get("date")
    first_d = first if isinstance(first, date) else date.fromisoformat(str(first)[:10])
    hist_rows: list[dict] = []
    try:
        hist = _read_daily_warmup(
            repo, asset_type, symbol, date(1990, 1, 1), first_d - timedelta(days=1),
            ["date", "open", "high", "low", "close", "volume"], raw_mode,
        )
        hist_rows = hist.to_dicts()
        if raw_mode:
            _to_raw_ohlcv(hist_rows)
        if split_map:
            _to_split_ohlcv(hist_rows, split_map)
    except Exception:  # noqa: BLE001 — 全历史读失败退化为窗口内聚合
        logger.debug("agg warmup 全历史读取失败 %s", symbol, exc_info=True)
    # 拼接后一次性聚合 (窗口行可能带 is_live/指标列, 聚合函数只认 OHLCV/date)
    agg_rows = _resample_daily_rows(hist_rows + list(rows), agg)
    # 定位窗口首日所在桶 (桶按日期升序; 取桶首日 <= first_d 的最后一个桶)
    win_idx = 0
    for i, r in enumerate(agg_rows):
        if str(r["date"])[:10] <= str(first_d)[:10]:
            win_idx = i
        else:
            break
    # 完整聚合序列上附着 (warmup 已并入序列, 前置递推传空);
    # is_live 继承已由 _resample_daily_rows 处理 (末根活动桶保留实时标记)
    attach_plus_indicators(agg_rows, warmup_closes=[], lookback=lookback)
    attach_ry_main(agg_rows, warmup_rows=[], bar_minutes=ry_bar_minutes,
                   tf_minutes=_AGG_TF_MINUTES.get(agg))
    return agg_rows[win_idx:]


def _attach_ext(resp: dict, repo, symbol: str, ext_columns: Optional[str]) -> dict:
    """按 ext_columns 规格为单只股票 LEFT JOIN 扩展数据，平铺到 stock_info['ext']。

    key 形如 "{config_id}__{field_name}"，与自选列表 enriched 接口保持一致。
    委托 screener._load_ext_value_maps 取值: 复用其 (路径,mtime) 签名缓存,
    个股弹窗每秒重拉时不再重复读 ext parquet; 任何 ext 表/字段缺失都静默跳过。
    """
    if not ext_columns or not ext_columns.strip():
        return resp

    specs: list[tuple[str, str]] = []
    for part in ext_columns.split(","):
        part = part.strip()
        if "." not in part:
            continue
        config_id, field_name = part.split(".", 1)
        config_id, field_name = config_id.strip(), field_name.strip()
        if config_id and field_name and is_valid_ext_ident(config_id):
            specs.append((config_id, field_name))
    if not specs:
        return resp

    try:
        from app.api.screener import _load_ext_value_maps
        value_maps = _load_ext_value_maps(repo, ext_columns)
    except Exception:  # noqa: BLE001
        value_maps = {}

    ext_values: dict = {}
    for config_id, field_name in specs:
        ext_col_name = f"{config_id}__{field_name}"
        vmap = value_maps.get(ext_col_name) or {}
        ext_values[ext_col_name] = vmap.get(symbol)

    stock_info = dict(resp.get("stock_info") or {})
    stock_info["ext"] = ext_values
    resp["stock_info"] = stock_info
    return resp


def _latest_live_candle(
    request: Request,
    symbol: str,
    asset_type: str = "stock",
    *,
    refresh_asset: bool = True,
) -> dict | None:
    """从内存缓存读取单只标的的当日实时 enriched 行。"""

    if asset_type == "stock":
        qs = getattr(request.app.state, "quote_service", None)
        if not qs:
            return None
        df_today, enriched_date = qs.get_enriched_today()
    elif asset_type in {"etf", "index"}:
        df_today, enriched_date = request.app.state.repo.get_enriched_latest_asset(
            asset_type, refresh=refresh_asset,
        )
    else:
        return None
    if df_today.is_empty():
        return None

    # 非交易日(周末/假日)缓存日期 != 北京今天, 跳过注入避免产生重复蜡烛。
    # 必须用 cn_today(): 美洲时区主机整个 A 股交易时段本地日期落后北京一天,
    # 旧代码盘中直接丢K。UTC 主机盘中(UTC 1:30-7:00)本地日期与北京相同, 并不丢K;
    # UTC 的旧症状是北京 00:00-08:00 把昨日残留快照误当实时K注入。
    if not enriched_date or enriched_date != cn_today():
        return None

    # 查找该 symbol 的实时 enriched 行
    import polars as pl
    try:
        q = df_today.filter(pl.col("symbol") == symbol).to_dicts()
        if not q:
            return None
        q = q[0]
    except Exception:
        return None

    close_price = q.get("close")
    if not close_price or close_price <= 0:
        return None

    # 沿用完整日K接口原有的实时行投影, 避免增量接口形成第二套字段契约。
    # API 在非交易时段可能返回 open/high/low=0, 用 close 填充避免异常蜡烛。
    # is_live 仅在实时窗口内标记 (第 37 轮): 收盘后行仍注入 (当日收盘价有效),
    # 但不再标实时 — 与分钟周期注入口径对齐, 前端 ● 徽记收盘后一致消失。
    raw_open = q.get("open")
    raw_high = q.get("high")
    raw_low = q.get("low")
    live_row = {
        "date": str(enriched_date),
        "symbol": symbol,
        "open": raw_open if raw_open and raw_open > 0 else close_price,
        "high": raw_high if raw_high and raw_high > 0 else close_price,
        "low": raw_low if raw_low and raw_low > 0 else close_price,
        "close": close_price,
        "volume": q.get("volume"),
        "amount": q.get("amount"),
        "change_pct": q.get("change_pct"),
        # is_live 仅在实时窗口内标记 (第 37 轮): 收盘后行仍注入 (当日收盘价有效),
        # 但不再标实时 — 与分钟周期注入口径对齐, 前端 ● 徽记收盘后一致消失。
        "is_live": _live_quote_window_open(),
    }
    for key in ("ma5", "ma10", "ma20", "ma30", "ma60",
                "macd_dif", "macd_dea", "macd_hist",
                "kdj_k", "kdj_d", "kdj_j",
                "boll_upper", "boll_lower",
                "rsi_6", "rsi_14", "rsi_24",
                "atr_14", "vol_ratio_5d"):
        if key in q and q[key] is not None:
            live_row[key] = q[key]
    return live_row


def _maybe_inject_live_candle(request: Request, symbol: str, rows: list[dict], asset_type: str = "stock") -> list[dict]:
    """如果有当日实时 enriched 数据, 用实时数据生成今日蜡烛并追加/覆盖。"""
    live_row = _latest_live_candle(request, symbol, asset_type)
    if live_row is None:
        return rows

    # 如果已有今天的 enriched 行, 覆盖; 否则追加
    found = False
    for r in rows:
        if str(r.get("date")) == live_row["date"]:
            r.update(live_row)
            found = True
            break

    if not found:
        rows.append(live_row)

    return rows


# A 股连续竞价两段时段 (墙钟): 09:30-11:30 / 13:00-15:00, 分钟桶对齐段内起点。
_SESSIONS_MINUTES: tuple[tuple[int, int], ...] = ((9 * 60 + 30, 11 * 60 + 30), (13 * 60, 15 * 60))


def _live_quote_window_open(now: datetime | None = None) -> bool:
    """日级行实时标记窗口 (第 37 轮): 工作日 09:15–15:05 (含集合竞价与收盘定版缓冲)。

    is_live 语义 = 「该行价格正在实时变动」。旧实现不判时段: 收盘后当日 enriched
    快照仍在 → 4h/1d/2d/4d/1w/1M 全部标 is_live=true → 前端 ● 徽记收盘后残留,
    而分钟周期 (intraday 注入判时段) 已回落 → 用户观察到「有些时间级别有小圈点
    有些没有」。行本身收盘后仍注入 (当日完整收盘价有效), 只是不再标记实时。
    节假日由 enriched_date == cn_today() 新鲜度判据兑底 (非交易日快照被上游拒绝)。
    """
    n = now or cn_now()
    if n.weekday() >= 5:
        return False
    t = n.hour * 60 + n.minute
    return 9 * 60 + 15 <= t < 15 * 60 + 5


def _current_intraday_bucket_start(minutes: int, now: datetime | None = None) -> datetime | None:
    """当前分钟桶的开始时刻 (A 股两段时段内按 minutes 对齐); 非连续竞价时段返回 None。

    第 35 轮 (2026-10-26): intraday (15m/60m) 实时快照注入用 — 判断末根 bar
    是否为当前进行中的桶。边界取半开区间 [s, e): 恰在 11:30/15:00 的整点
    (上段刚结束) 不属于任何段 → None, 避免算出不存在的 11:30/15:00 起始桶。
    """
    now = now or cn_now()
    now_min = now.hour * 60 + now.minute
    for s, e in _SESSIONS_MINUTES:
        if s <= now_min < e:
            start = s + (now_min - s) // minutes * minutes
            return now.replace(hour=start // 60, minute=start % 60, second=0, microsecond=0)
    return None


def _inject_intraday_live(
    bars: list[dict],
    minutes: int,
    live_row: dict | None,
    now: datetime | None = None,
) -> list[dict]:
    """把日线实时快照并入 intraday bars 的当前桶 (第 35 轮, TV 同款 ● 徽记语义)。

    用户复测: 15分/1小时 周期现价标签无 ● 实时徽记 — 根因 get_intraday 不注入
    实时行, 末根收盘停留在本地分钟K上次落盘轮 (≥60s 轮次)。日线源周期
    (4h/1d/2d/4d/1w/1M) 经 _maybe_inject_live_candle 有 is_live, 口径不一致。

    规则 (非连续竞价时段/无实时数据/实时价无效 → 原样返回):
    - 末根 = 当前桶: close 并实时价, high/low 取极值, is_live=True;
      open/volume/amount 不动 (桶内首笔已定; 日线累计量 ≠ 桶量)。
    - 末根 ≠ 当前桶 (落盘滞后/盘初): 追加退化实时桶 O=H=L=C=实时价 (TV 盘初同款),
      历史桶不标记。注入在 attach_intraday_plus 之前调用 → 指标覆盖实时行。
    """
    if not live_row:
        return bars
    price = live_row.get("close")
    if not price or price <= 0:
        return bars
    cur_bucket = _current_intraday_bucket_start(minutes, now)
    if cur_bucket is None:
        return bars
    cur_key = cur_bucket.strftime("%Y-%m-%d %H:%M")
    if bars and str(bars[-1]["date"]) == cur_key:
        b = bars[-1]
        b["close"] = price
        hi = b.get("high")
        lo = b.get("low")
        b["high"] = max(hi if hi is not None else price, price)
        b["low"] = min(lo if lo is not None else price, price)
        b["is_live"] = True
    else:
        # 末根不是当前桶 (落盘滞后/隔夜/盘初) → 追加今天的退化实时桶;
        # 与末根是否同日无关 — 只要当前桶存在且末根不是它就追加。
        bars.append({
            "date": cur_key,
            "open": price, "high": price, "low": price, "close": price,
            "volume": None, "amount": None,
            "is_live": True,
        })
    return bars


@router.get("/daily/latest")
def get_daily_latest(
    request: Request,
    symbol: str = Query(..., description="标的代码,如 000001.SZ"),
    plus_lookback: Optional[int] = Query(
        None, ge=1, le=500,
        description="私有指标量级缩放窗口 (默认 50=日K档; 4h 周期客户端传 160)",
    ),
    ry_bar_minutes: Optional[int] = Query(
        None, ge=1, le=1440,
        description="融易 K2/K3 桶语义输入周期分钟数 (4h 面板实时行传 240)",
    ),
):
    """返回内存中的当日单行 K 线, 供详情页实时增量更新。"""
    repo = request.app.state.repo
    asset_type = repo.resolve_asset_type(symbol)
    row = _latest_live_candle(request, symbol, asset_type, refresh_asset=False)
    if row is not None:
        # 私有化指标 (MACD+/RSI+): 单行无法递推, 用带历史 warmup 的附着让末行
        # plus 值随行情刷新 (与 get_daily 同口径同预热)。
        try:
            _attach_plus_with_warmup(repo, asset_type, symbol, [row], lookback=_resolve_plus_lookback(plus_lookback), ry_bar_minutes=ry_bar_minutes)
        except Exception:  # noqa: BLE001 — 历史读失败时实时行退化为无 plus 字段
            logger.debug("daily/latest plus 指标重算失败 %s", symbol, exc_info=True)
    return {
        "symbol": symbol,
        "row": row,
        "source": "live" if row is not None else "none",
    }


class DailyBatchRequest:
    """批量日K请求。"""
    symbols: list[str]
    days: int = 12


@router.post("/daily-batch")
def get_daily_batch(request: Request, body: dict):
    """批量获取多只股票最近 N 天日K (OHLCV)。

    用于自选列表迷你蜡烛图等场景，只返回基础列，不返回全部 enriched 指标。
    """
    symbols = body.get("symbols", [])
    days = body.get("days", 12)
    if not symbols:
        return {"data": {}}
    days = max(5, min(60, days))

    repo = request.app.state.repo
    from datetime import timedelta

    import polars as pl

    # 窗口右端必须是北京今天: QuoteService 当日 flush 的分区日期是北京交易日。
    # 美西主机整个 A 股交易时段、UTC 主机北京 00:00-08:00, date.today() 比北京早一天,
    # 迷你蜡烛会把当日实时 K 排除在窗口外。
    end = cn_today()
    start = end - timedelta(days=days * 2)  # 多取一些确保交易日够

    cols = ["symbol", "date", "open", "high", "low", "close", "volume"]

    # 按资产类型分组: stock 走批量缓存; etf/index 逐只查独立存储 (数量少, 成本可忽略)
    stock_symbols: list[str] = []
    etf_symbols: list[str] = []
    index_symbols: list[str] = []
    for s in symbols:
        t = repo.resolve_asset_type(s)
        if t == "etf":
            etf_symbols.append(s)
        elif t == "index":
            index_symbols.append(s)
        else:
            stock_symbols.append(s)

    frames: list[pl.DataFrame] = []
    if stock_symbols:
        df_stock = repo.get_daily_batch(stock_symbols, start, end, columns=cols)
        if not df_stock.is_empty():
            frames.append(df_stock)
    for sym in etf_symbols:
        sub = repo.get_etf_daily(sym, start, end, columns=cols)
        if not sub.is_empty():
            frames.append(sub)
    for sym in index_symbols:
        sub = repo.get_index_daily(sym, start, end, columns=cols)
        if not sub.is_empty():
            frames.append(sub)

    if not frames:
        return {"data": {}}
    df = pl.concat(frames, how="diagonal_relaxed")

    # 按 symbol 分组, 每只取最近 N 条。
    # partition_by 一次切分, 避免 N 只自选时对同一批数据做 N 次全帧过滤。
    result: dict[str, list[dict]] = {}
    for part in df.partition_by("symbol", maintain_order=True):
        sub = part.sort("date").tail(days)
        if not sub.is_empty():
            result[sub["symbol"][0]] = sub.to_dicts()

    # 日K批量同为大响应端点 (千只自选 MB 级), 与分时各自独立压缩开关
    return _gzip_payload(request, {"data": result}, pref_key="daily_batch_compress")


@router.post("/minute-batch")
def get_minute_batch(request: Request, body: dict):
    """批量获取多只股票某天的分钟K (分时图用)。

    - 本地优先: 先从 kline_minute parquet 读, 完整的直接用
    - 缺失补拉: 本地不完整的 symbol 用 sync_minute_batch 批量实时拉 (不落库)
    - 需 Pro+ 权限 (kline.minute.batch)
    """
    from datetime import datetime

    import polars as pl

    from app.tickflow.capabilities import Cap

    symbols: list[str] = body.get("symbols", [])
    trade_date_str: str | None = body.get("date")
    # 增量响应: since (ISO datetime) 之前的K不回传, 客户端本地缓存合并。
    # since 应传客户端已持有的最后一根时间 — 形成中的动态K >= since, 每轮覆盖。
    since_str = body.get("since")
    since_dt: datetime | None = None
    if since_str:
        try:
            since_dt = datetime.fromisoformat(str(since_str))
            # 防御: 带 Z/偏移的 aware 输入 (如 toISOString) → 转北京墙钟再去 tz,
            # 否则与行里的 naive 北京时间比较会 TypeError 且差 8 小时
            if since_dt.tzinfo is not None:
                since_dt = since_dt.astimezone(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
        except ValueError:
            since_dt = None
    # 自选分时本地优先标志: 全量分钟服务健康时, 股票缺口不再批量补拉
    # (本地分区由服务按间隔持续写入, 下一轮自然补全; 停牌/临停票补拉也是空, 无损)。
    # ETF 不在全量分钟 universe 内, 恒走补拉。服务不健康时回落现状补拉兜底。
    prefer_local = bool(body.get("prefer_local", False))
    if not symbols:
        return {"data": {}}

    repo = request.app.state.repo
    capset = request.app.state.capabilities

    # 权限守卫: 分钟K批量是 Pro+ 能力
    if not capset.has(Cap.KLINE_MINUTE_BATCH):
        raise HTTPException(status_code=403, detail="需要 Pro+ 权限 (kline.minute.batch)")

    trade_date = date.fromisoformat(trade_date_str) if trade_date_str else cn_today()

    # 非交易日(周末/节假日)才回退到最近有数据的交易日; 否则盘中会显示昨天而非今天。
    # 判据: 周末必回退; 工作日收盘后(>=15:30)仍无今日日K → 节假日, 回退。
    # (下方补拉已改为取到即落盘, 但只有真实交易时段才会写入当日分区,
    #  节假日当日分区恒为空, 不影响该回退判据。)
    if not trade_date_str:
        today = cn_today()
        # 周六/周日必非交易日; 工作日休市 (国庆等) 以交易日探针的「确定休市」为准,
        # 与 /api/index/minute 同口径 — 未知 (None) 维持下方收盘后判据
        need_fallback = today.weekday() >= 5 or trading_day.is_trading_day() is False
        if not need_fallback:
            now_cn = cn_now()
            after_close = now_cn.hour > 15 or (now_cn.hour == 15 and now_cn.minute >= 30)
            if after_close:
                latest_daily = repo.latest_daily_date()
                if latest_daily is None or latest_daily < today:
                    need_fallback = True
        if need_fallback:
            recent_date = repo.latest_minute_date_global()
            if recent_date is None:
                recent_date = repo.latest_daily_date()
            if recent_date is not None:
                trade_date = recent_date

    # Step 1: 本地优先 — 一次 scan 读全部 symbol 当日分钟K (股票 / ETF 分钟数据分开存储)
    etf_set = repo.get_etf_symbol_set()
    stock_syms = [s for s in symbols if s not in etf_set]
    etf_syms = [s for s in symbols if s in etf_set]
    df_local = repo.get_minute_batch(stock_syms, trade_date)
    if etf_syms:
        df_etf = repo.get_minute_batch(etf_syms, trade_date, asset_type="etf")
        if df_local.is_empty():
            df_local = df_etf
        elif not df_etf.is_empty():
            df_local = pl.concat([df_local, df_etf], how="diagonal_relaxed")

    # 期望条数 (盘中按当前时刻估算, 盘后 240)
    now = cn_now()
    h, m = now.hour, now.minute
    if trade_date != cn_today():
        expected = 240
    elif h < 9 or (h == 9 and m < 30):
        expected = 0
    elif h < 11 or (h == 11 and m <= 30):
        expected = (h - 9) * 60 + m - 30
    elif h < 13:
        expected = 120
    elif h < 15:
        expected = 120 + (h - 13) * 60 + m
    else:
        expected = 240

    # 本地状态分类 (补拉已改为取到即落盘, 完整性判定随之收紧):
    # - fresh:  根数 >= 期望-2 (时间边界容差), 直接用本地。原 0.9 比例阈值会让
    #           持久化数据在 90% 处冻结尾巴, 必须按根数差判。
    # - holes:  缺K → 全天重拉回填, 否则"最后一根+1min"的增量窗口永远不会
    #           回看洞。含两种: 中间的洞 (相邻间距非 1 分钟 / 非午休 91 分钟)
    #           与前部的洞 (首根显著晚于开盘 — 盘中重启/停机跨开盘的残留,
    #           连续的尾部K会被增量锚定锁死, 同样必须全天重拉)。
    # - stale:  仅尾部落后 → 增量拉, 请求量从"每轮全天"降为"每轮一根"量级。
    _LUNCH_GAP_MIN = 91  # 11:30 → 13:01
    # 前部洞基准: 开盘后 6 分钟 (容许无集合竞价K的数据源)。晚开/停牌复牌的票
    # 也会命中 → 全天拉幂等, 至多多一次批量请求, 与中间洞同一代价模型。
    day_open_floor = datetime(trade_date.year, trade_date.month, trade_date.day, 9, 36, 0)

    def _has_holes(sub: pl.DataFrame) -> bool:
        if not sub.is_empty() and sub["datetime"][0] > day_open_floor:
            return True
        gaps = sub["datetime"].diff().dt.total_minutes().drop_nulls()
        return gaps.filter((gaps != 1) & (gaps != _LUNCH_GAP_MIN)).len() > 0

    result: dict[str, list[dict]] = {}
    full_pull: list[str] = []          # 无数据或中间有洞 → 全天拉
    stale_last: dict[str, datetime] = {}  # 尾部落后 → symbol → 最后一根时间
    local_parts: dict[str, pl.DataFrame] = {}
    if not df_local.is_empty():
        for part in df_local.partition_by("symbol", maintain_order=True):
            local_parts[part["symbol"][0]] = part.sort("datetime")
    fresh_floor = max(0, expected - 2)
    for sym in symbols:
        sub = local_parts.get(sym, pl.DataFrame())
        if expected == 0 or sub.height >= fresh_floor:
            if not sub.is_empty():
                result[sym] = sub.to_dicts()
            continue
        if sub.is_empty() or _has_holes(sub):
            full_pull.append(sym)
        else:
            stale_last[sym] = sub["datetime"][-1]

    # prefer_local 生效判定: 仅当全量分钟服务健康 (freshness 契约, 见 minute_refresh.is_healthy)
    full_minute_healthy = False
    if prefer_local:
        svc = getattr(request.app.state, "minute_refresh", None)
        full_minute_healthy = bool(svc is not None and svc.is_healthy())
    if full_minute_healthy:
        # 纯尾部落后 (stale_last): 服务的增量轮下一轮就会补上, 股票不补拉省请求。
        # 空洞 (full_pull: 空分区 / 中间洞 / 前部洞): 服务增量锚定本地最新时间,
        # 永远不会回看洞 → 不压制, 由端点全天拉取并落盘修复。
        # ETF 不在服务 universe 内, 两类均维持补拉。
        for sym in stale_last:
            if sym not in etf_set:
                sub = local_parts.get(sym)
                if sub is not None and not sub.is_empty():
                    result[sym] = sub.to_dicts()
        stale_last = {s: t for s, t in stale_last.items() if s in etf_set}

    # Step 2: 补拉并落盘 (取到即写, upsert 语义; 下一轮命中本地, 请求量骤降)。
    # 落盘失败只降级 (log 后继续返回本轮数据), 不影响响应 —— 持久化是优化而非正确性前提。
    # 契约: 本端点只接受 stock/ETF (指数分钟K走 /api/index/minute 独立路径),
    # 按 asset_type 拆分调用 (自定义源 / TickFlow 路由均依赖 asset_type 正确传递)。
    day_start = datetime(trade_date.year, trade_date.month, trade_date.day, 9, 25, 0)
    session_end = datetime(trade_date.year, trade_date.month, trade_date.day, 15, 5, 0)
    lim = capset.limits(Cap.KLINE_MINUTE_BATCH)
    minute_dirs = {
        "stock": repo.store.data_dir / "kline_minute",
        "etf": repo.store.data_dir / "kline_etf_minute",
    }
    live_map: dict[str, pl.DataFrame] = {}

    def _pull(asset: str, sym_list: list[str], start: datetime) -> None:
        if not sym_list:
            return
        raw_basis = minute_adjust.minute_basis_is_raw(repo.store.data_dir)
        df_live = kline_sync.sync_minute_batch(
            sym_list,
            start_time=start,
            end_time=session_end,
            batch_size=lim.batch if lim else None,
            rpm=lim.rpm if lim else None,
            asset_type=asset,
            raw_basis=raw_basis,
        )
        if df_live.is_empty():
            return
        try:
            # 读-改-写必须持仓库写锁 (与全量分钟服务/盘后同步同一纪律, Windows 临时文件占用)。
            # 仅在拿到真实目录时落盘: data_dir 异常 (非 Path) 时跳过, 只返回本轮数据。
            # 落盘必须是原始口径 (raw_basis=True 时 sync 已按 adjust='none' 取回);
            # 对外响应再统一复权投影。
            minute_dir = minute_dirs[asset]
            if isinstance(minute_dir, Path):
                with repo._write_lock:
                    kline_sync._write_minute_partition(df_live, minute_dir)
        except Exception as e:  # noqa: BLE001
            logger.warning("minute-batch 补拉落盘失败 (降级为仅返回): %s", e)
        if raw_basis:
            df_live = minute_adjust.apply_minute_adjustment(
                df_live, repo.store.data_dir, asset,
            )
        for part in df_live.partition_by("symbol", maintain_order=True):
            live_map[part["symbol"][0]] = part.sort("datetime")

    _pull("stock", [s for s in full_pull if s not in etf_set], day_start)
    _pull("etf", [s for s in full_pull if s in etf_set], day_start)
    if stale_last:
        # 增量公共起点 = 最旧的最后一根本身: 最后一根是形成中的动态K (分钟内
        # 收盘/量/额持续变化), 必须重拉并以定版值覆盖; 重叠由 upsert/合并去重吸收
        inc_start = min(stale_last.values())
        if inc_start < session_end:
            _pull("stock", [s for s in stale_last if s not in etf_set], inc_start)
            _pull("etf", [s for s in stale_last if s in etf_set], inc_start)

    # 合并: 有增量/回填的 symbol = 本地 + 拉取 upsert; 仅拉到的 (missing) 直接进结果
    for sym, sub in local_parts.items():
        live = live_map.get(sym)
        if live is not None:
            merged = (
                pl.concat([sub, live])
                .unique(subset=["symbol", "datetime"], keep="last")
                .sort("datetime")
            )
            result[sym] = merged.to_dicts()
    for sym, live in live_map.items():
        if sym not in result:
            result[sym] = live.to_dicts()

    # since 增量过滤: 只回 >= since 的K (含动态最后一根), 无新增的 symbol 不回
    if since_dt is not None:
        result = {
            sym: [r for r in rows if r["datetime"] >= since_dt]
            for sym, rows in result.items()
        }
        result = {sym: rows for sym, rows in result.items() if rows}

    return _gzip_payload(
        request,
        {
            "data": result,
            "full_minute_local": full_minute_healthy,
            "incremental": since_dt is not None,
        },
        pref_key="minute_batch_compress",
    )


@router.get("/minute-range")
def get_minute_range(
    request: Request,
    symbol: str = Query(..., description="标的代码"),
    days: int = Query(10, ge=1, le=60, description="最近交易日数量（图表工作台多周期原料 60 日上限）"),
):
    """读取单只标的最近 N 个已落库交易日的分钟 K。"""
    import polars as pl

    repo = request.app.state.repo
    asset_type = repo.resolve_asset_type(symbol)
    stock_info = (
        _get_stock_info(repo, symbol)
        if asset_type == "stock"
        else _get_asset_info(repo, symbol, asset_type)
    )
    base_response = {
        "symbol": symbol,
        "name": stock_info.get("name"),
        "asset_type": asset_type,
        "requested_days": days,
    }

    # 指数分钟 K 不落本地仓库, 最新分时仍由 /api/index/minute 实时读取。
    if asset_type == "index":
        return _gzip_payload(
            request,
            {**base_response, "sessions": [], "source": "none"},
            pref_key="minute_batch_compress",
        )

    end = cn_today()
    start = end - timedelta(days=days * 3 + 20)
    minute = repo.get_minute_range([symbol], start, end, asset_type=asset_type)
    if minute.is_empty() or "datetime" not in minute.columns:
        return _gzip_payload(
            request,
            {**base_response, "sessions": [], "source": "none"},
            pref_key="minute_batch_compress",
        )

    minute = minute.with_columns(
        pl.col("datetime").dt.date().alias("_trade_date"),
    )
    trade_dates = sorted(minute["_trade_date"].unique().to_list())[-days:]
    previous_closes = _get_previous_closes(repo, symbol, trade_dates, asset_type)
    row_columns = [
        column
        for column in (
            "datetime", "open", "high", "low", "close", "volume", "amount"
        )
        if column in minute.columns
    ]
    sessions = []
    for trade_date in trade_dates:
        rows = (
            minute.filter(pl.col("_trade_date") == trade_date)
            .sort("datetime")
            .select(row_columns)
            .to_dicts()
        )
        if rows:
            sessions.append({
                "date": trade_date.isoformat(),
                "prev_close": previous_closes.get(trade_date),
                "rows": rows,
            })

    return _gzip_payload(
        request,
        {
            **base_response,
            "sessions": sessions,
            "source": "local" if sessions else "none",
        },
        pref_key="minute_batch_compress",
    )


@router.get("/intraday")
def get_intraday(
    request: Request,
    symbol: str = Query(..., description="标的代码"),
    period: str = Query(..., description="聚合周期: 15m | 60m"),
    days: int = Query(60, ge=1, le=60, description="最近交易日数量 (与 minute-range 同上限)"),
    adjust: Optional[str] = Query(
        None, description="复权方式: qfq(前复权,默认) | raw(不复权 — 跳过分钟读取时复权投影, 原始价)",
    ),
):
    """图表工作台分钟聚合周期K (15m/60m) + 私有指标 (MACD+/RSI+) 服务端附着。

    私有化收口 (2026-10-14): MACD+/RSI+ 算法全部在服务端计算, 聚合口径与
    迁移前前端实现逐字段一致 (见 indicators/intraday.py 模块注释)。
    bars 的 date 标签 = "YYYY-MM-DD HH:mm" (桶内首根时间, 开始时刻语义)。
    adjust=raw: 分钟存储为 qfq 基准 (无 raw 列, marker 未迁移) → 按交易日
    日K行级比例 (raw_close/close) 反推原始价, 指标在 raw 序列上重算
    (与 /daily raw 模式同口径; 比例缺失的日期保持原值)。
    """
    import polars as pl

    minutes = {"15m": 15, "60m": 60}.get(period)
    if minutes is None or minutes not in INTRADAY_PERIODS:
        raise HTTPException(status_code=400, detail="period 仅支持 15m | 60m")
    # 直调端点 (测试/内部调用) 时 FastAPI Query 默认对象会漏进来 — 同 get_daily 净化
    if adjust is not None and not isinstance(adjust, str):
        adjust = None
    if adjust is None:
        adjust = "qfq"
    if adjust not in _ADJUST_MODES:
        raise HTTPException(status_code=400, detail="adjust 仅支持 qfq | raw")
    raw_mode = adjust == "raw"

    repo = request.app.state.repo
    asset_type = repo.resolve_asset_type(symbol)
    stock_info = (
        _get_stock_info(repo, symbol)
        if asset_type == "stock"
        else _get_asset_info(repo, symbol, asset_type)
    )
    base_response = {
        "symbol": symbol,
        "name": stock_info.get("name"),
        "asset_type": asset_type,
        "period": period,
        "requested_days": days,
    }

    # 指数分钟 K 不落本地仓库 (与 minute-range 同口径)
    if asset_type == "index":
        return _gzip_payload(
            request,
            {**base_response, "bars": [], "source": "none"},
            pref_key="minute_batch_compress",
        )

    end = cn_today()
    # 取数窗口 ×7+30 日历日 (~300 交易日): SuperTrend 棘轮/EMA110 等长记忆递推
    # 指标需全历史口径对齐 TV (2026-10-22 600519 分钟K已扩至 2025-08 起;
    # 窗口内有什么用什么, 其他标的自动退化为存量深度)
    start = end - timedelta(days=days * 7 + 30)
    minute = repo.get_minute_range([symbol], start, end, asset_type=asset_type,
                                   apply_adjust=not raw_mode)
    if minute.is_empty() or "datetime" not in minute.columns:
        return _gzip_payload(
            request,
            {**base_response, "bars": [], "source": "none"},
            pref_key="minute_batch_compress",
        )
    minute = minute.with_columns(pl.col("datetime").dt.date().alias("_trade_date"))
    trade_dates = sorted(minute["_trade_date"].unique().to_list())
    row_columns = [
        column
        for column in ("datetime", "open", "high", "low", "close", "volume", "amount")
        if column in minute.columns
    ]
    rows = (
        minute.sort("datetime")
        .select(row_columns)
        .to_dicts()
    )

    # raw 模式: 分钟存储为 qfq 基准 → 按交易日日K行级比例 (raw_close/close)
    # 反推原始价 (指标随后在 raw 序列上聚合重算); 比例缺失的日期保持原值。
    if raw_mode and asset_type == "stock" and trade_dates:
        ratio_map = _daily_raw_ratio_map(repo, symbol, trade_dates[0], trade_dates[-1])
        if ratio_map:
            for r in rows:
                ratio = ratio_map.get(str(r.get("datetime"))[:10])
                if ratio is not None and ratio != 1:
                    for f_ in ("open", "high", "low", "close"):
                        v = r.get(f_)
                        if v is not None:
                            r[f_] = v * ratio

    # 结束时刻 → 开始时刻语义换算 → 时段切桶聚合 → 私有指标附着
    rows = to_minute_start_semantics(rows)
    all_bars = resample_minutes(rows, minutes)

    # warmup 收敛 (2026-10-22 二次校准): 全窗口聚合, 末 days 交易日为返回段,
    # 更早 bars 作递推 warmup — EMA110(牛熊)/ATR50/RSI 是长记忆递推指标,
    # 只在返回窗口内递推会带起点瞬态 (60 交易日≈237 根 60m bars 时牛熊通道
    # 与 TV 全历史口径差 ~1.5 元); warmup 段让瞬态在窗口前衰减。
    if len(trade_dates) > days:
        cutoff = trade_dates[-days].isoformat()
        warmup_bars = [b for b in all_bars if str(b["date"])[:10] < cutoff]
        bars = [b for b in all_bars if str(b["date"])[:10] >= cutoff]
    else:
        warmup_bars, bars = [], all_bars
    # 实时快照注入当前桶 (第 35 轮): 15m/60m 现价标签 ● 徽记与日线源周期同口径 —
    # 末根收盘并实时价 (本地分钟K ≥60s 轮次滞后), is_live 标记走前端 ● 徽记;
    # 注入先于 attach, 指标 (MACD+/RSI+) 覆盖实时行。前端 15s 轮询 → 标签 ≤15s 步进。
    live_row = _latest_live_candle(request, symbol, asset_type)
    if live_row is not None:
        bars = _inject_intraday_live(bars, minutes, live_row)
    attach_intraday_plus(bars, minutes, warmup_bars=warmup_bars)

    return _gzip_payload(
        request,
        {
            **base_response,
            "bars": bars,
            "source": "local" if bars else "none",
        },
        pref_key="minute_batch_compress",
    )


@router.get("/minute")
def get_minute(
    request: Request,
    symbol: str = Query(..., description="标的代码"),
    trade_date: date | None = Query(None, alias="date", description="交易日期, 默认最新"),
    live: bool = Query(False, description="当日盘中跳过本地优先, 直接实时拉取(个股详情分时轮询用)"),
):
    """读取某只股票某天的分钟 K 线。

    - 本地有完整数据(240条) → 直接返回
    - 本地无数据或不完整 → 从有效分钟数据源实时拉取返回(不写入)
    - 自定义源失败时, 仅具备 TickFlow 单股分钟能力才回退 TickFlow
    - live=true 且当日连续竞价时段 → 跳过本地优先直接实时拉取:
      盘中分钟增量落盘的本地分区按 ≥60s 轮次更新, 90% 完整度启发式会让
      详情分时图停在上一增量轮, 与行情列表的节奏脱节
    """
    repo = request.app.state.repo
    capset = request.app.state.capabilities
    raw_basis = minute_adjust.minute_basis_is_raw(repo.store.data_dir)
    asset_type = repo.resolve_asset_type(symbol)
    stock_info = _get_stock_info(repo, symbol) if asset_type == "stock" else _get_asset_info(repo, symbol, asset_type)
    stock_name = stock_info.get("name")

    if trade_date is None:
        # 默认看今天, 而不是本地落盘的最近日 (盘中后者是昨天)。
        # 非交易日(周末/节假日)才回退到本地最近有数据的交易日。
        today = cn_today()
        # 同 /minute-batch: 周末必回退, 工作日休市以交易日探针「确定休市」为准
        need_fallback = today.weekday() >= 5 or trading_day.is_trading_day() is False
        if not need_fallback:
            now_cn = cn_now()
            after_close = now_cn.hour > 15 or (now_cn.hour == 15 and now_cn.minute >= 30)
            if after_close:
                latest_daily = repo.latest_daily_date()
                if latest_daily is None or latest_daily < today:
                    need_fallback = True
        if need_fallback:
            recent = repo.latest_minute_date(symbol, asset_type=asset_type)
            if recent is None:
                recent = repo.latest_daily_date()
            trade_date = recent if recent is not None else today
        else:
            trade_date = today
    if trade_date is None:
        # 本地无任何分钟K, 尝试从当前有效分钟源拉取当天
        trade_date = cn_today()
        df = kline_sync.fetch_minute_single(
            symbol, trade_date, asset_type=asset_type, capset=capset,
            raw_basis=raw_basis,
        )
        if raw_basis:
            df = minute_adjust.apply_minute_adjustment(df, repo.store.data_dir, asset_type)
        price_limit = _get_price_limit_info(
            repo, symbol, trade_date, asset_type, stock_name,
        )
        prev_close = _get_previous_closes(
            repo, symbol, [trade_date], asset_type,
        ).get(trade_date)
        return _gzip_payload(
            request,
            {
                "symbol": symbol, "name": stock_name, "stock_info": stock_info,
                "date": str(trade_date), "rows": df.to_dicts(),
                "source": "live" if not df.is_empty() else "none",
                "asset_type": asset_type,
                "price_limit": price_limit,
                "prev_close": prev_close,
            },
            pref_key="minute_batch_compress",
        )

    prev_close = _get_previous_closes(
        repo, symbol, [trade_date], asset_type,
    ).get(trade_date)
    price_limit = _get_price_limit_info(
        repo, symbol, trade_date, asset_type, stock_name,
    )

    if live and trade_date == cn_today() and in_continuous_session():
        # 详情分时轮询: 当日盘中实时拉取最新一根K, 不落盘; 拉空(源侧延迟/
        # 时段边界)则落回下方本地优先路径。
        live_df = kline_sync.fetch_minute_single(
            symbol, trade_date, asset_type=asset_type, capset=capset,
            raw_basis=raw_basis,
        )
        if not live_df.is_empty():
            if raw_basis:
                live_df = minute_adjust.apply_minute_adjustment(
                    live_df, repo.store.data_dir, asset_type,
                )
            return _gzip_payload(
                request,
                {
                    "symbol": symbol, "name": stock_name, "stock_info": stock_info,
                    "date": str(trade_date), "rows": live_df.to_dicts(),
                    "source": "live", "asset_type": asset_type,
                    "price_limit": price_limit, "prev_close": prev_close,
                },
                pref_key="minute_batch_compress",
            )

    df = repo.get_minute(symbol, trade_date, asset_type=asset_type)

    # 完整交易日应有 240 条分钟K；如果是今天(盘中)，期望条数按已交易分钟估算
    expected = 240
    today = cn_today()
    if trade_date == today:
        now = cn_now()
        h, m = now.hour, now.minute
        if h < 9 or (h == 9 and m < 30):
            expected = 0  # 还没开盘
        elif h < 11 or (h == 11 and m <= 30):
            expected = (h - 9) * 60 + m - 30  # 9:30 起
        elif h < 13:
            expected = 120  # 午休
        elif h < 15:
            expected = 120 + (h - 13) * 60 + m
        else:
            expected = 240

    is_complete = not df.is_empty() and len(df) >= expected * 0.9  # 允许 10% 容差

    if is_complete:
        return _gzip_payload(
            request,
            {
                "symbol": symbol, "name": stock_name, "stock_info": stock_info,
                "date": str(trade_date), "rows": df.to_dicts(), "source": "local",
                "asset_type": asset_type,
                "price_limit": price_limit,
                "prev_close": prev_close,
            },
            pref_key="minute_batch_compress",
        )

    # 本地不完整或无数据 → 从当前有效分钟源实时拉取
    live_df = kline_sync.fetch_minute_single(
        symbol, trade_date, asset_type=asset_type, capset=capset,
        raw_basis=raw_basis,
    )
    if raw_basis and not live_df.is_empty():
        live_df = minute_adjust.apply_minute_adjustment(
            live_df, repo.store.data_dir, asset_type,
        )
    return _gzip_payload(
        request,
        {
            "symbol": symbol, "name": stock_name, "stock_info": stock_info,
            "date": str(trade_date), "rows": live_df.to_dicts(),
            "source": "live" if not live_df.is_empty() else "none",
            "asset_type": asset_type,
            "price_limit": price_limit,
            "prev_close": prev_close,
        },
        pref_key="minute_batch_compress",
    )


@router.post("/sync")
def sync_symbol(
    request: Request,
    symbol: str = Query(...),
    days: int = Query(250, ge=10, le=2000),
):
    """手动触发单股同步(Free 用户在 K 线页用)。"""
    repo = request.app.state.repo
    capset = request.app.state.capabilities
    zero: list[str] = []
    n = kline_sync.sync_and_persist_daily_batch([symbol], repo, capset, count=days, zero_row_out=zero)
    resp = {"symbol": symbol, "rows_written": n}
    if zero:
        resp["zero_row_symbols"] = zero
    return resp


@router.post("/sync_batch")
def sync_batch(
    request: Request,
    symbols: list[str],
    days: int = Query(250, ge=10, le=2000),
):
    repo = request.app.state.repo
    capset = request.app.state.capabilities
    zero: list[str] = []
    n = kline_sync.sync_and_persist_daily_batch(symbols, repo, capset, count=days, zero_row_out=zero)
    resp = {"symbols": symbols, "rows_written": n}
    if zero:
        # fail-loud (#302): 裸符号被跳过/上游 200 空数据的标的显式列出,
        # 不再"回填显示成功、实际全库 0 行"
        resp["zero_row_symbols"] = zero
    return resp


@router.post("/refresh_views")
def refresh_views(request: Request):
    """刷新所有 DuckDB 视图(解决视图状态不一致问题)。"""
    from app.jobs.daily_pipeline import _refresh_views
    repo = request.app.state.repo
    _refresh_views(repo)
    return {"status": "ok"}


@router.post("/sync_minute")
async def sync_minute(request: Request):
    """手动触发分钟 K 同步(全市场)。返回 pipeline job_id 可轮询进度。

    body 可选: { "days": int } — 指定拉取天数 (不传则用偏好设置)。
    """
    # 可选 body: { "days": int, "extend": bool }
    # days: 拉取天数; extend: 向前扩展模式 (从最早数据往前补)
    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        pass
    return await trigger_minute_sync(
        request.app.state.repo,
        request.app.state.capabilities,
        override_days=body.get("days"),
        extend_flag=body.get("extend"),
    )


async def trigger_minute_sync(repo, capset, *, override_days=None, extend_flag=None) -> dict:
    """触发分钟K同步/向前扩展后台任务(HTTP 端点与 AI 助手共用同一条触发路径)。"""
    import asyncio

    from app.api.data import invalidate_storage_cache
    from app.services.pipeline_jobs import (
        JobCancelledError,
        job_store,
        release_run_slot,
        run_with_capacity,
        try_acquire_run_slot,
    )
    from app.services.preferences import get_minute_sync_days
    from app.tickflow.capabilities import Cap
    from app.tickflow.pools import get_pool

    if not _minute_allowed(capset):
        raise HTTPException(status_code=403, detail="需要 Pro+ 权限")
    # 分钟K全市场同步是长任务(数据量是日K的 ~240 倍),用更宽松的卡死阈值
    job_id, is_new = job_store.create(long_running=True)
    if not is_new:
        return {"status": "reused", "job_id": job_id}

    async def task() -> None:
        if not try_acquire_run_slot(job_id):
            job_store.fail(job_id, "已有数据任务在运行(或上一次任务卡死未结束),请稍后再试")
            return
        loop = asyncio.get_event_loop()

        def progress(stage: str, pct: int, msg: str) -> None:
            job_store.progress(job_id, stage, pct, msg)

        try:
            progress("sync_minute", 5, "解析标的池…")
            # 标的池 = instruments 维表 + 自选 (单一来源, 不拉 CN_Equity_A/SW1 池)
            universe: set[str] = set(get_pool("watchlist"))
            inst_path = repo.store.data_dir / "instruments" / "instruments.parquet"
            if inst_path.exists():
                try:
                    import polars as pl
                    inst = pl.read_parquet(inst_path, columns=["symbol"])
                    universe.update(inst["symbol"].to_list())
                except Exception:  # noqa: BLE001
                    pass
            # 剔除指数 symbol: 指数分钟K无本地存储, 落库会污染 kline_minute
            index_set = repo.get_index_symbol_set()
            universe = sorted({s for s in universe if s not in index_set})
            progress("sync_minute", 10, f"标的池 {len(universe)} 只")

            days = override_days if override_days else get_minute_sync_days()
            # extend=1 → 向前扩展; days>=365 也自动向前扩展
            extend_backward = bool(extend_flag) or days >= 365

            def _on_chunk(done: int, total: int, seg_label: str) -> None:
                # 进度映射: 10% (标的池解析完) → 95%, 留 5% 给写入+刷新
                pct = 10 + int((done / max(total, 1)) * 85)
                progress("sync_minute", pct, f"拉取分钟K… {done}/{total} 批 [{seg_label}]")

            def _run():
                return kline_sync.sync_and_persist_minute(
                    universe, repo, capset, days=days,
                    extend_backward=extend_backward,
                    on_chunk_done=_on_chunk,
                )

            written = await loop.run_in_executor(_long_task_executor, run_with_capacity, job_id, _run)

            # 刷新视图
            from app.jobs.daily_pipeline import _refresh_single_view
            _refresh_single_view(repo, "kline_minute")

            progress("done", 100, f"分钟 K 同步完成,{written} 行")
            job_store.succeed(job_id, {"minute_rows": written, "universe_size": len(universe)})
            invalidate_storage_cache()
        except JobCancelledError:
            # 已由 terminate() 标记失败, 拉取线程在分块回调处自行退出
            invalidate_storage_cache()
        except Exception as e:  # noqa: BLE001
            job_store.fail(job_id, str(e))
            invalidate_storage_cache()
        finally:
            release_run_slot(job_id)

    asyncio.create_task(task())
    return {"status": "started", "job_id": job_id}


@router.post("/sync_minute_single")
async def sync_minute_single(request: Request, body: dict):
    """手动拉取单只股票的分钟K并落库 (口径随基准标记: 未迁移=前复权, 已迁移=原始)。

    body: { "symbol": "000001.SZ" }
    用于个股分时图"获取数据"按钮: 本地无数据时单独拉取并持久化。
    """
    import asyncio

    from app.services.preferences import get_minute_sync_days

    symbol = body.get("symbol", "").strip()
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol 不能为空")

    requested_days = body.get("days")
    if requested_days is not None:
        if isinstance(requested_days, bool) or not isinstance(requested_days, int):
            raise HTTPException(status_code=400, detail="days 必须是整数")
        if requested_days < 1 or requested_days > 30:
            raise HTTPException(status_code=400, detail="days 必须在 1 到 30 之间")

    repo = request.app.state.repo
    capset = request.app.state.capabilities

    # 指数分钟K无本地存储, 落库会污染股票分钟表 kline_minute;
    # 指数分钟数据走 /api/index/minute 实时读取, 此端点显式拒绝。
    if repo.resolve_asset_type(symbol) == "index":
        raise HTTPException(status_code=400, detail="指数分钟K不支持落库同步 (指数分钟数据走 /api/index/minute 实时读取)")

    if not _minute_allowed(capset):
        raise HTTPException(status_code=403, detail="需要 Pro+ 权限")

    days = requested_days if requested_days is not None else get_minute_sync_days()
    loop = asyncio.get_event_loop()

    def _run():
        return kline_sync.sync_and_persist_minute([symbol], repo, capset, days=days, force_full_days=True)

    written = await loop.run_in_executor(_long_task_executor, _run)

    # 刷新视图
    from app.jobs.daily_pipeline import _refresh_single_view
    _refresh_single_view(repo, "kline_minute")

    return {"status": "ok", "symbol": symbol, "rows": written}


@router.post("/minute-migrate")
async def minute_migrate(request: Request):
    """存量分钟K迁移为原始口径并启用读取时复权 (幂等, 见 services/minute_adjust)。

    - 用日K原始收盘价做锚点, 把历史"拉取时前复权"的分区换算回原始价;
    已是原始价的行 (全量分钟落盘) 锚点 k≈1 自动跳过;
    - 全部分区成功后创建 .raw_basis 标记: 此后读取自动复权投影、拉取改取原始价;
    - 失败不标记, 可重复调用续跑 (已换算分区二次运行为 no-op)。
    返回 { partitions, converted_symbols, skipped_no_daily, failed, marked }。
    """
    import asyncio

    repo = request.app.state.repo
    loop = asyncio.get_event_loop()
    stats = await loop.run_in_executor(
        _long_task_executor,
        lambda: minute_adjust.migrate_minute_to_raw(
            repo.store.data_dir, write_lock=repo._write_lock,
        ),
    )
    if stats.get("marked"):
        from app.jobs.daily_pipeline import _refresh_single_view
        _refresh_single_view(repo, "kline_minute")
        _refresh_single_view(repo, "kline_etf_minute")
    return {"status": "ok", **stats}


@router.post("/clear_minute")
async def clear_minute(request: Request, _: None = Depends(require_perm(P_DATA_WRITE))):
    """清空全部分钟K数据 (仅 kline_minute, 不影响其他数据)。

    删除 data/kline_minute/ 下所有分区 parquet, 刷新视图。
    需二次确认: body { "confirm": true }。
    v2.4: 挂 stick:data:write — 破坏性数据治理仅 admin/enterprise。
    """
    import shutil

    body = await request.json() if request.method == "POST" else {}
    if not body.get("confirm"):
        raise HTTPException(status_code=400, detail="需传 confirm: true 以确认清空")

    repo = request.app.state.repo
    minute_dir = repo.store.data_dir / "kline_minute"

    # 统计待删除行数 (用于返回)
    removed = 0
    if minute_dir.exists():
        try:
            # execute_one (cursor+close): 直连 db.execute 的未消费结果集会在 Windows 上
            # 钉住分区句柄, 导致下方 rmtree 静默删不掉被钉文件
            result = repo.execute_one("SELECT COUNT(*) AS cnt FROM kline_minute")
            removed = result[0] if result else 0
        except Exception:
            pass
        # 仅删 kline_minute 目录, 绝不触碰其他目录
        shutil.rmtree(minute_dir, ignore_errors=True)

    # 刷新视图 (重建空视图)
    from app.jobs.daily_pipeline import _refresh_single_view
    _refresh_single_view(repo, "kline_minute")

    from app.api.data import invalidate_storage_cache
    invalidate_storage_cache()

    logger.info("minute K cleared: %d rows removed", removed)
    return {"status": "ok", "removed": removed}


@router.post("/extend_history")
async def extend_history(request: Request, _: None = Depends(require_perm(P_DATA_WRITE))):
    """向前扩展历史日K数据 — 独立于盘后管道。

    body: { "value": int, "unit": "day"|"month"|"year" }
    返回 job_id,可轮询 /api/pipeline/jobs 查看进度。
    v2.4: 挂 stick:data:write — 全市场重拉历史属数据治理仅 admin/enterprise。
    """
    import asyncio
    import traceback as _tb
    try:
        body = await request.json()
        value = body.get("value")
        unit = body.get("unit", "month")
        if not value or value <= 0:
            raise HTTPException(status_code=400, detail="value 必须为正整数")
        if unit not in ("day", "month", "year"):
            raise HTTPException(status_code=400, detail="unit 只支持 day/month/year")

        repo = request.app.state.repo
        capset = request.app.state.capabilities

        from app.tickflow.capabilities import Cap
        if not capset.has(Cap.KLINE_DAILY_BATCH):
            raise HTTPException(status_code=403, detail="需要 Pro+ 权限 (batch K-line)")

        from app.api.data import invalidate_storage_cache
        from app.services.extend_history import run_extend_history
        from app.services.pipeline_jobs import (
            JobCancelledError,
            job_store,
            release_run_slot,
            run_with_capacity,
            try_acquire_run_slot,
        )

        job_id, is_new = job_store.create()
        if not is_new:
            return {"status": "reused", "job_id": job_id}

        async def task() -> None:
            if not try_acquire_run_slot(job_id):
                job_store.fail(job_id, "已有数据任务在运行(或上一次任务卡死未结束),请稍后再试")
                return
            loop = asyncio.get_event_loop()

            def progress(stage: str, pct: int, msg: str,
                         stage_pct: int | None = None, skip_log: bool = False) -> None:
                job_store.progress(job_id, stage, pct, msg,
                                   stage_pct=stage_pct, skip_log=skip_log)

            try:
                result = await loop.run_in_executor(
                    _long_task_executor, run_with_capacity, job_id,
                    lambda: run_extend_history(repo, capset, value, unit, on_progress=progress),
                )
                if "error" in result:
                    job_store.fail(job_id, result["error"])
                else:
                    job_store.succeed(job_id, result)
                invalidate_storage_cache()
            except JobCancelledError:
                # 已由 terminate() 标记失败, 拉取线程在分块回调处自行退出
                invalidate_storage_cache()
            except Exception as e:
                logger.exception("extend_history failed: job_id=%s", job_id)
                job_store.fail(job_id, str(e))
                invalidate_storage_cache()
            finally:
                release_run_slot(job_id)

        asyncio.create_task(task())
        return {"status": "started", "job_id": job_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("extend_history error: %s\n%s", e, _tb.format_exc())
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/repair_daily")
async def repair_daily(request: Request, _: None = Depends(require_perm(P_DATA_WRITE))):
    """修正 / 补全日K数据 — 从指定起始日期重拉到今天。

    典型场景: 昨天没看盘 / 服务挂了,本地日K缺了若干天。
    用户选起始日期,复用盘后管道全流程重拉 [start_date ~ 今天]。

    body: { "start_date": "YYYY-MM-DD" }
    返回 job_id,可轮询 /api/pipeline/jobs 查看进度。
    v2.4: 挂 stick:data:write — 管道级重拉属数据治理仅 admin/enterprise。
    """
    import asyncio
    import traceback as _tb
    from datetime import date as _date
    try:
        body = await request.json()
        raw = body.get("start_date")
        if not raw:
            raise HTTPException(status_code=400, detail="start_date 必填 (YYYY-MM-DD)")
        try:
            start_date = _date.fromisoformat(str(raw))
        except ValueError:
            raise HTTPException(status_code=400, detail="start_date 格式错误 (应为 YYYY-MM-DD)")

        if start_date > cn_today():
            raise HTTPException(status_code=400, detail="起始日期不能晚于今天")

        repo = request.app.state.repo
        capset = request.app.state.capabilities

        from app.tickflow.capabilities import Cap
        if not capset.has(Cap.KLINE_DAILY_BATCH):
            raise HTTPException(status_code=403, detail="需要 Pro+ 权限 (batch K-line)")

        from app.api.data import invalidate_storage_cache
        from app.services.pipeline_jobs import (
            JobCancelledError,
            job_store,
            release_run_slot,
            run_with_capacity,
            try_acquire_run_slot,
        )
        from app.services.repair_daily import run_repair_daily

        job_id, is_new = job_store.create()
        if not is_new:
            return {"status": "reused", "job_id": job_id}

        async def task() -> None:
            if not try_acquire_run_slot(job_id):
                job_store.fail(job_id, "已有数据任务在运行(或上一次任务卡死未结束),请稍后再试")
                return
            loop = asyncio.get_event_loop()
            qs = getattr(request.app.state, "quote_service", None)

            def progress(stage: str, pct: int, msg: str,
                         stage_pct: int | None = None, skip_log: bool = False) -> None:
                job_store.progress(job_id, stage, pct, msg,
                                   stage_pct=stage_pct, skip_log=skip_log)

            def _run() -> dict:
                # 修正运行期间暂停实时行情, 防止覆写同一批 parquet 竞态
                if qs:
                    with qs.paused():
                        return run_repair_daily(repo, capset, start_date, on_progress=progress)
                return run_repair_daily(repo, capset, start_date, on_progress=progress)

            try:
                result = await loop.run_in_executor(_long_task_executor, run_with_capacity, job_id, _run)
                if "error" in result:
                    job_store.fail(job_id, result["error"])
                else:
                    job_store.succeed(job_id, result)
                invalidate_storage_cache()
            except JobCancelledError:
                # 已由 terminate() 标记失败, 拉取线程在分块回调处自行退出
                invalidate_storage_cache()
            except Exception as e:
                logger.exception("repair_daily failed: job_id=%s", job_id)
                job_store.fail(job_id, str(e))
                invalidate_storage_cache()
            finally:
                release_run_slot(job_id)

        asyncio.create_task(task())
        return {"status": "started", "job_id": job_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("repair_daily error: %s\n%s", e, _tb.format_exc())
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/rebuild_enriched")
async def rebuild_enriched(request: Request, _: None = Depends(require_perm(P_DATA_WRITE))):
    """全量重算 enriched 表 — 不获取任何数据,仅基于已有 kline_daily + adj_factor 重算复权+指标。

    返回 job_id,可轮询 /api/pipeline/jobs 查看进度。
    v2.4: 挂 stick:data:write — 全量重算属数据治理仅 admin/enterprise。
    """
    import asyncio
    try:
        repo = request.app.state.repo

        from app.api.data import invalidate_storage_cache
        from app.services.pipeline_jobs import (
            JobCancelledError,
            job_store,
            release_run_slot,
            run_with_capacity,
            try_acquire_run_slot,
        )

        job_id, is_new = job_store.create()
        if not is_new:
            return {"status": "reused", "job_id": job_id}

        async def task() -> None:
            if not try_acquire_run_slot(job_id):
                job_store.fail(job_id, "已有数据任务在运行(或上一次任务卡死未结束),请稍后再试")
                return
            loop = asyncio.get_event_loop()

            def progress(stage: str, pct: int, msg: str,
                         stage_pct: int | None = None, skip_log: bool = False) -> None:
                job_store.progress(job_id, stage, pct, msg,
                                   stage_pct=stage_pct, skip_log=skip_log)

            try:
                progress("rebuild_enriched", 10, "全量计算 enriched…")
                from app.indicators.pipeline import run_pipeline

                def _batch_progress(cur: int, tot: int) -> None:
                    pct = 10 + int(85 * cur / tot)
                    progress("rebuild_enriched", pct,
                             f"计算指标 批次 {cur}/{tot}",
                             stage_pct=int(100 * cur / tot), skip_log=True)

                written = await loop.run_in_executor(
                    _long_task_executor, run_with_capacity, job_id,
                    lambda: run_pipeline(on_batch_done=_batch_progress),
                )

                enriched_dir = repo.store.data_dir / "kline_daily_enriched"
                enriched_days = len(list(enriched_dir.glob("date=*"))) if enriched_dir.exists() else 0

                # 刷新视图
                d = repo.store.data_dir.as_posix()
                for view_name, glob in [
                    ("kline_enriched", f"{d}/kline_daily_enriched/**/*.parquet"),
                ]:
                    try:
                        repo.db.execute(
                            f"CREATE OR REPLACE VIEW {view_name} AS "
                            f"SELECT * FROM read_parquet('{glob}', union_by_name=true)"
                        )
                    except Exception:
                        pass

                progress("rebuild_enriched", 100, f"完成,覆盖 {enriched_days} 天")
                job_store.succeed(job_id, {
                    "enriched_days": enriched_days,
                    "enriched_rows": written,
                })
                invalidate_storage_cache()
            except JobCancelledError:
                # 已由 terminate() 标记失败, 拉取线程在分块回调处自行退出
                invalidate_storage_cache()
            except Exception as e:
                logger.exception("rebuild_enriched failed: job_id=%s", job_id)
                job_store.fail(job_id, str(e))
                invalidate_storage_cache()
            finally:
                release_run_slot(job_id)

        asyncio.create_task(task())
        return {"status": "started", "job_id": job_id}
    except Exception as e:
        import traceback as _tb
        logger.error("rebuild_enriched error: %s\n%s", e, _tb.format_exc())
        raise HTTPException(status_code=500, detail=str(e)) from e


# 长时间任务专用线程池（隔离于 FastAPI 默认线程池，防止阻塞请求处理）
import concurrent.futures as _cf

_long_task_executor = _cf.ThreadPoolExecutor(max_workers=2, thread_name_prefix="long-task")
