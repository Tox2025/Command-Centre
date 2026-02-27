// Options Paper Trading — simulate options contract trades
// Tracks entries, premium P&L, theta decay, expirations, and feeds ML
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'options-paper-trades.json');

class OptionsPaperTrading {
    constructor() {
        this.trades = [];
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(DATA_PATH)) {
                var raw = fs.readFileSync(DATA_PATH, 'utf8');
                var data = JSON.parse(raw);
                this.trades = data.trades || [];
            }
        } catch (e) {
            this.trades = [];
        }
    }

    _save() {
        try {
            var dir = path.dirname(DATA_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(DATA_PATH, JSON.stringify({ trades: this.trades }, null, 2));
        } catch (e) {
            // silent
        }
    }

    // ── Open a new options paper trade ────────────────────
    openTrade(params) {
        if (!params || !params.ticker) return null;

        // Check for duplicate open trade (same ticker + type + strike)
        var dup = this.trades.find(function (t) {
            return t.status === 'OPEN'
                && t.ticker === params.ticker
                && t.optionType === params.optionType
                && t.strike === params.strike;
        });
        if (dup) return null;

        var now = Date.now();
        var trade = {
            id: 'OPT-' + now + '-' + Math.random().toString(36).substr(2, 5),
            ticker: params.ticker,
            optionType: params.optionType || 'call',   // 'call' or 'put'
            strategy: params.strategy || 'long_call',
            strike: params.strike,
            dte: params.dte || 30,
            expirationDate: this._calcExpiry(params.dte || 30),
            entryPremium: params.premium || 0,
            currentPremium: params.premium || 0,
            contracts: params.contracts || 1,
            entryPrice: params.stockPrice || 0,         // underlying price at entry
            currentPrice: params.stockPrice || 0,       // underlying current
            confidence: params.confidence || 0,
            direction: params.direction || 'NEUTRAL',
            signals: params.signals || [],
            reasoning: params.reasoning || [],
            ivRankAtEntry: params.ivRank || 0,
            horizon: params.horizon || 'swing',
            session: params.session || 'UNKNOWN',
            // P&L tracking
            pnl: 0,                    // realized P&L ($)
            pnlPct: 0,                 // realized P&L (%)
            unrealizedPnl: 0,          // unrealized P&L ($)
            unrealizedPnlPct: 0,       // unrealized P&L (%)
            // Timing
            openTime: new Date().toISOString(),
            closeTime: null,
            status: 'OPEN',            // OPEN, WIN, LOSS, EXPIRED, CLOSED
            outcome: null,
            // Auto-trading settings
            autoEntry: params.autoEntry || false,
            // ML features at entry
            features: params.features || {}
        };

        this.trades.push(trade);
        this._save();
        return trade;
    }

    // ── Calculate expiration date ─────────────────────────
    _calcExpiry(dte) {
        var d = new Date();
        d.setDate(d.getDate() + dte);
        return d.toISOString().split('T')[0]; // YYYY-MM-DD
    }

    // ── Update all open trades with current prices ───────
    updatePrices(quotes) {
        var updated = 0;
        var now = new Date();
        var self = this;

        this.trades.forEach(function (trade) {
            if (trade.status !== 'OPEN') return;
            var q = quotes[trade.ticker];
            if (!q) return;

            var currentPrice = parseFloat(q.last || q.price || q.close || 0);
            if (currentPrice === 0) return;

            trade.currentPrice = currentPrice;

            // Estimate current premium using simplified model
            var newPremium = self._estimatePremium(trade, currentPrice, now);
            trade.currentPremium = newPremium;

            // Calculate unrealized P&L
            var direction = (trade.strategy === 'long_call' || trade.strategy === 'long_put') ? 1 : -1;
            trade.unrealizedPnl = +((newPremium - trade.entryPremium) * direction * trade.contracts * 100).toFixed(2);
            trade.unrealizedPnlPct = trade.entryPremium > 0
                ? +((newPremium - trade.entryPremium) / trade.entryPremium * 100 * direction).toFixed(2)
                : 0;

            updated++;
        });

        // Check for expirations and auto-outcomes
        this._checkOutcomes(now);

        if (updated > 0) this._save();
        return updated;
    }

    // ── Estimate current premium (simplified Black-Scholes proxy) ──
    _estimatePremium(trade, currentPrice, now) {
        var strike = trade.strike;
        var entryPremium = trade.entryPremium;
        var entryPrice = trade.entryPrice;
        if (entryPrice === 0 || entryPremium === 0) return entryPremium;

        // Days remaining
        var expiry = new Date(trade.expirationDate);
        var msRemaining = expiry.getTime() - now.getTime();
        var daysRemaining = Math.max(0, msRemaining / (1000 * 60 * 60 * 24));
        var originalDTE = trade.dte || 30;

        // Time decay factor (theta): sqrt curve — faster near expiry
        var timeFactor = originalDTE > 0 ? Math.sqrt(daysRemaining / originalDTE) : 0;

        // Intrinsic value
        var intrinsic = 0;
        if (trade.optionType === 'call') {
            intrinsic = Math.max(0, currentPrice - strike);
        } else {
            intrinsic = Math.max(0, strike - currentPrice);
        }

        // Extrinsic at entry (time value)
        var entryIntrinsic = 0;
        if (trade.optionType === 'call') {
            entryIntrinsic = Math.max(0, entryPrice - strike);
        } else {
            entryIntrinsic = Math.max(0, strike - entryPrice);
        }
        var entryExtrinsic = Math.max(0, entryPremium - entryIntrinsic);

        // Current extrinsic = entry extrinsic × time decay factor
        var currentExtrinsic = entryExtrinsic * timeFactor;

        // Delta effect: how much premium changes per $ of underlying move
        var moneyness = (currentPrice - strike) / strike;
        var delta = 0.5; // ATM default
        if (trade.optionType === 'call') {
            if (moneyness > 0.05) delta = 0.7;      // ITM
            else if (moneyness > 0) delta = 0.55;    // slightly ITM
            else if (moneyness > -0.05) delta = 0.4; // slightly OTM
            else delta = 0.2;                         // deep OTM
        } else {
            moneyness = -moneyness; // flip for puts
            if (moneyness > 0.05) delta = 0.7;
            else if (moneyness > 0) delta = 0.55;
            else if (moneyness > -0.05) delta = 0.4;
            else delta = 0.2;
        }

        // Total estimated premium
        var estimated = intrinsic + currentExtrinsic;
        estimated = Math.max(0.01, estimated); // minimum $0.01

        return Math.round(estimated * 100) / 100;
    }

    // ── Check for outcomes (expiration, profit targets, stop losses) ──
    _checkOutcomes(now) {
        var self = this;
        this.trades.forEach(function (trade) {
            if (trade.status !== 'OPEN') return;

            // Check expiration
            var expiry = new Date(trade.expirationDate + 'T16:00:00');
            if (now >= expiry) {
                // Expired — close at intrinsic value
                var intrinsic = 0;
                if (trade.optionType === 'call') {
                    intrinsic = Math.max(0, trade.currentPrice - trade.strike);
                } else {
                    intrinsic = Math.max(0, trade.strike - trade.currentPrice);
                }
                var exitPremium = intrinsic;
                self._closeTrade(trade, intrinsic > 0 ? 'EXPIRED_ITM' : 'EXPIRED_OTM', exitPremium);
                return;
            }

            // Auto-close rules for paper trades
            if (trade.unrealizedPnlPct >= 100) {
                // Take profit at 100% gain (doubled)
                self._closeTrade(trade, 'WIN_100PCT', trade.currentPremium);
            } else if (trade.unrealizedPnlPct >= 50 && trade.dte <= 2) {
                // Take profit at 50% if near expiry
                self._closeTrade(trade, 'WIN_50PCT', trade.currentPremium);
            } else if (trade.unrealizedPnlPct <= -50) {
                // Cut losses at 50%
                self._closeTrade(trade, 'LOSS_50PCT', trade.currentPremium);
            }
        });
    }

    // ── Close a trade ────────────────────────────────────
    _closeTrade(trade, outcome, exitPremium) {
        trade.status = outcome.startsWith('WIN') || outcome === 'EXPIRED_ITM' ? 'WIN' : 'LOSS';
        trade.outcome = outcome;
        trade.closeTime = new Date().toISOString();
        trade.exitPremium = exitPremium;

        var direction = (trade.strategy === 'long_call' || trade.strategy === 'long_put') ? 1 : -1;
        trade.pnl = +((exitPremium - trade.entryPremium) * direction * trade.contracts * 100).toFixed(2);
        trade.pnlPct = trade.entryPremium > 0
            ? +((exitPremium - trade.entryPremium) / trade.entryPremium * 100 * direction).toFixed(2)
            : 0;
        trade.unrealizedPnl = 0;
        trade.unrealizedPnlPct = 0;

        this._save();
    }

    // ── Manual close ─────────────────────────────────────
    closeTrade(id) {
        var trade = this.trades.find(function (t) { return t.id === id && t.status === 'OPEN'; });
        if (!trade) return null;
        this._closeTrade(trade, 'CLOSED', trade.currentPremium);
        return trade;
    }

    // ── Get all trades ───────────────────────────────────
    getTrades() {
        return this.trades;
    }

    getOpenTrades() {
        return this.trades.filter(function (t) { return t.status === 'OPEN'; });
    }

    getClosedTrades() {
        return this.trades.filter(function (t) { return t.status !== 'OPEN'; });
    }

    // ── Stats ────────────────────────────────────────────
    getStats() {
        var open = this.getOpenTrades();
        var closed = this.getClosedTrades();
        var wins = closed.filter(function (t) { return t.status === 'WIN'; });
        var losses = closed.filter(function (t) { return t.status === 'LOSS'; });

        var totalPnl = closed.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var unrealizedPnl = open.reduce(function (s, t) { return s + (t.unrealizedPnl || 0); }, 0);
        var winRate = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
        var avgWin = wins.length > 0 ? +(wins.reduce(function (s, t) { return s + t.pnlPct; }, 0) / wins.length).toFixed(2) : 0;
        var avgLoss = losses.length > 0 ? +(losses.reduce(function (s, t) { return s + t.pnlPct; }, 0) / losses.length).toFixed(2) : 0;
        var avgPnl = closed.length > 0 ? +(closed.reduce(function (s, t) { return s + t.pnlPct; }, 0) / closed.length).toFixed(2) : 0;

        // Today's stats
        var now = new Date();
        var todayStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
        var todayClosed = closed.filter(function (t) {
            if (!t.closeTime) return false;
            return new Date(t.closeTime).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === todayStr;
        });
        var todayPnl = todayClosed.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var todayWins = todayClosed.filter(function (t) { return t.pnl > 0; }).length;
        var todayLosses = todayClosed.filter(function (t) { return t.pnl <= 0; }).length;
        var todayWinRate = todayClosed.length > 0 ? Math.round(todayWins / todayClosed.length * 100) : 0;

        // Call vs Put breakdown
        var calls = closed.filter(function (t) { return t.optionType === 'call'; });
        var puts = closed.filter(function (t) { return t.optionType === 'put'; });
        var callWins = calls.filter(function (t) { return t.pnl > 0; }).length;
        var putWins = puts.filter(function (t) { return t.pnl > 0; }).length;
        var callPnl = calls.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var putPnl = puts.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);

        // Best / Worst trade
        var sortedByPnl = closed.slice().sort(function (a, b) { return b.pnl - a.pnl; });
        var bestTrade = sortedByPnl[0] || null;
        var worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;

        // By strategy
        var byStrategy = {};
        closed.forEach(function (t) {
            var s = t.strategy || 'unknown';
            if (!byStrategy[s]) byStrategy[s] = { wins: 0, losses: 0, pnl: 0 };
            if (t.status === 'WIN') byStrategy[s].wins++;
            else byStrategy[s].losses++;
            byStrategy[s].pnl += t.pnl || 0;
        });

        // By confidence bracket
        var byConfidence = {};
        closed.forEach(function (t) {
            var bracket = Math.floor((t.confidence || 0) / 10) * 10;
            var key = bracket + '-' + (bracket + 9) + '%';
            if (!byConfidence[key]) byConfidence[key] = { wins: 0, losses: 0, pnl: 0 };
            if (t.status === 'WIN') byConfidence[key].wins++;
            else byConfidence[key].losses++;
            byConfidence[key].pnl += t.pnl || 0;
        });

        // Per-ticker breakdown
        var byTicker = {};
        closed.forEach(function (t) {
            if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, trades: 0, wins: 0, losses: 0, pnl: 0, calls: 0, puts: 0, callPnl: 0, putPnl: 0 };
            var bt = byTicker[t.ticker];
            bt.trades++;
            if (t.pnl > 0) bt.wins++; else bt.losses++;
            bt.pnl += (t.pnl || 0);
            if (t.optionType === 'call') { bt.calls++; bt.callPnl += (t.pnl || 0); }
            else { bt.puts++; bt.putPnl += (t.pnl || 0); }
        });
        var tickerBreakdown = Object.values(byTicker).sort(function (a, b) { return b.pnl - a.pnl; });

        return {
            totalTrades: this.trades.length,
            openPositions: open.length,
            closedTrades: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: winRate,
            totalPnl: +totalPnl.toFixed(2),
            unrealizedPnl: +unrealizedPnl.toFixed(2),
            avgWinPct: avgWin,
            avgLossPct: avgLoss,
            avgPnl: avgPnl,
            todayPnl: +todayPnl.toFixed(2),
            todayTrades: todayClosed.length,
            today: { closed: todayClosed.length, pnl: +todayPnl.toFixed(2), wins: todayWins, losses: todayLosses, winRate: todayWinRate },
            callStats: { trades: calls.length, wins: callWins, pnl: +callPnl.toFixed(2), winRate: calls.length > 0 ? Math.round(callWins / calls.length * 100) : 0 },
            putStats: { trades: puts.length, wins: putWins, pnl: +putPnl.toFixed(2), winRate: puts.length > 0 ? Math.round(putWins / puts.length * 100) : 0 },
            bestTrade: bestTrade ? { ticker: bestTrade.ticker, pnl: +bestTrade.pnl.toFixed(2), optionType: bestTrade.optionType, strike: bestTrade.strike } : null,
            worstTrade: worstTrade ? { ticker: worstTrade.ticker, pnl: +worstTrade.pnl.toFixed(2), optionType: worstTrade.optionType, strike: worstTrade.strike } : null,
            byStrategy: byStrategy,
            byConfidence: byConfidence,
            tickerBreakdown: tickerBreakdown
        };
    }

    // ── ML Training Data ─────────────────────────────────
    getTrainingData() {
        return this.getClosedTrades().map(function (t) {
            return {
                ticker: t.ticker,
                optionType: t.optionType,
                strategy: t.strategy,
                strike: t.strike,
                dte: t.dte,
                entryPremium: t.entryPremium,
                confidence: t.confidence,
                direction: t.direction,
                ivRankAtEntry: t.ivRankAtEntry,
                horizon: t.horizon,
                outcome: t.outcome,
                pnlPct: t.pnlPct,
                pnl: t.pnl,
                win: t.status === 'WIN' ? 1 : 0,
                features: t.features
            };
        });
    }

    // ── Auto-enter from signal engine ────────────────────
    // Called automatically when A/B paper trades are created
    autoEnterFromSignal(ticker, signalResult, stockPrice, quote) {
        if (!ticker || !signalResult || !stockPrice || stockPrice <= 0) return null;
        if (!signalResult.direction || signalResult.direction === 'NEUTRAL') return null;
        if ((signalResult.confidence || 0) < 60) return null; // Only trade high-conf signals

        // Cooldown: max 1 options trade per ticker per 2 hours
        var now = Date.now();
        var recent = this.trades.find(function (t) {
            return t.ticker === ticker && t.status === 'OPEN'
                && (now - new Date(t.openTime).getTime()) < 2 * 60 * 60 * 1000;
        });
        if (recent) return null;

        var isBullish = signalResult.direction === 'BULLISH';
        var optionType = isBullish ? 'call' : 'put';
        var strategy = isBullish ? 'long_call' : 'long_put';

        // ATM strike (round to nearest $5 for stocks > $100, $1 otherwise)
        var strikeRound = stockPrice > 100 ? 5 : 1;
        var strike = Math.round(stockPrice / strikeRound) * strikeRound;

        // DTE: 14 days for day/intraday, 30 for swing
        var dte = 14;

        // Estimate premium: ~2-4% of stock price for ATM with 14 DTE
        var premiumPct = 0.03; // 3%
        var estimatedPremium = +(stockPrice * premiumPct).toFixed(2);

        // Contracts: 1-3 based on confidence
        var contracts = signalResult.confidence >= 80 ? 3 : signalResult.confidence >= 70 ? 2 : 1;

        // Cap max premium per trade at $500 per contract
        if (estimatedPremium * 100 * contracts > 5000) {
            contracts = Math.max(1, Math.floor(5000 / (estimatedPremium * 100)));
        }

        var trade = this.openTrade({
            ticker: ticker,
            optionType: optionType,
            strategy: strategy,
            strike: strike,
            dte: dte,
            premium: estimatedPremium,
            contracts: contracts,
            stockPrice: stockPrice,
            confidence: signalResult.confidence,
            direction: signalResult.direction,
            signals: (signalResult.signals || []).slice(0, 5).map(function (s) { return s.name || s; }),
            features: signalResult.features || [],
            autoEntry: true,
            session: 'AUTO',
            horizon: 'day_trade'
        });

        if (trade) {
            console.log('📋 Auto options paper: ' + optionType.toUpperCase() + ' ' + ticker + ' $' + strike + ' x' + contracts + ' @ $' + estimatedPremium + ' (conf: ' + signalResult.confidence + '%)');
        }
        return trade;
    }
}

module.exports = OptionsPaperTrading;
