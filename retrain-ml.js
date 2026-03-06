const TradeJournal = require('./src/trade-journal');
const OptionsPaperTrading = require('./src/options-paper-trading');
const MLCalibrator = require('./src/ml-calibrator');
const fs = require('fs');

async function run() {
    console.log('--- 🧠 Universal ML Retraining Script ---');

    // Parse arguments
    const args = process.argv.slice(2);
    let targetVersion = null;
    if (args.includes('--version')) {
        targetVersion = args[args.indexOf('--version') + 1];
    }

    // Initialize modules
    const tradeJournal = new TradeJournal();
    const optionsTrading = new OptionsPaperTrading();
    const mlCalibrator = new MLCalibrator();
    const featureCount = mlCalibrator.featureCount || 44;

    // 1. Load Stock Data
    let stockData = tradeJournal.getTrainingData();
    if (targetVersion) {
        // If versioned training, we might want to prioritize or filter, 
        // but for now we pool all data to train the "brain" and only save to specific version profile
        console.log(`ℹ️ Training specifically for version profile: ${targetVersion}`);
    }

    // 2. Load and Normalize Options Data
    let rawOptions = optionsTrading.getTrainingData();
    let optionsData = rawOptions.map(t => {
        let features = t.features;
        // Normalize legacy object format to array vector
        if (features && !Array.isArray(features)) {
            let vec = new Array(featureCount).fill(0);
            vec[0] = features.rsi || 50;
            vec[4] = features.atr || 0;
            vec[7] = features.ivRank || 50;
            vec[8] = features.shortInterest ? Math.min(100, features.shortInterest / 1000) : 0;
            vec[36] = features.mtfAgreeing || 0;
            if (features.emaBias === 'BULLISH') vec[2] = 1;
            else if (features.emaBias === 'BEARISH') vec[2] = -1;
            features = vec;
        }

        return {
            features: features,
            label: t.win || (t.status === 'WIN' ? 1 : 0),
            confidence: t.confidence,
            pnlPct: t.pnlPct
        };
    });

    // 3. Merge and Deduplicate
    const combinedData = [...stockData, ...optionsData].filter(d => d.features && (Array.isArray(d.features) || d.features.length > 0));

    console.log(`📊 Data Pool Summary:`);
    console.log(`   - Stock Trades:   ${stockData.length}`);
    console.log(`   - Options Trades: ${optionsData.length}`);
    console.log(`   - Total Pooled:   ${combinedData.length}`);

    if (combinedData.length < 30) {
        console.log('⚠️ Not enough data to retrain (Need 30 total).');
        return;
    }

    // 4. Train Models
    const timeframes = ['dayTrade', 'swing'];
    for (const tf of timeframes) {
        console.log(`\n--- Training ${tf.toUpperCase()} Model ---`);
        const result = mlCalibrator.train(combinedData, tf, targetVersion);
        if (result) {
            console.log(`✅ ${tf} Model trained successfully${targetVersion ? ' for ' + targetVersion : ''}.`);
            if (!targetVersion) {
                const weights = mlCalibrator.getSuggestedWeights(tf);
                console.log('Suggested Global Weights:', JSON.stringify(weights, null, 2));
            }
        } else {
            console.error(`❌ ${tf} Model training failed.`);
        }
    }

    console.log('\n✨ Retraining Complete.');
}

run().catch(err => console.error('FATAL:', err));
