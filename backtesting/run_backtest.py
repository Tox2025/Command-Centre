#!/usr/bin/env python3
"""
VectorBt Backtesting CLI — run backtests, optimize weights, generate ML data.

Usage:
  python run_backtest.py                          # Default: backtest top 10 tickers
  python run_backtest.py --tickers AAPL,NVDA      # Specific tickers
  python run_backtest.py --optimize               # Run weight optimization
  python run_backtest.py --ml-train               # Generate ML training data
  python run_backtest.py --lookback 180           # Custom lookback days
  python run_backtest.py --threshold 70           # Custom confidence threshold
"""
import argparse
import sys
import json
from datetime import datetime


def main():
    parser = argparse.ArgumentParser(description='VectorBt Backtesting Engine')
    parser.add_argument('--tickers', type=str, default='',
                        help='Comma-separated ticker list (default: top 20)')
    parser.add_argument('--lookback', type=int, default=365,
                        help='Lookback period in days (default: 365)')
    parser.add_argument('--threshold', type=int, default=65,
                        help='Confidence threshold for entries (default: 65)')
    parser.add_argument('--optimize', action='store_true',
                        help='Run weight optimization pipeline')
    parser.add_argument('--ml-train', action='store_true',
                        help='Generate ML training data')
    parser.add_argument('--report', action='store_true',
                        help='Generate detailed report')
    parser.add_argument('--output', type=str, default='',
                        help='Output file path')
    args = parser.parse_args()

    print("=" * 60)
    print("  VectorBt Backtesting Engine")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    # Parse tickers
    from config import DEFAULT_TICKERS, BACKTEST_CONFIG, load_active_weights
    tickers = args.tickers.split(',') if args.tickers else DEFAULT_TICKERS
    tickers = [t.strip().upper() for t in tickers if t.strip()]

    # Load active weights
    weights, version = load_active_weights()
    print(f"Signal weights: {version}")
    print(f"Tickers: {', '.join(tickers)}")
    print(f"Lookback: {args.lookback} days")

    if args.optimize:
        # ── Weight Optimization ──
        print("\n" + "=" * 60)
        print("  WEIGHT OPTIMIZATION")
        print("=" * 60)
        from optimizer import Optimizer
        opt = Optimizer(tickers[:10])  # optimize on top 10
        opt.bt_config['lookback_days'] = args.lookback
        opt.bt_config['confidence_threshold'] = args.threshold
        optimized, metrics, new_version = opt.run_and_save()
        print(f"\n✅ Optimization complete! Saved as {new_version}")
        print(f"   Sharpe: {metrics.get('sharpe', 0):.2f}")
        print(f"   Win Rate: {metrics.get('win_rate', 0):.1f}%")
        print(f"   Trades: {metrics.get('total_trades', 0)}")

    elif args.ml_train:
        # ── ML Training Data Generation ──
        print("\n" + "=" * 60)
        print("  ML TRAINING DATA GENERATION")
        print("=" * 60)
        from ml_trainer import MLTrainer
        trainer = MLTrainer(weights)
        day_samples, swing_samples = trainer.generate_and_export(tickers, args.lookback)
        print(f"\n✅ ML data generated!")
        print(f"   Day trade: {len(day_samples) if day_samples else 0} samples")
        print(f"   Swing: {len(swing_samples) if swing_samples else 0} samples")

    else:
        # ── Standard Backtest ──
        print("\n" + "=" * 60)
        print("  BACKTEST")
        print("=" * 60)
        from backtester import Backtester
        bt = Backtester(weights)
        bt.config['lookback_days'] = args.lookback
        bt.config['confidence_threshold'] = args.threshold
        results = bt.run_universe(tickers)

        # Print results
        print("\n" + "=" * 60)
        print("  RESULTS")
        print("=" * 60)
        print(f"  Tickers tested: {results.get('tickers_tested', 0)}")
        print(f"  Total trades:   {results.get('total_trades', 0)}")
        print(f"  Win rate:       {results.get('win_rate', 0):.1f}%")
        print(f"  Avg Sharpe:     {results.get('avg_sharpe', 0):.2f}")
        print(f"  Total P&L:      {results.get('total_pnl', 0):.2f}%")
        print(f"  Max Drawdown:   {results.get('max_drawdown', 0):.2f}%")
        print(f"  Profit Factor:  {results.get('avg_profit_factor', 0):.2f}")

        # Per-ticker breakdown
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

        # Save results
        bt.save_results(results)

    print("\n✅ Done!")


if __name__ == '__main__':
    main()
