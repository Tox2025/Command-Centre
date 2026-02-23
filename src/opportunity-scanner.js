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

        // I5: Stock screener + short screener as additional discovery sources
        if (state.shortScreener && Array.isArray(state.shortScreener)) {
            state.shortScreener.forEach(function (s) {
                var t = (s.ticker || s.symbol || '').toUpperCase();
                if (t && t.length <= 5 && /^[A-Z]{1,5}$/.test(t) && !watchSet[t] && !marketSet[t]) {
                    marketSet[t] = 4; // Short screener is high-priority
                    sorted.push(t);
                }
            });
        }

        // I2: Sympathy play discovery — check related companies of high-scoring watchlist tickers
        if (state.relatedCompanies) {
            Object.keys(state.relatedCompanies).forEach(function (watchTicker) {
                // Only add sympathy tickers if the parent scored well
                var parentSetup = state.tradeSetups && state.tradeSetups[watchTicker];
                if (parentSetup && parentSetup.confidence >= 75) {
                    var related = state.relatedCompanies[watchTicker] || [];
                    related.forEach(function (r) {
                        var t = (r.ticker || '').toUpperCase();
                        if (t && t.length <= 5 && /^[A-Z]{1,5}$/.test(t) && !watchSet[t] && !marketSet[t]) {
                            marketSet[t] = 2; // Sympathy plays
                            sorted.push(t);
                        }
                    });
                }
            });
        }

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
                // Build scoring data from available state — FULL data set (matches scoreTickerSignals)
                var data = {
                    technicals: state.technicals[ticker] || {},
                    flow: (state.optionsFlow || []).filter(function (f) { return (f.ticker || f.symbol) === ticker; }),
                    darkPool: Array.isArray(state.darkPool[ticker]) ? state.darkPool[ticker] : [],
                    gex: Array.isArray(state.gex[ticker]) ? state.gex[ticker] : [],
                    ivRank: state.ivRank ? state.ivRank[ticker] : null,
                    shortInterest: state.shortInterest ? state.shortInterest[ticker] : null,
                    insider: [],
                    congress: [],
                    // I3: Congress trader filter — pass congress data with trader performance
                    congressTrader: state.congressTrader || null,
                    congressLateReports: state.congressLateReports || null,
                    quote: state.quotes[ticker] || {},
                    regime: state.marketRegime,
                    sentiment: null,
                    multiTF: state.multiTF ? state.multiTF[ticker] : null,
                    // Phase 1 API data
                    netPremium: state.netPremium ? state.netPremium[ticker] : null,
                    flowPerStrike: state.flowPerStrike ? state.flowPerStrike[ticker] : null,
                    flowPerExpiry: state.flowPerExpiry ? state.flowPerExpiry[ticker] : null,
                    greekFlow: state.greekFlow ? state.greekFlow[ticker] : null,
                    spotExposures: state.spotExposures ? state.spotExposures[ticker] : null,
                    shortVolume: state.shortVolume ? state.shortVolume[ticker] : null,
                    failsToDeliver: state.failsToDeliver ? state.failsToDeliver[ticker] : null,
                    seasonality: state.seasonality ? state.seasonality[ticker] : null,
                    realizedVol: state.realizedVol ? state.realizedVol[ticker] : null,
                    termStructure: state.termStructure ? state.termStructure[ticker] : null,
                    insiderFlow: state.insiderFlow ? state.insiderFlow[ticker] : null,
                    sectorTide: state.sectorTide || {},
                    etfTide: state.etfTide || {},
                    economicCalendar: state.economicCalendar || [],
                    // Phase 2 data
                    nope: state.nope ? state.nope[ticker] : null,
                    flowPerStrikeIntraday: state.flowPerStrikeIntraday ? state.flowPerStrikeIntraday[ticker] : null,
                    analystRatings: state.analystRatings ? state.analystRatings[ticker] : null,
                    institutionHoldings: state.institutionHoldings ? state.institutionHoldings[ticker] : null,
                    institutionActivity: state.institutionActivity ? state.institutionActivity[ticker] : null,
                    shortVolumesByExchange: state.shortVolumesByExchange ? state.shortVolumesByExchange[ticker] : null,
                    fdaCalendar: state.fdaCalendar || [],
                    // Phase 3 GAP data
                    maxPain: state.maxPain ? state.maxPain[ticker] : null,
                    oiChange: state.oiChange ? state.oiChange[ticker] : null,
                    greeks: state.greeks ? state.greeks[ticker] : null,
                    stockState: state.stockState ? state.stockState[ticker] : null,
                    earnings: state.earnings ? state.earnings[ticker] : null,
                    etfFlows: state.etfFlows || {},
                    // Phase B — New UW endpoints
                    shortInterestV2: state.shortInterestV2 ? state.shortInterestV2[ticker] : null,
                    interpolatedIV: state.interpolatedIV ? state.interpolatedIV[ticker] : null,
                    riskReversalSkew: state.riskReversalSkew ? state.riskReversalSkew[ticker] : null,
                    insiderSectorFlow: state.insiderSectorFlow || {},
                    // Phase C — Polygon expansion
                    financials: state.financials ? state.financials[ticker] : null,
                    relatedCompanies: state.relatedCompanies ? state.relatedCompanies[ticker] : null,
                    splits: state.splits ? state.splits[ticker] : null,
                    dividends: state.dividends ? state.dividends[ticker] : null,
                    marketHolidays: state.marketHolidays || [],
                    // Phase E data
                    oiPerStrike: (state.oiPerStrike || {})[ticker] || null,
                    oiPerExpiry: (state.oiPerExpiry || {})[ticker] || null,
                    atmChains: (state.atmChains || {})[ticker] || null,
                    stockPriceLevels: (state.stockPriceLevels || {})[ticker] || null,
                    stockVolumePriceLevels: (state.stockVolumePriceLevels || {})[ticker] || null,
                    // Phase F data
                    expiryBreakdown: (state.expiryBreakdown || {})[ticker] || null,
                    spotGEXByExpiryStrike: (state.spotGEXByExpiryStrike || {})[ticker] || null,
                    tickerOwnership: (state.tickerOwnership || {})[ticker] || null,
                    politicianHolders: (state.politicianHolders || {})[ticker] || null,
                    seasonalityYearMonth: (state.seasonalityYearMonth || {})[ticker] || null
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
