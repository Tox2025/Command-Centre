// A/B Tester — Parallel multi-version signal scoring and tagged paper trading
// Scores every ticker with ALL signal versions simultaneously
// Creates separate version-tagged paper trades for each version
const path = require('path');
const fs = require('fs');
const { SignalEngine } = require('./signal-engine');

const VERSIONS_PATH = path.join(__dirname, '..', 'data', 'signal-versions.json');

class ABTester {
    constructor(tradeJournal, mlCalibrator, scheduler) {
        this.tradeJournal = tradeJournal;
        this.mlCalibrator = mlCalibrator;
        this.scheduler = scheduler;
        this.optionsPaper = null; // Injected later
        this.engines = {}; // { 'v1.0': SignalEngine, ... }
        this.lastResults = {}; // latest scores per ticker per version
        this._loadVersions();
    }

    _loadVersions() {
        var keys = SignalEngine.getVersionKeys();
        var loaded = 0;
        var newEngines = {};
        for (var i = 0; i < keys.length; i++) {
            var engine = SignalEngine.loadVersion(keys[i]);
            if (engine) {
                newEngines[keys[i]] = engine;
                loaded++;
            }
        }
        this.engines = newEngines;
        var versionCount = Object.keys(this.engines).length;
        console.log('🔬 A/B Tester: Loaded ' + loaded + ' signal versions — ' + Object.keys(this.engines).join(', '));
        // Calculate per-version budget
        this.perVersionBudget = versionCount > 0 ? Math.floor(100000 / versionCount) : 100000;
        console.log('💰 A/B Tester: $' + this.perVersionBudget + ' budget per version (' + versionCount + ' versions)');
    }

    // Get all active version keys for cross-model learning
    getVersionKeys() {
        return Object.keys(this.engines);
    }

    refreshVersions() {
        console.log('🔬 A/B Tester: Refreshing signal versions...');
        this._loadVersions();
    }

    // Score a ticker with ALL versions simultaneously
    // Returns { 'v1.0': signalResult, 'v1.1': signalResult, ... }
    scoreAll(ticker, data, session) {
        var results = {};
        var engines = this.engines;
        var versionKeys = Object.keys(engines);
        for (var i = 0; i < versionKeys.length; i++) {
            var version = versionKeys[i];
            try {
                var result = engines[version].score(ticker, data, session);
                result.signalVersion = version;
                // ML ensemble
                var isSwingSession = session === 'OVERNIGHT' || session === 'AFTER_HOURS';
                var mlTimeframe = isSwingSession ? 'swing' : 'dayTrade';
                if (this.mlCalibrator) {
                    var ensemble = this.mlCalibrator.ensemble(result.confidence, result.features, mlTimeframe, version);
                    result.technicalConfidence = result.confidence;
                    result.mlConfidence = ensemble.mlConfidence || null;
                    result.blendedConfidence = ensemble.confidence;
                    result.ensemble = ensemble;
                    console.log('?? ABTester [' + version + '] ' + ticker + ': Tech=' + result.confidence + '% ML=' + (result.mlConfidence || 0) + '% Blend=' + result.blendedConfidence + '% (' + result.direction + ')');
                }
                results[version] = result;
            } catch (e) {
                console.error('A/B score error for ' + version + '/' + ticker + ':', e.message);
            }
        }
        // Store latest results for this ticker
        this.lastResults[ticker] = results;
        return results;
    }

    // Create paper trades for all versions that pass gating
    // Returns array of trades created
    createTrades(ticker, results, currentPrice, setup) {
        var trades = [];
        var self = this;
        var versionKeys = Object.keys(results);

        for (var i = 0; i < versionKeys.length; i++) {
            var version = versionKeys[i];
            var result = results[version];
            if (!result) continue;

            // For paper trading, accept any non-NEUTRAL direction
            // We need data from ALL conditions to train ML properly
            if (!result.direction || result.direction === 'NEUTRAL') continue;

            // Use the HIGHER of blended or technical confidence as the gate
            // This prevents a near-chance ML model from blocking good technical signals
            var conf = Math.max(
                result.blendedConfidence || 0,
                result.technicalConfidence || result.confidence || 0
            );
            if (conf < 40) continue;

            // ── Build version-specific stop/target based on THIS version's direction ──
            // Never inherit direction from v2.1 setup — each version decides independently
            var vDir = result.direction; // BULLISH or BEARISH from this version's signal engine
            var tradeDir = vDir === 'BULLISH' ? 'LONG' : 'SHORT';
            var baseEntry = currentPrice;
            var baseATR = (setup && setup.stop && setup.entry)
                ? Math.abs(setup.entry - setup.stop) // derive ATR proxy from v2.1 setup if available
                : 1;
            // If v2.1 setup exists and same direction, use its stop/targets (already ATR-sized)
            var useV21Setup = setup && setup.direction === tradeDir;

            var vSetup = Object.assign({}, setup, {
                ticker: ticker,
                direction: tradeDir,
                confidence: conf,
                signals: result.signals || [],
                features: result.features || [],
                bullScore: result.bull || 0,
                bearScore: result.bear || 0,
                session: (setup && setup.session) || 'UNKNOWN',
                horizon: (setup && setup.horizon) || 'Swing',
                kellySizing: (setup && setup.kellySizing) || null,
                // Correct stops/targets for this version's direction
                entry: baseEntry,
                target1: useV21Setup ? setup.target1 : +(tradeDir === 'LONG' ? baseEntry + baseATR : baseEntry - baseATR).toFixed(2),
                target2: useV21Setup ? setup.target2 : +(tradeDir === 'LONG' ? baseEntry + baseATR * 2 : baseEntry - baseATR * 2).toFixed(2),
                stop: useV21Setup ? setup.stop : +(tradeDir === 'LONG' ? baseEntry - baseATR * 0.75 : baseEntry + baseATR * 0.75).toFixed(2),
                riskReward: 1.33
            });

            // Paper trading: NO consecutive loss guard
            // We need data from ALL conditions to train ML properly
            // Consecutive loss guard is for real money only

            // Create paper trade with version tag + 30 min cooldown
            var cooldownMs = 30 * 60 * 1000;
            var trade = this.tradeJournal.paperTrade(
                vSetup, currentPrice, cooldownMs, this.scheduler, version
            );
            if (trade) {
                trades.push(trade);
            }
        }
        return trades;
    }

    // Get comparison summary: per-version stats
    getComparison(days) {
        var eqStats = this.tradeJournal.getStatsByVersion(days);
        var optStats = this.optionsPaper ? this.optionsPaper.getStatsByVersion(days) : {};

        var combined = {};
        var versions = new Set([...Object.keys(eqStats), ...Object.keys(optStats)]);

        versions.forEach(function (v) {
            var eq = eqStats[v] || { trades: 0, wins: 0, losses: 0, expired: 0, pending: 0, pnlSum: 0, pnlTotal: 0 };
            var opt = optStats[v] || { trades: 0, wins: 0, losses: 0, expired: 0, pending: 0, pnlSum: 0, pnlTotal: 0 };
            
            var cDecided = (eq.wins + eq.losses) + (opt.wins + opt.losses);
            var cExpired = eq.expired + opt.expired;
            var cWinRate = cDecided > 0 ? +((eq.wins + opt.wins) / cDecided * 100).toFixed(1) : 0;
            var cAvgPnlPct = (cDecided + cExpired) > 0 ? +((eq.pnlSum + opt.pnlSum) / (cDecided + cExpired)).toFixed(2) : 0;

            combined[v] = {
                version: v,
                trades: eq.trades + opt.trades,
                wins: eq.wins + opt.wins,
                losses: eq.losses + opt.losses,
                pending: eq.pending + opt.pending,
                winRate: cWinRate,
                avgPnlPct: cAvgPnlPct,
                pnlTotal: +(eq.pnlTotal + opt.pnlTotal).toFixed(2)
            };
        });

        return {
            equities: eqStats,
            options: optStats,
            combined: combined
        };
    }

    // Get latest scoring results for all tickers
    getLatestResults() {
        return this.lastResults;
    }

    // Log a comparison line showing how all versions scored a ticker
    logComparison(ticker, results) {
        var parts = [];
        var versionKeys = Object.keys(results);
        for (var i = 0; i < versionKeys.length; i++) {
            var v = versionKeys[i];
            var r = results[v];
            if (r) {
                parts.push(v + ':' + (r.direction || '?') + ' ' + (r.blendedConfidence || r.confidence || 0) + '%');
            }
        }
        if (parts.length > 0) {
            console.log('🔬 A/B ' + ticker + ' → ' + parts.join(' | '));
        }
    }

    // Get version count
    getVersionCount() {
        return Object.keys(this.engines).length;
    }

    // Get version names
    getVersionNames() {
        return Object.keys(this.engines);
    }
}

module.exports = ABTester;
