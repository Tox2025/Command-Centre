// X Alert Monitor — Ingest, Validate, and Predict Range for Low-Float Momentum Plays
// Receives ticker alerts from X/Twitter via Telegram forwarding, validates with UW data,
// predicts price move range, and calculates limit sell targets.

class XAlertMonitor {
    constructor(config) {
        config = config || {};
        this.alerts = [];        // validated alerts
        this.maxAlerts = config.maxAlerts || 50;
        this.minScore = config.minScore || 50;  // show all, highlight ≥70
        this.cooldown = {};      // ticker → timestamp (prevent duplicate validation)
        this.cooldownMs = config.cooldownMs || 1800000; // 30 min cooldown per ticker
    }

    // ── Ingest Alert ──────────────────────────────────────
    // Called when a ticker alert arrives from any source
    async ingestAlert(ticker, source, rawText, uw, polygonClient) {
        ticker = (ticker || '').toUpperCase().trim();
        if (!ticker || ticker.length > 6) return null;

        // Cooldown check
        if (this.cooldown[ticker] && Date.now() - this.cooldown[ticker] < this.cooldownMs) {
            return { status: 'COOLDOWN', ticker: ticker, message: 'Recently validated' };
        }
        this.cooldown[ticker] = Date.now();

        try {
            var data = await this.fetchValidationData(ticker, uw, polygonClient);
            var result = this.scoreAndPredict(ticker, data, source, rawText);

            // Store result
            this.alerts.unshift(result);
            if (this.alerts.length > this.maxAlerts) this.alerts.pop();

            return result;
        } catch (e) {
            console.error('XAlert validation error for ' + ticker + ':', e.message);
            return { status: 'ERROR', ticker: ticker, message: e.message };
        }
    }

    // ── Fetch Validation Data ─────────────────────────────
    // 5 UW API calls + Polygon REST fallback per ticker
    async fetchValidationData(ticker, uw, polygonClient) {
        var results = {};

        // 1. Quote (price, volume)
        try {
            var quote = await uw.getStockQuote(ticker);
            results.quote = quote?.data || {};
        } catch (e) { results.quote = {}; }

        // 2. Float + Short Interest
        try {
            var floatData = await uw.getFloatData(ticker);
            results.float = floatData?.data || {};
        } catch (e) { results.float = {}; }

        // 3. Options flow
        try {
            var flow = await uw.getFlowByTicker(ticker);
            results.flow = flow?.data || [];
        } catch (e) { results.flow = []; }

        // 4. Historical price (for relative volume + volatility)
        try {
            var hist = await uw.getHistoricalPrice(ticker);
            results.historical = hist?.data || [];
        } catch (e) { results.historical = []; }

        // 5. Stock state (shares outstanding, market cap)
        try {
            var stockState = await uw.getStockState(ticker);
            results.stockState = stockState?.data || {};
        } catch (e) { results.stockState = {}; }

        // 6. Polygon REST fallback (replaces Yahoo Finance)
        results.yahooFallback = {}; // keep field name for backward compat with scoreAndPredict
        if (polygonClient) {
            try {
                var snap = await polygonClient.getTickerSnapshot(ticker);
                var details = await polygonClient.getTickerDetails(ticker);
                var polyData = {};
                // Snapshot: price, volume, change
                if (snap) {
                    var lastPrice = snap.lastTrade ? snap.lastTrade.p : (snap.day ? snap.day.c : 0);
                    var dayVol = snap.day ? snap.day.v : 0;
                    var prevClose = snap.prevDay ? snap.prevDay.c : 0;
                    var changePct = prevClose > 0 ? ((lastPrice - prevClose) / prevClose * 100) : 0;
                    polyData.price = lastPrice || 0;
                    polyData.volume = dayVol || 0;
                    polyData.changePercent = changePct;
                }
                // Details: float, shares outstanding, market cap
                if (details) {
                    polyData.sharesOutstanding = details.share_class_shares_outstanding || details.weighted_shares_outstanding || 0;
                    polyData.floatShares = details.share_class_shares_outstanding || 0; // Polygon doesn't have float separately
                    polyData.marketCap = details.market_cap || 0;
                    polyData.avgVolume = 0; // Would need historical aggregates
                    polyData.shortRatio = 0; // Not available from Polygon
                }
                results.yahooFallback = polyData;
                // Fill in primary quote if UW returned nothing useful
                if (!results.quote.price && !results.quote.last && polyData.price > 0) {
                    results.quote.price = polyData.price;
                    results.quote.last = polyData.price;
                    results.quote.volume = polyData.volume || 0;
                }
            } catch (e) {
                console.log('Polygon fallback unavailable for ' + ticker + ': ' + e.message);
            }
        }

        return results;
    }

    // ── Score + Predict Range ─────────────────────────────
    scoreAndPredict(ticker, data, source, rawText) {
        var quote = data.quote || {};
        var floatInfo = data.float || {};
        var flow = data.flow || [];
        var historical = data.historical || [];

        var price = parseFloat(quote.last || quote.price || quote.close || 0);
        var volume = parseFloat(quote.volume || quote.vol || 0);

        // ── Extract shares outstanding ──
        var stockState = data.stockState || {};
        var sharesOutstanding = 0;
        var marketCap = 0;
        if (Array.isArray(stockState) && stockState.length > 0) {
            var latestState = stockState[stockState.length - 1];
            sharesOutstanding = parseFloat(latestState.shares_outstanding || latestState.outstanding_shares || latestState.total_shares || 0);
            marketCap = parseFloat(latestState.market_cap || latestState.marketcap || 0);
        } else if (typeof stockState === 'object') {
            sharesOutstanding = parseFloat(stockState.shares_outstanding || stockState.outstanding_shares || stockState.total_shares || 0);
            marketCap = parseFloat(stockState.market_cap || stockState.marketcap || 0);
        }
        // Fallback: derive from price and market cap
        if (sharesOutstanding === 0 && marketCap > 0 && price > 0) {
            sharesOutstanding = Math.round(marketCap / price);
        }

        // ── Extract float data ──
        // UW float endpoint may return different field names
        var floatShares = 0;
        var shortInterest = 0;
        var shortRatio = 0;

        if (Array.isArray(floatInfo) && floatInfo.length > 0) {
            var latest = floatInfo[floatInfo.length - 1];
            floatShares = parseFloat(latest.float || latest.free_float || latest.shares_float || 0);
            shortInterest = parseFloat(latest.short_interest || latest.si || 0);
            shortRatio = parseFloat(latest.short_interest_pct || latest.si_pct || latest.percent_float_short || 0);
            // If we got raw short interest but not %, calculate it
            if (shortInterest > 0 && shortRatio === 0 && floatShares > 0) {
                shortRatio = (shortInterest / floatShares) * 100;
            }
        } else if (typeof floatInfo === 'object') {
            floatShares = parseFloat(floatInfo.float || floatInfo.free_float || floatInfo.shares_float || 0);
            shortInterest = parseFloat(floatInfo.short_interest || floatInfo.si || 0);
            shortRatio = parseFloat(floatInfo.short_interest_pct || floatInfo.si_pct || floatInfo.percent_float_short || 0);
            if (shortInterest > 0 && shortRatio === 0 && floatShares > 0) {
                shortRatio = (shortInterest / floatShares) * 100;
            }
        }

        // ── Yahoo Finance fallback for float/shares ──
        var yahooData = data.yahooFallback || {};
        if (floatShares === 0 && yahooData.floatShares > 0) {
            floatShares = yahooData.floatShares;
        }
        if (sharesOutstanding === 0 && yahooData.sharesOutstanding > 0) {
            sharesOutstanding = yahooData.sharesOutstanding;
        }
        if (marketCap === 0 && yahooData.marketCap > 0) {
            marketCap = yahooData.marketCap;
        }
        if (shortRatio === 0 && yahooData.shortRatio > 0) {
            shortRatio = yahooData.shortRatio;
        }

        // Track data completeness
        var dataFields = 0;
        var totalFields = 5;  // float, SI, volume, flow, price
        if (floatShares > 0) dataFields++;
        if (shortRatio > 0) dataFields++;
        if (volume > 0) dataFields++;
        if (flow.length > 0) dataFields++;
        if (price > 0) dataFields++;
        var dataCompleteness = Math.round((dataFields / totalFields) * 100);

        // ── Calculate relative volume ──
        var avgVolume = 0;
        if (historical.length >= 5) {
            var recent = historical.slice(-20);
            var totalVol = 0;
            recent.forEach(function (d) { totalVol += parseFloat(d.volume || 0); });
            avgVolume = totalVol / recent.length;
        }
        // Yahoo fallback for avg volume
        if (avgVolume === 0 && yahooData.avgVolume > 0) {
            avgVolume = yahooData.avgVolume;
        }
        var relativeVolume = avgVolume > 0 ? volume / avgVolume : 0;

        // ── Calculate intraday momentum ──
        var intradayChangePct = 0;
        if (yahooData.changePercent) {
            intradayChangePct = Math.abs(yahooData.changePercent);
        } else if (quote.changePercent || quote.change_percent) {
            intradayChangePct = Math.abs(parseFloat(quote.changePercent || quote.change_percent || 0));
        }

        // ── Analyze options flow ──
        var flowData = Array.isArray(flow) ? flow : [];
        var totalCalls = 0, totalPuts = 0, sweepCount = 0, totalPremium = 0;
        flowData.forEach(function (f) {
            var prem = parseFloat(f.premium || f.total_premium || 0);
            totalPremium += prem;
            var type = (f.put_call || f.option_type || '').toUpperCase();
            if (type === 'CALL' || type === 'C') { totalCalls++; }
            else if (type === 'PUT' || type === 'P') { totalPuts++; }
            var tradeType = (f.trade_type || f.type || '').toUpperCase();
            if (tradeType.indexOf('SWEEP') >= 0) sweepCount++;
        });
        var callRatio = (totalCalls + totalPuts) > 0 ? totalCalls / (totalCalls + totalPuts) : 0.5;

        // ── SCORING ──
        var score = 0;
        var signals = [];
        var maxScore = 115; // expanded to include momentum

        // Float score (25 points max)
        var floatLabel = 'UNKNOWN';
        if (floatShares > 0) {
            if (floatShares < 5000000) { score += 25; floatLabel = 'MICRO'; signals.push({ name: 'Micro Float', detail: (floatShares / 1e6).toFixed(1) + 'M', impact: 'HIGH' }); }
            else if (floatShares < 10000000) { score += 20; floatLabel = 'LOW'; signals.push({ name: 'Low Float', detail: (floatShares / 1e6).toFixed(1) + 'M', impact: 'HIGH' }); }
            else if (floatShares < 20000000) { score += 12; floatLabel = 'MODERATE'; signals.push({ name: 'Moderate Float', detail: (floatShares / 1e6).toFixed(1) + 'M', impact: 'MED' }); }
            else { score += 5; floatLabel = 'HIGH'; signals.push({ name: 'High Float', detail: (floatShares / 1e6).toFixed(1) + 'M', impact: 'LOW' }); }
        }

        // Short interest score (20 points max)
        if (shortRatio > 30) { score += 20; signals.push({ name: 'Extreme SI', detail: shortRatio.toFixed(1) + '%', impact: 'HIGH' }); }
        else if (shortRatio > 20) { score += 15; signals.push({ name: 'High SI', detail: shortRatio.toFixed(1) + '%', impact: 'HIGH' }); }
        else if (shortRatio > 10) { score += 8; signals.push({ name: 'Moderate SI', detail: shortRatio.toFixed(1) + '%', impact: 'MED' }); }
        else if (shortRatio > 0) { score += 3; signals.push({ name: 'Low SI', detail: shortRatio.toFixed(1) + '%', impact: 'LOW' }); }

        // Relative volume score (20 points max)
        if (relativeVolume >= 5) { score += 20; signals.push({ name: 'Extreme Volume', detail: relativeVolume.toFixed(1) + 'x avg', impact: 'HIGH' }); }
        else if (relativeVolume >= 3) { score += 15; signals.push({ name: 'High Volume', detail: relativeVolume.toFixed(1) + 'x avg', impact: 'HIGH' }); }
        else if (relativeVolume >= 1.5) { score += 8; signals.push({ name: 'Above Avg Vol', detail: relativeVolume.toFixed(1) + 'x avg', impact: 'MED' }); }

        // Intraday momentum score (15 points max — NEW)
        if (intradayChangePct >= 10) { score += 15; signals.push({ name: 'Extreme Momentum', detail: '+' + intradayChangePct.toFixed(1) + '% move', impact: 'HIGH' }); }
        else if (intradayChangePct >= 5) { score += 12; signals.push({ name: 'Strong Momentum', detail: '+' + intradayChangePct.toFixed(1) + '% move', impact: 'HIGH' }); }
        else if (intradayChangePct >= 3) { score += 8; signals.push({ name: 'Moderate Momentum', detail: '+' + intradayChangePct.toFixed(1) + '% move', impact: 'MED' }); }

        // Options flow score (15 points max)
        if (callRatio > 0.75 && sweepCount >= 2) { score += 15; signals.push({ name: 'Call Sweeps', detail: sweepCount + ' sweeps, ' + Math.round(callRatio * 100) + '% calls', impact: 'HIGH' }); }
        else if (callRatio > 0.65) { score += 10; signals.push({ name: 'Bullish Flow', detail: Math.round(callRatio * 100) + '% calls', impact: 'MED' }); }
        else if (callRatio < 0.35) { score += 5; signals.push({ name: 'Bearish Flow', detail: Math.round((1 - callRatio) * 100) + '% puts', impact: 'MED' }); }

        // Price level bonus (10 points max)
        if (price > 0 && price < 5) { score += 10; signals.push({ name: 'Penny Range', detail: '$' + price.toFixed(2), impact: 'MED' }); }
        else if (price >= 5 && price < 15) { score += 7; signals.push({ name: 'Low Price', detail: '$' + price.toFixed(2), impact: 'MED' }); }

        // Source bonus (10 points — multi-source or known trader)
        score += 10;
        signals.push({ name: 'X Alert', detail: source || 'Manual', impact: 'MED' });

        // Normalize to 0-100 scale
        score = Math.min(100, Math.round(score / maxScore * 100));

        // ── RANGE PREDICTION ──
        var predictedRange = this.calculateRange(floatShares, shortRatio, relativeVolume, callRatio, price);
        var targets = this.calculateTargets(price, predictedRange);

        // Direction
        var direction = callRatio > 0.55 ? 'BULLISH' : callRatio < 0.45 ? 'BEARISH' : 'NEUTRAL';

        return {
            ticker: ticker,
            price: price,
            score: score,
            direction: direction,
            status: score >= 60 ? 'VALIDATED' : score >= 40 ? 'WEAK' : 'REJECTED',
            floatShares: floatShares,
            floatLabel: floatLabel,
            shortInterest: shortRatio,
            relativeVolume: relativeVolume,
            callRatio: callRatio,
            sweepCount: sweepCount,
            totalPremium: totalPremium,
            predictedRange: predictedRange,
            targets: targets,
            signals: signals,
            source: source || 'Manual',
            rawText: rawText || '',
            validatedAt: new Date().toISOString(),
            avgVolume: Math.round(avgVolume),
            volume: volume,
            sharesOutstanding: sharesOutstanding,
            marketCap: marketCap,
            dataCompleteness: dataCompleteness,
            intradayMomentum: intradayChangePct
        };
    }

    // ── Range Prediction ──────────────────────────────────
    calculateRange(floatShares, siPct, relVol, callRatio, price) {
        // Base range from float size
        var baseMin = 10, baseMax = 25; // default moderate
        if (floatShares > 0) {
            if (floatShares < 2000000) { baseMin = 60; baseMax = 150; }
            else if (floatShares < 5000000) { baseMin = 40; baseMax = 100; }
            else if (floatShares < 10000000) { baseMin = 25; baseMax = 70; }
            else if (floatShares < 20000000) { baseMin = 15; baseMax = 40; }
            else { baseMin = 8; baseMax = 25; }
        }

        // SI squeeze multiplier
        var siMultiplier = 1.0;
        if (siPct > 30) siMultiplier = 1.4;
        else if (siPct > 20) siMultiplier = 1.25;
        else if (siPct > 10) siMultiplier = 1.1;

        // Volume confirmation multiplier
        var volMultiplier = 1.0;
        if (relVol >= 5) volMultiplier = 1.3;
        else if (relVol >= 3) volMultiplier = 1.15;
        else if (relVol < 1) volMultiplier = 0.7; // low volume = less likely to move

        // Flow multiplier
        var flowMultiplier = 1.0;
        if (callRatio > 0.75) flowMultiplier = 1.2;
        else if (callRatio > 0.65) flowMultiplier = 1.1;

        // Price multiplier (cheaper stocks move more in %)
        var priceMultiplier = 1.0;
        if (price > 0 && price < 5) priceMultiplier = 1.25;
        else if (price >= 5 && price < 10) priceMultiplier = 1.1;

        var finalMin = Math.round(baseMin * siMultiplier * volMultiplier * flowMultiplier * priceMultiplier);
        var finalMax = Math.round(baseMax * siMultiplier * volMultiplier * flowMultiplier * priceMultiplier);

        return { min: finalMin, max: finalMax };
    }

    // ── Target Price Calculation ──────────────────────────
    calculateTargets(price, range) {
        if (!price || price <= 0) return null;
        var midRange = (range.min + range.max) / 2 / 100;

        return {
            conservative: {
                price: +(price * (1 + midRange * 0.4)).toFixed(2),
                pct: Math.round(midRange * 40)
            },
            moderate: {
                price: +(price * (1 + midRange * 0.7)).toFixed(2),
                pct: Math.round(midRange * 70)
            },
            aggressive: {
                price: +(price * (1 + midRange * 1.0)).toFixed(2),
                pct: Math.round(midRange * 100)
            },
            stopLoss: {
                price: +(price * 0.92).toFixed(2),
                pct: -8
            }
        };
    }

    // ── Getters ───────────────────────────────────────────
    getAlerts() {
        return this.alerts;
    }

    getAlert(ticker) {
        ticker = (ticker || '').toUpperCase();
        return this.alerts.find(function (a) { return a.ticker === ticker; });
    }

    clearCooldown(ticker) {
        if (ticker) {
            delete this.cooldown[ticker.toUpperCase()];
        } else {
            this.cooldown = {};
        }
    }

    // ── Format for Telegram ──────────────────────────────
    formatTelegramMessage(result) {
        if (!result || result.status === 'ERROR') return null;

        var emoji = result.status === 'VALIDATED' ? '✅' : result.status === 'WEAK' ? '⚠️' : '❌';
        var dirEmoji = result.direction === 'BULLISH' ? '🟢' : result.direction === 'BEARISH' ? '🔴' : '⚪';

        var msg = '🎯 <b>X ALERT ' + (result.status === 'VALIDATED' ? 'VALIDATED' : 'REVIEWED') + ': ' + result.ticker + '</b>\n\n';
        msg += 'Score: ' + result.score + '% ' + emoji + '\n';
        msg += 'Direction: ' + result.direction + ' ' + dirEmoji + '\n';
        msg += 'Price: $' + (result.price || 0).toFixed(2) + '\n';

        if (result.sharesOutstanding > 0) msg += 'Shares Outstanding: ' + this._fmtNum(result.sharesOutstanding) + '\n';
        if (result.floatShares > 0) msg += 'Float: ' + this._fmtNum(result.floatShares) + ' (' + result.floatLabel + ')\n';
        if (result.shortInterest > 0) msg += 'Short Interest: ' + result.shortInterest.toFixed(1) + '%\n';
        if (result.relativeVolume > 0) msg += 'Rel. Volume: ' + result.relativeVolume.toFixed(1) + 'x avg\n';
        if (result.sweepCount > 0) msg += 'Call Sweeps: ' + result.sweepCount + '\n';

        if (result.targets && result.price > 0) {
            msg += '\n📊 <b>PREDICTED RANGE: ' + result.predictedRange.min + '-' + result.predictedRange.max + '%</b>\n';
            msg += '🎯 Targets:\n';
            msg += '  Conservative: $' + result.targets.conservative.price + ' (+' + result.targets.conservative.pct + '%)\n';
            msg += '  Moderate: $' + result.targets.moderate.price + ' (+' + result.targets.moderate.pct + '%)\n';
            msg += '  Aggressive: $' + result.targets.aggressive.price + ' (+' + result.targets.aggressive.pct + '%)\n';
            msg += '  Stop Loss: $' + result.targets.stopLoss.price + ' (' + result.targets.stopLoss.pct + '%)\n';
        }

        msg += '\nSource: ' + result.source;
        if (result.rawText) msg += '\n<i>' + result.rawText.substring(0, 100) + '</i>';

        return msg;
    }

    // Helper: format large numbers
    _fmtNum(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
        return n.toString();
    }

    // ── Scan Market for Low-Float Candidates ────────────────
    // Discovers potential low-float movers from flow, dark pool, and halts
    async scanMarket(state, uw, polygonClient) {
        var candidates = {};
        var existingTickers = this.alerts.map(function (a) { return a.ticker; });
        var watchlist = state.tickers || [];

        // Exclude common ETFs, indices, and large-cap tickers
        var excludeList = ['SPY', 'QQQ', 'IWM', 'DIA', 'SPX', 'NDX', 'VXX', 'UVXY', 'SQQQ', 'TQQQ',
            'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV', 'TLT', 'HYG', 'EEM', 'XBI',
            'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AMD', 'INTC',
            'JPM', 'BAC', 'WFC', 'GS', 'V', 'MA', 'BRK.A', 'BRK.B', 'JNJ', 'PFE'];

        // Source 1: Options flow — look for high-volume sweeps on cheap stocks
        (state.optionsFlow || []).forEach(function (f) {
            var t = (f.ticker || f.symbol || f.underlying_symbol || '').toUpperCase();
            if (!t || existingTickers.indexOf(t) >= 0 || watchlist.indexOf(t) >= 0) return;
            if (excludeList.indexOf(t) >= 0) return;
            var price = parseFloat(f.price || f.underlying_price || f.stock_price || 0);
            var prem = parseFloat(f.premium || f.total_premium || 0);
            var tradeType = (f.trade_type || f.type || '').toUpperCase();
            var isSweep = tradeType.indexOf('SWEEP') >= 0;

            // Filter: cheap stocks with notable flow (price must be known and under $20)
            if (price > 0.5 && price < 20 && prem > 10000) {
                if (!candidates[t]) candidates[t] = { ticker: t, weight: 0, sources: [] };
                candidates[t].weight += isSweep ? 3 : 1;
                candidates[t].weight += prem > 50000 ? 2 : 0;
                candidates[t].sources.push('flow');
            }
        });

        // Source 2: Dark pool — unusual prints on cheap stocks
        (state.darkPoolRecent || []).forEach(function (d) {
            var t = (d.ticker || d.symbol || '').toUpperCase();
            if (!t || existingTickers.indexOf(t) >= 0 || watchlist.indexOf(t) >= 0) return;
            var price = parseFloat(d.price || d.avg_price || 0);
            var notional = parseFloat(d.volume || d.size || 0) * price;
            if (price > 0 && price < 20 && notional > 100000) {
                if (!candidates[t]) candidates[t] = { ticker: t, weight: 0, sources: [] };
                candidates[t].weight += 2;
                candidates[t].sources.push('darkpool');
            }
        });

        // Sort by weight, take top 5
        var sorted = Object.values(candidates)
            .sort(function (a, b) { return b.weight - a.weight; })
            .slice(0, 5);

        var results = [];
        for (var i = 0; i < sorted.length; i++) {
            var cand = sorted[i];
            try {
                console.log('🔎 Scanning low-float candidate: ' + cand.ticker + ' (weight: ' + cand.weight + ', sources: ' + cand.sources.join(',') + ')');
                var result = await this.ingestAlert(cand.ticker, 'Auto-Scan', '', uw, polygonClient);
                if (result && result.status !== 'COOLDOWN' && result.status !== 'ERROR') {
                    results.push(result);
                }
            } catch (e) {
                console.error('Scan error for ' + cand.ticker + ':', e.message);
            }
        }

        return results;
    }
}

module.exports = { XAlertMonitor };
