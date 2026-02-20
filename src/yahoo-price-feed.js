// Yahoo Finance Price Feed — Free real-time price updates
// Uses yahoo-finance2 for live quotes without burning UW API calls
// Provides: price, change%, volume, bid/ask, dayHigh/dayLow

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

class YahooPriceFeed {
    constructor() {
        this.lastFetch = {};     // { ticker: timestamp }
        this.cache = {};         // { ticker: quoteData }
        this.minIntervalMs = 5000; // Min 5s between fetches per ticker
        this.enabled = true;
        this.errors = {};        // { ticker: errorCount }
        this.stats = { totalCalls: 0, errors: 0, lastUpdate: null };
    }

    /**
     * Fetch live quotes for multiple tickers at once (batch)
     * @param {string[]} tickers - Array of ticker symbols
     * @returns {Object} - Map of ticker -> quote data
     */
    async fetchQuotes(tickers) {
        if (!this.enabled || !tickers || tickers.length === 0) return {};

        const results = {};
        const now = Date.now();

        // Filter out tickers that were fetched too recently
        const tickersToFetch = tickers.filter(t => {
            const last = this.lastFetch[t] || 0;
            return (now - last) >= this.minIntervalMs;
        });

        if (tickersToFetch.length === 0) {
            // Return cached data
            tickers.forEach(t => { if (this.cache[t]) results[t] = this.cache[t]; });
            return results;
        }

        try {
            // yahoo-finance2 quote() supports multiple symbols
            const quotes = await yahooFinance.quote(tickersToFetch);
            this.stats.totalCalls++;
            this.stats.lastUpdate = new Date().toISOString();

            // Process results (quote returns array for multiple, single object for one)
            const quoteArray = Array.isArray(quotes) ? quotes : [quotes];

            quoteArray.forEach(q => {
                if (!q || !q.symbol) return;
                const ticker = q.symbol;

                // Use extended hours price when available (pre-market > post-market > regular)
                var livePrice = q.regularMarketPrice || 0;
                var priceSource = 'regular';
                if (q.preMarketPrice && q.preMarketPrice > 0) {
                    livePrice = q.preMarketPrice;
                    priceSource = 'premarket';
                } else if (q.postMarketPrice && q.postMarketPrice > 0) {
                    livePrice = q.postMarketPrice;
                    priceSource = 'postmarket';
                }

                const data = {
                    price: livePrice,
                    last: livePrice,
                    regularMarketPrice: q.regularMarketPrice || 0,
                    preMarketPrice: q.preMarketPrice || null,
                    postMarketPrice: q.postMarketPrice || null,
                    priceSource: priceSource,
                    open: q.regularMarketOpen || 0,
                    high: q.regularMarketDayHigh || 0,
                    low: q.regularMarketDayLow || 0,
                    close: q.regularMarketPreviousClose || 0,
                    previousClose: q.regularMarketPreviousClose || 0,
                    prev_close: q.regularMarketPreviousClose || 0,
                    volume: q.regularMarketVolume || 0,
                    change: q.regularMarketChange || 0,
                    changePercent: q.regularMarketChangePercent || 0,
                    preMarketChange: q.preMarketChange || null,
                    preMarketChangePercent: q.preMarketChangePercent || null,
                    postMarketChange: q.postMarketChange || null,
                    postMarketChangePercent: q.postMarketChangePercent || null,
                    bid: q.bid || 0,
                    ask: q.ask || 0,
                    marketCap: q.marketCap || 0,
                    avgVolume: q.averageDailyVolume3Month || 0,
                    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh || 0,
                    fiftyTwoWeekLow: q.fiftyTwoWeekLow || 0,
                    source: 'yahoo',
                    timestamp: new Date().toISOString()
                };

                this.cache[ticker] = data;
                this.lastFetch[ticker] = now;
                results[ticker] = data;
                this.errors[ticker] = 0; // Reset error count on success
            });

            // Include cached data for tickers we didn't need to fetch
            tickers.forEach(t => {
                if (!results[t] && this.cache[t]) {
                    results[t] = this.cache[t];
                }
            });

        } catch (e) {
            this.stats.errors++;
            // On error, return whatever cache we have
            console.error('Yahoo price feed error:', e.message);
            tickers.forEach(t => {
                if (this.cache[t]) results[t] = this.cache[t];
                this.errors[t] = (this.errors[t] || 0) + 1;
            });

            // Disable after 10 consecutive errors
            var totalErrors = Object.values(this.errors).reduce((s, e) => s + e, 0);
            if (totalErrors > 50) {
                console.error('⚠️  Yahoo price feed disabled after too many errors');
                this.enabled = false;
            }
        }

        return results;
    }

    /**
     * Merge Yahoo prices into existing UW quotes
     * Yahoo prices are more current; UW quotes have more detail
     * @param {Object} uwQuotes - Existing UW quote data { ticker: {...} }
     * @param {Object} yahooQuotes - Yahoo price data { ticker: {...} }
     * @returns {Object} - Merged quotes
     */
    mergeWithUW(uwQuotes, yahooQuotes) {
        const merged = Object.assign({}, uwQuotes);

        Object.keys(yahooQuotes).forEach(ticker => {
            const yq = yahooQuotes[ticker];
            if (!yq || !yq.price) return;

            if (!merged[ticker]) {
                // No UW data, use Yahoo entirely
                merged[ticker] = yq;
            } else {
                // Merge: Yahoo price is fresher, keep UW metadata
                merged[ticker].price = yq.price;
                merged[ticker].last = yq.last;
                merged[ticker].volume = yq.volume || merged[ticker].volume;
                merged[ticker].changePercent = yq.changePercent || merged[ticker].changePercent;
                merged[ticker].change = yq.change || merged[ticker].change;
                merged[ticker].high = yq.high || merged[ticker].high;
                merged[ticker].low = yq.low || merged[ticker].low;
                merged[ticker].bid = yq.bid || merged[ticker].bid;
                merged[ticker].ask = yq.ask || merged[ticker].ask;
                merged[ticker].previousClose = yq.previousClose || merged[ticker].previousClose;
                merged[ticker].prev_close = yq.prev_close || merged[ticker].prev_close;
                merged[ticker].open = yq.open || merged[ticker].open;
                merged[ticker].yahooTimestamp = yq.timestamp;
            }
        });

        return merged;
    }

    getStats() {
        return {
            enabled: this.enabled,
            totalCalls: this.stats.totalCalls,
            errors: this.stats.errors,
            lastUpdate: this.stats.lastUpdate,
            cachedTickers: Object.keys(this.cache).length
        };
    }

    reset() {
        this.cache = {};
        this.lastFetch = {};
        this.errors = {};
        this.enabled = true;
    }
}

module.exports = YahooPriceFeed;
