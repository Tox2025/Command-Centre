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
        this.engines = {}; // { 'v1.0': SignalEngine, ... }
        this.lastResults = {}; // latest scores per ticker per version
        this._loadVersions();
    }

    _loadVersions() {
        var keys = SignalEngine.getVersionKeys();
        var loaded = 0;
        for (var i = 0; i < keys.length; i++) {
            var engine = SignalEngine.loadVersion(keys[i]);
            if (engine) {
                this.engines[keys[i]] = engine;
                loaded++;
            }
        }
        var versionCount = Object.keys(this.engines).length;
        console.log('🔬 A/B Tester: Loaded ' + loaded + ' signal versions — ' + Object.keys(this.engines).join(', '));
        // Calculate per-version budget
        this.perVersionBudget = versionCount > 0 ? Math.floor(100000 / versionCount) : 100000;
        console.log('💰 A/B Tester: $' + this.perVersionBudget + ' budget per version (' + versionCount + ' versions)');
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
                    var ensemble = this.mlCalibrator.ensemble(result.confidence, result.features, mlTimeframe);
                    result.technicalConfidence = result.confidence;
                    result.mlConfidence = ensemble.mlConfidence || null;
                    result.blendedConfidence = ensemble.confidence;
                    result.ensemble = ensemble;
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
            if (!result || !result.direction) continue;

            // Skip low confidence
            var conf = result.blendedConfidence || result.confidence || 0;
            if (conf < 50) continue;

            // Build version-specific setup
            var vSetup = Object.assign({}, setup, {
                ticker: ticker,
                direction: result.direction,
                confidence: conf,
                signals: result.signals || [],
                session: setup.session || 'UNKNOWN',
                horizon: setup.horizon || 'Swing',
                kellySizing: setup.kellySizing || null
            });

            // Consecutive loss guard (per version)
            var maxConsecLosses = 3;
            var consecLosses = this.tradeJournal.getConsecutiveLosses(ticker, result.direction);
            if (consecLosses >= maxConsecLosses) continue;

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
    getComparison() {
        return this.tradeJournal.getStatsByVersion();
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
