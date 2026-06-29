// MLMetaLearner — Cross-version learning for vML
// Analyzes all versions' trade outcomes to optimize vML signal weights
var fs = require('fs');
var path = require('path');

var VERSIONS_PATH = path.join(__dirname, '..', 'data', 'signal-versions.json');
var JOURNAL_PATH = path.join(__dirname, '..', 'data', 'trade-journal.json');
var OPTIONS_PATH = path.join(__dirname, '..', 'data', 'options-paper-trades.json');
var JOURNAL_ARCHIVE = path.join(__dirname, '..', 'data', 'trade-journal-archive-20260626.json');
var OPTIONS_ARCHIVE = path.join(__dirname, '..', 'data', 'options-paper-trades-archive-20260626.json');

var MIN_TRADES_TO_UPDATE = 50;
var MAX_WEIGHT_CHANGE_PCT = 0.5; // ±50% per cycle
var MIN_SIGNAL_OCCURRENCES = 10;
var MAX_WEIGHT = 10;

function MLMetaLearner(tradeJournal, optionsPaper) {
    this.tradeJournal = tradeJournal;
    this.optionsPaper = optionsPaper;
    this.allTrades = [];
    this.signalStats = {};
    this.loadArchives();
}

MLMetaLearner.prototype.loadArchives = function() {
    var self = this;
    var trades = [];

    // Load archived equities
    try {
        var archive = JSON.parse(fs.readFileSync(JOURNAL_ARCHIVE, 'utf8'));
        var at = archive.trades || [];
        at.forEach(function(t) {
            if (t.status === 'WIN' || t.status === 'LOSS' || t.status === 'STOPPED') {
                trades.push(self._normalizeTrade(t, 'equity'));
            }
        });
        console.log('[MetaLearner] Loaded ' + at.length + ' archived equity trades');
    } catch(e) { console.log('[MetaLearner] No equity archive: ' + e.message); }

    // Load archived options
    try {
        var optArchive = JSON.parse(fs.readFileSync(OPTIONS_ARCHIVE, 'utf8'));
        var ot = optArchive.trades || [];
        ot.forEach(function(t) {
            if (t.status === 'WIN' || t.status === 'LOSS') {
                trades.push(self._normalizeTrade(t, 'option'));
            }
        });
        console.log('[MetaLearner] Loaded ' + ot.length + ' archived option trades');
    } catch(e) { console.log('[MetaLearner] No options archive: ' + e.message); }

    // Load current trades
    try {
        var current = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
        (current.trades || []).forEach(function(t) {
            if (t.status === 'WIN' || t.status === 'LOSS' || t.status === 'STOPPED') {
                trades.push(self._normalizeTrade(t, 'equity'));
            }
        });
    } catch(e) { /* no current equity trades */ }

    try {
        var currentOpt = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
        (currentOpt.trades || []).forEach(function(t) {
            if (t.status === 'WIN' || t.status === 'LOSS') {
                trades.push(self._normalizeTrade(t, 'option'));
            }
        });
    } catch(e) { /* no current option trades */ }

    this.allTrades = trades;
    var closedCount = trades.filter(function(t) { return t.outcome !== undefined; }).length;
    console.log('[MetaLearner] Total closed trades for analysis: ' + closedCount);
};

MLMetaLearner.prototype._normalizeTrade = function(trade, type) {
    return {
        version: trade.signalVersion || trade.version || 'unknown',
        ticker: trade.ticker || '',
        direction: trade.direction || '',
        signals: (trade.signals || []).map(function(s) { return typeof s === 'string' ? s : (s.name || ''); }),
        outcome: trade.status === 'WIN' ? 1 : 0,
        pnl: trade.pnl || trade.pnlTotal || 0,
        pnlPct: trade.pnlPct || 0,
        type: type,
        openTime: trade.openTime || trade.entryTime || ''
    };
};

MLMetaLearner.prototype.analyzeSignalPerformance = function() {
    var signalMap = {};

    this.allTrades.forEach(function(trade) {
        if (!trade.signals || trade.signals.length === 0) return;

        trade.signals.forEach(function(signalName) {
            if (!signalName) return;
            // Normalize signal name to weight key format
            var key = signalName.toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '');

            if (!signalMap[key]) {
                signalMap[key] = { signal: key, originalName: signalName, wins: 0, losses: 0, totalPnl: 0, trades: 0 };
            }
            signalMap[key].trades++;
            if (trade.outcome === 1) signalMap[key].wins++;
            else signalMap[key].losses++;
            signalMap[key].totalPnl += (trade.pnlPct || 0);
        });
    });

    var results = [];
    for (var key in signalMap) {
        var s = signalMap[key];
        if (s.trades < MIN_SIGNAL_OCCURRENCES) continue;
        results.push({
            signal: s.signal,
            originalName: s.originalName,
            winRate: s.trades > 0 ? (s.wins / s.trades * 100) : 50,
            avgPnl: s.trades > 0 ? (s.totalPnl / s.trades) : 0,
            tradeCount: s.trades,
            wins: s.wins,
            losses: s.losses
        });
    }

    results.sort(function(a, b) { return b.winRate - a.winRate; });
    this.signalStats = results;
    return results;
};

MLMetaLearner.prototype.computeOptimalWeights = function() {
    var stats = this.analyzeSignalPerformance();
    
    // Load current vML weights
    var versions;
    try {
        versions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    } catch(e) {
        console.error('[MetaLearner] Cannot read signal-versions.json:', e.message);
        return null;
    }

    if (!versions.vML || !versions.vML.weights) {
        console.error('[MetaLearner] No vML version found in signal-versions.json');
        return null;
    }

    var currentWeights = JSON.parse(JSON.stringify(versions.vML.weights)); // deep copy
    var newWeights = JSON.parse(JSON.stringify(currentWeights));
    var changes = [];

    // Map signal stats to weight keys
    stats.forEach(function(stat) {
        // Try to find matching weight key
        var matchedKey = null;
        for (var wKey in currentWeights) {
            // Fuzzy match: signal name contains weight key or vice versa
            if (stat.signal.includes(wKey.replace(/_/g, '')) || wKey.includes(stat.signal.replace(/_/g, ''))) {
                matchedKey = wKey;
                break;
            }
            // Direct match
            if (stat.signal === wKey) {
                matchedKey = wKey;
                break;
            }
        }
        if (!matchedKey) return;

        var oldWeight = currentWeights[matchedKey];
        var adjustment = 0;

        if (stat.winRate > 55) {
            // Boost: proportional to edge above 50%
            adjustment = (stat.winRate - 50) / 10;
        } else if (stat.winRate < 45) {
            // Reduce: proportional to deficit below 50%
            adjustment = -((50 - stat.winRate) / 10);
        }
        // else: 45-55% = inconclusive, no change

        if (adjustment === 0) return;

        // Cap change at ±50% of current weight
        var maxChange = oldWeight * MAX_WEIGHT_CHANGE_PCT;
        adjustment = Math.max(-maxChange, Math.min(maxChange, adjustment));

        var newWeight = Math.max(0, Math.min(MAX_WEIGHT, oldWeight + adjustment));
        newWeight = +newWeight.toFixed(2);

        if (newWeight !== oldWeight) {
            newWeights[matchedKey] = newWeight;
            changes.push({
                signal: matchedKey,
                oldWeight: oldWeight,
                newWeight: newWeight,
                winRate: stat.winRate.toFixed(1),
                trades: stat.tradeCount
            });
        }
    });

    return { weights: newWeights, changes: changes };
};

MLMetaLearner.prototype.updateVMLWeights = function() {
    var result = this.computeOptimalWeights();
    if (!result) return { success: false, reason: 'Failed to compute weights' };

    if (result.changes.length === 0) {
        console.log('[MetaLearner] No weight changes needed');
        return { success: true, changes: 0 };
    }

    // Backup signal-versions.json
    try {
        var backup = fs.readFileSync(VERSIONS_PATH, 'utf8');
        fs.writeFileSync(VERSIONS_PATH + '.pre-meta-backup', backup);
    } catch(e) { /* backup failed, continue anyway */ }

    // Load and update
    var versions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    versions.vML.weights = result.weights;
    versions.vML.performance.notes = 'MetaLearner updated at ' + new Date().toISOString() +
        ' | ' + result.changes.length + ' weight changes | ' + this.allTrades.length + ' trades analyzed';

    fs.writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2));

    // Log changes
    console.log('[MetaLearner] === vML Weight Updates ===');
    result.changes.forEach(function(c) {
        console.log('[MetaLearner] ' + c.signal + ': ' + c.oldWeight + ' → ' + c.newWeight +
            ' (winRate=' + c.winRate + '%, trades=' + c.trades + ')');
    });
    console.log('[MetaLearner] Total changes: ' + result.changes.length);

    return { success: true, changes: result.changes.length, details: result.changes };
};

MLMetaLearner.prototype.runDailyUpdate = function() {
    console.log('[MetaLearner] Running daily vML weight optimization...');

    // Reload current trades
    this.loadArchives();

    var closedTrades = this.allTrades.filter(function(t) { return t.outcome !== undefined; });
    if (closedTrades.length < MIN_TRADES_TO_UPDATE) {
        console.log('[MetaLearner] Need ' + MIN_TRADES_TO_UPDATE + ' closed trades, have ' + closedTrades.length + '. Skipping.');
        return { success: false, reason: 'Insufficient trades' };
    }

    var signalAnalysis = this.analyzeSignalPerformance();
    console.log('[MetaLearner] Signal analysis (' + signalAnalysis.length + ' signals with >=' + MIN_SIGNAL_OCCURRENCES + ' occurrences):');
    signalAnalysis.slice(0, 10).forEach(function(s) {
        console.log('[MetaLearner]   ' + s.originalName + ': winRate=' + s.winRate.toFixed(1) + '% avgPnl=' + s.avgPnl.toFixed(2) + '% (' + s.tradeCount + ' trades)');
    });

    return this.updateVMLWeights();
};

module.exports = { MLMetaLearner: MLMetaLearner };
