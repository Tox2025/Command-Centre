// Weekend ML Full Retrain — regenerates all historical training data with _ticker tags
// and retrains both models from scratch. Run when market is closed.
// Usage: node retrain-ml-full.js

const PolygonHistorical = require('./src/polygon-historical');
const MLCalibrator = require('./src/ml-calibrator');
const fs = require('fs');
const path = require('path');

// Load config
var envPath = path.join(__dirname, '.env');
var apiKey = '';
try {
    var envContent = fs.readFileSync(envPath, 'utf8');
    var match = envContent.match(/POLYGON_API_KEY=(.+)/);
    if (match) apiKey = match[1].trim();
} catch (e) { }
if (!apiKey) {
    console.error('❌ No POLYGON_API_KEY found in .env');
    process.exit(1);
}

// Load watchlist
var watchlistPath = path.join(__dirname, 'data', 'watchlist.json');
var tickers = [];
try {
    tickers = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    if (!Array.isArray(tickers)) tickers = tickers.tickers || [];
} catch (e) {
    console.error('❌ Could not load watchlist from', watchlistPath);
    process.exit(1);
}

console.log('=== ML FULL RETRAIN ===');
console.log('Tickers:', tickers.length);
console.log('Years: 15');
console.log('========================\n');

async function run() {
    var poly = new PolygonHistorical(apiKey);
    var mlCalibrator = new MLCalibrator();
    var cumulPath = path.join(__dirname, 'data', 'ml-training-cumulative.json');

    // Step 1: Regenerate ALL historical training data with _ticker tags
    console.log('📊 Step 1: Regenerating historical data for ' + tickers.length + ' tickers (15 years each)...\n');

    var allML = [];
    var tickerStats = {};

    for (var i = 0; i < tickers.length; i++) {
        var ticker = tickers[i];
        try {
            console.log('[' + (i + 1) + '/' + tickers.length + '] ' + ticker + '...');
            var result = await poly.generateAndConvert([ticker], 15);
            if (result && result.data && result.data.length > 0) {
                allML = allML.concat(result.data);
                tickerStats[ticker] = { samples: result.mlSamples, bull: result.bullish, bear: result.bearish };
                console.log('  ✅ ' + ticker + ': ' + result.mlSamples + ' samples (bull=' + result.bullish + ' bear=' + result.bearish + ')');
            } else {
                console.log('  ⚠️ ' + ticker + ': no data');
            }
        } catch (e) {
            console.error('  ❌ ' + ticker + ': ' + e.message);
        }
    }

    // Cap at 50K
    if (allML.length > 50000) allML = allML.slice(-50000);

    // Save cumulative file
    console.log('\n📊 Step 2: Saving ' + allML.length + ' training records to cumulative file...');
    fs.writeFileSync(cumulPath, JSON.stringify(allML));
    console.log('  ✅ Saved to ' + cumulPath);

    // Step 3: Verify tickers are tagged
    var tickerCheck = {};
    allML.forEach(function (d) {
        var t = d._ticker || '?';
        tickerCheck[t] = (tickerCheck[t] || 0) + 1;
    });
    console.log('\n📊 Step 3: Ticker distribution:');
    Object.keys(tickerCheck).sort().forEach(function (t) {
        console.log('  ' + t + ': ' + tickerCheck[t] + ' samples');
    });

    // Step 4: Retrain both models
    console.log('\n📊 Step 4: Training ML models...');
    var recent = allML.slice(Math.floor(allML.length * 0.6));

    console.log('\n--- Day Trade Model (recent 60% = ' + recent.length + ' samples) ---');
    var dtResult = mlCalibrator.train(recent, 'dayTrade');
    if (dtResult) {
        console.log('✅ Day Trade trained!');
    } else {
        console.log('❌ Day Trade training failed');
    }

    console.log('\n--- Swing Model (all ' + allML.length + ' samples) ---');
    var swResult = mlCalibrator.train(allML, 'swing');
    if (swResult) {
        console.log('✅ Swing trained!');
    } else {
        console.log('❌ Swing training failed');
    }

    // Print final status
    var status = mlCalibrator.getStatus();
    console.log('\n=== FINAL ML STATUS ===');
    console.log('Day Trade: ' + status.dayTrade.accuracy + '% accuracy (' + status.dayTrade.trainingSamples + ' samples)');
    console.log('Swing:     ' + status.swing.accuracy + '% accuracy (' + status.swing.trainingSamples + ' samples)');

    // Top features
    if (status.dayTrade.featureImportance && status.dayTrade.featureImportance.length > 0) {
        console.log('\nTop 10 Day Trade Features:');
        status.dayTrade.featureImportance.slice(0, 10).forEach(function (f, i) {
            console.log('  ' + (i + 1) + '. ' + f.name + ' = ' + f.weight + ' (importance: ' + f.importance + ')');
        });
    }
    if (status.swing.featureImportance && status.swing.featureImportance.length > 0) {
        console.log('\nTop 10 Swing Features:');
        status.swing.featureImportance.slice(0, 10).forEach(function (f, i) {
            console.log('  ' + (i + 1) + '. ' + f.name + ' = ' + f.weight + ' (importance: ' + f.importance + ')');
        });
    }

    console.log('\n=== RETRAIN COMPLETE ===');
    console.log('Tickers processed: ' + Object.keys(tickerStats).length + '/' + tickers.length);
    console.log('Total samples: ' + allML.length);
    console.log('Models ready for Monday. 🚀');
}

run().catch(function (e) { console.error('Fatal error:', e); process.exit(1); });
