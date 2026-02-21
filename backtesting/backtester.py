"""
Prediction Accuracy Backtester — validates directional bias momentum predictions

Instead of simulating trades, this measures:
"When the model says BULLISH at X% confidence, does the price actually go up?"

Day Trade mode: scores on 5m bars, measures outcome at 15min/30min/1hr/2hr
Swing Trade mode: scores on daily bars, measures outcome at 1/2/3/5 days
"""

import numpy as np
import pandas as pd
from datetime import time as dtime
from signal_engine import SignalEngine
from data_fetcher import DataFetcher
from config import BACKTEST_CONFIG, DEFAULT_WEIGHTS, load_version_weights


class PredictionValidator:
    """Validates signal engine prediction accuracy against actual price moves"""

    def __init__(self, weights=None, config=None):
        self.config = config or BACKTEST_CONFIG.copy()
        self.engine = SignalEngine(weights or DEFAULT_WEIGHTS.copy())
        self.fetcher = DataFetcher()

    def validate_day_trade(self, ticker, df=None):
        """Validate predictions on intraday 5m bars
        Measures: did price move in predicted direction at 15m/30m/1hr/2hr?
        """
        bar_size = self.config['day_trade_bar_size']
        lookback = self.config['day_trade_lookback_days']

        if df is None or df.empty:
            df = self.fetcher.fetch_intraday(ticker, bar_size, lookback)
        if df.empty or len(df) < 100:
            return {'ticker': ticker, 'error': 'Insufficient intraday data', 'predictions': 0}

        # Filter to market hours only (9:30 AM - 4:00 PM ET)
        df = self._filter_market_hours(df)
        if len(df) < 100:
            return {'ticker': ticker, 'error': 'Insufficient market-hours data', 'predictions': 0}

        # Compute signals and scores
        signals = self.engine.compute_all_signals(df)
        scores = self.engine.score(signals)
        threshold = self.config['confidence_threshold']

        horizons = self.config['day_trade_horizons']
        labels = self.config['day_trade_horizon_labels']

        return self._measure_accuracy(ticker, df, scores, threshold, horizons, labels, 'day')

    def validate_swing(self, ticker, df=None):
        """Validate predictions on daily bars
        Measures: did price move in predicted direction at 1d/2d/3d/5d?
        """
        lookback = self.config['swing_lookback_days']

        if df is None or df.empty:
            df = self.fetcher.fetch_daily(ticker, lookback)
        if df.empty or len(df) < 50:
            return {'ticker': ticker, 'error': 'Insufficient daily data', 'predictions': 0}

        # Compute signals and scores
        signals = self.engine.compute_all_signals(df)
        scores = self.engine.score(signals)
        threshold = self.config['confidence_threshold']

        horizons = self.config['swing_horizons']
        labels = self.config['swing_horizon_labels']

        return self._measure_accuracy(ticker, df, scores, threshold, horizons, labels, 'swing')

    def _filter_market_hours(self, df):
        """Filter DataFrame to market hours only (9:30 AM - 4:00 PM ET)"""
        if df.index.tz is None:
            # Assume ET for Polygon data
            df = df.copy()
        market_open = dtime(self.config['market_open_hour'], self.config['market_open_min'])
        market_close = dtime(self.config['market_close_hour'], 0)
        mask = (df.index.time >= market_open) & (df.index.time < market_close)
        return df[mask]

    def _measure_accuracy(self, ticker, df, scores, threshold, horizons, labels, mode):
        """Core measurement: at each signal bar, look forward and record what happened"""
        close = df['close']
        max_horizon = max(horizons)

        # Find bars where model made a prediction (confidence >= threshold)
        pred_mask = scores['confidence'] >= threshold
        pred_indices = scores.index[pred_mask]

        predictions = []
        for idx in pred_indices:
            pos = close.index.get_loc(idx)
            # Need enough future bars to measure all horizons
            if pos + max_horizon >= len(close):
                continue

            entry_price = close.iloc[pos]
            direction = scores.loc[idx, 'direction']  # 1 = BULL, -1 = BEAR
            confidence = scores.loc[idx, 'confidence']
            bull_score = scores.loc[idx, 'bull_score']
            bear_score = scores.loc[idx, 'bear_score']

            if direction == 0:  # NEUTRAL — skip
                continue

            pred = {
                'timestamp': idx,
                'entry_price': entry_price,
                'direction': direction,
                'confidence': confidence,
                'bull_score': bull_score,
                'bear_score': bear_score,
            }

            # Measure outcome at each horizon
            for h, label in zip(horizons, labels):
                future_price = close.iloc[pos + h]
                price_change_pct = (future_price - entry_price) / entry_price * 100

                # Did price move in predicted direction?
                if direction == 1:  # BULL prediction
                    correct = price_change_pct > 0
                    directional_move = price_change_pct
                else:  # BEAR prediction
                    correct = price_change_pct < 0
                    directional_move = -price_change_pct  # flip for bear

                pred[f'{label}_change'] = round(price_change_pct, 4)
                pred[f'{label}_correct'] = correct
                pred[f'{label}_dir_move'] = round(directional_move, 4)

            # Max Favorable Excursion (MFE) — best price reached in predicted direction
            # Max Adverse Excursion (MAE) — worst price reached against predicted direction
            future_window = close.iloc[pos:pos + max_horizon + 1]
            if direction == 1:  # BULL
                mfe = (future_window.max() - entry_price) / entry_price * 100
                mae = (future_window.min() - entry_price) / entry_price * 100
            else:  # BEAR
                mfe = (entry_price - future_window.min()) / entry_price * 100
                mae = (entry_price - future_window.max()) / entry_price * 100

            pred['mfe'] = round(mfe, 4)
            pred['mae'] = round(mae, 4)

            # Session classification (for day trade only)
            if mode == 'day':
                pred['session'] = self._classify_session(idx)

            predictions.append(pred)

        if not predictions:
            return {'ticker': ticker, 'error': 'No predictions above threshold', 'predictions': 0}

        return self._compile_results(ticker, predictions, labels, mode)

    def _classify_session(self, timestamp):
        """Classify timestamp into trading session"""
        t = timestamp.time()
        if t < dtime(9, 21):
            return 'OPEN_RUSH'
        elif t < dtime(10, 1):
            return 'POWER_OPEN'
        elif t < dtime(15, 1):
            return 'MIDDAY'
        elif t < dtime(16, 16):
            return 'POWER_HOUR'
        else:
            return 'AFTER_HOURS'

    def _compile_results(self, ticker, predictions, labels, mode):
        """Compile prediction list into structured accuracy report"""
        pdf = pd.DataFrame(predictions)
        bins = self.config['confidence_bins']
        n = len(predictions)

        # Count BULL vs BEAR predictions
        bull_preds = len(pdf[pdf['direction'] == 1])
        bear_preds = len(pdf[pdf['direction'] == -1])

        result = {
            'ticker': ticker,
            'predictions': n,
            'bull_predictions': bull_preds,
            'bear_predictions': bear_preds,
            'avg_confidence': round(pdf['confidence'].mean(), 1),
        }

        # Accuracy at each horizon
        for label in labels:
            col = f'{label}_correct'
            move_col = f'{label}_dir_move'
            change_col = f'{label}_change'
            if col in pdf.columns:
                correct = pdf[col].sum()
                accuracy = round(correct / n * 100, 1)
                avg_move = round(pdf[change_col].mean(), 4)
                avg_dir_move = round(pdf[move_col].mean(), 4)

                result[f'{label}_accuracy'] = accuracy
                result[f'{label}_avg_move'] = avg_move
                result[f'{label}_avg_dir_move'] = avg_dir_move

                # BULL vs BEAR accuracy separately
                bull_mask = pdf['direction'] == 1
                bear_mask = pdf['direction'] == -1
                if bull_mask.sum() > 0:
                    result[f'{label}_bull_accuracy'] = round(pdf.loc[bull_mask, col].mean() * 100, 1)
                if bear_mask.sum() > 0:
                    result[f'{label}_bear_accuracy'] = round(pdf.loc[bear_mask, col].mean() * 100, 1)

        # MFE / MAE
        result['avg_mfe'] = round(pdf['mfe'].mean(), 4)
        result['avg_mae'] = round(pdf['mae'].mean(), 4)
        result['mfe_mae_ratio'] = round(pdf['mfe'].mean() / max(abs(pdf['mae'].mean()), 0.001), 2)

        # Confidence bin breakdown (accuracy at each confidence level)
        result['confidence_bins'] = {}
        for i, low in enumerate(bins):
            high = bins[i + 1] if i + 1 < len(bins) else 100
            bin_label = f'{low}-{high}'
            mask = (pdf['confidence'] >= low) & (pdf['confidence'] < high)
            bin_preds = pdf[mask]
            if len(bin_preds) > 0:
                # Use the last horizon label for the bin accuracy
                last_label = labels[-1]
                col = f'{last_label}_correct'
                result['confidence_bins'][bin_label] = {
                    'count': len(bin_preds),
                    'accuracy': round(bin_preds[col].mean() * 100, 1),
                    'avg_confidence': round(bin_preds['confidence'].mean(), 1),
                    'avg_mfe': round(bin_preds['mfe'].mean(), 4),
                }

        # Session breakdown (day trade only)
        if mode == 'day' and 'session' in pdf.columns:
            result['session_breakdown'] = {}
            for sess in pdf['session'].unique():
                sess_preds = pdf[pdf['session'] == sess]
                if len(sess_preds) > 0:
                    last_label = labels[-1]
                    col = f'{last_label}_correct'
                    result['session_breakdown'][sess] = {
                        'count': len(sess_preds),
                        'accuracy': round(sess_preds[col].mean() * 100, 1),
                        'avg_confidence': round(sess_preds['confidence'].mean(), 1),
                    }

        # Raw predictions for detailed analysis
        result['raw_predictions'] = predictions

        return result

    def run_universe(self, tickers, mode='day'):
        """Run prediction validation across multiple tickers"""
        results = []
        for i, ticker in enumerate(tickers):
            print(f"\n{'='*60}")
            print(f"[{i+1}/{len(tickers)}] {ticker} — {mode} trade validation")
            print(f"{'='*60}")
            try:
                if mode == 'day':
                    r = self.validate_day_trade(ticker)
                else:
                    r = self.validate_swing(ticker)
                results.append(r)
                if r.get('predictions', 0) > 0:
                    self._print_ticker_summary(r, mode)
            except Exception as e:
                print(f"  ❌ Error: {e}")
                import traceback
                traceback.print_exc()
                results.append({'ticker': ticker, 'error': str(e), 'predictions': 0})
        return results

    def _print_ticker_summary(self, r, mode):
        """Print a quick summary for one ticker"""
        labels = self.config[f'{"day_trade" if mode == "day" else "swing"}_horizon_labels']
        print(f"\n  📊 {r['ticker']}: {r['predictions']} predictions "
              f"({r['bull_predictions']} BULL / {r['bear_predictions']} BEAR)")
        print(f"  Avg confidence: {r['avg_confidence']}%")
        print(f"  MFE: {r['avg_mfe']:.3f}%  |  MAE: {r['avg_mae']:.3f}%  |  Ratio: {r['mfe_mae_ratio']}")

        print(f"\n  {'Horizon':<10} {'Accuracy':>10} {'Avg Move':>10} {'Bull Acc':>10} {'Bear Acc':>10}")
        print(f"  {'─'*50}")
        for label in labels:
            acc = r.get(f'{label}_accuracy', 0)
            move = r.get(f'{label}_avg_move', 0)
            bull_acc = r.get(f'{label}_bull_accuracy', '—')
            bear_acc = r.get(f'{label}_bear_accuracy', '—')
            bull_str = f"{bull_acc}%" if isinstance(bull_acc, (int, float)) else bull_acc
            bear_str = f"{bear_acc}%" if isinstance(bear_acc, (int, float)) else bear_acc
            print(f"  {label:<10} {acc:>9.1f}% {move:>9.3f}% {bull_str:>10} {bear_str:>10}")

        if 'confidence_bins' in r:
            print(f"\n  Confidence Bins:")
            for bin_label, data in r['confidence_bins'].items():
                print(f"    {bin_label}%: {data['count']} predictions, "
                      f"{data['accuracy']:.1f}% accurate, MFE {data['avg_mfe']:.3f}%")

        if 'session_breakdown' in r:
            print(f"\n  Session Breakdown:")
            for sess, data in r['session_breakdown'].items():
                print(f"    {sess}: {data['count']} predictions, {data['accuracy']:.1f}% accurate")

    @staticmethod
    def aggregate_results(results, mode_labels):
        """Aggregate results across all tickers"""
        valid = [r for r in results if r.get('predictions', 0) > 0]
        if not valid:
            return {'error': 'No valid results'}

        total_preds = sum(r['predictions'] for r in valid)
        total_bull = sum(r.get('bull_predictions', 0) for r in valid)
        total_bear = sum(r.get('bear_predictions', 0) for r in valid)

        agg = {
            'tickers_tested': len(valid),
            'total_predictions': total_preds,
            'total_bull': total_bull,
            'total_bear': total_bear,
            'avg_confidence': round(np.mean([r['avg_confidence'] for r in valid]), 1),
            'avg_mfe': round(np.mean([r['avg_mfe'] for r in valid]), 4),
            'avg_mae': round(np.mean([r['avg_mae'] for r in valid]), 4),
        }

        # Weighted accuracy at each horizon (weighted by number of predictions)
        for label in mode_labels:
            key = f'{label}_accuracy'
            weighted_acc = sum(
                r[key] * r['predictions'] for r in valid if key in r
            ) / total_preds
            agg[key] = round(weighted_acc, 1)

            # Bull vs Bear
            bull_key = f'{label}_bull_accuracy'
            bear_key = f'{label}_bear_accuracy'
            bull_accs = [r[bull_key] for r in valid if bull_key in r]
            bear_accs = [r[bear_key] for r in valid if bear_key in r]
            if bull_accs:
                agg[bull_key] = round(np.mean(bull_accs), 1)
            if bear_accs:
                agg[bear_key] = round(np.mean(bear_accs), 1)

        return agg
