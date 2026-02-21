"""
Technical indicators computed from OHLCV DataFrames using vectorized NumPy/Pandas.
Used by signal_engine.py for backtesting signal scoring.
"""
import numpy as np
import pandas as pd


def ema(series, period):
    return series.ewm(span=period, adjust=False).mean()


def sma(series, period):
    return series.rolling(period).mean()


def rsi(close, period=14):
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd(close, fast=12, slow=26, signal=9):
    ema_fast = ema(close, fast)
    ema_slow = ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def bollinger_bands(close, period=20, std_dev=2):
    mid = sma(close, period)
    std = close.rolling(period).std()
    upper = mid + std_dev * std
    lower = mid - std_dev * std
    bandwidth = (upper - lower) / mid
    position = (close - lower) / (upper - lower)
    return upper, mid, lower, bandwidth, position


def atr(high, low, close, period=14):
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def adx(high, low, close, period=14):
    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)
    atr_val = atr(high, low, close, period)
    plus_di = 100 * ema(plus_dm, period) / atr_val.replace(0, np.nan)
    minus_di = 100 * ema(minus_dm, period) / atr_val.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx_val = ema(dx, period)
    return adx_val, plus_di, minus_di


def vwap(high, low, close, volume):
    typical = (high + low + close) / 3
    cum_tp_vol = (typical * volume).cumsum()
    cum_vol = volume.cumsum()
    return cum_tp_vol / cum_vol.replace(0, np.nan)


def volume_sma(volume, period=20):
    return volume.rolling(period).mean()


def rsi_divergence(close, rsi_vals, lookback=14):
    """Detect RSI divergence: price makes new low but RSI doesn't (bull) or vice versa"""
    score = pd.Series(0.0, index=close.index)
    price_min = close.rolling(lookback).min()
    rsi_min = rsi_vals.rolling(lookback).min()
    # Bullish divergence: price at/near low, RSI higher than its low
    bull = (close <= price_min * 1.01) & (rsi_vals > rsi_min + 5)
    score[bull] = 1.0
    price_max = close.rolling(lookback).max()
    rsi_max = rsi_vals.rolling(lookback).max()
    bear = (close >= price_max * 0.99) & (rsi_vals < rsi_max - 5)
    score[bear] = -1.0
    return score


def detect_squeeze(bb_bandwidth, threshold=0.03):
    """BB squeeze detection: bandwidth below threshold = squeeze"""
    return (bb_bandwidth < threshold).astype(float)


def candlestick_score(open_p, high, low, close):
    """Simple candlestick pattern scoring (doji, hammer, engulfing)"""
    body = (close - open_p).abs()
    total_range = (high - low).replace(0, np.nan)
    body_ratio = body / total_range
    # Doji: tiny body
    doji = body_ratio < 0.1
    # Hammer: small body at top, long lower wick
    lower_wick = pd.concat([open_p, close], axis=1).min(axis=1) - low
    hammer = (lower_wick / total_range > 0.6) & (body_ratio < 0.3)
    # Bullish engulfing
    prev_bear = close.shift(1) < open_p.shift(1)
    curr_bull = close > open_p
    engulf_bull = prev_bear & curr_bull & (close > open_p.shift(1)) & (open_p < close.shift(1))
    score = pd.Series(0.0, index=close.index)
    score[hammer & (close > open_p)] = 1.0
    score[hammer & (close < open_p)] = -0.5
    score[engulf_bull] = 1.0
    score[doji] = 0.0
    return score
