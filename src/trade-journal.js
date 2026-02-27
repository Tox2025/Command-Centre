// Trade Journal - Logs setups, tracks outcomes, computes stats
const fs = require('fs');
const path = require('path');

const JOURNAL_PATH = path.join(__dirname, '..', 'data', 'trade-journal.json');
const VERSIONS_PATH = path.join(__dirname, '..', 'data', 'signal-versions.json');
const EXPIRY_DAYS = 5; // Max days to track a trade before marking expired
const ACCOUNT_BALANCE = 100000; // Paper trading account size
const VERSION_BUDGET = 25000;   // Per-version budget ($100K / 4 versions)
const MAX_PER_TICKER = 3; // Max concurrent open trades per ticker

class TradeJournal {
    constructor() {
        this.trades = [];
        this.stats = { totalTrades: 0, wins: 0, losses: 0, expired: 0, pending: 0 };
        this._load();
        this._migrateUnknownToV1();
    }

    // One-time migration: tag old 'unknown' trades as v1.0 (same baseline weights)
    _migrateUnknownToV1() {
        var migrated = 0;
        this.trades.forEach(function (t) {
            if (t.signalVersion === 'unknown' || !t.signalVersion) {
                t.signalVersion = 'v1.0';
                migrated++;
            }
        });
        if (migrated > 0) {
            console.log('📦 Migrated ' + migrated + ' unknown trades → v1.0');
            this._save();
        }
    }

    _load() {
        try {
            const dir = path.dirname(JOURNAL_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(JOURNAL_PATH)) {
                const raw = fs.readFileSync(JOURNAL_PATH, 'utf8');
                const data = JSON.parse(raw);
                this.trades = data.trades || [];
                this.stats = data.stats || this.stats;
            }
        } catch (e) {
            console.error('TradeJournal load error:', e.message);
        }
    }

    _save() {
        try {
            const dir = path.dirname(JOURNAL_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(JOURNAL_PATH, JSON.stringify({ trades: this.trades, stats: this.stats }, null, 2));
        } catch (e) {
            console.error('TradeJournal save error:', e.message);
        }
    }

    // Get active signal version from signal-versions.json
    _getSignalVersion() {
        try {
            if (fs.existsSync(VERSIONS_PATH)) {
                var data = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
                return data.activeVersion || 'unknown';
            }
        } catch (e) { /* ignore */ }
        return 'unknown';
    }

    // Get total open position notional exposure (per-version aware)
    _getOpenExposure(version) {
        var total = 0;
        var versionTotal = 0;
        var byTicker = {};
        this.trades.forEach(function (t) {
            if (t.status !== 'PENDING' || !t.paper) return;
            var price = t.paperEntry || t.entry || 0;
            var shares = t.shares || 1;
            var notional = price * shares;
            total += notional;
            if (version && t.signalVersion === version) versionTotal += notional;
            byTicker[t.ticker] = (byTicker[t.ticker] || 0) + 1;
        });
        return { total: total, versionTotal: versionTotal, byTicker: byTicker };
    }

    // Log a new trade setup
    logSetup(setup, signalResult, scheduler) {
        if (!setup || !setup.ticker) return;

        // ── Market hours gate ──
        if (scheduler && typeof scheduler.isTradingSession === 'function') {
            if (!scheduler.isTradingSession()) {
                return; // Don't log setups outside market hours
            }
        }

        // Check for duplicate (same ticker + direction within last 30 min, ANY status)
        const now = Date.now();
        const cooldownMs = 30 * 60 * 1000;
        const dup = this.trades.find(t =>
            t.ticker === setup.ticker &&
            t.direction === setup.direction &&
            !t.paper &&
            (now - new Date(t.openTime).getTime()) < cooldownMs
        );
        if (dup) return; // Skip duplicate — any recent trade blocks

        const trade = {
            id: 'T-' + now + '-' + Math.random().toString(36).substr(2, 5),
            ticker: setup.ticker,
            direction: setup.direction,
            entry: setup.entry,
            target1: setup.target1,
            target2: setup.target2,
            stop: setup.stop,
            riskReward: setup.riskReward,
            confidence: setup.confidence,
            signals: signalResult ? signalResult.signals : [],
            features: signalResult ? signalResult.features : [],
            bullScore: signalResult ? signalResult.bull : 0,
            bearScore: signalResult ? signalResult.bear : 0,
            openTime: new Date().toISOString(),
            closeTime: null,
            status: 'PENDING', // PENDING, WIN_T1, WIN_T2, LOSS_STOP, EXPIRED
            outcome: null, // actual exit price
            pnlPct: null,
            session: setup.session || 'UNKNOWN',
            signalVersion: this._getSignalVersion()
        };
        this.trades.push(trade);
        this.stats.totalTrades++;
        this.stats.pending++;
        this._save();
        return trade;
    }

    // Check all pending trades against current prices
    checkOutcomes(quotes) {
        let updated = 0;
        const now = Date.now();
        const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes — don't check brand-new trades

        this.trades.forEach(trade => {
            if (trade.status !== 'PENDING') return;

            // Grace period: don't check trades until they're at least 5 min old
            // Prevents instant-close bug where stale session low/high triggers false outcomes
            const tradeAge = now - new Date(trade.openTime).getTime();
            if (tradeAge < GRACE_PERIOD_MS) return;

            const q = quotes[trade.ticker];
            if (!q) return;

            // Use CURRENT price only — not session high/low which include prices from before trade opened
            const current = parseFloat(q.last || q.price || q.close || 0);
            if (current === 0) return;

            const ageDays = tradeAge / (1000 * 60 * 60 * 24);

            if (trade.direction === 'LONG') {
                if (current <= trade.stop) {
                    this._closeTrade(trade, 'LOSS_STOP', current);
                    updated++;
                } else if (current >= trade.target2) {
                    this._closeTrade(trade, 'WIN_T2', current);
                    updated++;
                } else if (current >= trade.target1) {
                    this._closeTrade(trade, 'WIN_T1', current);
                    updated++;
                } else if (ageDays > EXPIRY_DAYS) {
                    this._closeTrade(trade, 'EXPIRED', current);
                    updated++;
                }
            } else { // SHORT
                if (current >= trade.stop) {
                    this._closeTrade(trade, 'LOSS_STOP', current);
                    updated++;
                } else if (current <= trade.target2) {
                    this._closeTrade(trade, 'WIN_T2', current);
                    updated++;
                } else if (current <= trade.target1) {
                    this._closeTrade(trade, 'WIN_T1', current);
                    updated++;
                } else if (ageDays > EXPIRY_DAYS) {
                    this._closeTrade(trade, 'EXPIRED', current);
                    updated++;
                }
            }
        });

        if (updated > 0) {
            this._recalcStats();
            this._save();
        }
        return updated;
    }

    _closeTrade(trade, status, exitPrice) {
        trade.status = status;
        trade.closeTime = new Date().toISOString();
        trade.closedAt = trade.closeTime; // Client-side checks closedAt
        trade.outcome = exitPrice;
        trade.exitPrice = exitPrice;
        // Use paperEntry if available (paper trades), otherwise use entry
        var entryPrice = trade.paperEntry || trade.entry;
        if (trade.direction === 'LONG') {
            trade.pnlPct = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
        } else {
            trade.pnlPct = +((entryPrice - exitPrice) / entryPrice * 100).toFixed(2);
        }
        trade.pnl = trade.pnlPct; // Stats use pnl field
        // Dollar P&L per share (points)
        trade.pnlPoints = +(exitPrice - entryPrice).toFixed(2);
        if (trade.direction === 'SHORT') trade.pnlPoints = +(entryPrice - exitPrice).toFixed(2);

        // Total P&L ($)
        if (trade.shares) {
            trade.pnlTotal = +(trade.pnlPoints * trade.shares).toFixed(2);
        } else {
            // Fallback for old trades: estimate shares based on $2000 risk
            const riskPerShare = Math.abs(trade.entry - trade.stop);
            const estShares = riskPerShare > 0 ? Math.floor(2000 / riskPerShare) : 1;
            trade.pnlTotal = +(trade.pnlPoints * estShares).toFixed(2);
        }
    }

    _recalcStats() {
        const s = { totalTrades: this.trades.length, wins: 0, losses: 0, expired: 0, pending: 0 };
        this.trades.forEach(t => {
            if (t.status === 'PENDING') s.pending++;
            else if (t.status === 'WIN_T1' || t.status === 'WIN_T2') s.wins++;
            else if (t.status === 'LOSS_STOP') s.losses++;
            else if (t.status === 'EXPIRED') s.expired++;
        });
        s.winRate = (s.wins + s.losses) > 0 ? +(s.wins / (s.wins + s.losses) * 100).toFixed(1) : 0;
        s.avgPnl = this._avgPnl();
        s.byConfidence = this._statsByConfidence();
        this.stats = s;
    }

    _avgPnl() {
        const closed = this.trades.filter(t => t.pnlPct !== null);
        if (closed.length === 0) return 0;
        return +(closed.reduce((a, t) => a + t.pnlPct, 0) / closed.length).toFixed(2);
    }

    _statsByConfidence() {
        const buckets = { '50-60': { w: 0, l: 0 }, '60-70': { w: 0, l: 0 }, '70-80': { w: 0, l: 0 }, '80+': { w: 0, l: 0 } };
        this.trades.forEach(t => {
            if (t.status === 'PENDING' || t.status === 'EXPIRED') return;
            const c = t.confidence;
            const bucket = c >= 80 ? '80+' : c >= 70 ? '70-80' : c >= 60 ? '60-70' : '50-60';
            if (t.status.startsWith('WIN')) buckets[bucket].w++;
            else buckets[bucket].l++;
        });
        const result = {};
        Object.keys(buckets).forEach(k => {
            const b = buckets[k];
            const tot = b.w + b.l;
            result[k] = { wins: b.w, losses: b.l, total: tot, winRate: tot > 0 ? +(b.w / tot * 100).toFixed(1) : 0 };
        });
        return result;
    }

    // Get graded trades for ML training
    getTrainingData() {
        return this.trades.filter(t => t.status !== 'PENDING' && t.status !== 'EXPIRED' && t.features && t.features.length > 0)
            .map(t => ({
                features: t.features,
                label: t.status.startsWith('WIN') ? 1 : 0,
                confidence: t.confidence,
                pnlPct: t.pnlPct
            }));
    }

    getStats() { return this.stats; }

    getRecentTrades(limit = 20) {
        return this.trades.slice(-limit).reverse();
    }

    // Backtest: simulate trades from historical candle data
    backtest(ticker, candles, signalEngine, dataGetter) {
        if (!candles || candles.length < 50) return [];
        const results = [];

        // Slide a window through history
        for (let i = 40; i < candles.length - 5; i++) {
            const window = candles.slice(Math.max(0, i - 60), i + 1);
            const TechnicalAnalysis = require('./technical');
            const analysis = TechnicalAnalysis.analyze(window);
            if (!analysis || analysis.error || analysis.bias === 'NEUTRAL') continue;

            const currentPrice = window[window.length - 1].close;
            const atr = analysis.atr || Math.abs(analysis.pivots.r1 - analysis.pivots.s1) / 2;
            if (atr <= 0) continue;

            const direction = analysis.bias === 'BULLISH' ? 'LONG' : 'SHORT';
            const entry = currentPrice;
            const t1 = direction === 'LONG' ? entry + atr : entry - atr;
            const t2 = direction === 'LONG' ? entry + atr * 2 : entry - atr * 2;
            const stop = direction === 'LONG' ? entry - atr * 0.75 : entry + atr * 0.75;

            // Build mock data for signal engine
            const mockData = {
                technicals: analysis,
                flow: [], darkPool: [], gex: [],
                ivRank: null, shortInterest: null,
                insider: [], congress: [],
                quote: { last: currentPrice }
            };
            if (dataGetter) Object.assign(mockData, dataGetter(ticker));

            const signalResult = signalEngine.score(ticker, mockData);

            // Check future candles for outcome
            let outcome = 'EXPIRED';
            let exitPrice = candles[Math.min(i + 5, candles.length - 1)].close;

            for (let j = i + 1; j <= Math.min(i + 5, candles.length - 1); j++) {
                const c = candles[j];
                if (direction === 'LONG') {
                    if (c.low <= stop) { outcome = 'LOSS_STOP'; exitPrice = stop; break; }
                    if (c.high >= t2) { outcome = 'WIN_T2'; exitPrice = t2; break; }
                    if (c.high >= t1) { outcome = 'WIN_T1'; exitPrice = t1; break; }
                } else {
                    if (c.high >= stop) { outcome = 'LOSS_STOP'; exitPrice = stop; break; }
                    if (c.low <= t2) { outcome = 'WIN_T2'; exitPrice = t2; break; }
                    if (c.low <= t1) { outcome = 'WIN_T1'; exitPrice = t1; break; }
                }
            }

            const pnlPct = direction === 'LONG'
                ? +((exitPrice - entry) / entry * 100).toFixed(2)
                : +((entry - exitPrice) / entry * 100).toFixed(2);

            results.push({
                ticker, direction, entry, t1, t2, stop,
                confidence: signalResult.confidence,
                features: signalResult.features,
                outcome, exitPrice, pnlPct,
                label: outcome.startsWith('WIN') ? 1 : 0,
                date: candles[i].date || candles[i].timestamp
            });
        }
        return results;
    }
    // Kelly Criterion Position Sizing — per-version budget
    // 4 versions × $25,000 = $100K total paper account
    calculateKellySize(confidence, accountSize) {
        accountSize = accountSize || VERSION_BUDGET; // $25K per version
        var closed = this.trades.filter(function (t) { return t.status !== 'PENDING' && t.status !== 'EXPIRED'; });
        if (closed.length < 10) {
            // Not enough data — scale by confidence: 10-40% of budget
            var pct = Math.max(10, Math.min(40, (confidence || 60) / 100 * 30));
            return { size: Math.round(accountSize * pct / 100), pct: pct, method: 'fixed-aggressive', reason: 'Not enough trades for Kelly — confidence-scaled' };
        }

        var wins = closed.filter(function (t) { return t.status.startsWith('WIN'); });
        var losses = closed.filter(function (t) { return t.status === 'LOSS_STOP'; });
        var winRate = wins.length / closed.length;
        var avgWin = wins.length > 0 ? wins.reduce(function (a, t) { return a + Math.abs(t.pnlPct); }, 0) / wins.length : 1;
        var avgLoss = losses.length > 0 ? losses.reduce(function (a, t) { return a + Math.abs(t.pnlPct); }, 0) / losses.length : 1;

        // Kelly = W - (1-W)/R where W=win rate, R=win/loss ratio
        var R = avgLoss > 0 ? avgWin / avgLoss : 1;
        var kelly = winRate - (1 - winRate) / R;

        // Scale for paper trading: 10-50% of per-version budget
        var kellyPct = Math.max(10, Math.min(50, kelly * 100));

        // Confidence adjustment
        var confAdj = (confidence || 60) / 100;
        var finalPct = +(kellyPct * confAdj).toFixed(1);
        finalPct = Math.max(10, Math.min(50, finalPct));

        return {
            size: Math.round(accountSize * finalPct / 100),
            pct: finalPct,
            method: 'kelly-paper',
            winRate: +(winRate * 100).toFixed(1),
            avgWinPct: +avgWin.toFixed(2),
            avgLossPct: +avgLoss.toFixed(2),
            fullKelly: +(kelly * 100).toFixed(1),
            reason: 'Kelly × confidence — $25K version budget'
        };
    }

    // Paper Trading - simulate entries at current price
    paperTrade(setup, currentPrice, cooldownMs, scheduler, explicitVersion) {
        if (!setup || !setup.ticker) return null;

        // ── Market hours gate — no trading on weekends or outside session ──
        if (scheduler && typeof scheduler.isTradingSession === 'function') {
            if (!scheduler.isTradingSession()) {
                return null; // Market is closed
            }
        }

        cooldownMs = cooldownMs || 2 * 60 * 60 * 1000; // default 2 hours
        var nowMs = Date.now();

        // ── Duplicate check: same ticker+direction+version within cooldown ──
        var checkVersion = explicitVersion || null;
        var dup = this.trades.find(function (t) {
            if (t.paper !== true || t.ticker !== setup.ticker || t.direction !== setup.direction) return false;
            // In A/B testing, only check duplicates within same version
            if (checkVersion && t.signalVersion !== checkVersion) return false;
            var tradeTime = new Date(t.openTime || t.entryTime).getTime();
            return (nowMs - tradeTime) < cooldownMs;
        });
        if (dup) return null; // Cooldown period hasn't expired

        // ── Per-ticker limit — max concurrent positions per ticker ──
        var tradeVersion = explicitVersion || this._getSignalVersion();
        var exposure = this._getOpenExposure(tradeVersion);
        var tickerOpenCount = exposure.byTicker[setup.ticker] || 0;
        if (tickerOpenCount >= MAX_PER_TICKER) {
            return null; // Too many open positions for this ticker
        }

        var entryPrice = currentPrice || setup.entry;

        // Tentatively calculate shares — use Kelly sizing or default to meaningful position
        var tentativeShares = 0;
        if (setup.kellySizing && setup.kellySizing.size > 0) {
            tentativeShares = Math.floor(setup.kellySizing.size / entryPrice);
        } else {
            // Default: allocate $5000 per trade (20% of $25K version budget)
            tentativeShares = Math.max(1, Math.floor(5000 / entryPrice));
        }
        // Minimum shares — paper trades should be realistic size
        var minShares = entryPrice < 100 ? 10 : entryPrice < 500 ? 5 : 2;
        if (tentativeShares < minShares) tentativeShares = minShares;

        // ── Per-version exposure cap — ≤ $25K per version, ≤ $100K total ──
        var newNotional = entryPrice * tentativeShares;
        var versionCap = VERSION_BUDGET;
        if (exposure.versionTotal + newNotional > versionCap) {
            var remaining = versionCap - exposure.versionTotal;
            if (remaining < entryPrice) return null;
            tentativeShares = Math.floor(remaining / entryPrice);
            if (tentativeShares < 1) return null;
        }
        // Also cap at total account level
        newNotional = entryPrice * tentativeShares;
        if (exposure.total + newNotional > ACCOUNT_BALANCE) {
            var totalRemaining = ACCOUNT_BALANCE - exposure.total;
            if (totalRemaining < entryPrice) return null;
            tentativeShares = Math.floor(totalRemaining / entryPrice);
            if (tentativeShares < 1) return null;
        }

        // ── Recalculate stop/target from ACTUAL fill price (not setup entry) ──
        // Setup entry and paper fill may differ; stops/targets must be relative to actual entry
        var setupEntry = parseFloat(setup.entry) || entryPrice;
        var adjustedStop = setup.stop;
        var adjustedT1 = setup.target1;
        var adjustedT2 = setup.target2;
        if (setupEntry > 0 && Math.abs(setupEntry - entryPrice) / setupEntry > 0.001) {
            // Proportional adjustment: maintain same % distances from actual fill
            var stopPct = (setup.stop - setupEntry) / setupEntry;
            var t1Pct = (setup.target1 - setupEntry) / setupEntry;
            var t2Pct = (setup.target2 - setupEntry) / setupEntry;
            adjustedStop = +(entryPrice * (1 + stopPct)).toFixed(2);
            adjustedT1 = +(entryPrice * (1 + t1Pct)).toFixed(2);
            adjustedT2 = +(entryPrice * (1 + t2Pct)).toFixed(2);
        }

        var trade = {
            id: 'PT-' + nowMs + '-' + Math.random().toString(36).substr(2, 5),
            ticker: setup.ticker,
            direction: setup.direction,
            entry: entryPrice,
            target1: adjustedT1,
            target2: adjustedT2,
            stop: adjustedStop,
            riskReward: setup.riskReward,
            confidence: setup.confidence,
            signals: setup.signals || [],
            features: setup.features || [],
            bullScore: setup.bullScore || 0,
            bearScore: setup.bearScore || 0,
            openTime: new Date().toISOString(),
            entryTime: new Date().toISOString(),
            closeTime: null,
            status: 'PENDING',
            outcome: null,
            pnlPct: null,
            pnl: 0,
            unrealizedPnl: 0,
            session: setup.session || 'UNKNOWN',
            horizon: setup.horizon || 'Swing',
            paper: true,
            paperEntry: entryPrice,
            shares: tentativeShares,
            signalVersion: explicitVersion || this._getSignalVersion()
        };

        this.trades.push(trade);
        this._save();
        return trade;
    }

    // Get performance stats grouped by signal version
    getStatsByVersion() {
        var byVersion = {};
        this.trades.forEach(function (t) {
            if (t.paper !== true) return;
            var v = t.signalVersion || 'unknown';
            if (byVersion[v] === undefined) {
                byVersion[v] = { version: v, trades: 0, wins: 0, losses: 0, expired: 0, pending: 0, pnlSum: 0, pnlTotal: 0 };
            }
            byVersion[v].trades++;
            if (t.status === 'PENDING') byVersion[v].pending++;
            else if (t.status && t.status.indexOf('WIN') >= 0) { byVersion[v].wins++; byVersion[v].pnlSum += (t.pnlPct || 0); byVersion[v].pnlTotal += (t.pnlTotal || 0); }
            else if (t.status === 'LOSS_STOP' || t.status === 'LOSS_EOD') { byVersion[v].losses++; byVersion[v].pnlSum += (t.pnlPct || 0); byVersion[v].pnlTotal += (t.pnlTotal || 0); }
            else if (t.status === 'EXPIRED') { byVersion[v].expired++; byVersion[v].pnlSum += (t.pnlPct || 0); byVersion[v].pnlTotal += (t.pnlTotal || 0); }
        });
        // Compute derived stats
        Object.keys(byVersion).forEach(function (v) {
            var s = byVersion[v];
            var decided = s.wins + s.losses;
            s.winRate = decided > 0 ? +(s.wins / decided * 100).toFixed(1) : 0;
            s.avgPnlPct = (decided + s.expired) > 0 ? +(s.pnlSum / (decided + s.expired)).toFixed(2) : 0;
            s.pnlTotal = +s.pnlTotal.toFixed(2);
        });
        return byVersion;
    }

    // Count consecutive losses for a ticker+direction (most recent trades first)
    getConsecutiveLosses(ticker, direction) {
        var matching = this.trades.filter(function (t) {
            return t.paper && t.ticker === ticker && t.direction === direction && t.status !== 'PENDING';
        });
        // Sort by closeTime descending (most recent first)
        matching.sort(function (a, b) {
            return new Date(b.closeTime || b.openTime).getTime() - new Date(a.closeTime || a.openTime).getTime();
        });
        var count = 0;
        for (var i = 0; i < matching.length; i++) {
            if (matching[i].status === 'LOSS_STOP') {
                count++;
            } else {
                break; // Stop at first non-loss
            }
        }
        return count;
    }

    // Get paper trade P&L
    getPaperTrades() {
        return this.trades.filter(function (t) { return t.paper === true; });
    }

    // Update paper trade with current prices
    updatePaperPnL(quotes) {
        var updated = 0;
        var now = new Date().toISOString();
        this.trades.forEach(function (trade) {
            if (!trade.paper || trade.status !== 'PENDING') return;
            var q = quotes[trade.ticker];
            if (!q) return;
            var current = parseFloat(q.last || q.price || q.close || 0);
            if (current === 0) return;

            trade.currentPrice = current;
            trade.lastPriceUpdate = now;

            if (trade.direction === 'LONG') {
                trade.unrealizedPnl = +((current - trade.paperEntry) / trade.paperEntry * 100).toFixed(2);
            } else {
                trade.unrealizedPnl = +((trade.paperEntry - current) / trade.paperEntry * 100).toFixed(2);
            }
            trade.unrealizedPnlPct = trade.unrealizedPnl; // alias for frontend
            // Dollar P&L — direction-aware
            if (trade.direction === 'LONG') {
                trade.unrealizedPnlDollar = +(current - trade.paperEntry).toFixed(2);
            } else {
                trade.unrealizedPnlDollar = +(trade.paperEntry - current).toFixed(2);
            }

            // Total Unrealized P&L ($)
            if (trade.shares) {
                trade.unrealizedPnlTotal = +(trade.unrealizedPnlDollar * trade.shares).toFixed(2);
            } else {
                const riskPerShare = Math.abs(trade.paperEntry - trade.stop);
                const estShares = riskPerShare > 0 ? Math.floor(2000 / riskPerShare) : 1;
                trade.unrealizedPnlTotal = +(trade.unrealizedPnlDollar * estShares).toFixed(2);
            }

            updated++;
        });
        if (updated > 0) this._save();
        return updated;
    }

    // Force-close all intraday paper trades at EOD (4:00 PM ET)
    closeIntradayTrades(quotes) {
        var closed = 0;
        var self = this;
        var intradayHorizons = ['Scalp / Day Trade', 'Day Trade', 'Day Trade (volatile)', 'Intraday', 'Extended Hours'];
        this.trades.forEach(function (trade) {
            if (!trade.paper || trade.status !== 'PENDING') return;
            var horizon = (trade.horizon || '').toLowerCase();
            var isIntraday = intradayHorizons.some(function (h) { return horizon === h.toLowerCase(); });
            if (!isIntraday) return;

            var q = quotes[trade.ticker];
            var current = q ? parseFloat(q.last || q.price || q.close || 0) : 0;
            if (current === 0) current = trade.currentPrice || trade.paperEntry || trade.entry;

            self._closeTrade(trade, current >= (trade.paperEntry || trade.entry) ? (trade.direction === 'LONG' ? 'WIN_EOD' : 'LOSS_EOD') : (trade.direction === 'LONG' ? 'LOSS_EOD' : 'WIN_EOD'), current);
            closed++;
        });
        if (closed > 0) {
            this._recalcStats();
            this._save();
            console.log('📊 EOD: Force-closed ' + closed + ' intraday paper trades');
        }
        return closed;
    }
}

module.exports = TradeJournal;
