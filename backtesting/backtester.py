"""
VectorBt-powered Backtester — runs vectorized backtests using signal engine scores.
Generates performance metrics: Sharpe, drawdown, win rate, profit factor.
"""
import numpy as np
import pandas as pd
import json
import os
from datetime import datetime

try:
    import vectorbt as vbt
    HAS_VBT = True
except ImportError:
    HAS_VBT = False
    print("⚠️ vectorbt not installed — using basic backtesting mode")

from signal_engine import SignalEngine
from data_fetcher import DataFetcher
from config import BACKTEST_CONFIG, RESULTS_DIR


class Backtester:
    def __init__(self, weights=None, config=None):
        self.engine = SignalEngine(weights)
        self.config = config or BACKTEST_CONFIG.copy()
        self.fetcher = DataFetcher()

    def run(self, ticker, df=None, timeframe='daily'):
        """Run a backtest on a single ticker. Returns metrics dict."""
        if df is None or df.empty:
            if timeframe == 'weekly':
                df = self.fetcher.fetch_weekly(ticker, self.config['lookback_days'])
            else:
                df = self.fetcher.fetch_daily(ticker, self.config['lookback_days'])
        if df.empty or len(df) < 50:
            return {'ticker': ticker, 'error': 'Insufficient data', 'total_trades': 0}

        # Compute signals and scores
        signals = self.engine.compute_all_signals(df)
        scores = self.engine.score(signals)
        threshold = self.config['confidence_threshold']
        entries_long, entries_short = self.engine.generate_entries(scores, threshold)

        # ATR for stops/targets
        atr_vals = signals['_atr'].fillna(df['close'] * 0.02)
        sl_mult = self.config['stop_loss_atr_mult']
        tp_mult = self.config['take_profit_atr_mult']

        if HAS_VBT:
            return self._run_vbt(ticker, df, entries_long, entries_short, atr_vals, sl_mult, tp_mult, scores)
        else:
            return self._run_basic(ticker, df, entries_long, entries_short, atr_vals, sl_mult, tp_mult, scores)

    def _run_vbt(self, ticker, df, entries_long, entries_short, atr_vals, sl_mult, tp_mult, scores):
        """VectorBt-powered backtest with ATR-based exits"""
        close = df['close']
        # Combined entries (long only for simplicity in initial version)
        entries = entries_long

        # Use fixed SL/TP based on ATR at entry
        sl_pct = (atr_vals * sl_mult / close).fillna(0.02)
        tp_pct = (atr_vals * tp_mult / close).fillna(0.03)

        # Run portfolio simulation
        pf = vbt.Portfolio.from_signals(
            close,
            entries=entries,
            sl_stop=sl_pct.mean(),  # average SL
            tp_stop=tp_pct.mean(),  # average TP
            init_cash=self.config['initial_capital'],
            fees=self.config['commission_pct'] / 100,
            slippage=self.config['slippage_pct'] / 100,
            freq='1D' if len(df) < 5000 else '5min'
        )

        stats = pf.stats()
        trades = pf.trades.records_readable if hasattr(pf, 'trades') else pd.DataFrame()

        return {
            'ticker': ticker,
            'total_trades': int(stats.get('Total Trades', 0)),
            'wins': int(len(trades[trades['PnL'] > 0])) if not trades.empty else 0,
            'losses': int(len(trades[trades['PnL'] <= 0])) if not trades.empty else 0,
            'win_rate': float(stats.get('Win Rate [%]', 0)),
            'total_pnl': float(stats.get('Total Return [%]', 0)),
            'sharpe': float(stats.get('Sharpe Ratio', 0)),
            'max_drawdown': float(stats.get('Max Drawdown [%]', 0)),
            'profit_factor': float(stats.get('Profit Factor', 0)),
            'avg_trade_pnl': float(stats.get('Avg Winning Trade [%]', 0)),
            'equity_curve': pf.value().tolist()[-100:],  # last 100 points
        }

    def _run_basic(self, ticker, df, entries_long, entries_short, atr_vals, sl_mult, tp_mult, scores):
        """Basic bar-by-bar backtest when vectorbt is not available"""
        close = df['close'].values
        entries = entries_long.values
        atr = atr_vals.values
        capital = self.config['initial_capital']
        trades = []
        position = None
        hold_max = self.config['hold_bars_max']

        for i in range(len(close)):
            # Check exit
            if position is not None:
                bars_held = i - position['entry_bar']
                pnl_pct = (close[i] - position['entry_price']) / position['entry_price']
                hit_tp = pnl_pct >= position['tp_pct']
                hit_sl = pnl_pct <= -position['sl_pct']
                hit_max = bars_held >= hold_max

                if hit_tp or hit_sl or hit_max:
                    exit_reason = 'TP' if hit_tp else 'SL' if hit_sl else 'MAX_HOLD'
                    net_pnl = pnl_pct - (self.config['commission_pct'] / 100 * 2)
                    trades.append({
                        'entry_price': position['entry_price'],
                        'exit_price': close[i],
                        'pnl_pct': net_pnl * 100,
                        'bars_held': bars_held,
                        'exit_reason': exit_reason,
                        'direction': 'LONG'
                    })
                    capital *= (1 + net_pnl)
                    position = None

            # Check entry
            if position is None and entries[i]:
                entry_atr = atr[i] if not np.isnan(atr[i]) else close[i] * 0.02
                position = {
                    'entry_price': close[i],
                    'entry_bar': i,
                    'tp_pct': entry_atr * tp_mult / close[i],
                    'sl_pct': entry_atr * sl_mult / close[i],
                }

        if not trades:
            return {'ticker': ticker, 'total_trades': 0, 'error': 'No trades generated'}

        wins = [t for t in trades if t['pnl_pct'] > 0]
        losses = [t for t in trades if t['pnl_pct'] <= 0]
        all_pnl = [t['pnl_pct'] for t in trades]
        win_pnl = sum(t['pnl_pct'] for t in wins) if wins else 0
        loss_pnl = abs(sum(t['pnl_pct'] for t in losses)) if losses else 0.01

        return {
            'ticker': ticker,
            'total_trades': len(trades),
            'wins': len(wins),
            'losses': len(losses),
            'win_rate': round(len(wins) / len(trades) * 100, 1),
            'total_pnl': round(sum(all_pnl), 2),
            'sharpe': round(np.mean(all_pnl) / max(np.std(all_pnl), 0.01) * np.sqrt(252), 2),
            'max_drawdown': round(min(np.minimum.accumulate(np.cumsum(all_pnl)) - np.cumsum(all_pnl)), 2) if all_pnl else 0,
            'profit_factor': round(win_pnl / loss_pnl, 2),
            'avg_trade_pnl': round(np.mean(all_pnl), 2),
            'trades': trades,
        }

    def run_universe(self, tickers, timeframe='daily'):
        """Run backtest across multiple tickers. Returns aggregate metrics."""
        results = {}
        for i, ticker in enumerate(tickers):
            print(f"\n[{i+1}/{len(tickers)}] Backtesting {ticker}...")
            results[ticker] = self.run(ticker, timeframe=timeframe)
        return self._aggregate(results, tickers)

    def _aggregate(self, results, tickers):
        """Aggregate multi-ticker results"""
        valid = {k: v for k, v in results.items() if v.get('total_trades', 0) > 0}
        if not valid:
            return {'error': 'No valid backtests', 'per_ticker': results}

        total_trades = sum(v['total_trades'] for v in valid.values())
        total_wins = sum(v.get('wins', 0) for v in valid.values())
        sharpes = [v['sharpe'] for v in valid.values() if 'sharpe' in v]
        pnls = [v.get('total_pnl', 0) for v in valid.values()]

        return {
            'tickers_tested': len(tickers),
            'tickers_with_trades': len(valid),
            'total_trades': total_trades,
            'wins': total_wins,
            'losses': total_trades - total_wins,
            'win_rate': round(total_wins / max(total_trades, 1) * 100, 1),
            'avg_sharpe': round(np.mean(sharpes), 2) if sharpes else 0,
            'sharpe': round(np.mean(sharpes), 2) if sharpes else 0,
            'avg_pnl': round(np.mean(pnls), 2),
            'total_pnl': round(sum(pnls), 2),
            'max_drawdown': round(min(v.get('max_drawdown', 0) for v in valid.values()), 2),
            'avg_profit_factor': round(np.mean([v.get('profit_factor', 0) for v in valid.values()]), 2),
            'per_ticker': results,
            'lookback_days': self.config['lookback_days'],
        }

    def save_results(self, results, filename=None):
        """Save backtest results to JSON"""
        fname = filename or f"backtest_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        path = os.path.join(RESULTS_DIR, fname)
        # Remove non-serializable items
        clean = json.loads(json.dumps(results, default=str))
        with open(path, 'w') as f:
            json.dump(clean, f, indent=2)
        print(f"📊 Results saved: {path}")
        return path
