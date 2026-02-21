"""
ML Training Data Generator — creates labeled datasets for the Node.js ML Calibrator.
Labels are based on actual price outcomes after signal generation.
"""
import numpy as np
import pandas as pd
import json
import os
from signal_engine import SignalEngine
from data_fetcher import DataFetcher
from config import DEFAULT_WEIGHTS, DATA_DIR, DEFAULT_TICKERS


class MLTrainer:
    def __init__(self, weights=None):
        self.engine = SignalEngine(weights)
        self.fetcher = DataFetcher()

    def generate_training_data(self, tickers=None, lookback_days=365,
                                hold_period=5, tp_atr_mult=1.0):
        """Generate labeled ML training data from historical bars.
        
        Label = 1 if price moved favorably by >= 1 ATR within hold_period bars, 0 otherwise.
        """
        tickers = tickers or DEFAULT_TICKERS
        all_samples = []

        for i, ticker in enumerate(tickers):
            print(f"[{i+1}/{len(tickers)}] Generating ML data for {ticker}...")
            df = self.fetcher.fetch_daily(ticker, lookback_days)
            if df.empty or len(df) < 60:
                continue

            signals = self.engine.compute_all_signals(df)
            scores = self.engine.score(signals)
            features = self.engine.extract_ml_features(signals)
            close = df['close'].values
            atr_vals = signals['_atr'].fillna(df['close'] * 0.02).values

            for j in range(50, len(df) - hold_period):
                feat_row = features.iloc[j].values
                if np.any(np.isnan(feat_row)):
                    continue

                direction = scores['direction'].iloc[j]
                if direction == 0:
                    continue

                entry_price = close[j]
                atr_at_entry = atr_vals[j]
                target = entry_price + (direction * atr_at_entry * tp_atr_mult)

                # Check if target hit within hold_period
                label = 0
                best_pnl = 0
                for k in range(1, hold_period + 1):
                    future_price = close[j + k]
                    pnl = (future_price - entry_price) * direction / entry_price
                    best_pnl = max(best_pnl, pnl)
                    if direction == 1 and future_price >= target:
                        label = 1
                        break
                    elif direction == -1 and future_price <= target:
                        label = 1
                        break

                all_samples.append({
                    'features': feat_row.tolist(),
                    'label': label,
                    'confidence': float(scores['confidence'].iloc[j]),
                    'pnlPct': round(best_pnl * 100, 2),
                    'ticker': ticker,
                    'direction': 'BULLISH' if direction == 1 else 'BEARISH',
                })

        print(f"\n✅ Generated {len(all_samples)} training samples")
        if all_samples:
            labels = [s['label'] for s in all_samples]
            print(f"   Positive: {sum(labels)} ({sum(labels)/len(labels)*100:.1f}%)")
            print(f"   Negative: {len(labels)-sum(labels)} ({(1-sum(labels)/len(labels))*100:.1f}%)")

        return all_samples

    def export_for_node(self, samples, timeframe='dayTrade'):
        """Export training data in format expected by Node.js MLCalibrator.train()"""
        output = {
            'timeframe': timeframe,
            'generatedAt': pd.Timestamp.now().isoformat(),
            'totalSamples': len(samples),
            'samples': samples
        }
        path = os.path.join(DATA_DIR, f'ml-training-{timeframe}.json')
        with open(path, 'w') as f:
            json.dump(output, f)
        print(f"📁 Exported {len(samples)} samples → {path}")
        return path

    def generate_and_export(self, tickers=None, lookback_days=365):
        """Full pipeline: generate data for both timeframes and export"""
        # Day trade data (hold 1-5 bars)
        print("\n═══ Day Trade Training Data ═══")
        day_samples = self.generate_training_data(tickers, lookback_days, hold_period=5)
        if day_samples:
            self.export_for_node(day_samples, 'dayTrade')

        # Swing data (hold 5-20 bars)
        print("\n═══ Swing Trading Training Data ═══")
        swing_samples = self.generate_training_data(tickers, lookback_days,
                                                      hold_period=20, tp_atr_mult=2.0)
        if swing_samples:
            self.export_for_node(swing_samples, 'swing')

        return day_samples, swing_samples
