"""
Configuration for VectorBt Backtesting Engine
Mirrors the Node.js signal engine weights and session multipliers
"""

import os
import json

# ── Polygon API ──────────────────────────────────────────
POLYGON_API_KEY = os.environ.get('POLYGON_API_KEY', '')
POLYGON_BASE_URL = 'https://api.polygon.io'

# ── Data Paths ───────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_DIR, 'data')
CACHE_DIR = os.path.join(BASE_DIR, 'cache')
RESULTS_DIR = os.path.join(BASE_DIR, 'results')

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)

# ── Signal Weights (mirror of signal-engine.js) ─────────
DEFAULT_WEIGHTS = {
    'ema_alignment': 5,
    'rsi_position': 3,
    'macd_histogram': 2,
    'bollinger_position': 1,
    'bb_squeeze': 2,
    'vwap_deviation': 2,
    'call_put_ratio': 3,
    'sweep_activity': 2,
    'dark_pool_direction': 4,
    'insider_congress': 1,
    'gex_positioning': 2,
    'iv_rank': 1,
    'short_interest': 1,
    'volume_spike': 2,
    'regime_alignment': 3,
    'gamma_wall': 2,
    'iv_skew': 1,
    'candlestick_pattern': 2,
    'news_sentiment': 2,
    'multi_tf_confluence': 5,
    'rsi_divergence': 3,
    'adx_filter': 0,
    'volatility_runner': 5,
    'net_premium_momentum': 5,
    'strike_flow_levels': 4,
    'greek_flow_momentum': 4,
    'sector_tide_alignment': 3,
    'etf_tide_macro': 3,
    'squeeze_composite': 5,
    'seasonality_alignment': 2,
    'vol_regime': 3,
    'insider_conviction': 3,
    'spot_gamma_pin': 3,
    'flow_horizon': 2,
    'volume_direction': 3,
    'earnings_gap_trade': 6,
}

# Signals that can be accurately computed from OHLCV data alone
# These are the ones we optimize via backtesting
BACKTESTABLE_SIGNALS = [
    'ema_alignment', 'rsi_position', 'macd_histogram', 'bollinger_position',
    'bb_squeeze', 'vwap_deviation', 'volume_spike', 'regime_alignment',
    'multi_tf_confluence', 'rsi_divergence', 'adx_filter',
    'squeeze_composite', 'vol_regime', 'volume_direction',
    'candlestick_pattern',
]

# Signals that use proxy calculations from OHLCV
PROXY_SIGNALS = [
    'call_put_ratio', 'sweep_activity', 'dark_pool_direction',
    'gex_positioning', 'iv_rank', 'iv_skew', 'gamma_wall',
    'short_interest', 'net_premium_momentum', 'strike_flow_levels',
    'greek_flow_momentum', 'spot_gamma_pin', 'flow_horizon',
]

# Signals that are constants or external data
EXTERNAL_SIGNALS = [
    'insider_congress', 'news_sentiment', 'sector_tide_alignment',
    'etf_tide_macro', 'seasonality_alignment', 'insider_conviction',
    'volatility_runner', 'earnings_gap_trade',
]

# ── Backtest Parameters ──────────────────────────────────
BACKTEST_CONFIG = {
    'lookback_days': 365,
    'commission_pct': 0.05,      # 0.05% per side
    'slippage_pct': 0.05,        # 0.05% slippage
    'initial_capital': 100000,
    'confidence_threshold': 65,   # minimum confidence to enter
    'hold_bars_min': 3,           # minimum hold period (bars)
    'hold_bars_max': 30,          # maximum hold period (bars)
    'stop_loss_atr_mult': 0.8,    # stop at 0.8x ATR
    'take_profit_atr_mult': 1.5,  # TP at 1.5x ATR
    'walk_forward_train_pct': 0.75,  # 75% train, 25% test
    'walk_forward_windows': 4,       # number of rolling windows
}

# ── Optimization Parameters ──────────────────────────────
OPTIMIZE_CONFIG = {
    'weight_range': (0, 10),      # min/max weight values
    'weight_step': 1,             # grid step size
    'top_signals_to_optimize': 10, # optimize top N most impactful signals
    'metric': 'sharpe',           # optimize for: sharpe, win_rate, profit_factor
    'min_trades': 30,             # minimum trades for valid backtest
}

# ── Default Ticker Universe ──────────────────────────────
DEFAULT_TICKERS = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
    'NFLX', 'CRM', 'ORCL', 'AVGO', 'ADBE', 'INTC', 'PYPL',
    'SPY', 'QQQ', 'IWM', 'DIA', 'SOFI',
]


def load_active_weights():
    """Load the active signal weights from signal-versions.json"""
    try:
        versions_path = os.path.join(DATA_DIR, 'signal-versions.json')
        with open(versions_path, 'r') as f:
            config = json.load(f)
        active = config.get('activeVersion', 'v1.0')
        version = config['versions'].get(active, {})
        weights = version.get('weights', DEFAULT_WEIGHTS)
        print(f"Loaded weights: {active} — {version.get('label', 'unknown')}")
        return weights, active
    except Exception as e:
        print(f"Using default weights: {e}")
        return DEFAULT_WEIGHTS.copy(), 'default'


def save_optimized_weights(weights, metrics, label=''):
    """Save optimized weights as a new version in signal-versions.json"""
    try:
        versions_path = os.path.join(DATA_DIR, 'signal-versions.json')
        with open(versions_path, 'r') as f:
            config = json.load(f)

        # Generate version number
        existing = list(config['versions'].keys())
        major = max(int(v.split('.')[0].replace('v', '')) for v in existing)
        new_version = f'v{major + 1}.0-optimized'

        config['versions'][new_version] = {
            'label': label or f'VectorBt optimized — {metrics.get("sharpe", 0):.2f} Sharpe',
            'date': __import__('datetime').datetime.now().strftime('%Y-%m-%d'),
            'performance': {
                'closedTrades': metrics.get('total_trades', 0),
                'wins': metrics.get('wins', 0),
                'losses': metrics.get('losses', 0),
                'pnl': metrics.get('total_pnl', 0),
                'winRate': metrics.get('win_rate', 0),
                'sharpe': metrics.get('sharpe', 0),
                'maxDrawdown': metrics.get('max_drawdown', 0),
                'profitFactor': metrics.get('profit_factor', 0),
                'notes': f'Backtested on {metrics.get("tickers_tested", 0)} tickers, {metrics.get("lookback_days", 365)}d lookback'
            },
            'weights': weights,
            'gating': config['versions'].get(config.get('activeVersion', 'v1.0'), {}).get('gating', {})
        }

        with open(versions_path, 'w') as f:
            json.dump(config, f, indent=4)

        print(f"✅ Saved optimized weights as {new_version}")
        return new_version
    except Exception as e:
        print(f"❌ Error saving weights: {e}")
        return None
