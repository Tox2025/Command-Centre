// Market Scanner — Discovers high-probability setups from market-wide data
// Uses flow alerts, dark pool, top net impact, insider, and news feeds
// to find tickers not on your watchlist that show unusual convergence

const TechnicalAnalysis = require('./technical');

class MarketScanner {
    constructor(config) {
        config = config || {};
        this.minConfidence = config.minConfidence || 40;  // Lowered from 55 — was filtering out valid candidates
        this.maxCandidates = config.maxCandidates || 5;
        this.minPrice = config.minPrice || 5;
        this.cooldown = {};
        this.cooldownMs = config.cooldownMs || 1800000; // 30 min per ticker
        this.results = [];
        this.lastScan = null;
        this.polygonClient = config.polygonClient || null; // Polygon REST for candle/quote data
    }

    // ── Main Pipeline ──────────────────────────────────────
    async scan(marketData, watchlist, uw, session, polygonClient) {
        var poly = polygonClient || this.polygonClient;
        var self = this;
        var candidates = this.harvest(marketData, watchlist);

        if (candidates.length === 0) {
            this.lastScan = new Date().toISOString();
            return this.results;
        }

        // Quick-score top candidates (limit to 3 per cycle to avoid rate limits)
        var scored = [];
        var toScore = candidates.slice(0, Math.min(3, this.maxCandidates));

        for (var i = 0; i < toScore.length; i++) {
            var c = toScore[i];
            try {
                // Delay between candidates to avoid UW rate limit (120 req/min)
                if (i > 0) await new Promise(function (resolve) { setTimeout(resolve, 2000); });
                var result = await this.quickScore(c, uw, session, poly);
                if (result) scored.push(result);
            } catch (e) {
                console.error('Scanner: Error scoring ' + c.ticker + ':', e.message);
            }
        }

        // Filter by confidence threshold
        var hits = scored.filter(function (s) {
            return s.confidence >= self.minConfidence;
        });

        // Apply cooldown — don't re-alert on same ticker within window
        hits = hits.filter(function (h) {
            if (self.cooldown[h.ticker] && Date.now() - self.cooldown[h.ticker] < self.cooldownMs) {
                return false;
            }
            if (h.confidence >= self.minConfidence) {
                self.cooldown[h.ticker] = Date.now();
            }
            return true;
        });

        // Merge new hits with existing results (keep last 20)
        hits.forEach(function (h) {
            // Remove any previous entry for same ticker
            self.results = self.results.filter(function (r) { return r.ticker !== h.ticker; });
            self.results.unshift(h);
        });
        this.results = this.results.slice(0, 20);
        this.lastScan = new Date().toISOString();

        return hits; // return only NEW hits this cycle
    }

    // ── Step 1: Harvest candidate tickers from market-wide feeds ──
    harvest(marketData, watchlist) {
        var tally = {}; // ticker → { count, sources[], details }
        var excludeSet = {};
        (watchlist || []).forEach(function (t) { excludeSet[t.toUpperCase()] = true; });

        // Also exclude common ETFs and indices that aren't tradeable setups
        var etfExclude = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'UVXY', 'SQQQ', 'TQQQ'];
        etfExclude.forEach(function (t) { excludeSet[t] = true; });

        function addTicker(ticker, source, detail, weight) {
            if (!ticker || excludeSet[ticker.toUpperCase()]) return;
            var t = ticker.toUpperCase();
            if (!tally[t]) tally[t] = { ticker: t, count: 0, weight: 0, sources: [], details: [] };
            tally[t].count++;
            tally[t].weight += (weight || 1);
            if (tally[t].sources.indexOf(source) === -1) tally[t].sources.push(source);
            if (detail) tally[t].details.push(detail);
        }

        // 1. Options Flow Alerts — unusual activity
        var flowAlerts = marketData.optionsFlow || [];
        flowAlerts.forEach(function (f) {
            var ticker = f.ticker || f.symbol || f.underlying_symbol || '';
            var prem = parseFloat(f.premium || f.total_premium || f.ask_price || 0);
            var type = (f.put_call || f.option_type || '').toUpperCase();
            var tradeType = (f.trade_type || f.execution_type || '').toLowerCase();
            var weight = 1;

            // Higher weight for sweeps and large premiums
            if (tradeType.includes('sweep')) weight = 2;
            if (prem > 500000) weight += 1;
            if (prem > 1000000) weight += 2;

            var detail = type + ' $' + (prem / 1000).toFixed(0) + 'K';
            if (tradeType.includes('sweep')) detail += ' SWEEP';
            addTicker(ticker, 'FLOW', detail, weight);
        });

        // 2. Dark Pool Recent — large block prints
        var dpRecent = marketData.darkPoolRecent || [];
        dpRecent.forEach(function (d) {
            var ticker = d.ticker || d.symbol || '';
            var volume = parseFloat(d.volume || d.size || 0);
            var notional = parseFloat(d.notional_value || d.premium || 0);
            var weight = 1;
            if (notional > 1000000) weight = 2;
            if (notional > 5000000) weight = 3;

            var detail = '$' + (notional / 1000000).toFixed(1) + 'M block';
            addTicker(ticker, 'DARKPOOL', detail, weight);
        });

        // 3. Top Net Impact — biggest premium movers
        var topImpact = marketData.topNetImpact || [];
        if (Array.isArray(topImpact)) {
            topImpact.forEach(function (t) {
                var ticker = t.ticker || t.symbol || '';
                var netPrem = parseFloat(t.net_premium || t.net_call_premium || 0);
                var weight = 2; // high signal value
                var detail = 'Net premium $' + (netPrem / 1000).toFixed(0) + 'K';
                addTicker(ticker, 'NET_IMPACT', detail, weight);
            });
        }

        // 4. Insider Buy/Sells — smart money moves
        var insider = marketData.marketInsiderBuySells || {};
        var insiderTx = marketData.insiderTransactions || [];
        insiderTx.forEach(function (tx) {
            var ticker = tx.ticker || tx.symbol || '';
            var type = (tx.transaction_type || tx.acquisition_or_disposition || '').toUpperCase();
            var isBuy = type.includes('BUY') || type.includes('P') || type === 'A';
            if (isBuy) {
                var shares = parseFloat(tx.shares || tx.amount || 0);
                var detail = 'Insider BUY ' + shares.toLocaleString() + ' shares';
                addTicker(ticker, 'INSIDER', detail, 1.5);
            }
        });

        // 5. News Headlines — breaking news mentions
        var news = marketData.news || [];
        news.forEach(function (n) {
            var tickers = n.tickers || [];
            var headline = n.headline || n.title || '';
            tickers.forEach(function (ticker) {
                addTicker(ticker, 'NEWS', headline.slice(0, 60), 0.5);
            });
        });

        // 6. Polygon Gainers — top % movers up
        var gainers = marketData.polygonGainers || [];
        gainers.forEach(function (g) {
            if (g.ticker && Math.abs(g.changePercent || 0) > 2) {
                var w = Math.abs(g.changePercent) > 5 ? 2 : 1;
                addTicker(g.ticker, 'POLYGON_GAINER', '+' + (g.changePercent || 0).toFixed(1) + '% vol:' + (g.volume || 0), w);
            }
        });

        // 7. Polygon Losers — top % movers down
        var losers = marketData.polygonLosers || [];
        losers.forEach(function (g) {
            if (g.ticker && Math.abs(g.changePercent || 0) > 2) {
                var w = Math.abs(g.changePercent) > 5 ? 2 : 1;
                addTicker(g.ticker, 'POLYGON_LOSER', (g.changePercent || 0).toFixed(1) + '% vol:' + (g.volume || 0), w);
            }
        });

        // Convert to array and sort by convergence score (weight × source count)
        var candidates = Object.values(tally);
        candidates.forEach(function (c) {
            c.convergenceScore = c.weight * c.sources.length;
        });
        candidates.sort(function (a, b) { return b.convergenceScore - a.convergenceScore; });

        // Filter: accept single-source candidates with any weight, or multi-source convergence
        candidates = candidates.filter(function (c) { return c.weight >= 1; });

        return candidates.slice(0, this.maxCandidates * 2); // fetch extras in case some fail
    }

    // ── Step 2: Quick score a candidate (3 API calls) ──────
    async quickScore(candidate, uw, session, polygonClient) {
        var ticker = candidate.ticker;

        // Fetch lightweight data — handle failures gracefully so partial data still scores
        var quote, flow, gex;
        try { quote = await uw.getStockQuote(ticker); } catch (e) { console.log('Scanner: Quote failed for ' + ticker + ': ' + e.message); }
        try { flow = await uw.getFlowByTicker(ticker); } catch (e) { console.log('Scanner: Flow failed for ' + ticker + ': ' + e.message); }
        try { gex = await uw.getGEXByStrike(ticker); } catch (e) { console.log('Scanner: GEX failed for ' + ticker + ': ' + e.message); }

        var quoteData = quote?.data || {};
        var price = parseFloat(quoteData.last || quoteData.price || quoteData.close || 0);

        // Polygon snapshot fallback for price if UW returned nothing
        if (price === 0 && polygonClient) {
            try {
                var snap = await polygonClient.getTickerSnapshot(ticker);
                if (snap && snap.lastTrade) price = parseFloat(snap.lastTrade.p || 0);
                if (price === 0 && snap && snap.day) price = parseFloat(snap.day.c || snap.day.vw || 0);
                if (price === 0 && snap && snap.prevDay) price = parseFloat(snap.prevDay.c || 0);
            } catch (e) { /* Polygon snapshot failed */ }
        }

        // Skip penny stocks
        if (price > 0 && price < this.minPrice) return null;

        // Calculate a lightweight signal score
        var bull = 0, bear = 0;
        var signals = [];

        // ── Technical Analysis via Polygon daily candles ──
        try {
            var candles = [];
            if (polygonClient) {
                var fromDate = new Date();
                fromDate.setDate(fromDate.getDate() - 90);
                var toDate = new Date();
                var fromStr = fromDate.toISOString().split('T')[0];
                var toStr = toDate.toISOString().split('T')[0];
                var aggResult = await polygonClient.getAggregates(ticker, 1, 'day', fromStr, toStr);
                if (aggResult && aggResult.results && aggResult.results.length >= 30) {
                    candles = aggResult.results.map(function (bar) {
                        return { date: new Date(bar.t).toISOString(), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v || 0 };
                    });
                }
            }
            if (candles.length >= 30) {
                var ta = TechnicalAnalysis.analyze(candles);
                if (ta) {
                    // RSI scoring
                    if (ta.rsi !== null && ta.rsi !== undefined) {
                        if (ta.rsi < 30) { bull += 3; signals.push({ name: 'RSI Oversold', dir: 'BULL', detail: 'RSI ' + ta.rsi.toFixed(1) }); }
                        else if (ta.rsi < 40) { bull += 1; }
                        else if (ta.rsi > 70) { bear += 3; signals.push({ name: 'RSI Overbought', dir: 'BEAR', detail: 'RSI ' + ta.rsi.toFixed(1) }); }
                        else if (ta.rsi > 60) { bear += 1; }
                    }
                    // EMA bias
                    if (ta.emaBias === 'BULLISH') { bull += 2; signals.push({ name: 'EMA Bullish', dir: 'BULL', detail: 'EMA 9/20/50 stacked' }); }
                    else if (ta.emaBias === 'BEARISH') { bear += 2; signals.push({ name: 'EMA Bearish', dir: 'BEAR', detail: 'EMA 9/20/50 stacked' }); }
                    // BB position
                    if (ta.bollingerBands && ta.bollingerBands.position !== null) {
                        var bbPos = ta.bollingerBands.position;
                        if (bbPos < 0.1) { bull += 2; signals.push({ name: 'BB Lower', dir: 'BULL', detail: 'Near lower BB' }); }
                        else if (bbPos > 0.9) { bear += 2; signals.push({ name: 'BB Upper', dir: 'BEAR', detail: 'Near upper BB' }); }
                    }
                    // Volume spike
                    if (ta.volumeSpike) {
                        var volDir = bull > bear ? 'BULL' : 'BEAR';
                        if (volDir === 'BULL') bull += 1; else bear += 1;
                        signals.push({ name: 'Volume Spike', dir: volDir, detail: 'Above avg volume' });
                    }
                }
            }
        } catch (taErr) { /* Polygon candle fetch failed — continue without TA */ }

        // Flow analysis
        var flowData = (flow?.data) || [];
        if (Array.isArray(flowData) && flowData.length > 0) {
            var callPrem = 0, putPrem = 0, sweepCount = 0;
            flowData.forEach(function (f) {
                var prem = parseFloat(f.premium || f.total_premium || 0);
                var pc = (f.put_call || f.option_type || f.sentiment || '').toUpperCase();
                var tt = (f.trade_type || f.execution_type || '').toLowerCase();
                if (pc.includes('CALL') || pc.includes('BULLISH') || pc.includes('C')) callPrem += prem;
                else putPrem += prem;
                if (tt.includes('sweep')) sweepCount++;
            });
            var total = callPrem + putPrem;
            if (total > 0) {
                var ratio = callPrem / (putPrem || 1);
                if (ratio > 1.5) {
                    bull += 3;
                    signals.push({ name: 'Call Flow Dominant', dir: 'BULL', detail: 'Ratio ' + ratio.toFixed(2) });
                } else if (ratio < 0.67) {
                    bear += 3;
                    signals.push({ name: 'Put Flow Dominant', dir: 'BEAR', detail: 'Ratio ' + ratio.toFixed(2) });
                }
            }
            if (sweepCount > 2) {
                var sweepDir = callPrem > putPrem ? 'BULL' : 'BEAR';
                if (sweepDir === 'BULL') bull += 2; else bear += 2;
                signals.push({ name: 'Sweep Activity', dir: sweepDir, detail: sweepCount + ' sweeps' });
            }
        }

        // GEX analysis
        var gexData = (gex?.data) || [];
        if (Array.isArray(gexData) && gexData.length > 0 && price > 0) {
            var posGexAbove = 0, negGexBelow = 0;
            gexData.forEach(function (g) {
                var strike = parseFloat(g.strike || 0);
                var net = parseFloat(g.call_gex || 0) + parseFloat(g.put_gex || 0);
                if (strike > price && net > 0) posGexAbove += net;
                if (strike < price && net < 0) negGexBelow += Math.abs(net);
            });
            if (posGexAbove > negGexBelow * 1.5) {
                bull += 2;
                signals.push({ name: 'GEX Support Above', dir: 'BULL', detail: 'Positive gamma wall' });
            } else if (negGexBelow > posGexAbove * 1.5) {
                bear += 2;
                signals.push({ name: 'GEX Magnet Below', dir: 'BEAR', detail: 'Negative gamma pull' });
            }
        }

        // Bonus for multi-source convergence from harvest
        var convergenceBonus = Math.min(candidate.sources.length - 1, 3);
        if (bull > bear) bull += convergenceBonus;
        else if (bear > bull) bear += convergenceBonus;
        signals.push({ name: 'Multi-Source', dir: bull > bear ? 'BULL' : 'BEAR', detail: candidate.sources.join(' + ') });

        // Compute final score — spread-based like main signal engine
        var spread = Math.abs(bull - bear);
        var direction = bull > bear + 0.5 ? 'BULLISH' : bear > bull + 0.5 ? 'BEARISH' : 'NEUTRAL';
        var confidence = Math.min(95, Math.round(50 + (spread / 15) * 50));  // 15 = max realistic score
        console.log('Scanner quickScore: ' + ticker + ' → ' + direction + ' conf=' + confidence + '% bull=' + bull.toFixed(1) + ' bear=' + bear.toFixed(1) + ' signals=' + signals.length + ' sources=' + candidate.sources.join(','));

        return {
            ticker: ticker,
            price: price,
            direction: direction,
            confidence: confidence,
            bull: +bull.toFixed(2),
            bear: +bear.toFixed(2),
            signals: signals,
            sources: candidate.sources,
            details: candidate.details.slice(0, 5),
            convergenceScore: candidate.convergenceScore,
            discoveredAt: new Date().toISOString(),
            session: session || 'UNKNOWN'
        };
    }

    // ── Getters ─────────────────────────────────────────────
    getResults() {
        return {
            results: this.results,
            lastScan: this.lastScan,
            totalDiscovered: this.results.length,
            cooldownTickers: Object.keys(this.cooldown).length
        };
    }

    clearCooldown(ticker) {
        if (ticker) {
            delete this.cooldown[ticker.toUpperCase()];
        } else {
            this.cooldown = {};
        }
    }
}

module.exports = { MarketScanner };
