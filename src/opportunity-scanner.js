// Opportunity Scanner — finds high-probability setups on non-watchlist tickers
// Scans all tickers surfacing through options flow, dark pool, and net impact data
// Surfaces top 5 with confidence ≥ 65% as "Hot Opportunities"

class OpportunityScanner {
    constructor(signalEngine, multiTFAnalyzer) {
        this.signalEngine = signalEngine;
        this.multiTFAnalyzer = multiTFAnalyzer;
        this.lastScan = null;
        this.maxOpportunities = 5;
        this.minConfidence = 65;
    }

    // Extract unique tickers from flow/DP/net-impact that are NOT in the watchlist
    _getMarketTickers(state) {
        var watchSet = {};
        (state.tickers || []).forEach(function (t) { watchSet[t] = true; });

        var marketSet = {};

        // Options flow tickers
        (state.optionsFlow || []).forEach(function (f) {
            var t = (f.ticker || f.symbol || f.underlying_symbol || '').toUpperCase();
            if (t && t.length <= 5 && /^[A-Z]{1,5}$/.test(t) && !watchSet[t]) {
                marketSet[t] = (marketSet[t] || 0) + 1; // count appearances
            }
        });

        // Dark pool tickers
        (state.darkPoolRecent || []).forEach(function (d) {
            var t = (d.ticker || d.symbol || '').toUpperCase();
            if (t && t.length <= 5 && /^[A-Z]{1,5}$/.test(t) && !watchSet[t]) {
                marketSet[t] = (marketSet[t] || 0) + 2; // DP is higher signal
            }
        });

        // Net impact tickers
        (state.topNetImpact || []).forEach(function (n) {
            var t = (n.ticker || n.symbol || '').toUpperCase();
            if (t && t.length <= 5 && /^[A-Z]{1,5}$/.test(t) && !watchSet[t]) {
                marketSet[t] = (marketSet[t] || 0) + 3; // Net impact is strongest
            }
        });

        // Sort by frequency/importance and take top 20
        var sorted = Object.keys(marketSet).sort(function (a, b) {
            return marketSet[b] - marketSet[a];
        });

        return sorted.slice(0, 20);
    }

    // Score non-watchlist tickers and return top opportunities
    async scan(state, session) {
        var marketTickers = this._getMarketTickers(state);
        if (marketTickers.length === 0) return [];

        var opportunities = [];

        for (var i = 0; i < marketTickers.length; i++) {
            var ticker = marketTickers[i];

            try {
                // Build scoring data from available state
                var data = {
                    technicals: state.technicals[ticker] || {},
                    flow: (state.optionsFlow || []).filter(function (f) { return (f.ticker || f.symbol) === ticker; }),
                    darkPool: Array.isArray(state.darkPool[ticker]) ? state.darkPool[ticker] : [],
                    gex: Array.isArray(state.gex[ticker]) ? state.gex[ticker] : [],
                    ivRank: state.ivRank ? state.ivRank[ticker] : null,
                    shortInterest: state.shortInterest ? state.shortInterest[ticker] : null,
                    insider: [],
                    congress: [],
                    quote: state.quotes[ticker] || {},
                    regime: state.marketRegime,
                    sentiment: null,
                    multiTF: state.multiTF ? state.multiTF[ticker] : null
                };

                var result = this.signalEngine.score(ticker, data, session);

                if (result.confidence >= this.minConfidence && result.direction !== 'NEUTRAL') {
                    var quote = state.quotes[ticker] || {};
                    opportunities.push({
                        ticker: ticker,
                        direction: result.direction === 'BULLISH' ? 'LONG' : 'SHORT',
                        confidence: result.confidence,
                        signalCount: result.signalCount,
                        topSignals: result.signals.sort(function (a, b) { return b.weight - a.weight; }).slice(0, 3),
                        price: quote.price || quote.last || 0,
                        changePct: quote.changePercent || quote.change_percent || 0,
                        volume: quote.volume || 0,
                        multiTFDetails: result.multiTFDetails || [],
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (e) {
                // Skip failed tickers
            }
        }

        // Sort by confidence descending and return top N
        opportunities.sort(function (a, b) { return b.confidence - a.confidence; });
        this.lastScan = new Date().toISOString();

        return opportunities.slice(0, this.maxOpportunities);
    }
}

module.exports = { OpportunityScanner };
