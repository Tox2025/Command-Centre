#!/usr/bin/env python3
"""
VectorBt Backtesting CLI — run backtests, compare versions, optimize weights.

Usage:
  python run_backtest.py                                    # Backtest 20 tickers daily
  python run_backtest.py --tickers AAPL,NVDA --lookback 365 # Specific tickers
  python run_backtest.py --timeframe weekly                 # Weekly bars (swing)
  python run_backtest.py --version v1.1                     # Use specific weight version
  python run_backtest.py --compare v1.1 v2.0-optimized      # A/B comparison
  python run_backtest.py --optimize                          # Weight optimization
  python run_backtest.py --ml-train                          # Generate ML data
"""
import argparse
import sys
import json
from datetime import datetime


def load_version_weights(version_name):
    """Load weights for a specific version from signal-versions.json"""
    import os
    path = os.path.join(os.path.dirname(__file__), '..', 'data', 'signal-versions.json')
    if not os.path.exists(path):
        return None, None
    with open(path) as f:
        data = json.load(f)
    if version_name in data.get('versions', {}):
        v = data['versions'][version_name]
        return v.get('weights', {}), v.get('description', version_name)
    return None, None


def run_single_backtest(tickers, weights, version_name, args, timeframe='daily'):
    """Run a single backtest and return results"""
    from backtester import Backtester
    bt = Backtester(weights)
    bt.config['lookback_days'] = args.lookback
    bt.config['confidence_threshold'] = args.threshold
    results = bt.run_universe(tickers, timeframe=timeframe)
    results['version'] = version_name
    results['timeframe'] = timeframe
    return results, bt


def print_results(results, label=""):
    """Pretty-print backtest results"""
    header = f"RESULTS — {label}" if label else "RESULTS"
    print(f"\n{'=' * 60}")
    print(f"  {header}")
    print(f"{'=' * 60}")
    print(f"  Tickers tested: {results.get('tickers_tested', 0)}")
    print(f"  Total trades:   {results.get('total_trades', 0)}")
    print(f"  Win rate:       {results.get('win_rate', 0):.1f}%")
    print(f"  Avg Sharpe:     {results.get('avg_sharpe', 0):.2f}")
    print(f"  Total P&L:      {results.get('total_pnl', 0):.2f}%")
    print(f"  Max Drawdown:   {results.get('max_drawdown', 0):.2f}%")
    print(f"  Profit Factor:  {results.get('avg_profit_factor', 0):.2f}")

    per = results.get('per_ticker', {})
    if per:
        print(f"\n{'Ticker':<8} {'Trades':>7} {'WR%':>6} {'Sharpe':>7} {'P&L%':>8} {'PF':>6}")
        print("-" * 44)
        for t in sorted(per.keys()):
            r = per[t]
            if r.get('total_trades', 0) > 0:
                print(f"{t:<8} {r['total_trades']:>7} {r.get('win_rate',0):>5.1f}% "
                      f"{r.get('sharpe',0):>7.2f} {r.get('total_pnl',0):>7.2f}% "
                      f"{r.get('profit_factor',0):>5.2f}")


def print_comparison(results_a, results_b, name_a, name_b):
    """Print side-by-side comparison of two backtest runs"""
    print(f"\n{'=' * 70}")
    print(f"  COMPARISON: {name_a} vs {name_b}")
    print(f"{'=' * 70}")

    metrics = [
        ('Win Rate', 'win_rate', '%', 1),
        ('Avg Sharpe', 'avg_sharpe', '', 2),
        ('Total P&L', 'total_pnl', '%', 2),
        ('Total Trades', 'total_trades', '', 0),
        ('Profit Factor', 'avg_profit_factor', '', 2),
        ('Max Drawdown', 'max_drawdown', '%', 2),
    ]
    print(f"\n{'Metric':<16} {name_a:>12} {name_b:>12} {'Δ Change':>12}")
    print("-" * 54)
    for label, key, unit, dec in metrics:
        a = results_a.get(key, 0)
        b = results_b.get(key, 0)
        delta = b - a
        arrow = '↑' if delta > 0 else '↓' if delta < 0 else '→'
        if dec == 0:
            print(f"{label:<16} {a:>11}{unit} {b:>11}{unit} {arrow} {delta:>+.{dec}f}{unit}")
        else:
            print(f"{label:<16} {a:>11.{dec}f}{unit} {b:>11.{dec}f}{unit} {arrow} {delta:>+.{dec}f}{unit}")

    # Per-ticker comparison
    per_a = results_a.get('per_ticker', {})
    per_b = results_b.get('per_ticker', {})
    all_tickers = sorted(set(list(per_a.keys()) + list(per_b.keys())))
    if all_tickers:
        print(f"\n{'Ticker':<8} {'P&L A':>8} {'P&L B':>8} {'Δ':>8}  {'Sharpe A':>9} {'Sharpe B':>9} {'Δ':>8}")
        print("-" * 60)
        improved = 0
        worse = 0
        for t in all_tickers:
            ra = per_a.get(t, {})
            rb = per_b.get(t, {})
            pnl_a = ra.get('total_pnl', 0)
            pnl_b = rb.get('total_pnl', 0)
            sh_a = ra.get('sharpe', 0)
            sh_b = rb.get('sharpe', 0)
            d_pnl = pnl_b - pnl_a
            d_sh = sh_b - sh_a
            flag = '✅' if d_pnl > 0 else '❌' if d_pnl < 0 else '  '
            if d_pnl > 0: improved += 1
            elif d_pnl < 0: worse += 1
            print(f"{t:<8} {pnl_a:>7.2f}% {pnl_b:>7.2f}% {d_pnl:>+7.2f}%  "
                  f"{sh_a:>8.2f} {sh_b:>8.2f} {d_sh:>+7.2f} {flag}")
        print(f"\n  Improved: {improved}/{len(all_tickers)}  |  Worse: {worse}/{len(all_tickers)}")


def main():
    parser = argparse.ArgumentParser(description='VectorBt Backtesting Engine')
    parser.add_argument('--tickers', type=str, default='',
                        help='Comma-separated ticker list')
    parser.add_argument('--lookback', type=int, default=365,
                        help='Lookback period in days (default: 365)')
    parser.add_argument('--threshold', type=int, default=65,
                        help='Confidence threshold (default: 65)')
    parser.add_argument('--timeframe', type=str, default='daily',
                        choices=['daily', 'weekly'],
                        help='Timeframe: daily or weekly')
    parser.add_argument('--version', type=str, default='',
                        help='Use specific weight version (e.g. v2.0-optimized)')
    parser.add_argument('--compare', nargs=2, metavar=('V1', 'V2'),
                        help='Compare two versions A/B (e.g. --compare v1.1 v2.0-optimized)')
    parser.add_argument('--optimize', action='store_true',
                        help='Run weight optimization')
    parser.add_argument('--ml-train', action='store_true',
                        help='Generate ML training data')
    args = parser.parse_args()

    print("=" * 60)
    print("  VectorBt Backtesting Engine")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    from config import DEFAULT_TICKERS, BACKTEST_CONFIG, load_active_weights
    tickers = args.tickers.split(',') if args.tickers else DEFAULT_TICKERS
    tickers = [t.strip().upper() for t in tickers if t.strip()]

    # Load weights based on mode
    if args.compare:
        # ── A/B Comparison Mode ──
        v1_name, v2_name = args.compare
        w1, desc1 = load_version_weights(v1_name)
        w2, desc2 = load_version_weights(v2_name)
        if not w1:
            print(f"❌ Version '{v1_name}' not found in signal-versions.json")
            return
        if not w2:
            print(f"❌ Version '{v2_name}' not found in signal-versions.json")
            return

        print(f"Comparing: {v1_name} vs {v2_name}")
        print(f"Tickers: {', '.join(tickers)}")
        print(f"Lookback: {args.lookback} days | Timeframe: {args.timeframe}")

        print(f"\n{'=' * 60}")
        print(f"  BACKTEST A — {v1_name}")
        print(f"{'=' * 60}")
        results_a, bt_a = run_single_backtest(tickers, w1, v1_name, args, args.timeframe)
        print_results(results_a, v1_name)

        print(f"\n{'=' * 60}")
        print(f"  BACKTEST B — {v2_name}")
        print(f"{'=' * 60}")
        results_b, bt_b = run_single_backtest(tickers, w2, v2_name, args, args.timeframe)
        print_results(results_b, v2_name)

        print_comparison(results_a, results_b, v1_name, v2_name)

        # Save comparison
        bt_a.save_results({
            'comparison': True,
            'versions': [v1_name, v2_name],
            'timeframe': args.timeframe,
            v1_name: results_a,
            v2_name: results_b,
        }, f"compare_{v1_name}_vs_{v2_name}_{args.timeframe}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")

    elif args.optimize:
        # ── Weight Optimization ──
        print(f"\n{'=' * 60}")
        print("  WEIGHT OPTIMIZATION")
        print(f"{'=' * 60}")
        from optimizer import Optimizer
        opt = Optimizer(tickers[:10])
        opt.bt_config['lookback_days'] = args.lookback
        opt.bt_config['confidence_threshold'] = args.threshold
        optimized, metrics, new_version = opt.run_and_save()
        print(f"\n✅ Optimization complete! Saved as {new_version}")
        print(f"   Sharpe: {metrics.get('sharpe', 0):.2f}")
        print(f"   Win Rate: {metrics.get('win_rate', 0):.1f}%")
        print(f"   Trades: {metrics.get('total_trades', 0)}")

    elif args.ml_train:
        # ── ML Training Data ──
        print(f"\n{'=' * 60}")
        print("  ML TRAINING DATA GENERATION")
        print(f"{'=' * 60}")
        weights, version = load_active_weights()
        from ml_trainer import MLTrainer
        trainer = MLTrainer(weights)
        day_samples, swing_samples = trainer.generate_and_export(tickers, args.lookback)
        print(f"\n✅ ML data generated!")
        print(f"   Day trade: {len(day_samples) if day_samples else 0} samples")
        print(f"   Swing: {len(swing_samples) if swing_samples else 0} samples")

    else:
        # ── Standard Backtest ──
        if args.version:
            weights, desc = load_version_weights(args.version)
            if not weights:
                print(f"❌ Version '{args.version}' not found")
                return
            version_name = args.version
        else:
            weights, version_name = load_active_weights()

        print(f"Signal weights: {version_name}")
        print(f"Tickers: {', '.join(tickers)}")
        print(f"Lookback: {args.lookback} days | Timeframe: {args.timeframe}")

        print(f"\n{'=' * 60}")
        print(f"  BACKTEST — {version_name} ({args.timeframe})")
        print(f"{'=' * 60}")
        results, bt = run_single_backtest(tickers, weights, version_name, args, args.timeframe)
        print_results(results, f"{version_name} {args.timeframe}")
        bt.save_results(results)

    print("\n✅ Done!")


if __name__ == '__main__':
    main()
