const TradeJournal = require('./src/trade-journal');
const MLCalibrator = require('./src/ml-calibrator');
const fs = require('fs');

async function run() {
    console.log('--- ML Retraining Script ---');

    // Initialize modules
    const tradeJournal = new TradeJournal();
    const mlCalibrator = new MLCalibrator();

    // Load data
    const trainingData = tradeJournal.getTrainingData();
    console.log(`Loaded ${trainingData.length} eligible training records.`);

    if (trainingData.length < 30) {
        console.log('⚠️ Not enough data to retrain (Need 30, have ' + trainingData.length + ').');
        return;
    }

    // Train Day Trade Model
    console.log('\n--- Training Day Trade Model ---');
    const dtResult = mlCalibrator.train(trainingData, 'dayTrade');
    if (dtResult) {
        console.log('✅ Day Trade Model trained successfully.');
        const weights = mlCalibrator.getSuggestedWeights('dayTrade');
        console.log('Suggested Weights:', JSON.stringify(weights, null, 2));
    } else {
        console.error('❌ Day Trade Model training failed.');
    }

    // Train Swing Model
    console.log('\n--- Training Swing Model ---');
    const swingResult = mlCalibrator.train(trainingData, 'swing');
    if (swingResult) {
        console.log('✅ Swing Model trained successfully.');
    } else {
        console.error('❌ Swing Model training failed.');
    }

    console.log('\nDone.');
}

run();
