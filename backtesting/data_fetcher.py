"""
Data Fetcher — Polygon REST API historical OHLCV with Parquet caching
Fetches multi-timeframe candles and caches locally for fast repeated backtesting
"""

import os
import time
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from config import POLYGON_API_KEY, POLYGON_BASE_URL, CACHE_DIR


class DataFetcher:
    """Fetches and caches historical OHLCV data from Polygon.io"""

    def __init__(self, api_key=None):
        self.api_key = api_key or POLYGON_API_KEY
        self.session = requests.Session()
        self.request_count = 0
        self.last_request_time = 0

    def _rate_limit(self):
        """Respect Polygon rate limits (5 req/min on free, 100/min on paid)"""
        elapsed = time.time() - self.last_request_time
        if elapsed < 0.25:  # 4 req/sec max
            time.sleep(0.25 - elapsed)
        self.last_request_time = time.time()
        self.request_count += 1

    def _fetch_aggs(self, ticker, multiplier, timespan, from_date, to_date, limit=50000):
        """Fetch aggregate bars from Polygon REST API"""
        self._rate_limit()
        url = f"{POLYGON_BASE_URL}/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from_date}/{to_date}"
        params = {
            'apiKey': self.api_key,
            'adjusted': 'true',
            'sort': 'asc',
            'limit': limit
        }
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        results = data.get('results', [])
        return results

    def fetch_daily(self, ticker, lookback_days=365):
        """Fetch daily OHLCV candles"""
        cache_path = os.path.join(CACHE_DIR, f"{ticker}_daily.parquet")

        # Check cache freshness (refresh if > 12 hours old)
        if os.path.exists(cache_path):
            mtime = os.path.getmtime(cache_path)
            age_hours = (time.time() - mtime) / 3600
            if age_hours < 12:
                df = pd.read_parquet(cache_path)
                print(f"  📦 Cache hit: {ticker} daily ({len(df)} bars, {age_hours:.1f}h old)")
                return df

        to_date = datetime.now().strftime('%Y-%m-%d')
        from_date = (datetime.now() - timedelta(days=lookback_days)).strftime('%Y-%m-%d')

        print(f"  📡 Fetching {ticker} daily {from_date} → {to_date}...")
        results = self._fetch_aggs(ticker, 1, 'day', from_date, to_date)

        if not results:
            print(f"  ⚠️ No data for {ticker}")
            return pd.DataFrame()

        df = self._results_to_df(results)
        df.to_parquet(cache_path)
        print(f"  ✅ {ticker} daily: {len(df)} bars cached")
        return df

    def fetch_intraday(self, ticker, interval_min=5, lookback_days=30):
        """Fetch intraday OHLCV candles (5m, 15m, etc.)"""
        cache_path = os.path.join(CACHE_DIR, f"{ticker}_{interval_min}m.parquet")

        if os.path.exists(cache_path):
            mtime = os.path.getmtime(cache_path)
            age_hours = (time.time() - mtime) / 3600
            if age_hours < 6:
                df = pd.read_parquet(cache_path)
                print(f"  📦 Cache hit: {ticker} {interval_min}m ({len(df)} bars)")
                return df

        # Polygon limits intraday to ~2 years, but we cap at lookback_days
        to_date = datetime.now().strftime('%Y-%m-%d')
        from_date = (datetime.now() - timedelta(days=lookback_days)).strftime('%Y-%m-%d')

        print(f"  📡 Fetching {ticker} {interval_min}m {from_date} → {to_date}...")

        # Fetch in chunks for large date ranges
        all_results = []
        chunk_start = datetime.now() - timedelta(days=lookback_days)
        chunk_size = 7 if interval_min <= 5 else 30  # 7 days per chunk for 5m

        while chunk_start < datetime.now():
            chunk_end = min(chunk_start + timedelta(days=chunk_size), datetime.now())
            results = self._fetch_aggs(
                ticker, interval_min, 'minute',
                chunk_start.strftime('%Y-%m-%d'),
                chunk_end.strftime('%Y-%m-%d')
            )
            all_results.extend(results)
            chunk_start = chunk_end

        if not all_results:
            return pd.DataFrame()

        df = self._results_to_df(all_results)
        df.to_parquet(cache_path)
        print(f"  ✅ {ticker} {interval_min}m: {len(df)} bars cached")
        return df

    def fetch_weekly(self, ticker, lookback_days=365):
        """Fetch weekly OHLCV by resampling daily bars"""
        cache_path = os.path.join(CACHE_DIR, f"{ticker}_weekly.parquet")

        if os.path.exists(cache_path):
            mtime = os.path.getmtime(cache_path)
            age_hours = (time.time() - mtime) / 3600
            if age_hours < 12:
                df = pd.read_parquet(cache_path)
                print(f"  📦 Cache hit: {ticker} weekly ({len(df)} bars, {age_hours:.1f}h old)")
                return df

        # Fetch daily and resample to weekly
        daily = self.fetch_daily(ticker, lookback_days)
        if daily.empty:
            return daily

        weekly = daily.resample('W').agg({
            'open': 'first',
            'high': 'max',
            'low': 'min',
            'close': 'last',
            'volume': 'sum'
        }).dropna()

        if 'vwap' in daily.columns:
            weekly['vwap'] = daily['vwap'].resample('W').mean()

        weekly.to_parquet(cache_path)
        print(f"  ✅ {ticker} weekly: {len(weekly)} bars cached")
        return weekly

    def fetch_multi_tf(self, ticker, lookback_days=365):
        """Fetch all timeframes needed for signal engine"""
        data = {}
        data['daily'] = self.fetch_daily(ticker, lookback_days)
        data['5m'] = self.fetch_intraday(ticker, 5, min(lookback_days, 60))
        data['15m'] = self.fetch_intraday(ticker, 15, min(lookback_days, 90))
        return data

    def fetch_universe(self, tickers, lookback_days=365, timeframe='daily'):
        """Fetch data for a list of tickers"""
        data = {}
        for i, ticker in enumerate(tickers):
            print(f"\n[{i+1}/{len(tickers)}] {ticker}")
            try:
                if timeframe == 'daily':
                    data[ticker] = self.fetch_daily(ticker, lookback_days)
                elif timeframe == 'weekly':
                    data[ticker] = self.fetch_weekly(ticker, lookback_days)
                elif timeframe == 'multi':
                    data[ticker] = self.fetch_multi_tf(ticker, lookback_days)
                else:
                    interval = int(timeframe.replace('m', ''))
                    data[ticker] = self.fetch_intraday(ticker, interval, lookback_days)
            except Exception as e:
                print(f"  ❌ Error fetching {ticker}: {e}")
                data[ticker] = pd.DataFrame()
        return data

    def _results_to_df(self, results):
        """Convert Polygon API results to pandas DataFrame"""
        df = pd.DataFrame(results)
        if df.empty:
            return df

        # Rename columns to standard OHLCV
        col_map = {
            'o': 'open', 'h': 'high', 'l': 'low', 'c': 'close',
            'v': 'volume', 'vw': 'vwap', 't': 'timestamp', 'n': 'trades'
        }
        df = df.rename(columns=col_map)

        # Convert timestamp (ms) to datetime index
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms')
        df = df.set_index('datetime')
        df = df.sort_index()

        # Keep only relevant columns
        cols = ['open', 'high', 'low', 'close', 'volume']
        if 'vwap' in df.columns:
            cols.append('vwap')
        if 'trades' in df.columns:
            cols.append('trades')
        df = df[cols]

        # Remove duplicates
        df = df[~df.index.duplicated(keep='last')]

        return df

    def clear_cache(self, ticker=None):
        """Clear cached data"""
        if ticker:
            for f in os.listdir(CACHE_DIR):
                if f.startswith(ticker):
                    os.remove(os.path.join(CACHE_DIR, f))
                    print(f"  🗑️ Cleared {f}")
        else:
            for f in os.listdir(CACHE_DIR):
                if f.endswith('.parquet'):
                    os.remove(os.path.join(CACHE_DIR, f))
            print("  🗑️ Cache cleared")


if __name__ == '__main__':
    fetcher = DataFetcher()
    # Test fetch
    df = fetcher.fetch_daily('AAPL', 30)
    if not df.empty:
        print(f"\nAAPL daily sample:\n{df.tail()}")
        print(f"\nShape: {df.shape}")
        print(f"Date range: {df.index[0]} → {df.index[-1]}")
