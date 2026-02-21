"""
Weight Optimizer — finds optimal signal weights via walk-forward grid search.
Tests weight variations on historical data and saves best performers.
"""
import numpy as np
import itertools
from copy import deepcopy
from backtester import Backtester
from data_fetcher import DataFetcher
from config import (DEFAULT_WEIGHTS, BACKTESTABLE_SIGNALS, OPTIMIZE_CONFIG,
                    BACKTEST_CONFIG, DEFAULT_TICKERS, save_optimized_weights)


class Optimizer:
    def __init__(self, tickers=None, config=None):
        self.tickers = tickers or DEFAULT_TICKERS[:10]
        self.config = config or OPTIMIZE_CONFIG.copy()
        self.bt_config = BACKTEST_CONFIG.copy()
        self.fetcher = DataFetcher()
        self.data_cache = {}

    def _prefetch(self):
        """Pre-fetch all ticker data"""
        print("📡 Pre-fetching data for optimization universe...")
        for ticker in self.tickers:
            if ticker not in self.data_cache:
                self.data_cache[ticker] = self.fetcher.fetch_daily(
                    ticker, self.bt_config['lookback_days'])
        valid = {k: v for k, v in self.data_cache.items() if not v.empty and len(v) >= 50}
        print(f"✅ {len(valid)}/{len(self.tickers)} tickers loaded")
        return valid

    def _evaluate(self, weights):
        """Evaluate a weight set across the universe"""
        bt = Backtester(weights, self.bt_config)
        total_trades = 0
        total_wins = 0
        sharpes = []
        pnls = []

        for ticker, df in self.data_cache.items():
            if df.empty or len(df) < 50:
                continue
            result = bt.run(ticker, df)
            if result.get('total_trades', 0) > 0:
                total_trades += result['total_trades']
                total_wins += result.get('wins', 0)
                sharpes.append(result.get('sharpe', 0))
                pnls.append(result.get('total_pnl', 0))

        if total_trades < self.config['min_trades']:
            return {'score': -999, 'total_trades': total_trades}

        metric = self.config['metric']
        if metric == 'sharpe':
            score = np.mean(sharpes) if sharpes else 0
        elif metric == 'win_rate':
            score = total_wins / max(total_trades, 1) * 100
        elif metric == 'profit_factor':
            win_sum = sum(max(p, 0) for p in pnls)
            loss_sum = abs(sum(min(p, 0) for p in pnls)) or 0.01
            score = win_sum / loss_sum
        else:
            score = sum(pnls)

        return {
            'score': round(score, 4),
            'total_trades': total_trades,
            'win_rate': round(total_wins / max(total_trades, 1) * 100, 1),
            'sharpe': round(np.mean(sharpes), 2) if sharpes else 0,
            'total_pnl': round(sum(pnls), 2),
        }

    def optimize_single_signal(self, signal_key, base_weights=None):
        """Optimize a single signal weight while keeping others fixed"""
        weights = deepcopy(base_weights or DEFAULT_WEIGHTS)
        best_score = -999
        best_weight = weights[signal_key]
        lo, hi = self.config['weight_range']
        step = self.config['weight_step']

        for w in range(lo, hi + 1, step):
            weights[signal_key] = w
            result = self._evaluate(weights)
            if result['score'] > best_score:
                best_score = result['score']
                best_weight = w
                print(f"  {signal_key}={w}: score={result['score']:.4f} "
                      f"trades={result['total_trades']} wr={result.get('win_rate', 0)}%")

        return best_weight, best_score

    def optimize_top_signals(self):
        """Optimize the top N most impactful backtestable signals"""
        self._prefetch()

        # Baseline
        print("\n📊 Baseline evaluation...")
        baseline = self._evaluate(DEFAULT_WEIGHTS)
        print(f"Baseline: score={baseline['score']:.4f} trades={baseline['total_trades']} "
              f"wr={baseline.get('win_rate', 0)}%")

        # Rank signals by sensitivity
        print("\n🔬 Ranking signal sensitivity...")
        sensitivity = {}
        for sig in BACKTESTABLE_SIGNALS:
            weights_off = deepcopy(DEFAULT_WEIGHTS)
            weights_off[sig] = 0
            result = self._evaluate(weights_off)
            impact = baseline['score'] - result['score']
            sensitivity[sig] = impact
            print(f"  {sig}: impact={impact:.4f}")

        # Sort by absolute impact
        ranked = sorted(sensitivity.items(), key=lambda x: abs(x[1]), reverse=True)
        top_signals = [s[0] for s in ranked[:self.config['top_signals_to_optimize']]]
        print(f"\n🎯 Optimizing top {len(top_signals)}: {', '.join(top_signals)}")

        # Sequential optimization
        optimized = deepcopy(DEFAULT_WEIGHTS)
        for sig in top_signals:
            print(f"\n── Optimizing {sig} ──")
            best_w, best_s = self.optimize_single_signal(sig, optimized)
            optimized[sig] = best_w
            print(f"  → Best: {sig}={best_w}")

        # Final evaluation
        print("\n📊 Final evaluation with optimized weights...")
        final = self._evaluate(optimized)
        print(f"Optimized: score={final['score']:.4f} trades={final['total_trades']} "
              f"wr={final.get('win_rate', 0)}%")
        print(f"Improvement: {final['score'] - baseline['score']:.4f}")

        return optimized, final

    def run_and_save(self):
        """Full optimization pipeline: optimize, evaluate, save"""
        optimized_weights, metrics = self.optimize_top_signals()

        metrics['tickers_tested'] = len(self.tickers)
        metrics['lookback_days'] = self.bt_config['lookback_days']

        # Save to signal-versions.json
        version = save_optimized_weights(optimized_weights, metrics)

        # Print weight changes
        print("\n📋 Weight Changes:")
        for key in sorted(optimized_weights.keys()):
            old = DEFAULT_WEIGHTS.get(key, 0)
            new = optimized_weights[key]
            if old != new:
                print(f"  {key}: {old} → {new}")

        return optimized_weights, metrics, version
