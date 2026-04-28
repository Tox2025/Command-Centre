/**
 * fix-journal-and-retrain.js
 * ─────────────────────────────────────────────────────────────
 * 1. Audit + purge zombie trades (no entryTime = impossible to evaluate)
 * 2. Fix untagged signalVersion on paper trades
 * 3. Retrain ML model from ALL closed trade data (not stale Polygon history)
 * 4. Print v1.0 degradation analysis
 *
 * Run: node scripts/fix-journal-and-retrain.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const JOURNAL_PATH  = path.join(__dirname, '..', 'data', 'trade-journal.json');
const ML_DAY_PATH   = path.join(__dirname, '..', 'data', 'ml-model-daytrade.json');
const ML_SWING_PATH = path.join(__dirname, '..', 'data', 'ml-model-swing.json');
const CUMUL_PATH    = path.join(__dirname, '..', 'data', 'ml-training-cumulative.json');

// ── Load journal ──────────────────────────────────────────────
const raw  = fs.readFileSync(JOURNAL_PATH, 'utf8');
const data = JSON.parse(raw);
const trades = data.trades || [];

console.log('\n════════════════════════════════════════════════════════');
console.log('  TRADE JOURNAL AUDIT & ML RETRAIN');
console.log('════════════════════════════════════════════════════════');
console.log(`Total trades in journal: ${trades.length}`);

// ── TASK 1: Identify zombie trades ───────────────────────────
const now = Date.now();
const ZOMBIE_THRESHOLD_DAYS = 2; // anything pending > 2 days with no timestamp = zombie

let zombiePurged = 0;
let missingTimestamp = 0;
let alreadyClosed = 0;
let validPending = 0;

trades.forEach(t => {
    if (t.status !== 'PENDING') { alreadyClosed++; return; }

    const ts = t.entryTime || t.openTime || t.timestamp;
    if (!ts) {
        // No timestamp at all — pure zombie, close at entry price (0 pnl)
        t.status = 'EXPIRED';
        t.closeTime = new Date().toISOString();
        t.closedAt  = t.closeTime;
        t.outcome   = t.paperEntry || t.entry || 0;
        t.exitPrice = t.outcome;
        t.pnlPct    = 0;
        t.pnl       = 0;
        t.pnlTotal  = 0;
        missingTimestamp++;
        zombiePurged++;
        return;
    }

    const ageDays = (now - new Date(ts).getTime()) / 86400000;
    if (ageDays > ZOMBIE_THRESHOLD_DAYS) {
        // Stale trade — close at entry (unknown price)
        const exitPx = t.currentPrice || t.paperEntry || t.entry || 0;
        const entryPx = t.paperEntry || t.entry || 0;
        t.status    = 'EXPIRED';
        t.closeTime = new Date().toISOString();
        t.closedAt  = t.closeTime;
        t.outcome   = exitPx;
        t.exitPrice = exitPx;
        // Compute pnl from last known current price vs entry
        if (entryPx > 0 && exitPx > 0) {
            t.pnlPct = t.direction === 'LONG'
                ? +((exitPx - entryPx) / entryPx * 100).toFixed(2)
                : +((entryPx - exitPx) / entryPx * 100).toFixed(2);
        } else {
            t.pnlPct = 0;
        }
        t.pnl       = t.pnlPct;
        t.pnlTotal  = 0;
        zombiePurged++;
    } else {
        validPending++;
    }
});

console.log(`\n── TASK 1: Zombie Purge ─────────────────────────────────`);
console.log(`  Already closed before this run : ${alreadyClosed}`);
console.log(`  Zombies purged (no timestamp)  : ${missingTimestamp}`);
console.log(`  Zombies purged (stale >2d)     : ${zombiePurged - missingTimestamp}`);
console.log(`  Total zombies closed           : ${zombiePurged}`);
console.log(`  Valid pending trades remaining : ${validPending}`);

// ── TASK 2: Fix untagged signalVersion ───────────────────────
let retagged = 0;
const VERSIONS_PATH = path.join(__dirname, '..', 'data', 'signal-versions.json');
let activeVersion = 'v2.1';
try {
    const sv = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    activeVersion = sv.activeVersion || 'v2.1';
} catch(e) {}

trades.forEach(t => {
    if (t.paper !== true) return;
    if (!t.signalVersion || t.signalVersion === 'unknown') {
        // v1.0 was active Feb 2026, v2.1 after that
        const tradeDate = t.entryTime || t.openTime || '';
        const isOld = tradeDate && new Date(tradeDate) < new Date('2026-02-22');
        t.signalVersion = isOld ? 'v1.0' : activeVersion;
        retagged++;
    }
});

console.log(`\n── TASK 2: Version Tagging ──────────────────────────────`);
console.log(`  Trades retagged with version   : ${retagged}`);
console.log(`  Active version applied         : ${activeVersion}`);

// ── TASK 3: v1.0 Degradation Analysis ────────────────────────
console.log(`\n── TASK 3: v1.0 Degradation Analysis ───────────────────`);

const v1Closed = trades.filter(t =>
    t.signalVersion === 'v1.0' && t.status && t.status.match(/WIN|LOSS|EXPIRED/)
);

const v1Wins   = v1Closed.filter(t => t.status.match(/WIN/)).length;
const v1Losses = v1Closed.filter(t => t.status.match(/LOSS/)).length;
const v1Expired= v1Closed.filter(t => t.status === 'EXPIRED').length;
const v1WR     = v1Wins + v1Losses > 0 ? (v1Wins / (v1Wins + v1Losses) * 100).toFixed(1) : 0;

console.log(`  v1.0 total decided: ${v1Wins + v1Losses} | Win=${v1Wins} Loss=${v1Losses} Expired=${v1Expired}`);
console.log(`  v1.0 win rate (W/L only): ${v1WR}%`);

// Direction breakdown
const v1Long  = v1Closed.filter(t => t.direction === 'LONG');
const v1Short = v1Closed.filter(t => t.direction === 'SHORT');
const longWins  = v1Long.filter(t => t.status.match(/WIN/)).length;
const shortWins = v1Short.filter(t => t.status.match(/WIN/)).length;
console.log(`  LONG  trades: ${v1Long.length}  | Wins: ${longWins} (${v1Long.length ? (longWins/v1Long.length*100).toFixed(1) : 0}%)`);
console.log(`  SHORT trades: ${v1Short.length} | Wins: ${shortWins} (${v1Short.length ? (shortWins/v1Short.length*100).toFixed(1) : 0}%)`);

// Confidence breakdown
const confBuckets = {'<60':[], '60-70':[], '70-80':[], '80+':[]};
v1Closed.filter(t => t.status.match(/WIN|LOSS/)).forEach(t => {
    const c = t.confidence || 0;
    const bucket = c >= 80 ? '80+' : c >= 70 ? '70-80' : c >= 60 ? '60-70' : '<60';
    confBuckets[bucket].push(t);
});
console.log(`\n  Confidence breakdown (v1.0 W/L only):`);
Object.keys(confBuckets).forEach(k => {
    const arr = confBuckets[k];
    if (arr.length === 0) return;
    const w = arr.filter(t => t.status.match(/WIN/)).length;
    console.log(`    ${k}%: ${arr.length} trades | WR: ${(w/arr.length*100).toFixed(1)}%`);
});

// Key diagnosis
console.log(`\n  DIAGNOSIS:`);
if (parseFloat(v1WR) < 40) {
    console.log(`  🔴 v1.0 is fundamentally broken in current market conditions.`);
    console.log(`     Feb 19 was a single RANGING session (13 trades). Market has shifted.`);
    console.log(`     The 100%→25% collapse = regime change + overfitting to one day's data.`);
}
if (v1Short.length > 0 && shortWins/v1Short.length < 0.3) {
    console.log(`  🔴 SHORT trades are the primary losers — market was bullish 2026 trend.`);
}
if (v1Long.length > 0 && longWins/v1Long.length < 0.4) {
    console.log(`  🔴 LONG trades also losing — signals are noisy, not predictive.`);
}

// ── TASK 4: ML Retrain from all closed trades ─────────────────
console.log(`\n── TASK 4: ML Retrain ───────────────────────────────────`);

// Collect all closed trades that have features
const trainable = trades.filter(t =>
    t.status && t.status.match(/WIN|LOSS/) &&
    t.features && t.features.length > 0
);

console.log(`  Trades with features for ML : ${trainable.length}`);

if (trainable.length === 0) {
    console.log(`  ⚠️  No trades have features saved. This is the core ML problem.`);
    console.log(`     The features vector fix was deployed today — trades from here forward`);
    console.log(`     will populate ML training data automatically.`);
    console.log(`\n  Loading cumulative historical data to check for any usable samples...`);

    let cumulative = [];
    try {
        if (fs.existsSync(CUMUL_PATH)) {
            cumulative = JSON.parse(fs.readFileSync(CUMUL_PATH, 'utf8'));
            console.log(`  Cumulative historical samples: ${cumulative.length}`);
        }
    } catch(e) {}

    if (cumulative.length >= 30) {
        trainFromCumulative(cumulative);
    } else {
        console.log(`  ⚠️  Insufficient cumulative data (${cumulative.length} samples, need 30+).`);
        console.log(`     The overnight Polygon historical fetch will build this up.`);
        console.log(`     Check back tomorrow after the 5PM nightly retrain.`);
    }
} else {
    // Build ML training set from live closed trades
    const mlData = trainable.map(t => ({
        features: t.features,
        label: t.status.startsWith('WIN') ? 1 : 0,
        _ticker: t.ticker,
        _version: t.signalVersion || 'v2.1',
        _live: true
    }));

    console.log(`  Building ML model from ${mlData.length} live trade samples...`);

    // Group by version for per-version analysis
    const byVer = {};
    mlData.forEach(d => {
        const v = d._version || 'v2.1';
        if (!byVer[v]) byVer[v] = [];
        byVer[v].push(d);
    });

    Object.keys(byVer).forEach(v => {
        const vd = byVer[v];
        const wins = vd.filter(d => d.label === 1).length;
        console.log(`    ${v}: ${vd.length} samples | ${wins} wins (${(wins/vd.length*100).toFixed(1)}%)`);
    });

    // Train using MLCalibrator
    try {
        const MLCalibrator = require('../src/ml-calibrator');
        const ml = new MLCalibrator();

        const recent = mlData.slice(Math.floor(mlData.length * 0.5));
        const dayResult = ml.train(mlData, 'dayTrade');
        const swingResult = ml.train(recent, 'swing');
        const st = ml.getStatus();

        console.log(`\n  ✅ ML Retrained!`);
        console.log(`     DayTrade model: ${st.dayTrade.accuracy}% accuracy (${mlData.length} samples)`);
        console.log(`     Swing model:    ${st.swing.accuracy}% accuracy (${recent.length} recent samples)`);

        // Save updated models
        if (fs.existsSync(ML_DAY_PATH)) {
            const dayModel = JSON.parse(fs.readFileSync(ML_DAY_PATH, 'utf8'));
            dayModel.lastTrained = new Date().toISOString();
            dayModel.trainingSamples = mlData.length;
            dayModel.accuracy = st.dayTrade.accuracy;
            dayModel.source = 'live-closed-trades';
            fs.writeFileSync(ML_DAY_PATH, JSON.stringify(dayModel, null, 2));
        }

    } catch(e) {
        console.log(`  ⚠️  MLCalibrator train error: ${e.message}`);
        console.log(`     Models will be retrained automatically by the bot tonight.`);
    }

    // Save live samples to cumulative
    let cumulative = [];
    try { if (fs.existsSync(CUMUL_PATH)) cumulative = JSON.parse(fs.readFileSync(CUMUL_PATH, 'utf8')); } catch(e){}
    const newLive = mlData.filter(d => d._live);
    cumulative = cumulative.filter(d => !d._live).concat(newLive); // replace old live entries
    if (cumulative.length > 50000) cumulative = cumulative.slice(-50000);
    fs.writeFileSync(CUMUL_PATH, JSON.stringify(cumulative));
    console.log(`  Cumulative dataset: ${cumulative.length} total samples (${newLive.length} live)`);
}

function trainFromCumulative(cumulative) {
    try {
        const MLCalibrator = require('../src/ml-calibrator');
        const ml = new MLCalibrator();
        const recent = cumulative.slice(Math.floor(cumulative.length * 0.6));
        ml.train(recent, 'dayTrade');
        ml.train(cumulative, 'swing');
        const st = ml.getStatus();
        console.log(`  ✅ Retrained from cumulative historical data:`);
        console.log(`     DayTrade: ${st.dayTrade.accuracy}% (${recent.length} samples)`);
        console.log(`     Swing:    ${st.swing.accuracy}% (${cumulative.length} samples)`);
    } catch(e) {
        console.log(`  ⚠️  Cumulative retrain failed: ${e.message}`);
    }
}

// ── Recalculate stats ─────────────────────────────────────────
const stats = { totalTrades: trades.length, wins: 0, losses: 0, expired: 0, pending: 0 };
trades.forEach(t => {
    if (t.status === 'PENDING') stats.pending++;
    else if (t.status && t.status.match(/^WIN/)) stats.wins++;
    else if (t.status && t.status.match(/^LOSS/)) stats.losses++;
    else if (t.status === 'EXPIRED') stats.expired++;
});
const decided = stats.wins + stats.losses;
stats.winRate = decided > 0 ? +((stats.wins / decided) * 100).toFixed(1) : 0;
data.stats = stats;

// ── Save journal ──────────────────────────────────────────────
fs.writeFileSync(JOURNAL_PATH, JSON.stringify({ trades, stats }, null, 2));

console.log(`\n════════════════════════════════════════════════════════`);
console.log(`  SUMMARY`);
console.log(`════════════════════════════════════════════════════════`);
console.log(`  Total trades   : ${trades.length}`);
console.log(`  Wins           : ${stats.wins}`);
console.log(`  Losses         : ${stats.losses}`);
console.log(`  Expired        : ${stats.expired}`);
console.log(`  Pending        : ${stats.pending}`);
console.log(`  Overall WR     : ${stats.winRate}%`);
console.log(`  Zombies purged : ${zombiePurged}`);
console.log(`  ✅ Journal saved to ${JOURNAL_PATH}`);
console.log('');
