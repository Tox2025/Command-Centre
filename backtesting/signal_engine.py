"""
Vectorized Signal Engine — Python port of the Node.js 38-signal scoring system.
Computes all backtestable signals from OHLCV data and produces direction + confidence.
"""
import numpy as np
import pandas as pd
from indicators import (ema, sma, rsi, macd, bollinger_bands, atr, adx,
                         vwap, volume_sma, rsi_divergence, detect_squeeze,
                         candlestick_score)
from config import DEFAULT_WEIGHTS, BACKTEST_CONFIG


class SignalEngine:
    def __init__(self, weights=None):
        self.weights = weights or DEFAULT_WEIGHTS.copy()

    def compute_all_signals(self, df):
        """Compute all technical signals on a DataFrame. Returns DataFrame with signal columns."""
        c, h, l, o, v = df['close'], df['high'], df['low'], df['open'], df['volume']

        # Core indicators
        rsi_14 = rsi(c, 14)
        macd_line, macd_sig, macd_hist = macd(c)
        bb_upper, bb_mid, bb_lower, bb_bw, bb_pos = bollinger_bands(c)
        atr_14 = atr(h, l, c, 14)
        adx_14, plus_di, minus_di = adx(h, l, c, 14)
        ema_8 = ema(c, 8)
        ema_21 = ema(c, 21)
        ema_50 = ema(c, 50)
        vol_avg = volume_sma(v, 20)

        # VWAP (daily reset would be ideal, but we use rolling for daily bars)
        vwap_val = vwap(h, l, c, v) if 'vwap' not in df.columns else df['vwap']

        signals = pd.DataFrame(index=df.index)

        # 1. EMA Alignment (-1 to +1)
        ema_bull = ((ema_8 > ema_21) & (ema_21 > ema_50)).astype(float)
        ema_bear = ((ema_8 < ema_21) & (ema_21 < ema_50)).astype(float)
        signals['ema_alignment'] = ema_bull - ema_bear

        # 2. RSI Position (-1 to +1)
        signals['rsi_position'] = np.where(rsi_14 > 70, -1, np.where(rsi_14 < 30, 1,
                                  np.where(rsi_14 > 50, (rsi_14 - 50) / 20, (rsi_14 - 50) / 20)))

        # 3. MACD Histogram (-1 to +1)
        macd_norm = macd_hist / atr_14.replace(0, np.nan)
        signals['macd_histogram'] = macd_norm.clip(-1, 1)

        # 4. Bollinger Position (-1 to +1)
        signals['bollinger_position'] = (bb_pos * 2 - 1).clip(-1, 1)

        # 5. BB Squeeze (0 or 1)
        signals['bb_squeeze'] = detect_squeeze(bb_bw)

        # 6. VWAP Deviation (-1 to +1)
        vwap_dev = (c - vwap_val) / atr_14.replace(0, np.nan)
        signals['vwap_deviation'] = vwap_dev.clip(-1, 1)

        # 7-9. Options flow proxies (use volume + price patterns as proxy)
        # Call/put ratio proxy: bullish volume days suggest call flow
        price_change = c.pct_change()
        vol_ratio = v / vol_avg.replace(0, np.nan)
        signals['call_put_ratio'] = np.where(
            (price_change > 0) & (vol_ratio > 1.5), 0.5,
            np.where((price_change < 0) & (vol_ratio > 1.5), -0.5, 0))
        signals['sweep_activity'] = (vol_ratio > 3).astype(float) * np.sign(price_change)
        signals['dark_pool_direction'] = np.where(
            (v > vol_avg * 2) & (price_change.abs() < atr_14 / c * 0.3), 0.3 * np.sign(price_change), 0)

        # 10-13. Volatility proxies
        signals['gex_positioning'] = np.zeros(len(df))  # neutral proxy
        iv_proxy = bb_bw.rolling(20).rank(pct=True)
        signals['iv_rank'] = np.where(iv_proxy > 0.8, -0.3, np.where(iv_proxy < 0.2, 0.3, 0))
        signals['short_interest'] = np.zeros(len(df))  # needs external data
        signals['volume_spike'] = np.where(vol_ratio > 2, 1, np.where(vol_ratio > 1.5, 0.5, 0))
        signals['volume_spike'] *= np.sign(price_change)

        # 14. Regime Alignment
        sma_200 = sma(c, 200)
        regime = np.where(c > sma_200, 1, np.where(c < sma_200, -1, 0)).astype(float)
        signals['regime_alignment'] = regime * signals['ema_alignment'].abs()

        # 15-16. Gamma proxies
        signals['gamma_wall'] = np.zeros(len(df))
        signals['iv_skew'] = np.zeros(len(df))

        # 17. Candlestick Pattern
        signals['candlestick_pattern'] = candlestick_score(o, h, l, c)

        # 18. News Sentiment (neutral proxy)
        signals['news_sentiment'] = np.zeros(len(df))

        # 19. Multi-TF Confluence (use daily alignment as proxy)
        ema_20d = sma(c, 20)
        ema_50d = sma(c, 50)
        mtf = ((c > ema_20d) & (ema_20d > ema_50d) & (c > sma_200)).astype(float)
        mtf -= ((c < ema_20d) & (ema_20d < ema_50d) & (c < sma_200)).astype(float)
        signals['multi_tf_confluence'] = mtf

        # 20. RSI Divergence
        signals['rsi_divergence'] = rsi_divergence(c, rsi_14)

        # 21. ADX Filter (trend strength)
        signals['adx_filter'] = np.where(adx_14 > 25, 1, np.where(adx_14 < 15, -0.5, 0))
        signals['adx_filter'] *= signals['ema_alignment']

        # 22-26. Flow proxies
        signals['volatility_runner'] = np.where(
            (price_change > 0.05) & (vol_ratio > 3), 1, 0).astype(float)
        mom_5 = c.pct_change(5)
        signals['net_premium_momentum'] = mom_5.clip(-0.1, 0.1) * 10
        signals['strike_flow_levels'] = np.zeros(len(df))
        signals['greek_flow_momentum'] = np.zeros(len(df))

        # 27-30. Macro proxies
        signals['sector_tide_alignment'] = regime * 0.5
        signals['etf_tide_macro'] = regime * 0.3
        signals['squeeze_composite'] = signals['bb_squeeze'] * signals['adx_filter'].clip(0, 1)
        signals['seasonality_alignment'] = np.zeros(len(df))

        # 31-34. Additional
        signals['vol_regime'] = np.where(bb_bw > bb_bw.rolling(50).quantile(0.8), -0.5,
                                np.where(bb_bw < bb_bw.rolling(50).quantile(0.2), 0.5, 0))
        signals['insider_conviction'] = np.zeros(len(df))
        signals['spot_gamma_pin'] = np.zeros(len(df))
        signals['flow_horizon'] = np.zeros(len(df))
        signals['volume_direction'] = np.where(vol_ratio > 1.5, 1, 0) * np.sign(price_change)
        signals['earnings_gap_trade'] = np.where(
            price_change.abs() > 0.04, np.sign(price_change), 0).astype(float)
        signals['insider_congress'] = np.zeros(len(df))

        # Store raw indicators for ML features
        signals['_rsi'] = rsi_14
        signals['_macd_hist'] = macd_hist
        signals['_atr'] = atr_14
        signals['_adx'] = adx_14
        signals['_bb_bw'] = bb_bw
        signals['_vol_ratio'] = vol_ratio
        signals['_price_change'] = price_change
        signals['_close'] = c

        return signals

    def score(self, signals_df):
        """Score signals → direction + confidence for each bar. Returns DataFrame."""
        weight_keys = [k for k in self.weights.keys() if k in signals_df.columns]
        bull_score = pd.Series(0.0, index=signals_df.index)
        bear_score = pd.Series(0.0, index=signals_df.index)
        active_weight_sum = pd.Series(0.0, index=signals_df.index)

        for key in weight_keys:
            w = self.weights[key]
            if w == 0:
                continue
            sig = signals_df[key].fillna(0)
            bull_score += np.maximum(sig, 0) * w
            bear_score += np.maximum(-sig, 0) * w
            # Only count weight if signal is non-zero on this bar
            active_weight_sum += (sig.abs() > 0.01).astype(float) * w

        # Use active weights as denominator (signals that actually fired)
        active_weight_sum = active_weight_sum.replace(0, 1)

        result = pd.DataFrame(index=signals_df.index)
        result['bull_score'] = bull_score
        result['bear_score'] = bear_score
        result['net_score'] = bull_score - bear_score

        # Confidence based on active signals only
        result['confidence'] = ((bull_score + bear_score) / active_weight_sum * 100).clip(0, 100)
        result['direction'] = np.where(result['net_score'] > 0, 1, np.where(result['net_score'] < 0, -1, 0))

        # Directional conviction: how one-sided is the score
        total = bull_score + bear_score
        total = total.replace(0, np.nan)
        result['directional_conf'] = ((bull_score - bear_score).abs() / total * 100).fillna(0).clip(0, 100)

        # Final confidence = blend of signal strength + directional agreement
        result['confidence'] = (result['confidence'] * 0.6 + result['directional_conf'] * 0.4).clip(0, 100)

        return result

    def generate_entries(self, score_df, threshold=65):
        """Generate entry signals based on confidence threshold"""
        entries_long = (score_df['direction'] == 1) & (score_df['confidence'] >= threshold)
        entries_short = (score_df['direction'] == -1) & (score_df['confidence'] >= threshold)
        return entries_long, entries_short

    def debug_scores(self, df):
        """Print score distribution for debugging"""
        signals = self.compute_all_signals(df)
        scores = self.score(signals)
        print(f"\n📊 Score Distribution:")
        print(f"  Confidence: min={scores['confidence'].min():.1f} "
              f"median={scores['confidence'].median():.1f} "
              f"max={scores['confidence'].max():.1f} "
              f"mean={scores['confidence'].mean():.1f}")
        print(f"  Direction:  Bull={int((scores['direction']==1).sum())} "
              f"Bear={int((scores['direction']==-1).sum())} "
              f"Neutral={int((scores['direction']==0).sum())}")
        bins = [0, 30, 50, 60, 65, 70, 80, 100]
        hist = pd.cut(scores['confidence'], bins=bins).value_counts().sort_index()
        print(f"  Histogram:")
        for bucket, count in hist.items():
            pct = count / len(scores) * 100
            bar = '█' * int(pct / 2)
            print(f"    {str(bucket):>12}: {count:>4} ({pct:>5.1f}%) {bar}")
        # Active signals per bar
        active = sum(1 for k in self.weights if k in signals.columns
                     and self.weights[k] > 0 and (signals[k].abs() > 0.01).any())
        print(f"  Active signals (any bar): {active}/{len(self.weights)}")
        return scores

    def extract_ml_features(self, signals_df):
        """Extract 25-feature vector matching Node.js MLCalibrator format"""
        feat = pd.DataFrame(index=signals_df.index)
        feat['rsi'] = signals_df['_rsi']
        feat['macd_hist'] = signals_df['_macd_hist']
        feat['ema_align'] = signals_df['ema_alignment']
        feat['bb_pos'] = signals_df['bollinger_position']
        feat['atr'] = signals_df['_atr']
        feat['cp_ratio'] = signals_df['call_put_ratio']
        feat['dp_dir'] = signals_df['dark_pool_direction']
        feat['iv_rank'] = signals_df['iv_rank']
        feat['si_pct'] = signals_df['short_interest']
        feat['vol_spike'] = signals_df['volume_spike']
        feat['bb_bw'] = signals_df['_bb_bw']
        feat['vwap_dev'] = signals_df['vwap_deviation']
        feat['regime'] = signals_df['regime_alignment']
        feat['gamma_prox'] = signals_df['gamma_wall']
        feat['iv_skew'] = signals_df['iv_skew']
        feat['candle'] = signals_df['candlestick_pattern']
        feat['sentiment'] = signals_df['news_sentiment']
        feat['adx'] = signals_df['_adx']
        feat['rsi_div'] = signals_df['rsi_divergence']
        feat['fib_prox'] = np.zeros(len(signals_df))
        feat['rsi_slope'] = signals_df['_rsi'].diff(3)
        feat['macd_accel'] = signals_df['_macd_hist'].diff(3)
        feat['atr_change'] = signals_df['_atr'].pct_change(5)
        feat['rsi_x_ema'] = ((signals_df['_rsi'] - 50) / 50) * signals_df['ema_alignment']
        feat['vol_x_macd'] = signals_df['volume_spike'].abs() * np.sign(signals_df['_macd_hist'])
        return feat
