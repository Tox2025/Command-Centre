"""
Prediction Accuracy Backtester CLI

Usage:
    python run_backtest.py --mode day --tickers AAPL NVDA SPY
    python run_backtest.py --mode swing --tickers AAPL MSFT --lookback 365
    python run_backtest.py --mode day --threshold 70
    python run_backtest.py --mode day --version v1.1
    python run_backtest.py --compare v1.1 v2.0-optimized --mode day --tickers AAPL SPY
"""

import argparse
import sys
import json
import os
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (DEFAULT_TICKERS, BACKTEST_CONFIG, DEFAULT_WEIGHTS,
                    load_active_weights, load_version_weights, RESULTS_DIR)
from backtester import PredictionValidator


def parse_args():
    parser = argparse.ArgumentParser(description='Signal Engine Prediction Accuracy Validator')
    parser.add_argument('--mode', choices=['day', 'swing'], default='day',
                        help='Trading mode: day (5m bars, intraday) or swing (daily bars)')
    parser.add_argument('--tickers', nargs='+', default=None,
                        help='Tickers to test (default: universe)')
    parser.add_argument('--lookback', type=int, default=None,
                        help='Lookback days (default: 60 for day, 365 for swing)')
    parser.add_argument('--threshold', type=int, default=65,
                        help='Min confidence to count as prediction (default: 65)')
    parser.add_argument('--version', type=str, default=None,
                        help='Signal weight version to test (e.g. v1.1)')
    parser.add_argument('--compare', nargs=2, metavar=('V1', 'V2'), default=None,
                        help='Compare two versions side-by-side')
    parser.add_argument('--save', action='store_true',
                        help='Save results to JSON file')
    return parser.parse_args()


def print_header(mode, version, threshold, tickers, lookback):
    print(f"\n{'═'*70}")
    print(f"  SIGNAL ENGINE PREDICTION ACCURACY VALIDATOR")
    print(f"{'═'*70}")
    print(f"  Mode:       {'Day Trade (5m bars)' if mode == 'day' else 'Swing Trade (daily bars)'}")
    print(f"  Version:    {version}")
    print(f"  Threshold:  {threshold}% confidence minimum")
    print(f"  Tickers:    {len(tickers)} tickers")
    print(f"  Lookback:   {lookback} days")
    if mode == 'day':
        print(f"  Horizons:   15min / 30min / 1hr / 2hr")
    else:
        print(f"  Horizons:   1d / 2d / 3d / 5d")
    print(f"{'═'*70}")


def print_aggregate(agg, mode):
    labels = BACKTEST_CONFIG[f'{"day_trade" if mode == "day" else "swing"}_horizon_labels']
    print(f"\n{'═'*70}")
    print(f"  AGGREGATE RESULTS — {agg['tickers_tested']} tickers")
    print(f"{'═'*70}")
    print(f"  Total predictions: {agg['total_predictions']} ({agg['total_bull']} BULL / {agg['total_bear']} BEAR)")
    print(f"  Avg confidence:    {agg['avg_confidence']}%")
    print(f"  Avg MFE:           {agg['avg_mfe']:.3f}%")
    print(f"  Avg MAE:           {agg['avg_mae']:.3f}%")

    print(f"\n  {'Horizon':<10} {'Accuracy':>10} {'Bull Acc':>10} {'Bear Acc':>10}")
    print(f"  {'─'*42}")
    for label in labels:
        acc = agg.get(f'{label}_accuracy', 0)
        bull_acc = agg.get(f'{label}_bull_accuracy', '—')
        bear_acc = agg.get(f'{label}_bear_accuracy', '—')
        bull_str = f"{bull_acc}%" if isinstance(bull_acc, (int, float)) else bull_acc
        bear_str = f"{bear_acc}%" if isinstance(bear_acc, (int, float)) else bear_acc
        marker = ' ✅' if isinstance(acc, (int, float)) and acc >= 55 else ''
        print(f"  {label:<10} {acc:>9.1f}% {bull_str:>10} {bear_str:>10}{marker}")

    print(f"\n{'═'*70}")


def print_per_ticker_table(results, mode):
    labels = BACKTEST_CONFIG[f'{"day_trade" if mode == "day" else "swing"}_horizon_labels']
    valid = [r for r in results if r.get('predictions', 0) > 0]
    if not valid:
        print("  No valid results to display.")
        return

    # Pick the most relevant horizon for the summary
    main_label = labels[2] if len(labels) > 2 else labels[-1]  # 1hr for day, 3d for swing

    print(f"\n  {'Ticker':<8} {'Preds':>6} {'Bull':>5} {'Bear':>5} {'Conf':>6} "
          f"{f'{main_label} Acc':>8} {'MFE':>8} {'MAE':>8} {'MFE/MAE':>8}")
    print(f"  {'─'*70}")

    for r in sorted(valid, key=lambda x: x.get(f'{main_label}_accuracy', 0), reverse=True):
        acc = r.get(f'{main_label}_accuracy', 0)
        marker = '✅' if acc >= 55 else '❌' if acc < 45 else '  '
        print(f"  {r['ticker']:<8} {r['predictions']:>6} {r.get('bull_predictions',0):>5} "
              f"{r.get('bear_predictions',0):>5} {r['avg_confidence']:>5.1f}% "
              f"{acc:>7.1f}% {r['avg_mfe']:>7.3f}% {r['avg_mae']:>7.3f}% "
              f"{r.get('mfe_mae_ratio', 0):>7.2f}  {marker}")


def print_comparison(results_a, results_b, v1, v2, mode):
    labels = BACKTEST_CONFIG[f'{"day_trade" if mode == "day" else "swing"}_horizon_labels']
    main_label = labels[2] if len(labels) > 2 else labels[-1]

    valid_a = {r['ticker']: r for r in results_a if r.get('predictions', 0) > 0}
    valid_b = {r['ticker']: r for r in results_b if r.get('predictions', 0) > 0}
    common = sorted(set(valid_a.keys()) & set(valid_b.keys()))

    if not common:
        print("  No common tickers with predictions.")
        return

    print(f"\n{'═'*80}")
    print(f"  COMPARISON: {v1} vs {v2} — {mode} trade")
    print(f"{'═'*80}")
    print(f"\n  {'Ticker':<8} {f'{v1} Acc':>10} {f'{v2} Acc':>10} {'Delta':>8} "
          f"{f'{v1} MFE':>8} {f'{v2} MFE':>8} {'Winner':>8}")
    print(f"  {'─'*66}")

    v1_wins = 0
    v2_wins = 0

    for ticker in common:
        a = valid_a[ticker]
        b = valid_b[ticker]
        acc_a = a.get(f'{main_label}_accuracy', 0)
        acc_b = b.get(f'{main_label}_accuracy', 0)
        mfe_a = a.get('avg_mfe', 0)
        mfe_b = b.get('avg_mfe', 0)
        delta = acc_b - acc_a
        winner = v2 if acc_b > acc_a else v1 if acc_a > acc_b else 'Tie'
        if acc_b > acc_a:
            v2_wins += 1
        elif acc_a > acc_b:
            v1_wins += 1

        delta_str = f"+{delta:.1f}" if delta > 0 else f"{delta:.1f}"
        print(f"  {ticker:<8} {acc_a:>9.1f}% {acc_b:>9.1f}% {delta_str:>7}% "
              f"{mfe_a:>7.3f}% {mfe_b:>7.3f}% {winner:>8}")

    print(f"\n  Summary: {v1} wins {v1_wins} tickers, {v2} wins {v2_wins} tickers")

    # Aggregate comparison
    agg_a = PredictionValidator.aggregate_results(results_a, labels)
    agg_b = PredictionValidator.aggregate_results(results_b, labels)

    print(f"\n  Aggregate:")
    for label in labels:
        acc_a = agg_a.get(f'{label}_accuracy', 0)
        acc_b = agg_b.get(f'{label}_accuracy', 0)
        delta = acc_b - acc_a
        delta_str = f"+{delta:.1f}" if delta > 0 else f"{delta:.1f}"
        marker = f"← {v2}" if delta > 0 else f"← {v1}" if delta < 0 else "Tie"
        print(f"    {label:<10}: {v1} {acc_a:.1f}%  vs  {v2} {acc_b:.1f}%  ({delta_str}%)  {marker}")


def main():
    args = parse_args()
    tickers = args.tickers or DEFAULT_TICKERS
    mode = args.mode

    # Set lookback
    if args.lookback:
        lookback = args.lookback
    else:
        lookback = BACKTEST_CONFIG['day_trade_lookback_days'] if mode == 'day' else BACKTEST_CONFIG['swing_lookback_days']

    config = BACKTEST_CONFIG.copy()
    config['confidence_threshold'] = args.threshold
    if mode == 'day':
        config['day_trade_lookback_days'] = lookback
    else:
        config['swing_lookback_days'] = lookback

    # ── Compare mode ───────────────────────────────────────
    if args.compare:
        v1, v2 = args.compare
        print(f"\n🔄 Comparing {v1} vs {v2}...")

        w1 = load_version_weights(v1)
        validator_a = PredictionValidator(w1, config)
        results_a = validator_a.run_universe(tickers, mode)

        w2 = load_version_weights(v2)
        validator_b = PredictionValidator(w2, config)
        results_b = validator_b.run_universe(tickers, mode)

        print_comparison(results_a, results_b, v1, v2, mode)
        return

    # ── Single version mode ────────────────────────────────
    if args.version:
        weights = load_version_weights(args.version)
        version_name = args.version
    else:
        weights, version_name = load_active_weights()

    print_header(mode, version_name, args.threshold, tickers, lookback)

    validator = PredictionValidator(weights, config)
    results = validator.run_universe(tickers, mode)

    labels = config[f'{"day_trade" if mode == "day" else "swing"}_horizon_labels']
    agg = PredictionValidator.aggregate_results(results, labels)

    print_aggregate(agg, mode)
    print_per_ticker_table(results, mode)

    if args.save:
        # Save results (without raw predictions to keep file size reasonable)
        save_results = []
        for r in results:
            r_copy = {k: v for k, v in r.items() if k != 'raw_predictions'}
            save_results.append(r_copy)

        output_path = os.path.join(RESULTS_DIR, f'accuracy_{mode}_{version_name}.json')
        with open(output_path, 'w') as f:
            json.dump({'aggregate': agg, 'per_ticker': save_results}, f, indent=2, default=str)
        print(f"\n  💾 Results saved to {output_path}")


if __name__ == '__main__':
    main()
