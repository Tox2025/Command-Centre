"""
Configuration for VectorBt Backtesting Engine
Mirrors the Node.js signal engine weights and session multipliers
"""

import os
import json

# ── Load .env from project root (same as Node.js app) ────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)

def _load_dotenv():
    """Load key=value pairs from project .env file"""
    env_path = os.path.join(PROJECT_DIR, '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, _, value = line.partition('=')
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = value

_load_dotenv()

# ── Polygon API ──────────────────────────────────────────
POLYGON_API_KEY = os.environ.get('POLYGON_API_KEY', '')
POLYGON_BASE_URL = 'https://api.polygon.io'

# ── Data Paths ───────────────────────────────────────────
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
# These are the ones we can backtest from historical data
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

# ── Prediction Accuracy Parameters ───────────────────────
BACKTEST_CONFIG = {
    # Day trade: 5m bars, measure outcome at these bar counts
    # 3 bars = 15min, 6 = 30min, 12 = 1hr, 24 = 2hr
    'day_trade_bar_size': 5,               # 5-minute bars
    'day_trade_horizons': [3, 6, 12, 24],  # bars forward on 5m chart
    'day_trade_horizon_labels': ['15min', '30min', '1hr', '2hr'],
    'day_trade_lookback_days': 60,         # days of intraday data

    # Swing trade: daily bars, measure outcome at these day counts
    'swing_horizons': [1, 2, 3, 5],
    'swing_horizon_labels': ['1d', '2d', '3d', '5d'],
    'swing_lookback_days': 365,

    # Shared
    'confidence_threshold': 65,            # minimum confidence to count as a prediction
    'confidence_bins': [65, 70, 75, 80],   # bin boundaries for accuracy breakdown
    'initial_capital': 100000,
    'commission_pct': 0.05,                # 0.05% per side
    'market_open_hour': 9,                 # 9:30 AM ET
    'market_open_min': 30,
    'market_close_hour': 16,               # 4:00 PM ET
}

# ── Optimization Parameters ──────────────────────────────
OPTIMIZE_CONFIG = {
    'weight_range': (0, 10),      # min/max weight values
    'weight_step': 1,             # grid step size
    'top_signals_to_optimize': 10, # optimize top N most impactful signals
    'metric': 'accuracy',         # optimize for: accuracy, avg_move, sharpe
    'min_predictions': 30,        # minimum predictions for valid test
}

# ── Default Ticker Universe ──────────────────────────────
DEFAULT_TICKERS = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
    'NFLX', 'CRM', 'ORCL', 'AVGO', 'ADBE', 'INTC', 'PYPL',
    'SPY', 'QQQ', 'IWM', 'DIA', 'SOFI',
]


def load_active_weights():
    """Load the active signal weights from signal-versions.json, including horizon profiles"""
    try:
        versions_path = os.path.join(DATA_DIR, 'signal-versions.json')
        with open(versions_path, 'r') as f:
            config = json.load(f)
        active = config.get('activeVersion', 'v1.0')
        version = config['versions'].get(active, {})
        weights = version.get('weights', DEFAULT_WEIGHTS)
        # Load horizon-specific profiles if available
        profiles = {
            'scalp': version.get('weights_scalp'),
            'day': version.get('weights_day'),
            'swing': version.get('weights_swing'),
        }
        ticker_overrides = version.get('ticker_overrides', {})
        available = [k for k, v in profiles.items() if v]
        if available:
            print(f"Loaded weights: {active} — {version.get('label', 'unknown')} (profiles: {'/'.join(available)})")
        else:
            print(f"Loaded weights: {active} — {version.get('label', 'unknown')}")
        return weights, active, profiles, ticker_overrides
    except Exception as e:
        print(f"Using default weights: {e}")
        return DEFAULT_WEIGHTS.copy(), 'default', {}, {}


def load_version_weights(version_name):
    """Load specific version weights from signal-versions.json, including horizon profiles"""
    try:
        versions_path = os.path.join(DATA_DIR, 'signal-versions.json')
        with open(versions_path, 'r') as f:
            config = json.load(f)
        version = config['versions'].get(version_name, {})
        weights = version.get('weights', DEFAULT_WEIGHTS)
        profiles = {
            'scalp': version.get('weights_scalp'),
            'day': version.get('weights_day'),
            'swing': version.get('weights_swing'),
        }
        ticker_overrides = version.get('ticker_overrides', {})
        available = [k for k, v in profiles.items() if v]
        if available:
            print(f"Loaded weights: {version_name} — {version.get('label', 'unknown')} (profiles: {'/'.join(available)})")
        else:
            print(f"Loaded weights: {version_name} — {version.get('label', 'unknown')}")
        return weights, profiles, ticker_overrides
    except Exception as e:
        print(f"Using default weights: {e}")
        return DEFAULT_WEIGHTS.copy(), {}, {}


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
            'label': label or f'VectorBt optimized — {metrics.get("accuracy", 0):.1f}% accuracy',
            'date': __import__('datetime').datetime.now().strftime('%Y-%m-%d'),
            'performance': {
                'totalPredictions': metrics.get('total_predictions', 0),
                'accuracy': metrics.get('accuracy', 0),
                'avgMove': metrics.get('avg_move', 0),
                'avgMFE': metrics.get('avg_mfe', 0),
                'avgMAE': metrics.get('avg_mae', 0),
                'notes': f'Tested on {metrics.get("tickers_tested", 0)} tickers, {metrics.get("lookback_days", 365)}d lookback'
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
