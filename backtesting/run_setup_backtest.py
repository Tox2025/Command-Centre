"""
Setup Backtester — Tests high-probability setups instead of scoring every bar.
Only measures accuracy when a specific conditional pattern triggers.
"""
import sys, os, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from setup_detector import SetupDetector
from data_fetcher import DataFetcher
from config import BACKTEST_CONFIG


def measure_setup_outcomes(df, setups, horizons, horizon_labels):
    """For each detected setup, measure if price moved in predicted direction."""
    close = df['close']
    results = []

    for idx, row in setups.iterrows():
        pos = close.index.get_loc(idx)
        max_h = max(horizons)
        if pos + max_h >= len(close):
            continue

        entry = row['entry_price']
        direction = row['direction']
        r = {
            'timestamp': idx,
            'setup': row['setup'],
            'direction': direction,
            'entry_price': entry,
            'rsi': row.get('rsi_at_entry', 0),
            'vol_ratio': row.get('vol_ratio_at_entry', 0),
        }

        for h, label in zip(horizons, horizon_labels):
            future = close.iloc[pos + h]
            change_pct = (future - entry) / entry * 100
            if direction == 1:
                r[f'{label}_correct'] = change_pct > 0
                r[f'{label}_move'] = round(change_pct, 4)
            else:
                r[f'{label}_correct'] = change_pct < 0
                r[f'{label}_move'] = round(-change_pct, 4)

        # MFE / MAE
        window = close.iloc[pos:pos + max_h + 1]
        if direction == 1:
            r['mfe'] = round((window.max() - entry) / entry * 100, 4)
            r['mae'] = round((window.min() - entry) / entry * 100, 4)
        else:
            r['mfe'] = round((entry - window.min()) / entry * 100, 4)
            r['mae'] = round((entry - window.max()) / entry * 100, 4)

        results.append(r)

    return results


def print_setup_results(all_results, horizon_labels, ticker):
    """Print results grouped by setup type."""
    if not all_results:
        print(f"  {ticker}: No setups detected")
        return

    df = pd.DataFrame(all_results)
    total = len(df)
    longs = (df['direction'] == 1).sum()
    shorts = (df['direction'] == -1).sum()
    print(f"\n  📊 {ticker}: {total} setups detected ({longs} LONG / {shorts} SHORT)")
    print(f"  Avg MFE: {df['mfe'].mean():.3f}%  |  Avg MAE: {df['mae'].mean():.3f}%")

    # Per-setup breakdown
    print(f"\n  {'Setup':<30} {'Count':>5} ", end='')
    for label in horizon_labels:
        print(f" {label:>7}", end='')
    print(f"  {'MFE':>7}  {'MAE':>7}")
    print(f"  {'─'*90}")

    for setup_name in df['setup'].unique():
        sdf = df[df['setup'] == setup_name]
        count = len(sdf)
        print(f"  {setup_name:<30} {count:>5} ", end='')
        for label in horizon_labels:
            col = f'{label}_correct'
            if col in sdf.columns:
                acc = sdf[col].mean() * 100
                marker = '✅' if acc > 55 else '❌' if acc < 45 else '  '
                print(f" {acc:>5.1f}%{marker}", end='')
            else:
                print(f"     —  ", end='')
        print(f"  {sdf['mfe'].mean():>6.3f}%  {sdf['mae'].mean():>6.3f}%")

    # Overall accuracy
    print(f"\n  {'TOTAL':<30} {total:>5} ", end='')
    for label in horizon_labels:
        col = f'{label}_correct'
        if col in df.columns:
            acc = df[col].mean() * 100
            print(f" {acc:>5.1f}%  ", end='')
    print(f"  {df['mfe'].mean():>6.3f}%  {df['mae'].mean():>6.3f}%")


def run_ticker(fetcher, detector, ticker, bar_size, lookback, horizons, horizon_labels):
    """Run setup detection + measurement for one ticker."""
    if bar_size == 1 or bar_size == 5:
        df = fetcher.fetch_intraday(ticker, bar_size, lookback)
    else:
        df = fetcher.fetch_daily(ticker, lookback)

    if df.empty or len(df) < 200:
        print(f"  ❌ {ticker}: Insufficient data ({len(df)} bars)")
        return []

    setups = detector.detect_all(df)
    if setups.empty:
        print(f"  {ticker}: No setups detected in {len(df)} bars")
        return []

    results = measure_setup_outcomes(df, setups, horizons, horizon_labels)
    print_setup_results(results, horizon_labels, ticker)
    return results


def main():
    parser = argparse.ArgumentParser(description='Setup-Based Backtest')
    parser.add_argument('--mode', choices=['scalp', 'day', 'swing'], default='day')
    parser.add_argument('--tickers', nargs='+', default=['TSLA', 'AMD', 'META', 'APP', 'MSFT'])
    parser.add_argument('--lookback', type=int, default=None)
    args = parser.parse_args()

    mode = args.mode
    tickers = args.tickers

    # Mode-specific config
    if mode == 'scalp':
        bar_size = 1
        horizons = [1, 3, 5, 10]
        horizon_labels = ['1min', '3min', '5min', '10min']
        lookback = args.lookback or 14
    elif mode == 'day':
        bar_size = 5
        horizons = [3, 6, 12, 24]
        horizon_labels = ['15min', '30min', '1hr', '2hr']
        lookback = args.lookback or 30
    else:  # swing
        bar_size = 1440  # daily
        horizons = [1, 2, 3, 5]
        horizon_labels = ['1d', '2d', '3d', '5d']
        lookback = args.lookback or 365

    print(f"\n{'='*70}")
    print(f"  SETUP-BASED BACKTEST (Conditional Pattern Matching)")
    print(f"{'='*70}")
    print(f"  Mode:      {mode} ({'1min' if bar_size == 1 else '5min' if bar_size == 5 else 'daily'} bars)")
    print(f"  Tickers:   {len(tickers)} tickers")
    print(f"  Lookback:  {lookback} days")
    print(f"  Horizons:  {' / '.join(horizon_labels)}")
    print(f"  Setups:    14 conditional patterns (RSI bounce, VWAP, BB squeeze, EMA pullback, etc.)")
    print(f"{'='*70}")

    fetcher = DataFetcher()
    detector = SetupDetector()
    all_results = []

    for i, ticker in enumerate(tickers):
        print(f"\n{'='*60}")
        print(f"[{i+1}/{len(tickers)}] {ticker}")
        print(f"{'='*60}")
        results = run_ticker(fetcher, detector, ticker, bar_size, lookback, horizons, horizon_labels)
        all_results.extend(results)

    # Aggregate
    if all_results:
        print(f"\n{'='*70}")
        print(f"  AGGREGATE — {len(all_results)} setups across {len(tickers)} tickers")
        print(f"{'='*70}")
        df = pd.DataFrame(all_results)

        # Overall by horizon
        print(f"\n  Overall Accuracy:")
        for label in horizon_labels:
            col = f'{label}_correct'
            if col in df.columns:
                acc = df[col].mean() * 100
                print(f"    {label:<8}: {acc:.1f}%")

        print(f"\n  Avg MFE: {df['mfe'].mean():.3f}%  |  Avg MAE: {df['mae'].mean():.3f}%")
        print(f"  MFE/MAE Ratio: {abs(df['mfe'].mean() / df['mae'].mean()):.2f}" if df['mae'].mean() != 0 else "")

        # Best/worst setups
        print(f"\n  Setup Ranking (by 1hr / 5min accuracy):")
        target_col = f'{horizon_labels[2]}_correct' if len(horizon_labels) > 2 else f'{horizon_labels[0]}_correct'
        by_setup = df.groupby('setup').agg(
            count=('setup', 'size'),
            accuracy=(target_col, 'mean'),
            avg_mfe=('mfe', 'mean'),
            avg_mae=('mae', 'mean'),
        ).sort_values('accuracy', ascending=False)

        for setup, row in by_setup.iterrows():
            acc = row['accuracy'] * 100
            marker = '✅' if acc > 55 else '❌' if acc < 45 else '  '
            ratio = abs(row['avg_mfe'] / row['avg_mae']) if row['avg_mae'] != 0 else 0
            print(f"    {setup:<35} {int(row['count']):>4} setups  {acc:>5.1f}% {marker}  MFE/MAE={ratio:.2f}")
    else:
        print("\n  No setups detected across any tickers.")

    print(f"\n{'='*70}")


if __name__ == '__main__':
    main()
