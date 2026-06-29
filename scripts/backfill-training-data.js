// Backfill ML training data from 5 years of Polygon daily bars
// Computes all 44 features at each bar + ATR-relative labels
// Run: node scripts/backfill-training-data.js
require('dotenv').config();
var fs = require('fs');
var path = require('path');

var POLYGON_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_KEY) { console.error('Missing POLYGON_API_KEY in .env'); process.exit(1); }

var TICKERS = [
    'AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','AMD','NFLX','AVGO',
    'CRM','ORCL','ADBE','INTC','MU','APP','JPM','GS','BAC','V',
    'MA','UNH','LLY','JNJ','PFE','XOM','CVX','HD','MCD','NKE',
    'BA','CAT','GE','DIS','PG','KO','WMT','COST','NEE','LIN',
    'MSTR','COIN','NBIS','TSLA','SPY','QQQ','IWM','DIA'
];
// Deduplicate
TICKERS = TICKERS.filter(function(t, i) { return TICKERS.indexOf(t) === i; });

var OUTPUT_PATH = path.join(__dirname, '..', 'data', 'ml-training-backfill.json');
var BASE_URL = 'https://api.polygon.io';

// Simple HTTP fetch
var https = require('https');
function fetchJSON(url) {
    return new Promise(function(resolve, reject) {
        https.get(url, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// Fetch daily bars for a ticker
async function fetchBars(ticker, from, to) {
    var url = BASE_URL + '/v2/aggs/ticker/' + ticker + '/range/1/day/' + from + '/' + to + '?adjusted=true&sort=asc&limit=50000&apiKey=' + POLYGON_KEY;
    var resp = await fetchJSON(url);
    return (resp && resp.results) || [];
}

// Compute RSI from closes
function computeRSI(closes, period) {
    if (closes.length < period + 1) return 50;
    var gains = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
        var diff = closes[i] - closes[i-1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    var avgGain = gains / period;
    var avgLoss = losses / period;
    for (var j = period + 1; j < closes.length; j++) {
        var d = closes[j] - closes[j-1];
        avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    var rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Compute EMA
function computeEMA(values, period) {
    var k = 2 / (period + 1);
    var ema = values[0];
    for (var i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

// Compute SMA
function computeSMA(values, period) {
    if (values.length < period) return 0;
    var sum = 0;
    for (var i = values.length - period; i < values.length; i++) sum += values[i];
    return sum / period;
}

// Compute ATR
function computeATR(bars, period) {
    if (bars.length < period + 1) return 0;
    var trs = [];
    for (var i = 1; i < bars.length; i++) {
        var h = bars[i].h, l = bars[i].l, pc = bars[i-1].c;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    // Wilder's smoothing
    var atr = 0;
    for (var j = 0; j < period && j < trs.length; j++) atr += trs[j];
    atr /= period;
    for (var k2 = period; k2 < trs.length; k2++) {
        atr = (atr * (period - 1) + trs[k2]) / period;
    }
    return atr;
}

// Compute Bollinger Band position
function computeBBPosition(closes, period) {
    if (closes.length < period) return 0.5;
    var sma = computeSMA(closes, period);
    var variance = 0;
    for (var i = closes.length - period; i < closes.length; i++) {
        variance += (closes[i] - sma) * (closes[i] - sma);
    }
    var std = Math.sqrt(variance / period);
    var upper = sma + 2 * std;
    var lower = sma - 2 * std;
    if (upper === lower) return 0.5;
    return (closes[closes.length - 1] - lower) / (upper - lower);
}

// Compute MACD histogram
function computeMACDHist(closes) {
    if (closes.length < 26) return 0;
    var ema12 = closes[0], ema26 = closes[0], signal = 0;
    var k12 = 2/13, k26 = 2/27, k9 = 2/10;
    for (var i = 1; i < closes.length; i++) {
        ema12 = closes[i] * k12 + ema12 * (1 - k12);
        ema26 = closes[i] * k26 + ema26 * (1 - k26);
    }
    var macd = ema12 - ema26;
    // Approximate signal line
    signal = macd * 0.8; // rough approximation for single-pass
    return macd - signal;
}

// Build features at a specific bar position
function buildFeatures(bars, idx, ticker) {
    var lookback = Math.min(idx + 1, 50); // max 50 bars lookback
    var slice = bars.slice(idx - lookback + 1, idx + 1);
    var closes = slice.map(function(b) { return b.c; });
    
    // Core technicals
    var rsi = computeRSI(closes, 14);
    var macdHist = computeMACDHist(closes);
    
    // EMA alignment
    var ema9 = computeEMA(closes, 9);
    var ema21 = computeEMA(closes, 21);
    var emaAlign = ema9 > ema21 * 1.001 ? 1 : ema9 < ema21 * 0.999 ? -1 : 0;
    
    var bbPos = computeBBPosition(closes, 20);
    var atr = computeATR(slice, 14);
    
    // Slots 5-11: flow/options features (not available historically)
    var cpRatio = 1, dpDir = 0, ivRank = 50, siPct = 0, volSpike = 0, bbBandwidth = 0.05, vwapDev = 0;
    
    // Feature 12: 5-bar return %
    var fiveBarReturn = 0;
    if (closes.length >= 6) {
        fiveBarReturn = (closes[closes.length-1] - closes[closes.length-6]) / closes[closes.length-6] * 100;
    }
    
    // Feature 13: 20-bar MA slope
    var maSlope = 0;
    if (closes.length >= 25) {
        var sma20Now = computeSMA(closes, 20);
        var prevCloses = closes.slice(0, closes.length - 5);
        var sma20Prev = computeSMA(prevCloses, 20);
        if (sma20Prev > 0) maSlope = (sma20Now - sma20Prev) / sma20Prev * 100;
    }
    
    // Feature 14: Price vs 20-bar MA %
    var priceVsMa = 0;
    if (closes.length >= 20) {
        var sma20 = computeSMA(closes, 20);
        if (sma20 > 0) priceVsMa = (closes[closes.length-1] - sma20) / sma20 * 100;
    }
    
    // Feature 15: Gap from prev close %
    var gapPct = 0;
    if (idx >= 1) {
        var todayOpen = bars[idx].o;
        var yesterClose = bars[idx-1].c;
        if (yesterClose > 0) gapPct = (todayOpen - yesterClose) / yesterClose * 100;
    }
    
    // Feature 16: 10-bar realized volatility
    var realizedVolFeat = 0;
    if (closes.length >= 11) {
        var rets = [];
        for (var ri = closes.length - 10; ri < closes.length; ri++) {
            if (closes[ri-1] > 0) rets.push((closes[ri] - closes[ri-1]) / closes[ri-1]);
        }
        if (rets.length >= 5) {
            var meanR = rets.reduce(function(s,r){return s+r;}, 0) / rets.length;
            var variance = rets.reduce(function(s,r){return s + (r-meanR)*(r-meanR);}, 0) / rets.length;
            realizedVolFeat = Math.sqrt(variance) * Math.sqrt(252) * 100;
        }
    }
    
    // Feature 17: ADX approximation
    var adxVal = 20; // simplified default
    
    // Slots 18-43: set to 0 (UW/flow features not available historically)
    var features = [
        rsi, macdHist, emaAlign, bbPos, atr,
        cpRatio, dpDir, ivRank, siPct, volSpike, bbBandwidth, vwapDev,
        fiveBarReturn, maSlope, priceVsMa, gapPct, realizedVolFeat,
        adxVal, 0, 0.5, 0, 0, 0, 0, 0,  // slots 18-24
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0,   // slots 25-34
        0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0 // slots 35-43 (44th = sectorVol)
    ];
    
    // Ensure exactly 44
    while (features.length < 44) features.push(0);
    features = features.slice(0, 44);
    
    return features;
}

// Compute ATR-relative label
function computeLabel(bars, idx, forwardDays) {
    if (idx + forwardDays >= bars.length) return -1; // can't label, skip
    
    var currentClose = bars[idx].c;
    var atr = computeATR(bars.slice(Math.max(0, idx - 20), idx + 1), 14);
    if (atr <= 0) return -1;
    
    var threshold = 0.5 * atr;
    var maxUp = 0, maxDown = 0;
    
    for (var i = 1; i <= forwardDays && idx + i < bars.length; i++) {
        var hi = bars[idx + i].h;
        var lo = bars[idx + i].l;
        var upMove = hi - currentClose;
        var downMove = currentClose - lo;
        if (upMove > maxUp) maxUp = upMove;
        if (downMove > maxDown) maxDown = downMove;
    }
    
    if (maxUp >= threshold && maxUp > maxDown) return 1;  // bullish WIN
    if (maxDown >= threshold && maxDown > maxUp) return 0; // bearish (bullish LOSS)
    return -1; // no clear signal, skip
}

// Main
async function main() {
    console.log('=== ML Training Data Backfill ===');
    console.log('Tickers:', TICKERS.length);
    console.log('Period: 5 years');
    console.log('');
    
    var allSamples = [];
    var errors = 0;
    
    var fromDate = '2021-06-01';
    var toDate = '2026-06-26';
    
    for (var ti = 0; ti < TICKERS.length; ti++) {
        var ticker = TICKERS[ti];
        process.stdout.write('[' + (ti+1) + '/' + TICKERS.length + '] ' + ticker + '... ');
        
        try {
            var bars = await fetchBars(ticker, fromDate, toDate);
            if (bars.length < 50) {
                console.log('skipped (only ' + bars.length + ' bars)');
                continue;
            }
            
            var tickerSamples = 0;
            for (var i = 30; i < bars.length - 5; i++) {
                var label = computeLabel(bars, i, 5);
                if (label === -1) continue; // skip ambiguous
                
                var features = buildFeatures(bars, i, ticker);
                var date = new Date(bars[i].t).toISOString().substring(0, 10);
                
                allSamples.push({
                    features: features,
                    label: label,
                    ticker: ticker,
                    date: date,
                    _source: 'polygon-backfill'
                });
                tickerSamples++;
            }
            
            console.log(bars.length + ' bars → ' + tickerSamples + ' samples');
            await sleep(300); // respect rate limits
            
        } catch (e) {
            console.log('ERROR: ' + e.message);
            errors++;
        }
    }
    
    console.log('');
    console.log('=== Results ===');
    console.log('Total samples: ' + allSamples.length);
    console.log('Label distribution: WIN=' + allSamples.filter(function(s){return s.label===1;}).length +
        ' LOSS=' + allSamples.filter(function(s){return s.label===0;}).length);
    console.log('Errors: ' + errors);
    
    // Write output
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allSamples));
    console.log('Written to: ' + OUTPUT_PATH);
    console.log('File size: ' + (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1) + ' MB');
}

main().catch(function(e) { console.error('Fatal:', e); process.exit(1); });
