// ML Calibrator - Multi-timeframe logistic regression for confidence calibration
// Maintains separate models for dayTrade (open/power hour) and swing (1-7d+)
// Supports per-version models for A/B testing
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
    'Strike_Magnet', 'CP_x_DP'
];

class MLCalibrator {
    constructor() {
        this.models = {
            dayTrade: this._emptyModel(),
            swing: this._emptyModel()
        };
        this.versionModels = {}; // { 'v1.0': { dayTrade: model, swing: model }, ... }
        this.featureCount = 42;
        this._loadAll();
    }

    _emptyModel() {
        return {
            weights: null, bias: 0, trained: false,
            trainingSamples: 0, accuracy: 0,
            featureImportance: [], featureStats: null
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
                        weights: data.weights,
                        bias: data.bias || 0,
                        trained: data.trained || false,
                        trainingSamples: data.trainingSamples || 0,
                        accuracy: data.accuracy || 0,
                        featureImportance: data.featureImportance || [],
                        featureStats: data.featureStats || null
                    };
                }
            } catch (e) {
                console.error('MLCalibrator load error (' + tf + '):', e.message);
            }
        }
        // Load per-version models
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
                            weights: d.weights, bias: d.bias || 0, trained: d.trained || false,
                            trainingSamples: d.trainingSamples || 0, accuracy: d.accuracy || 0,
                            featureImportance: d.featureImportance || [], featureStats: d.featureStats || null
                        };
                    } catch (e2) { /* skip corrupt version models */ }
                }
            });
            var vCount = Object.keys(self.versionModels).length;
            if (vCount > 0) console.log('MLCalibrator: Loaded per-version models for ' + Object.keys(self.versionModels).join(', '));
        } catch (e) { /* no version models yet */ }
    }

    _save(tf, version) {
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            var m = version ? this._getModel(tf, version) : this.models[tf];
            var filePath = version ? this._versionModelPath(tf, version) : MODEL_PATHS[tf];
            fs.writeFileSync(filePath, JSON.stringify({
                weights: m.weights, bias: m.bias, trained: m.trained,
                trainingSamples: m.trainingSamples, accuracy: m.accuracy,
                featureImportance: m.featureImportance, featureStats: m.featureStats,
                lastTrained: new Date().toISOString(), version: version || 'shared'
            }, null, 2));
        } catch (e) {
            console.error('MLCalibrator save error (' + tf + (version ? '/' + version : '') + '):', e.message);
        }
    }

    _sigmoid(z) {
        if (z > 500) return 1;
        if (z < -500) return 0;
        return 1 / (1 + Math.exp(-z));
    }

    _normalize(features, stats) {
        return features.map(function (f, i) {
            var s = stats[i];
            if (!s || s.max === s.min) return 0.5;
            return (f - s.min) / (s.max - s.min);
        });
    }

    _computeStats(data) {
        var stats = [];
        for (var i = 0; i < this.featureCount; i++) {
            var min = Infinity, max = -Infinity, sum = 0;
            data.forEach(function (d) {
                var v = (d.features && d.features[i]) || 0;
                if (v < min) min = v;
                if (v > max) max = v;
                sum += v;
            });
            stats.push({ min: min, max: max, mean: sum / data.length });
        }
        return stats;
    }

    // Train a specific timeframe model, optionally for a specific version
    train(trainingData, timeframe, version) {
        var tf = timeframe || 'dayTrade';
        if (tf !== 'dayTrade' && tf !== 'swing') tf = 'dayTrade';
        var label = tf + (version ? '/' + version : '');

        if (!trainingData || trainingData.length < MIN_TRAINING_SAMPLES) {
            console.log('MLCalibrator (' + label + '): Need ' + MIN_TRAINING_SAMPLES + ' samples, have ' + (trainingData ? trainingData.length : 0));
            return false;
        }

        var self = this;
        var data = trainingData.filter(function (d) {
            return d.features && d.features.length >= 10;
        });
        data = data.map(function (d) {
            var f = d.features.slice();
            while (f.length < self.featureCount) f.push(0);
            return { features: f.slice(0, self.featureCount), label: d.label, confidence: d.confidence, pnlPct: d.pnlPct };
        });

        if (data.length < MIN_TRAINING_SAMPLES) return false;
        console.log('MLCalibrator (' + label + '): Training on ' + data.length + ' samples...');

        var fStats = this._computeStats(data);
        var w = new Array(this.featureCount).fill(0);
        var b = 0;
        var lr = 0.01;
        var epochs = 500;
        var lambda = 0.01;

        for (var epoch = 0; epoch < epochs; epoch++) {
            var gradW = new Array(this.featureCount).fill(0);
            var gradB = 0;
            for (var si = 0; si < data.length; si++) {
                var sample = data[si];
                var x = this._normalize(sample.features, fStats);
                var y = sample.label;
                var z = b;
                for (var i = 0; i < this.featureCount; i++) z += w[i] * x[i];
                var pred = this._sigmoid(z);
                var diff = pred - y;
                for (var i2 = 0; i2 < this.featureCount; i2++) {
                    gradW[i2] += diff * x[i2] + lambda * w[i2];
                }
                gradB += diff;
            }
            for (var i3 = 0; i3 < this.featureCount; i3++) {
                w[i3] -= lr * gradW[i3] / data.length;
            }
            b -= lr * gradB / data.length;
        }

        // Store the trained model
        var m;
        if (version) {
            if (!this.versionModels[version]) this.versionModels[version] = {};
            if (!this.versionModels[version][tf]) this.versionModels[version][tf] = this._emptyModel();
            m = this.versionModels[version][tf];
        } else {
            m = this.models[tf];
        }
        m.weights = w;
        m.bias = b;
        m.trained = true;
        m.trainingSamples = data.length;
        m.featureStats = fStats;

        // Accuracy
        var correct = 0;
        for (var ci = 0; ci < data.length; ci++) {
            var p = this.predict(data[ci].features, tf, version);
            if ((p >= 0.5 ? 1 : 0) === data[ci].label) correct++;
        }
        m.accuracy = +(correct / data.length * 100).toFixed(1);

        // Feature importance
        m.featureImportance = w.map(function (wt, idx) {
            return { name: FEATURE_NAMES[idx] || 'Feature_' + idx, weight: +wt.toFixed(4), importance: +Math.abs(wt).toFixed(4) };
        }).sort(function (a, b2) { return b2.importance - a.importance; });

        console.log('MLCalibrator (' + label + '): Trained! Accuracy: ' + m.accuracy + '%');
        console.log('Top features:', m.featureImportance.slice(0, 5).map(function (f) { return f.name + '=' + f.weight; }).join(', '));

        this._save(tf, version);
        return true;
    }

    predict(features, timeframe, version) {
        var tf = timeframe || 'dayTrade';
        var m = this._getModel(tf, version);
        if (!m || !m.trained || !m.weights) return null;

        var f = features ? features.slice() : null;
        if (!f) return null;
        while (f.length < this.featureCount) f.push(0);
        f = f.slice(0, this.featureCount);

        var x = m.featureStats ? this._normalize(f, m.featureStats) : f;
        var z = m.bias;
        for (var i = 0; i < this.featureCount; i++) {
            z += m.weights[i] * (x[i] || 0);
        }
        return +this._sigmoid(z).toFixed(4);
    }

    // Ensemble: blend rule-based and ML confidence using the right TF model
    ensemble(ruleBasedConfidence, features, timeframe, version) {
        var tf = timeframe || 'dayTrade';
        var m = this._getModel(tf, version);
        var mlPred = this.predict(features, tf, version);

        if (mlPred === null) {
            return { confidence: ruleBasedConfidence, source: 'rule_based', mlWeight: 0, timeframe: tf };
        }

        var mlWeight = Math.min(0.6, (m.trainingSamples / ML_RAMP_FULL) * 0.6);
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
            modelAccuracy: m.accuracy,
            trainingSamples: m.trainingSamples
        };
    }

    getSuggestedWeights(timeframe) {
        var tf = timeframe || 'dayTrade';
        var m = this.models[tf];
        if (!m || !m.trained || !m.featureImportance.length) return null;

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
