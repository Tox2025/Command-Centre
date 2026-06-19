const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MODEL_PATHS = {
    dayTrade: path.join(DATA_DIR, 'ml-model-daytrade.json'),
    swing: path.join(DATA_DIR, 'ml-model-swing.json')
};
const MIN_TRAINING_SAMPLES = 30;
const ML_RAMP_FULL = 100;

const FEATURE_NAMES = [
    'RSI', 'MACD_Hist', 'EMA_Align', 'BB_Position', 'ATR',
    'CP_Ratio', 'DP_Direction', 'IV_Rank', 'Short_Interest', 'Vol_Spike',
    'BB_Bandwidth', 'VWAP_Dev', 'Regime', 'Gamma_Prox', 'IV_Skew',
    'Candle_Score', 'Sentiment', 'ADX', 'RSI_Divergence', 'Fib_Proximity',
    'RSI_Slope', 'MACD_Accel', 'ATR_Change', 'RSI_x_EMA', 'Vol_x_MACD',
    'Net_Premium', 'DP_Magnitude', 'Sweep_Ratio', 'Sector_CP', 'ETF_Macro',
    'Squeeze_Score', 'Season_Return', 'IVRV_Ratio', 'Congress_Net', 'Insider_Net',
    'GEX_Net_Gamma', 'MTF_Agreement', 'Runner_Score', 'Session_Pos', 'Delta_Shift',
    'Strike_Magnet', 'CP_x_DP', 'Sector_ID', 'Sector_Vol_Profile'
];

class MLCalibrator {
    constructor() {
        this.models = {
            dayTrade: this._emptyModel(),
            swing: this._emptyModel()
        };
        this.versionModels = {}; // { 'v1.0': { dayTrade: model, swing: model }, ... }
        this.featureCount = 44;
        this._loadAll();
    }

    _emptyModel() {
        return {
            trees: [], initialPrior: 0, interactions: [], trained: false,
            trainingSamples: 0, accuracy: 0,
            featureImportance: []
        };
    }

    _versionModelPath(tf, version) {
        return path.join(DATA_DIR, 'ml-model-' + tf + '-' + version.replace(/\./g, '_') + '.json');
    }

    _getModel(tf, version) {
        if (version && this.versionModels[version] && this.versionModels[version][tf]) {
            var vm = this.versionModels[version][tf];
            if (vm.trained) return vm;
        }
        return this.models[tf] || this.models.dayTrade;
    }

    _loadAll() {
        var self = this;
        for (var tf of ['dayTrade', 'swing']) {
            try {
                if (fs.existsSync(MODEL_PATHS[tf])) {
                    var data = JSON.parse(fs.readFileSync(MODEL_PATHS[tf], 'utf8'));
                    this.models[tf] = {
                        trees: data.trees || [],
                        initialPrior: data.initialPrior || 0,
                        interactions: data.interactions || [],
                        trained: data.trained || false,
                        trainingSamples: data.trainingSamples || 0,
                        accuracy: data.accuracy || 0,
                        featureImportance: data.featureImportance || []
                    };
                }
            } catch (e) {
                console.error('MLCalibrator load error (' + tf + '):', e.message);
            }
        }
        try {
            var files = fs.readdirSync(DATA_DIR).filter(function (f) { return f.startsWith('ml-model-') && f.includes('-v'); });
            files.forEach(function (f) {
                var match = f.match(/ml-model-(dayTrade|swing)-v(.+)\.json/);
                if (match) {
                    var mtf = match[1];
                    var ver = 'v' + match[2].replace(/_/g, '.');
                    try {
                        var d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
                        if (!self.versionModels[ver]) self.versionModels[ver] = {};
                        self.versionModels[ver][mtf] = {
                            trees: d.trees || [], initialPrior: d.initialPrior || 0, interactions: d.interactions || [],
                            trained: d.trained || false, trainingSamples: d.trainingSamples || 0,
                            accuracy: d.accuracy || 0, featureImportance: d.featureImportance || []
                        };
                    } catch (e2) { }
                }
            });
            var vCount = Object.keys(self.versionModels).length;
            if (vCount > 0) console.log('MLCalibrator: Loaded per-version models for ' + Object.keys(self.versionModels).join(', '));
        } catch (e) { }
    }

    _save(tf, version) {
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            var m = version ? this._getModel(tf, version) : this.models[tf];
            var filePath = version ? this._versionModelPath(tf, version) : MODEL_PATHS[tf];
            fs.writeFileSync(filePath, JSON.stringify({
                trees: m.trees, initialPrior: m.initialPrior, interactions: m.interactions,
                trained: m.trained, trainingSamples: m.trainingSamples, accuracy: m.accuracy,
                featureImportance: m.featureImportance,
                lastTrained: new Date().toISOString(), version: version || 'shared'
            }, null, 2));
        } catch (e) {
            console.error('MLCalibrator save error (' + tf + (version ? '/' + version : '') + '):', e.message);
        }
    }

    _getRecencyWeight(trade, index, totalLength) {
        let ts = trade.timestamp || trade.date || trade.exitTime;
        if (ts) {
            let age = Date.now() - new Date(ts).getTime();
            if (age <= 7 * 86400000) return 1.5;
            if (age <= 30 * 86400000) return 1.2;
            return 1.0;
        }
        let tradesFromEnd = totalLength - 1 - index;
        if (tradesFromEnd <= 35) return 1.5;
        if (tradesFromEnd <= 150) return 1.2;
        return 1.0;
    }

    _pearson(x, y) {
        let n = x.length;
        if (n === 0) return 0;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
        for (let i = 0; i < n; i++) {
            sumX += x[i]; sumY += y[i];
            sumXY += x[i] * y[i];
            sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
        }
        let num = (n * sumXY) - (sumX * sumY);
        let den = Math.sqrt(((n * sumX2) - (sumX * sumX)) * ((n * sumY2) - (sumY * sumY)));
        if (den === 0) return 0;
        return num / den;
    }

    train(trainingData, timeframe, version) {
        var tf = timeframe || 'dayTrade';
        if (tf !== 'dayTrade' && tf !== 'swing') tf = 'dayTrade';
        var label = tf + (version ? '/' + version : '');

        if (!trainingData || trainingData.length < MIN_TRAINING_SAMPLES) {
            console.log('MLCalibrator (' + label + '): Need ' + MIN_TRAINING_SAMPLES + ' samples, have ' + (trainingData ? trainingData.length : 0));
            return false;
        }

        var self = this;
        var data = trainingData.filter(d => d.features && d.features.length >= 10);
        data = data.map((d, index) => {
            var f = d.features.slice();
            while (f.length < self.featureCount) f.push(0);
            return { 
                features: f.slice(0, self.featureCount), 
                label: d.label, 
                weight: self._getRecencyWeight(d, index, data.length)
            };
        });

        if (data.length < MIN_TRAINING_SAMPLES) return false;
        console.log('MLCalibrator (' + label + '): Training GBT on ' + data.length + ' samples...');

        let splitIdx = Math.floor(data.length * 0.8);
        let trainData = data.slice(0, splitIdx);
        let valData = data.slice(splitIdx);

        // Find top 10 features by correlation
        let baseCorr = [];
        for(let i = 0; i < this.featureCount; i++) {
            baseCorr.push({ i, corr: Math.abs(this._pearson(trainData.map(d => d.features[i]), trainData.map(d => d.label))) });
        }
        baseCorr.sort((a,b) => b.corr - a.corr);
        let top10 = baseCorr.slice(0, 10).map(x => x.i);

        // Top 20 interactions
        let pairs = [];
        for(let i = 0; i < top10.length; i++) {
            for(let j = i+1; j < top10.length; j++) {
                let f1 = top10[i], f2 = top10[j];
                let interVals = trainData.map(d => d.features[f1] * d.features[f2]);
                let corr = Math.abs(this._pearson(interVals, trainData.map(d => d.label)));
                pairs.push({ f1, f2, corr: isNaN(corr) ? 0 : corr });
            }
        }
        pairs.sort((a,b) => b.corr - a.corr);
        let top20Pairs = pairs.slice(0, 20).map(p => [p.f1, p.f2]);

        trainData.forEach(d => {
            d.expanded = d.features.concat(top20Pairs.map(p => d.features[p[0]] * d.features[p[1]]));
        });
        valData.forEach(d => {
            d.expanded = d.features.concat(top20Pairs.map(p => d.features[p[0]] * d.features[p[1]]));
        });

        let sumW = 0, sumWY = 0;
        trainData.forEach(d => {
            sumW += d.weight;
            sumWY += d.weight * d.label;
        });
        let p = sumWY / sumW;
        if (p <= 0.001) p = 0.001;
        if (p >= 0.999) p = 0.999;
        let initialPrior = Math.log(p / (1 - p));

        let currentF = trainData.map(d => initialPrior);
        let trees = [];
        let featureImpMap = new Array(this.featureCount + 20).fill(0);

        let nTrees = 50;
        let lr = 0.1;
        let maxDepth = 4;

        for (let m = 0; m < nTrees; m++) {
            let y_residuals = [];
            let p_preds = [];
            for(let i = 0; i < trainData.length; i++) {
                let predP = 1 / (1 + Math.exp(-currentF[i]));
                p_preds.push(predP);
                y_residuals.push(trainData[i].label - predP);
            }

            let tree = this._buildTree(trainData.map(d=>d.expanded), y_residuals, trainData.map(d=>d.weight), p_preds, 0, maxDepth, featureImpMap);
            trees.push(tree);

            for(let i = 0; i < trainData.length; i++) {
                currentF[i] += lr * this._predictTree(tree, trainData[i].expanded);
            }
        }

        let trainAcc = this._evaluateAccuracy(trainData, initialPrior, trees, lr);
        let valAcc = this._evaluateAccuracy(valData, initialPrior, trees, lr);

        console.log(`MLCalibrator (${label}): Train Acc: ${trainAcc}%, Val Acc: ${valAcc}%`);

        if (valAcc < trainAcc - 5) {
            console.log(`MLCalibrator (${label}): Validation accuracy (${valAcc}%) is >5% worse than training (${trainAcc}%). Overfitting detected. Not deploying.`);
            return false;
        }

        let mObj;
        if (version) {
            if (!this.versionModels[version]) this.versionModels[version] = {};
            if (!this.versionModels[version][tf]) this.versionModels[version][tf] = this._emptyModel();
            mObj = this.versionModels[version][tf];
        } else {
            mObj = this.models[tf];
        }

        mObj.trees = trees;
        mObj.initialPrior = initialPrior;
        mObj.interactions = top20Pairs;
        mObj.trained = true;
        mObj.trainingSamples = data.length;
        mObj.accuracy = valAcc;

        let maxImp = Math.max(...featureImpMap, 0.0001);
        mObj.featureImportance = featureImpMap.map((imp, idx) => {
            let name = idx < this.featureCount ? (FEATURE_NAMES[idx] || `Feature_${idx}`) : `${FEATURE_NAMES[top20Pairs[idx-this.featureCount][0]]}x${FEATURE_NAMES[top20Pairs[idx-this.featureCount][1]]}`;
            return { name, importance: +(imp/maxImp).toFixed(4), weight: +(imp/maxImp).toFixed(4) };
        }).sort((a,b) => b.importance - a.importance);

        console.log('Top features:', mObj.featureImportance.slice(0, 5).map(f => `${f.name}=${f.importance}`).join(', '));

        this._save(tf, version);
        return true;
    }

    _buildTree(X, y_res, weights, p_preds, depth, maxDepth, impMap) {
        if (depth >= maxDepth || X.length < 5) {
            return { isLeaf: true, value: this._calcLeaf(y_res, weights, p_preds) };
        }

        let sumTotal = 0;
        let weightTotal = 0;
        for (let i = 0; i < y_res.length; i++) {
            sumTotal += weights[i] * y_res[i];
            weightTotal += weights[i];
        }

        let parentScore = (sumTotal * sumTotal) / weightTotal;
        let bestScore = -Infinity;
        let bestSplit = null;
        let nFeatures = X[0].length;

        for (let f = 0; f < nFeatures; f++) {
            let indices = X.map((_, i) => i).sort((a, b) => X[a][f] - X[b][f]);
            
            let sumLeft = 0;
            let weightLeft = 0;

            for (let i = 0; i < indices.length - 1; i++) {
                let idx = indices[i];
                sumLeft += weights[idx] * y_res[idx];
                weightLeft += weights[idx];

                if (X[idx][f] === X[indices[i+1]][f]) continue;

                let sumRight = sumTotal - sumLeft;
                let weightRight = weightTotal - weightLeft;

                if (weightLeft < 1 || weightRight < 1) continue;

                let score = (sumLeft * sumLeft / weightLeft) + (sumRight * sumRight / weightRight);
                let improvement = score - parentScore;
                
                if (improvement > bestScore && improvement > 1e-7) {
                    bestScore = improvement;
                    bestSplit = {
                        feature: f,
                        threshold: (X[idx][f] + X[indices[i+1]][f]) / 2
                    };
                }
            }
        }

        if (!bestSplit) {
            return { isLeaf: true, value: this._calcLeaf(y_res, weights, p_preds) };
        }

        impMap[bestSplit.feature] += bestScore;

        let leftIdx = [], rightIdx = [];
        for (let i = 0; i < X.length; i++) {
            if (X[i][bestSplit.feature] <= bestSplit.threshold) leftIdx.push(i);
            else rightIdx.push(i);
        }

        if (leftIdx.length === 0 || rightIdx.length === 0) {
            return { isLeaf: true, value: this._calcLeaf(y_res, weights, p_preds) };
        }

        return {
            isLeaf: false,
            feature: bestSplit.feature,
            threshold: bestSplit.threshold,
            left: this._buildTree(leftIdx.map(i=>X[i]), leftIdx.map(i=>y_res[i]), leftIdx.map(i=>weights[i]), leftIdx.map(i=>p_preds[i]), depth+1, maxDepth, impMap),
            right: this._buildTree(rightIdx.map(i=>X[i]), rightIdx.map(i=>y_res[i]), rightIdx.map(i=>weights[i]), rightIdx.map(i=>p_preds[i]), depth+1, maxDepth, impMap)
        };
    }

    _calcLeaf(y_res, weights, p_preds) {
        let num = 0, den = 0;
        for(let i = 0; i < y_res.length; i++) {
            num += weights[i] * y_res[i];
            den += weights[i] * p_preds[i] * (1 - p_preds[i]);
        }
        if (den === 0) return 0;
        let v = num / den;
        if (v > 10) return 10;
        if (v < -10) return -10;
        return v;
    }

    _predictTree(node, x) {
        while (!node.isLeaf) {
            if (x[node.feature] <= node.threshold) node = node.left;
            else node = node.right;
        }
        return node.value;
    }

    _evaluateAccuracy(data, initialPrior, trees, lr) {
        let correct = 0;
        for (let i = 0; i < data.length; i++) {
            let z = initialPrior;
            for (let t = 0; t < trees.length; t++) {
                z += lr * this._predictTree(trees[t], data[i].expanded);
            }
            let pred = 1 / (1 + Math.exp(-z));
            let predLabel = pred >= 0.5 ? 1 : 0;
            if (predLabel === data[i].label) correct++;
        }
        return +((correct / data.length) * 100).toFixed(1);
    }

    predict(features, timeframe, version) {
        var tf = timeframe || 'dayTrade';
        var m = this._getModel(tf, version);
        if (!m || !m.trained || !m.trees || m.trees.length === 0) return null;

        var f = features ? features.slice() : null;
        if (!f) return null;
        while (f.length < this.featureCount) f.push(0);
        f = f.slice(0, this.featureCount);

        let expanded = f.slice();
        if (m.interactions) {
            m.interactions.forEach(p => {
                expanded.push(f[p[0]] * f[p[1]]);
            });
        }

        let z = m.initialPrior || 0;
        for (let t = 0; t < m.trees.length; t++) {
            z += 0.1 * this._predictTree(m.trees[t], expanded);
        }
        return +(1 / (1 + Math.exp(-z))).toFixed(4);
    }

    ensemble(ruleBasedConfidence, features, timeframe, version) {
        var tf = timeframe || 'dayTrade';
        var m = this._getModel(tf, version);
        var mlPred = this.predict(features, tf, version);

        if (mlPred === null) {
            return { confidence: ruleBasedConfidence, source: 'rule_based', mlWeight: 0, timeframe: tf };
        }

        let acc = m.accuracy || 0;
        let mlMaxWeight = 0.15;
        if (acc >= 75) mlMaxWeight = 0.60;
        else if (acc >= 70) mlMaxWeight = 0.50;
        else if (acc >= 65) mlMaxWeight = 0.40;
        else if (acc >= 60) mlMaxWeight = 0.30;

        if (acc >= 72 && mlPred < 0.30) {
            return {
                confidence: 0,
                ruleBasedConfidence: ruleBasedConfidence,
                mlConfidence: Math.round(mlPred * 100),
                mlProbability: mlPred,
                mlWeight: mlMaxWeight,
                ruleWeight: 1 - mlMaxWeight,
                source: 'ensemble',
                timeframe: tf,
                version: version || 'shared',
                modelAccuracy: acc,
                trainingSamples: m.trainingSamples,
                vetoed: true,
                reason: 'ML_VETO'
            };
        }

        var rawRamp = Math.min(mlMaxWeight, (m.trainingSamples / ML_RAMP_FULL) * mlMaxWeight);
        var mlWeight = +rawRamp.toFixed(3);
        var ruleWeight = 1 - mlWeight;
        var mlConfidence = Math.round(mlPred * 100);
        var blended = Math.round(ruleWeight * ruleBasedConfidence + mlWeight * mlConfidence);

        return {
            confidence: Math.max(0, Math.min(100, blended)),
            ruleBasedConfidence: ruleBasedConfidence,
            mlConfidence: mlConfidence,
            mlProbability: mlPred,
            mlWeight: +mlWeight.toFixed(2),
            ruleWeight: +ruleWeight.toFixed(2),
            source: 'ensemble',
            timeframe: tf,
            version: version || 'shared',
            modelAccuracy: acc,
            trainingSamples: m.trainingSamples
        };
    }

    getSuggestedWeights(timeframe) {
        var tf = timeframe || 'dayTrade';
        var m = this.models[tf];
        if (!m || !m.trained || !m.featureImportance || !m.featureImportance.length) return null;

        var featureToSignal = {
            'RSI': 'rsi_position', 'MACD_Hist': 'macd_histogram',
            'EMA_Align': 'ema_alignment', 'BB_Position': 'bollinger_position',
            'CP_Ratio': 'call_put_ratio', 'DP_Direction': 'dark_pool_direction',
            'IV_Rank': 'iv_rank', 'Short_Interest': 'short_interest',
            'Vol_Spike': 'volume_spike', 'BB_Bandwidth': 'bb_squeeze',
            'VWAP_Dev': 'vwap_deviation',
            'ADX': 'adx_filter', 'RSI_Divergence': 'rsi_divergence',
            'Net_Premium': 'net_premium_momentum', 'Sector_CP': 'sector_tide_alignment',
            'ETF_Macro': 'etf_tide_macro', 'Squeeze_Score': 'squeeze_composite',
            'GEX_Net_Gamma': 'gex_positioning', 'Runner_Score': 'volatility_runner'
        };
        var suggestions = {};
        var maxImp = m.featureImportance[0].importance || 1;
        m.featureImportance.forEach(function (f) {
            var signal = featureToSignal[f.name];
            if (signal) {
                suggestions[signal] = Math.max(1, Math.round(f.importance / maxImp * 4));
            }
        });
        return suggestions;
    }

    getStatus() {
        var dt = this.models.dayTrade;
        var sw = this.models.swing;
        var versionStats = {};
        var self = this;
        Object.keys(this.versionModels).forEach(function (ver) {
            versionStats[ver] = {};
            ['dayTrade', 'swing'].forEach(function (tf) {
                var vm = self.versionModels[ver][tf];
                if (vm) {
                    versionStats[ver][tf] = {
                        trained: vm.trained, trainingSamples: vm.trainingSamples,
                        accuracy: vm.accuracy
                    };
                }
            });
        });
        return {
            featureCount: this.featureCount,
            dayTrade: {
                trained: dt.trained, trainingSamples: dt.trainingSamples,
                accuracy: dt.accuracy, featureImportance: dt.featureImportance,
                mlRampPct: Math.min(100, Math.round(dt.trainingSamples / ML_RAMP_FULL * 100))
            },
            swing: {
                trained: sw.trained, trainingSamples: sw.trainingSamples,
                accuracy: sw.accuracy, featureImportance: sw.featureImportance,
                mlRampPct: Math.min(100, Math.round(sw.trainingSamples / ML_RAMP_FULL * 100))
            },
            versionModels: versionStats
        };
    }
}

module.exports = MLCalibrator;
