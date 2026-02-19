// Polygon Historical Data Pipeline for ML Training
// Uses Polygon.io REST API to fetch up to 15 years of historical data
// and generate feature-rich training datasets for signal calibration.

const https = require('https');
const fs = require('fs');
const path = require('path');

class PolygonHistorical {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.polygon.io';
        this.dataDir = path.join(__dirname, '../data/ml-training');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        this.rateLimitMs = 250; // 4 requests per second (Developer plan)
    }

    _restGet(urlPath) {
        var self = this;
        var separator = urlPath.includes('?') ? '&' : '?';
        var url = this.baseUrl + urlPath + separator + 'apiKey=' + this.apiKey;

        return new Promise(function (resolve, reject) {
            https.get(url, function (res) {
                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('JSON parse error')); }
                });
            }).on('error', function (e) { reject(e); });
        });
    }

    _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // ── Fetch Historical Aggregates (up to 5000 bars per call) ──
    async fetchAggregates(ticker, multiplier, timespan, fromDate, toDate) {
        try {
            var result = await this._restGet(
                '/v2/aggs/ticker/' + ticker.toUpperCase() +
                '/range/' + multiplier + '/' + timespan + '/' + fromDate + '/' + toDate +
                '?adjusted=true&sort=asc&limit=5000'
            );
            if (result && result.results) {
                return result.results.map(function (r) {
                    return {
                        open: r.o,
                        high: r.h,
                        low: r.l,
                        close: r.c,
                        volume: r.v,
                        vwap: r.vw || 0,
                        trades: r.n || 0,
                        timestamp: r.t,
                        date: new Date(r.t).toISOString().split('T')[0]
                    };
                });
            }
            return [];
        } catch (e) {
            console.error('Polygon historical fetch error for ' + ticker + ':', e.message);
            return [];
        }
    }

    // ── Generate ML Training Features from Historical Data ──
    async generateTrainingData(ticker, years) {
        years = years || 5;
        console.log('📊 Generating ML training data for ' + ticker + ' (' + years + ' years)...');

        var toDate = new Date().toISOString().split('T')[0];
        var fromDate = new Date();
        fromDate.setFullYear(fromDate.getFullYear() - years);
        fromDate = fromDate.toISOString().split('T')[0];

        // Fetch daily candles
        var dailyCandles = await this.fetchAggregates(ticker, 1, 'day', fromDate, toDate);
        await this._sleep(this.rateLimitMs);

        if (dailyCandles.length < 100) {
            console.log('⚠️ Insufficient data for ' + ticker + ' (' + dailyCandles.length + ' candles)');
            return null;
        }

        console.log('  📈 ' + ticker + ': ' + dailyCandles.length + ' daily candles fetched');

        // Calculate features for each day
        var features = [];
        for (var i = 50; i < dailyCandles.length - 5; i++) {
            var candle = dailyCandles[i];
            var prev = dailyCandles[i - 1];
            var window20 = dailyCandles.slice(i - 20, i);
            var window50 = dailyCandles.slice(i - 50, i);
            var future5 = dailyCandles.slice(i + 1, i + 6);

            // Feature: returns
            var dailyReturn = (candle.close - prev.close) / prev.close;
            var gapPct = (candle.open - prev.close) / prev.close;

            // Feature: volume stats
            var avgVol20 = window20.reduce(function (s, c) { return s + c.volume; }, 0) / 20;
            var relativeVolume = candle.volume / (avgVol20 || 1);

            // Feature: price vs moving averages
            var sma20 = window20.reduce(function (s, c) { return s + c.close; }, 0) / 20;
            var sma50 = window50.reduce(function (s, c) { return s + c.close; }, 0) / 50;
            var priceVsSma20 = (candle.close - sma20) / sma20;
            var priceVsSma50 = (candle.close - sma50) / sma50;

            // Feature: volatility (20-day)
            var returns20 = [];
            for (var j = 1; j < window20.length; j++) {
                returns20.push((window20[j].close - window20[j - 1].close) / window20[j - 1].close);
            }
            var meanReturn = returns20.reduce(function (s, r) { return s + r; }, 0) / returns20.length;
            var variance = returns20.reduce(function (s, r) { return s + Math.pow(r - meanReturn, 2); }, 0) / returns20.length;
            var volatility20 = Math.sqrt(variance) * Math.sqrt(252); // annualized

            // Feature: RSI (14-day)
            var gains = 0, losses = 0;
            for (var k = i - 14; k < i; k++) {
                var change = dailyCandles[k].close - dailyCandles[k - 1].close;
                if (change > 0) gains += change;
                else losses += Math.abs(change);
            }
            var avgGain = gains / 14;
            var avgLoss = losses / 14;
            var rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

            // Feature: intraday range
            var intradayRange = (candle.high - candle.low) / candle.open;

            // Feature: candle body ratio (close vs open relative to range)
            var range = candle.high - candle.low;
            var bodyRatio = range > 0 ? (candle.close - candle.open) / range : 0;

            // Feature: VWAP deviation
            var vwapDev = candle.vwap > 0 ? (candle.close - candle.vwap) / candle.vwap : 0;

            // Label: next 5-day return (what we're predicting)
            var future5Close = future5.length === 5 ? future5[4].close : null;
            if (future5Close === null) continue;
            var next5Return = (future5Close - candle.close) / candle.close;
            var label = next5Return > 0.02 ? 'BULLISH' : next5Return < -0.02 ? 'BEARISH' : 'NEUTRAL';

            features.push({
                ticker: ticker,
                date: candle.date,
                price: candle.close,
                // Raw features
                dailyReturn: +dailyReturn.toFixed(6),
                gapPct: +gapPct.toFixed(6),
                relativeVolume: +relativeVolume.toFixed(4),
                priceVsSma20: +priceVsSma20.toFixed(6),
                priceVsSma50: +priceVsSma50.toFixed(6),
                volatility20: +volatility20.toFixed(6),
                rsi: +rsi.toFixed(2),
                intradayRange: +intradayRange.toFixed(6),
                bodyRatio: +bodyRatio.toFixed(4),
                vwapDev: +vwapDev.toFixed(6),
                volume: candle.volume,
                // Labels
                next5Return: +next5Return.toFixed(6),
                label: label
            });
        }

        console.log('  📊 ' + ticker + ': ' + features.length + ' training samples generated');
        return features;
    }

    // ── Generate Training Dataset for Multiple Tickers ──────
    async generateBatchTrainingData(tickers, years) {
        years = years || 5;
        var allFeatures = [];

        for (var i = 0; i < tickers.length; i++) {
            var ticker = tickers[i].toUpperCase();
            try {
                var features = await this.generateTrainingData(ticker, years);
                if (features && features.length > 0) {
                    allFeatures = allFeatures.concat(features);
                }
                await this._sleep(this.rateLimitMs * 2); // extra delay between tickers
            } catch (e) {
                console.error('Error generating data for ' + ticker + ':', e.message);
            }
        }

        // Save to file
        var filename = 'training_' + new Date().toISOString().split('T')[0] + '_' + tickers.length + 'tickers.json';
        var filepath = path.join(this.dataDir, filename);
        fs.writeFileSync(filepath, JSON.stringify(allFeatures, null, 2));
        console.log('\n📊 ML Training data saved: ' + filepath + ' (' + allFeatures.length + ' samples)');

        // Also generate CSV for easy import to other tools
        var csvFile = filepath.replace('.json', '.csv');
        var headers = Object.keys(allFeatures[0] || {}).join(',');
        var csvRows = allFeatures.map(function (f) {
            return Object.values(f).join(',');
        });
        fs.writeFileSync(csvFile, headers + '\n' + csvRows.join('\n'));
        console.log('📊 CSV exported: ' + csvFile);

        return {
            totalSamples: allFeatures.length,
            tickers: tickers.length,
            filepath: filepath,
            csvPath: csvFile,
            bullish: allFeatures.filter(function (f) { return f.label === 'BULLISH'; }).length,
            bearish: allFeatures.filter(function (f) { return f.label === 'BEARISH'; }).length,
            neutral: allFeatures.filter(function (f) { return f.label === 'NEUTRAL'; }).length
        };
    }

    // ── Quick Stats on Available Data ──────────────────────
    async checkDataAvailability(ticker) {
        try {
            var result = await this._restGet('/v3/reference/tickers/' + ticker.toUpperCase());
            if (result && result.results) {
                return {
                    ticker: result.results.ticker,
                    name: result.results.name,
                    listDate: result.results.list_date,
                    type: result.results.type,
                    exchange: result.results.primary_exchange,
                    yearsAvailable: result.results.list_date ?
                        Math.round((Date.now() - new Date(result.results.list_date).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null
                };
            }
            return null;
        } catch (e) { return null; }
    }

    // ── Convert Polygon features to ML calibrator's 25-feature format ──
    // Maps our historical features into the signal engine's feature vector slots
    // MLCalibrator expects: [RSI, MACD_Hist, EMA_Align, BB_Position, ATR, CP_Ratio,
    //   DP_Direction, IV_Rank, Short_Interest, Vol_Spike, BB_Bandwidth, VWAP_Dev,
    //   Regime, Gamma_Prox, IV_Skew, Candle_Score, Sentiment, ADX, RSI_Divergence,
    //   Fib_Proximity, RSI_Slope, MACD_Accel, ATR_Change, RSI_x_EMA, Vol_x_MACD]
    convertToMLFormat(rawFeatures) {
        if (!rawFeatures || rawFeatures.length === 0) return [];

        // Filter out NEUTRAL labels — only train on clear bullish/bearish outcomes
        var trainingData = [];
        for (var i = 0; i < rawFeatures.length; i++) {
            var f = rawFeatures[i];
            if (f.label === 'NEUTRAL') continue;

            // Map Polygon features into the 25-slot vector
            var features = new Array(25).fill(0);

            // Slot 0: RSI (0-100)
            features[0] = f.rsi || 50;

            // Slot 1: MACD_Hist — approximate from momentum (dailyReturn * 1000)
            features[1] = (f.dailyReturn || 0) * 1000;

            // Slot 2: EMA_Align — use priceVsSma20 as EMA alignment proxy
            features[2] = (f.priceVsSma20 || 0) * 100;

            // Slot 3: BB_Position — use priceVsSma20 relative to volatility
            var vol = f.volatility20 || 0.2;
            features[3] = vol > 0 ? ((f.priceVsSma20 || 0) / (vol / Math.sqrt(252))) * 50 + 50 : 50;

            // Slot 4: ATR — use intradayRange as ATR proxy (already 0-1 range)
            features[4] = (f.intradayRange || 0) * 100;

            // Slot 5: CP_Ratio — not available from historical, leave 0
            // Slot 6: DP_Direction — not available, leave 0
            // Slot 7: IV_Rank — not available, leave 0
            // Slot 8: Short_Interest — not available, leave 0

            // Slot 9: Vol_Spike — relative volume (1.0 = normal)
            features[9] = Math.min(5, f.relativeVolume || 1);

            // Slot 10: BB_Bandwidth — use volatility as proxy
            features[10] = (f.volatility20 || 0.2) * 100;

            // Slot 11: VWAP_Dev
            features[11] = (f.vwapDev || 0) * 100;

            // Slot 12: Regime — derive from SMA50 trend
            features[12] = f.priceVsSma50 > 0.02 ? 1 : f.priceVsSma50 < -0.02 ? -1 : 0;

            // Slot 13: Gamma_Prox — not available, leave 0
            // Slot 14: IV_Skew — not available, leave 0

            // Slot 15: Candle_Score — bodyRatio (-1 to 1)
            features[15] = (f.bodyRatio || 0) * 100;

            // Slot 16: Sentiment — not available, leave 0

            // Slot 17: ADX — approximate from volatility + trend strength
            var trendStrength = Math.abs(f.priceVsSma20 || 0) + Math.abs(f.priceVsSma50 || 0);
            features[17] = Math.min(100, trendStrength * 200);

            // Slot 18: RSI_Divergence — RSI vs price trend divergence
            var rsiNorm = ((f.rsi || 50) - 50) / 50; // -1 to 1
            var priceTrend = f.priceVsSma20 || 0;
            features[18] = (rsiNorm - priceTrend * 10) * 50;

            // Slot 19: Fib_Proximity — not available, leave 0

            // Slot 20: RSI_Slope — would need multiple RSI values, approximate from return
            features[20] = (f.dailyReturn || 0) * 500;

            // Slot 21: MACD_Accel — use gap as momentum acceleration proxy
            features[21] = (f.gapPct || 0) * 100;

            // Slot 22: ATR_Change — not available for single point, leave 0

            // Slot 23: RSI_x_EMA — interaction feature
            features[23] = rsiNorm * (f.priceVsSma20 || 0) * 100;

            // Slot 24: Vol_x_MACD — interaction feature
            features[24] = (f.relativeVolume || 1) * (f.dailyReturn || 0) * 100;

            trainingData.push({
                features: features,
                label: f.label === 'BULLISH' ? 1 : 0,
                confidence: f.label === 'BULLISH' ? 70 : 30,
                pnlPct: (f.next5Return || 0) * 100
            });
        }

        return trainingData;
    }

    // ── One-Stop: Generate historical data and convert to ML format ──
    async generateAndConvert(tickers, years) {
        years = years || 5;
        var allRaw = [];

        for (var i = 0; i < tickers.length; i++) {
            var ticker = tickers[i].toUpperCase();
            try {
                var raw = await this.generateTrainingData(ticker, years);
                if (raw && raw.length > 0) {
                    allRaw = allRaw.concat(raw);
                }
                await this._sleep(this.rateLimitMs * 2);
            } catch (e) {
                console.error('Error generating for ' + ticker + ':', e.message);
            }
        }

        var mlData = this.convertToMLFormat(allRaw);
        console.log('📊 ML conversion: ' + allRaw.length + ' raw samples → ' + mlData.length + ' ML training samples (NEUTRAL filtered out)');

        return {
            rawSamples: allRaw.length,
            mlSamples: mlData.length,
            bullish: mlData.filter(function (d) { return d.label === 1; }).length,
            bearish: mlData.filter(function (d) { return d.label === 0; }).length,
            data: mlData
        };
    }
}

module.exports = PolygonHistorical;
