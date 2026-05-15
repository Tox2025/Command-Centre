// Futures Paper Trading — simulate futures contract trades using proxy ETFs
// Tracks entries, P&L, margins, and feeds ML
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'futures-paper-trades.json');

// Future contract specifications
const FUTURES_SPECS = {
    '/ES': { proxy: 'SPY', proxyRatio: 10, multiplier: 50, tickSize: 0.25 },
    '/NQ': { proxy: 'QQQ', proxyRatio: 40, multiplier: 20, tickSize: 0.25 }
};

class FuturesPaperTrading {
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

    // ── Open a new futures paper trade ────────────────────
    openTrade(params) {
        if (!params || !params.ticker) return null;
        
        var spec = FUTURES_SPECS[params.ticker.toUpperCase()];
        if (!spec) return null; // Only support defined futures

        // Check for duplicate open trade (same ticker + strategy + version)
        var dup = this.trades.find(function (t) {
            return t.status === 'OPEN'
                && t.ticker === params.ticker
                && t.strategy === params.strategy
                && t.signalVersion === (params.signalVersion || 'vF1');
        });
        if (dup) return null;

        var now = Date.now();
        var entryPoints = params.proxyPrice * spec.proxyRatio;

        var trade = {
            id: 'FUT-' + now + '-' + Math.random().toString(36).substr(2, 5),
            ticker: params.ticker.toUpperCase(),
            proxyTicker: spec.proxy,
            strategy: params.strategy || 'long',   // 'long' or 'short'
            entryProxyPrice: params.proxyPrice || 0,
            currentProxyPrice: params.proxyPrice || 0,
            entryPoints: entryPoints,
            currentPoints: entryPoints,
            contracts: params.contracts || 1, // lots
            
            confidence: params.confidence || 0,
            signals: params.signals || [],
            reasoning: params.reasoning || [],
            horizon: params.horizon || 'day_trade',
            session: params.session || 'UNKNOWN',
            
            // P&L tracking
            pnl: 0,                    // realized P&L ($)
            unrealizedPnl: 0,          // unrealized P&L ($)
            
            // Timing
            openTime: new Date().toISOString(),
            closeTime: null,
            status: 'OPEN',            // OPEN, WIN, LOSS, CLOSED
            outcome: null,
            
            // auto-trading settings
            autoEntry: params.autoEntry || false,
            signalVersion: params.signalVersion || 'vF1',
            
            // ML features at entry
            features: params.features || {}
        };

        this.trades.push(trade);
        this._save();
        return trade;
    }

    // ── Update all open trades with current proxy prices ──
    updatePrices(quotes) {
        var updated = 0;
        var self = this;

        this.trades.forEach(function (trade) {
            if (trade.status !== 'OPEN') return;
            var q = quotes[trade.proxyTicker];
            if (!q) return;

            var currentProxyPrice = parseFloat(q.last || q.price || q.close || 0);
            if (currentProxyPrice === 0) return;

            trade.currentProxyPrice = currentProxyPrice;
            
            var spec = FUTURES_SPECS[trade.ticker];
            trade.currentPoints = currentProxyPrice * spec.proxyRatio;

            // Calculate unrealized P&L
            var direction = trade.strategy === 'long' ? 1 : -1;
            var pointsMoved = (trade.currentPoints - trade.entryPoints) * direction;
            trade.unrealizedPnl = +(pointsMoved * spec.multiplier * trade.contracts).toFixed(2);

            updated++;
        });

        // Check auto-outcomes (stop losses / profit targets)
        this._checkOutcomes();

        if (updated > 0) this._save();
        return updated;
    }

    // ── Check for outcomes (profit targets, stop losses) ──
    _checkOutcomes() {
        var self = this;
        this.trades.forEach(function (trade) {
            if (trade.status !== 'OPEN') return;

            // Example rules: take profit at $1000 per contract, stop loss at -$500 per contract
            var pnlPerContract = trade.unrealizedPnl / trade.contracts;
            
            if (pnlPerContract >= 1000) {
                self._closeTrade(trade, 'WIN_TARGET', trade.currentPoints);
            } else if (pnlPerContract <= -500) {
                self._closeTrade(trade, 'LOSS_STOP', trade.currentPoints);
            }
        });
    }

    // ── Close a trade ────────────────────────────────────
    _closeTrade(trade, outcome, exitPoints) {
        trade.status = outcome.startsWith('WIN') ? 'WIN' : (outcome.startsWith('LOSS') ? 'LOSS' : 'CLOSED');
        trade.outcome = outcome;
        trade.closeTime = new Date().toISOString();
        trade.exitPoints = exitPoints;

        var spec = FUTURES_SPECS[trade.ticker];
        var direction = trade.strategy === 'long' ? 1 : -1;
        var pointsMoved = (exitPoints - trade.entryPoints) * direction;
        
        trade.pnl = +(pointsMoved * spec.multiplier * trade.contracts).toFixed(2);
        if (trade.pnl > 0 && trade.status === 'CLOSED') trade.status = 'WIN';
        if (trade.pnl < 0 && trade.status === 'CLOSED') trade.status = 'LOSS';
        
        trade.unrealizedPnl = 0;

        this._save();
    }

    // ── Manual close ─────────────────────────────────────
    closeTrade(id) {
        var trade = this.trades.find(function (t) { return t.id === id && t.status === 'OPEN'; });
        if (!trade) return null;
        this._closeTrade(trade, 'CLOSED_MANUAL', trade.currentPoints);
        return trade;
    }

    // ── Get trades ─────────────────────────────────────────
    getTrades(version) {
        if (!version || version === 'all') return this.trades;
        return this.trades.filter(function (t) { return t.signalVersion === version; });
    }

    getOpenTrades(version) {
        var open = this.trades.filter(function (t) { return t.status === 'OPEN'; });
        if (!version || version === 'all') return open;
        return open.filter(function (t) { return t.signalVersion === version; });
    }

    getClosedTrades(version) {
        var closed = this.trades.filter(function (t) { return t.status !== 'OPEN'; });
        if (!version || version === 'all') return closed;
        return closed.filter(function (t) { return t.signalVersion === version; });
    }

    // ── Stats ────────────────────────────────────────────
    getStats(version) {
        var open = this.getOpenTrades(version);
        var closed = this.getClosedTrades(version);

        var wins = closed.filter(function (t) { return t.status === 'WIN'; });
        var losses = closed.filter(function (t) { return t.status === 'LOSS'; });

        var totalPnl = closed.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var unrealizedPnl = open.reduce(function (s, t) { return s + (t.unrealizedPnl || 0); }, 0);
        var winRate = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
        
        var avgWin = wins.length > 0 ? +(wins.reduce(function (s, t) { return s + t.pnl; }, 0) / wins.length).toFixed(2) : 0;
        var avgLoss = losses.length > 0 ? +(losses.reduce(function (s, t) { return s + t.pnl; }, 0) / losses.length).toFixed(2) : 0;
        var avgPnl = closed.length > 0 ? +(closed.reduce(function (s, t) { return s + t.pnl; }, 0) / closed.length).toFixed(2) : 0;

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

        // Long vs Short breakdown
        var longs = closed.filter(function (t) { return t.strategy === 'long'; });
        var shorts = closed.filter(function (t) { return t.strategy === 'short'; });
        var longWins = longs.filter(function (t) { return t.pnl > 0; }).length;
        var shortWins = shorts.filter(function (t) { return t.pnl > 0; }).length;
        var longPnl = longs.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var shortPnl = shorts.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);

        // Best / Worst trade
        var sortedByPnl = closed.slice().sort(function (a, b) { return b.pnl - a.pnl; });
        var bestTrade = sortedByPnl[0] || null;
        var worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;

        // Per-ticker breakdown
        var byTicker = {};
        closed.forEach(function (t) {
            if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, trades: 0, wins: 0, losses: 0, pnl: 0 };
            var bt = byTicker[t.ticker];
            bt.trades++;
            if (t.pnl > 0) bt.wins++; else bt.losses++;
            bt.pnl += (t.pnl || 0);
        });
        var tickerBreakdown = Object.values(byTicker).sort(function (a, b) { return b.pnl - a.pnl; });

        return {
            totalTrades: open.length + closed.length,
            openPositions: open.length,
            closedTrades: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: winRate,
            totalPnl: +totalPnl.toFixed(2),
            unrealizedPnl: +unrealizedPnl.toFixed(2),
            avgWin: avgWin,
            avgLoss: avgLoss,
            avgPnl: avgPnl,
            todayPnl: +todayPnl.toFixed(2),
            todayTrades: todayClosed.length,
            today: { closed: todayClosed.length, pnl: +todayPnl.toFixed(2), wins: todayWins, losses: todayLosses, winRate: todayWinRate },
            longStats: { trades: longs.length, wins: longWins, pnl: +longPnl.toFixed(2), winRate: longs.length > 0 ? Math.round(longWins / longs.length * 100) : 0 },
            shortStats: { trades: shorts.length, wins: shortWins, pnl: +shortPnl.toFixed(2), winRate: shorts.length > 0 ? Math.round(shortWins / shorts.length * 100) : 0 },
            bestTrade: bestTrade ? { ticker: bestTrade.ticker, pnl: +bestTrade.pnl.toFixed(2), strategy: bestTrade.strategy } : null,
            worstTrade: worstTrade ? { ticker: worstTrade.ticker, pnl: +worstTrade.pnl.toFixed(2), strategy: worstTrade.strategy } : null,
            tickerBreakdown: tickerBreakdown
        };
    }

    // ── ML Training Data ─────────────────────────────────
    getTrainingData() {
        return this.getClosedTrades().map(function (t) {
            return {
                ticker: t.ticker,
                strategy: t.strategy,
                entryPoints: t.entryPoints,
                confidence: t.confidence,
                horizon: t.horizon,
                outcome: t.outcome,
                pnl: t.pnl,
                win: t.status === 'WIN' ? 1 : 0,
                features: t.features
            };
        });
    }

    // ── Auto-enter from signal engine ────────────────────
    autoEnterFromSignal(proxyTicker, signalResult, proxyPrice, explicitVersion) {
        if (!proxyTicker || !signalResult || !proxyPrice || proxyPrice <= 0) return null;
        if (!signalResult.direction || signalResult.direction === 'NEUTRAL') return null;
        if ((signalResult.confidence || 0) < 51) return null; // Trade signals 51%+

        // Map proxy ETF to futures ticker
        var futuresTicker = null;
        if (proxyTicker === 'SPY') futuresTicker = '/ES';
        else if (proxyTicker === 'QQQ') futuresTicker = '/NQ';
        else return null; // Not a supported futures proxy

        var version = explicitVersion || 'vF1';
        // Allow any version that matches futures naming (vF...)
        if (!version.startsWith('vF')) return null;

        // Cooldown: max 1 futures trade per ticker per version per hour
        var now = Date.now();
        var recent = this.trades.find(function (t) {
            return t.ticker === futuresTicker && t.status === 'OPEN' && t.signalVersion === version
                && (now - new Date(t.openTime).getTime()) < 60 * 60 * 1000;
        });
        if (recent) return null;

        var isBullish = signalResult.direction === 'BULLISH';
        var strategy = isBullish ? 'long' : 'short';

        // Contracts: 1-3 based on confidence
        var contracts = signalResult.confidence >= 80 ? 3 : signalResult.confidence >= 70 ? 2 : 1;

        var trade = this.openTrade({
            ticker: futuresTicker,
            strategy: strategy,
            proxyPrice: proxyPrice,
            contracts: contracts,
            confidence: signalResult.confidence,
            signals: (signalResult.signals || []).slice(0, 5).map(function (s) { return s.name || s; }),
            features: signalResult.features || [],
            autoEntry: true,
            signalVersion: version,
            session: 'AUTO',
            horizon: 'day_trade'
        });

        if (trade) {
            console.log('📋 Auto futures paper [' + version + ']: ' + strategy.toUpperCase() + ' ' + futuresTicker + ' x' + contracts + ' @ ' + trade.entryPoints + ' pts (conf: ' + signalResult.confidence + '%)');
        }
        return trade;
    }
}

module.exports = FuturesPaperTrading;
