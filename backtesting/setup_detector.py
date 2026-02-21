"""
Setup Detector — Conditional pattern matching for high-probability trade setups.
Instead of scoring every bar, this detects SPECIFIC setups where multiple conditions
must align — the way real traders read charts.
"""
import numpy as np
import pandas as pd
from indicators import (ema, sma, rsi, macd, bollinger_bands, atr, adx,
                         vwap, volume_sma, candlestick_score)


class SetupDetector:
    """Detects high-probability trading setups from OHLCV data."""

    def __init__(self):
        self.setups_detected = []

    def compute_indicators(self, df):
        """Pre-compute all indicators needed for setup detection."""
        c, h, l, o, v = df['close'], df['high'], df['low'], df['open'], df['volume']
        ind = {}
        ind['close'] = c
        ind['open'] = o
        ind['high'] = h
        ind['low'] = l
        ind['volume'] = v
        ind['rsi'] = rsi(c, 14)
        ind['rsi_5'] = rsi(c, 5)
        ml, ms, mh = macd(c)
        ind['macd_line'] = ml
        ind['macd_signal'] = ms
        ind['macd_hist'] = mh
        bb_u, bb_m, bb_l, bb_bw, bb_pos = bollinger_bands(c)
        ind['bb_upper'] = bb_u
        ind['bb_mid'] = bb_m
        ind['bb_lower'] = bb_l
        ind['bb_bw'] = bb_bw
        ind['bb_pos'] = bb_pos
        ind['atr'] = atr(h, l, c, 14)
        adx_val, plus_di, minus_di = adx(h, l, c, 14)
        ind['adx'] = adx_val
        ind['plus_di'] = plus_di
        ind['minus_di'] = minus_di
        ind['ema8'] = ema(c, 8)
        ind['ema21'] = ema(c, 21)
        ind['ema50'] = ema(c, 50)
        ind['vol_avg'] = volume_sma(v, 20)
        ind['vol_ratio'] = v / ind['vol_avg'].replace(0, np.nan)
        ind['vwap'] = vwap(h, l, c, v) if 'vwap' not in df.columns else df['vwap']
        ind['candle_body'] = (c - o).abs()
        ind['candle_range'] = (h - l).replace(0, np.nan)
        ind['body_ratio'] = ind['candle_body'] / ind['candle_range']
        ind['bullish_candle'] = c > o
        ind['bearish_candle'] = c < o
        lower_wick = pd.concat([o, c], axis=1).min(axis=1) - l
        upper_wick = h - pd.concat([o, c], axis=1).max(axis=1)
        ind['lower_wick_pct'] = lower_wick / ind['candle_range']
        ind['upper_wick_pct'] = upper_wick / ind['candle_range']
        ind['price_change'] = c.pct_change()
        ind['sma200'] = sma(c, 200)
        return ind

    def detect_all(self, df):
        """Run all setup detectors on the dataframe. Returns DataFrame of setups."""
        ind = self.compute_indicators(df)
        all_setups = []

        # Run each setup detector
        for name, func in [
            ('RSI_OVERSOLD_BOUNCE', self._rsi_oversold_bounce),
            ('RSI_OVERBOUGHT_FADE', self._rsi_overbought_fade),
            ('VWAP_RECLAIM', self._vwap_reclaim),
            ('VWAP_REJECTION', self._vwap_rejection),
            ('BB_SQUEEZE_BREAKOUT_LONG', self._bb_squeeze_breakout_long),
            ('BB_SQUEEZE_BREAKOUT_SHORT', self._bb_squeeze_breakout_short),
            ('EMA_TREND_PULLBACK_LONG', self._ema_trend_pullback_long),
            ('EMA_TREND_PULLBACK_SHORT', self._ema_trend_pullback_short),
            ('VOLUME_CLIMAX_REVERSAL_LONG', self._volume_climax_reversal_long),
            ('VOLUME_CLIMAX_REVERSAL_SHORT', self._volume_climax_reversal_short),
            ('MACD_BULLISH_CROSS', self._macd_bullish_cross),
            ('MACD_BEARISH_CROSS', self._macd_bearish_cross),
            ('MOMENTUM_BREAKOUT_LONG', self._momentum_breakout_long),
            ('MOMENTUM_BREAKOUT_SHORT', self._momentum_breakout_short),
        ]:
            mask = func(ind)
            if mask.any():
                setup_df = pd.DataFrame(index=df.index[mask])
                setup_df['setup'] = name
                setup_df['direction'] = 1 if 'LONG' in name or 'BOUNCE' in name or 'RECLAIM' in name or 'BULLISH' in name else -1
                setup_df['entry_price'] = ind['close'][mask].values
                setup_df['rsi_at_entry'] = ind['rsi'][mask].values
                setup_df['vol_ratio_at_entry'] = ind['vol_ratio'][mask].values
                all_setups.append(setup_df)

        if not all_setups:
            return pd.DataFrame()
        return pd.concat(all_setups).sort_index()

    # ── SCALP SETUPS ──────────────────────────────────────────

    def _rsi_oversold_bounce(self, ind):
        """RSI < 30 + volume spike + bullish candle = long scalp"""
        return (
            (ind['rsi'] < 30) &
            (ind['vol_ratio'] > 1.5) &
            (ind['bullish_candle']) &
            (ind['body_ratio'] > 0.3)  # not a doji
        )

    def _rsi_overbought_fade(self, ind):
        """RSI > 70 + volume spike + bearish candle = short scalp"""
        return (
            (ind['rsi'] > 70) &
            (ind['vol_ratio'] > 1.5) &
            (ind['bearish_candle']) &
            (ind['body_ratio'] > 0.3)
        )

    def _vwap_reclaim(self, ind):
        """Price crosses above VWAP with volume after being below = long"""
        prev_below = ind['close'].shift(1) < ind['vwap'].shift(1)
        now_above = ind['close'] > ind['vwap']
        return (
            prev_below &
            now_above &
            (ind['vol_ratio'] > 1.3) &
            (ind['rsi'] > 35) & (ind['rsi'] < 65)  # not already overbought
        )

    def _vwap_rejection(self, ind):
        """Price fails at VWAP — wick above, close below = short"""
        wick_above_vwap = ind['high'] > ind['vwap']
        close_below_vwap = ind['close'] < ind['vwap']
        return (
            wick_above_vwap &
            close_below_vwap &
            (ind['vol_ratio'] > 1.3) &
            (ind['bearish_candle']) &
            (ind['upper_wick_pct'] > 0.4)  # significant rejection wick
        )

    def _volume_climax_reversal_long(self, ind):
        """Extreme volume + long lower wick + bearish exhaustion = reversal long"""
        return (
            (ind['vol_ratio'] > 2.5) &
            (ind['lower_wick_pct'] > 0.5) &
            (ind['rsi'] < 40) &
            (ind['body_ratio'] < 0.4)  # small body = indecision after selloff
        )

    def _volume_climax_reversal_short(self, ind):
        """Extreme volume + long upper wick + bullish exhaustion = reversal short"""
        return (
            (ind['vol_ratio'] > 2.5) &
            (ind['upper_wick_pct'] > 0.5) &
            (ind['rsi'] > 60) &
            (ind['body_ratio'] < 0.4)
        )

    # ── MOMENTUM / DAY TRADE SETUPS ───────────────────────────

    def _bb_squeeze_breakout_long(self, ind):
        """BB squeeze + breakout above upper band + volume = long momentum"""
        squeeze = ind['bb_bw'] < ind['bb_bw'].rolling(50, min_periods=20).quantile(0.2)
        breakout = ind['close'] > ind['bb_upper']
        return (
            squeeze &
            breakout &
            (ind['vol_ratio'] > 1.5) &
            (ind['bullish_candle']) &
            (ind['adx'] > 15)
        )

    def _bb_squeeze_breakout_short(self, ind):
        """BB squeeze + breakdown below lower band + volume = short momentum"""
        squeeze = ind['bb_bw'] < ind['bb_bw'].rolling(50, min_periods=20).quantile(0.2)
        breakdown = ind['close'] < ind['bb_lower']
        return (
            squeeze &
            breakdown &
            (ind['vol_ratio'] > 1.5) &
            (ind['bearish_candle']) &
            (ind['adx'] > 15)
        )

    def _ema_trend_pullback_long(self, ind):
        """EMA aligned bullish + pullback to EMA21 + bounce with volume = long"""
        ema_aligned = (ind['ema8'] > ind['ema21']) & (ind['ema21'] > ind['ema50'])
        at_support = (ind['low'] <= ind['ema21'] * 1.005) & (ind['close'] > ind['ema21'])
        return (
            ema_aligned &
            at_support &
            (ind['bullish_candle']) &
            (ind['vol_ratio'] > 1.0) &
            (ind['rsi'] > 35) & (ind['rsi'] < 60) &
            (ind['macd_hist'] > ind['macd_hist'].shift(1))  # MACD turning up
        )

    def _ema_trend_pullback_short(self, ind):
        """EMA aligned bearish + rally to EMA21 + rejection with volume = short"""
        ema_aligned = (ind['ema8'] < ind['ema21']) & (ind['ema21'] < ind['ema50'])
        at_resistance = (ind['high'] >= ind['ema21'] * 0.995) & (ind['close'] < ind['ema21'])
        return (
            ema_aligned &
            at_resistance &
            (ind['bearish_candle']) &
            (ind['vol_ratio'] > 1.0) &
            (ind['rsi'] > 40) & (ind['rsi'] < 65) &
            (ind['macd_hist'] < ind['macd_hist'].shift(1))  # MACD turning down
        )

    def _macd_bullish_cross(self, ind):
        """MACD line crosses above signal + RSI not overbought + volume = long"""
        cross_up = (ind['macd_line'] > ind['macd_signal']) & (ind['macd_line'].shift(1) <= ind['macd_signal'].shift(1))
        return (
            cross_up &
            (ind['rsi'] > 35) & (ind['rsi'] < 65) &
            (ind['vol_ratio'] > 1.0) &
            (ind['macd_hist'] > 0)
        )

    def _macd_bearish_cross(self, ind):
        """MACD line crosses below signal + RSI not oversold + volume = short"""
        cross_down = (ind['macd_line'] < ind['macd_signal']) & (ind['macd_line'].shift(1) >= ind['macd_signal'].shift(1))
        return (
            cross_down &
            (ind['rsi'] > 35) & (ind['rsi'] < 65) &
            (ind['vol_ratio'] > 1.0) &
            (ind['macd_hist'] < 0)
        )

    def _momentum_breakout_long(self, ind):
        """Strong move up: price > EMA8, volume > 2x, ADX rising, MACD positive"""
        return (
            (ind['close'] > ind['ema8']) &
            (ind['close'] > ind['close'].shift(1)) &
            (ind['vol_ratio'] > 2.0) &
            (ind['adx'] > 20) &
            (ind['macd_hist'] > 0) &
            (ind['rsi'] > 50) & (ind['rsi'] < 75) &
            (ind['bullish_candle']) &
            (ind['body_ratio'] > 0.5)  # strong body, not doji
        )

    def _momentum_breakout_short(self, ind):
        """Strong move down: price < EMA8, volume > 2x, ADX rising, MACD negative"""
        return (
            (ind['close'] < ind['ema8']) &
            (ind['close'] < ind['close'].shift(1)) &
            (ind['vol_ratio'] > 2.0) &
            (ind['adx'] > 20) &
            (ind['macd_hist'] < 0) &
            (ind['rsi'] > 25) & (ind['rsi'] < 50) &
            (ind['bearish_candle']) &
            (ind['body_ratio'] > 0.5)
        )
