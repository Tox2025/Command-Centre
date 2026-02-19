// Technical Analysis Module
// Pure JS implementation — no external TA library needed

class TechnicalAnalysis {

    // ── EMA ─────────────────────────────────────────────────
    static ema(data, period) {
        if (data.length < period) return [];
        const k = 2 / (period + 1);
        const result = [];
        // SMA for first value
        let sum = 0;
        for (let i = 0; i < period; i++) sum += data[i];
        result.push(sum / period);
        for (let i = period; i < data.length; i++) {
            result.push(data[i] * k + result[result.length - 1] * (1 - k));
        }
        return result;
    }

    // ── SMA ─────────────────────────────────────────────────
    static sma(data, period) {
        if (data.length < period) return [];
        const result = [];
        for (let i = period - 1; i < data.length; i++) {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) sum += data[j];
            result.push(sum / period);
        }
        return result;
    }

    // ── RSI ─────────────────────────────────────────────────
    static rsi(closes, period = 14) {
        if (closes.length < period + 1) return [];

        const changes = [];
        for (let i = 1; i < closes.length; i++) {
            changes.push(closes[i] - closes[i - 1]);
        }

        let avgGain = 0, avgLoss = 0;
        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain += changes[i];
            else avgLoss += Math.abs(changes[i]);
        }
        avgGain /= period;
        avgLoss /= period;

        const result = [];
        if (avgLoss === 0) result.push(100);
        else {
            const rs = avgGain / avgLoss;
            result.push(100 - 100 / (1 + rs));
        }

        for (let i = period; i < changes.length; i++) {
            const gain = changes[i] > 0 ? changes[i] : 0;
            const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            if (avgLoss === 0) result.push(100);
            else {
                const rs = avgGain / avgLoss;
                result.push(100 - 100 / (1 + rs));
            }
        }
        return result;
    }

    // ── MACD ────────────────────────────────────────────────
    static macd(closes, fast = 12, slow = 26, signal = 9) {
        const emaFast = this.ema(closes, fast);
        const emaSlow = this.ema(closes, slow);

        if (emaFast.length === 0 || emaSlow.length === 0) return { macd: [], signal: [], histogram: [] };

        // Align lengths — slow EMA is shorter
        const offset = fast < slow ? slow - fast : 0;
        const macdLine = [];
        for (let i = 0; i < emaSlow.length; i++) {
            macdLine.push(emaFast[i + offset] - emaSlow[i]);
        }

        const signalLine = this.ema(macdLine, signal);
        const histogram = [];
        const sigOffset = macdLine.length - signalLine.length;
        for (let i = 0; i < signalLine.length; i++) {
            histogram.push(macdLine[i + sigOffset] - signalLine[i]);
        }

        return { macd: macdLine, signal: signalLine, histogram };
    }

    // ── VWAP (requires high, low, close, volume) ────────────
    static vwap(highs, lows, closes, volumes) {
        const result = [];
        let cumTPV = 0, cumVol = 0;
        for (let i = 0; i < closes.length; i++) {
            const tp = (highs[i] + lows[i] + closes[i]) / 3;
            cumTPV += tp * volumes[i];
            cumVol += volumes[i];
            result.push(cumVol > 0 ? cumTPV / cumVol : tp);
        }
        return result;
    }

    // ── True ATR (Average True Range) ───────────────────────
    static atr(highs, lows, closes, period = 14) {
        if (closes.length < period + 1) return { values: [], current: null };
        const trueRanges = [];
        for (let i = 1; i < closes.length; i++) {
            const hl = highs[i] - lows[i];
            const hpc = Math.abs(highs[i] - closes[i - 1]);
            const lpc = Math.abs(lows[i] - closes[i - 1]);
            trueRanges.push(Math.max(hl, hpc, lpc));
        }
        // SMA for first ATR value
        let sum = 0;
        for (let i = 0; i < period; i++) sum += trueRanges[i];
        const atrValues = [sum / period];
        // Smoothed ATR (Wilder's method)
        for (let i = period; i < trueRanges.length; i++) {
            atrValues.push((atrValues[atrValues.length - 1] * (period - 1) + trueRanges[i]) / period);
        }
        return {
            values: atrValues,
            current: atrValues.length > 0 ? +atrValues[atrValues.length - 1].toFixed(4) : null
        };
    }

    // ── Bollinger Bands ─────────────────────────────────────
    static bollingerBands(closes, period = 20, stdMult = 2) {
        if (closes.length < period) return { upper: null, lower: null, middle: null, position: null, bandwidth: null };
        let sum = 0;
        for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
        const middle = sum / period;
        let sqSum = 0;
        for (let i = closes.length - period; i < closes.length; i++) sqSum += Math.pow(closes[i] - middle, 2);
        const std = Math.sqrt(sqSum / period);
        const upper = middle + stdMult * std;
        const lower = middle - stdMult * std;
        const lastClose = closes[closes.length - 1];
        // Position: 0 = at lower band, 0.5 = at middle, 1 = at upper band
        const position = upper !== lower ? (lastClose - lower) / (upper - lower) : 0.5;
        const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
        return {
            upper: +upper.toFixed(2),
            lower: +lower.toFixed(2),
            middle: +middle.toFixed(2),
            position: +position.toFixed(3),
            bandwidth: +bandwidth.toFixed(2)
        };
    }

    // ── Volume Spike Detection ──────────────────────────────
    static volumeSpikes(volumes, lookback = 20, threshold = 2.0) {
        const spikes = [];
        for (let i = lookback; i < volumes.length; i++) {
            let sum = 0;
            for (let j = i - lookback; j < i; j++) sum += volumes[j];
            const avg = sum / lookback;
            if (volumes[i] > avg * threshold) {
                spikes.push({ index: i, volume: volumes[i], avg, ratio: volumes[i] / avg });
            }
        }
        return spikes;
    }

    // ── Support & Resistance (Pivot Points) ─────────────────
    static pivotPoints(high, low, close) {
        const pp = (high + low + close) / 3;
        return {
            pp: +pp.toFixed(2),
            r1: +(2 * pp - low).toFixed(2),
            r2: +(pp + (high - low)).toFixed(2),
            r3: +(high + 2 * (pp - low)).toFixed(2),
            s1: +(2 * pp - high).toFixed(2),
            s2: +(pp - (high - low)).toFixed(2),
            s3: +(low - 2 * (high - pp)).toFixed(2)
        };
    }

    // ── Gap Detection ───────────────────────────────────────
    static detectGaps(candles, minGapPct = 0.5) {
        const gaps = [];
        for (let i = 1; i < candles.length; i++) {
            const prevClose = candles[i - 1].close;
            const currOpen = candles[i].open;
            const gapPct = ((currOpen - prevClose) / prevClose) * 100;

            if (Math.abs(gapPct) >= minGapPct) {
                gaps.push({
                    index: i,
                    date: candles[i].date || candles[i].timestamp,
                    type: gapPct > 0 ? 'GAP_UP' : 'GAP_DOWN',
                    pct: +gapPct.toFixed(2),
                    prevClose,
                    open: currOpen
                });
            }
        }
        return gaps;
    }

    // ── Candlestick Pattern Detection ────────────────────────
    static detectCandlePatterns(candles) {
        if (!candles || candles.length < 3) return [];
        var patterns = [];
        var n = candles.length;
        var c = candles[n - 1]; // current
        var p = candles[n - 2]; // previous
        var pp = n >= 3 ? candles[n - 3] : null; // 2 back

        var body = Math.abs(c.close - c.open);
        var range = c.high - c.low;
        var upperWick = c.high - Math.max(c.open, c.close);
        var lowerWick = Math.min(c.open, c.close) - c.low;
        var pBody = Math.abs(p.close - p.open);
        var pRange = p.high - p.low;

        // Doji: very small body relative to range
        if (range > 0 && body / range < 0.1) {
            patterns.push({ name: 'Doji', direction: 'NEUTRAL', strength: 0.5 });
        }

        // Hammer: small body at top, long lower wick (bullish reversal)
        if (range > 0 && lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open) {
            patterns.push({ name: 'Hammer', direction: 'BULL', strength: 0.8 });
        }

        // Shooting Star: small body at bottom, long upper wick (bearish reversal)
        if (range > 0 && upperWick > body * 2 && lowerWick < body * 0.5 && c.close < c.open) {
            patterns.push({ name: 'Shooting Star', direction: 'BEAR', strength: 0.8 });
        }

        // Bullish Engulfing: current green candle engulfs previous red
        if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open) {
            patterns.push({ name: 'Bullish Engulfing', direction: 'BULL', strength: 1.0 });
        }

        // Bearish Engulfing: current red candle engulfs previous green
        if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open) {
            patterns.push({ name: 'Bearish Engulfing', direction: 'BEAR', strength: 1.0 });
        }

        // Morning Star (3-candle bullish reversal)
        if (pp && pp.close < pp.open && pBody / pRange < 0.3 && c.close > c.open && c.close > (pp.open + pp.close) / 2) {
            patterns.push({ name: 'Morning Star', direction: 'BULL', strength: 1.0 });
        }

        // Evening Star (3-candle bearish reversal)
        if (pp && pp.close > pp.open && pBody / pRange < 0.3 && c.close < c.open && c.close < (pp.open + pp.close) / 2) {
            patterns.push({ name: 'Evening Star', direction: 'BEAR', strength: 1.0 });
        }

        return patterns;
    }

    // ── ADX (Average Directional Index) — Trend Strength ────
    static adx(highs, lows, closes, period = 14) {
        if (closes.length < period * 2 + 1) return { adx: null, plusDI: null, minusDI: null, trendStrength: 'UNKNOWN' };

        // Step 1: +DM / -DM
        var plusDM = [], minusDM = [], trueRanges = [];
        for (var i = 1; i < closes.length; i++) {
            var upMove = highs[i] - highs[i - 1];
            var downMove = lows[i - 1] - lows[i];
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
            var hl = highs[i] - lows[i];
            var hpc = Math.abs(highs[i] - closes[i - 1]);
            var lpc = Math.abs(lows[i] - closes[i - 1]);
            trueRanges.push(Math.max(hl, hpc, lpc));
        }

        // Step 2: Smoothed +DM, -DM, and TR (Wilder's smoothing)
        var smoothPlusDM = 0, smoothMinusDM = 0, smoothTR = 0;
        for (var j = 0; j < period; j++) {
            smoothPlusDM += plusDM[j];
            smoothMinusDM += minusDM[j];
            smoothTR += trueRanges[j];
        }

        var plusDIArr = [], minusDIArr = [], dxArr = [];
        for (var k = period; k < plusDM.length; k++) {
            if (k === period) {
                // First smoothed value is the sum
            } else {
                smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[k];
                smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[k];
                smoothTR = smoothTR - (smoothTR / period) + trueRanges[k];
            }

            var pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
            var mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
            plusDIArr.push(pdi);
            minusDIArr.push(mdi);

            var diSum = pdi + mdi;
            var dx = diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0;
            dxArr.push(dx);
        }

        // Step 3: ADX = smoothed DX
        if (dxArr.length < period) return { adx: null, plusDI: null, minusDI: null, trendStrength: 'UNKNOWN' };

        var adxVal = 0;
        for (var m = 0; m < period; m++) adxVal += dxArr[m];
        adxVal /= period;
        for (var n = period; n < dxArr.length; n++) {
            adxVal = (adxVal * (period - 1) + dxArr[n]) / period;
        }

        var lastPlusDI = plusDIArr[plusDIArr.length - 1];
        var lastMinusDI = minusDIArr[minusDIArr.length - 1];

        var trendStrength = 'NO_TREND';
        if (adxVal >= 30) trendStrength = 'STRONG_TREND';
        else if (adxVal >= 20) trendStrength = 'WEAK_TREND';

        return {
            adx: +adxVal.toFixed(2),
            plusDI: +lastPlusDI.toFixed(2),
            minusDI: +lastMinusDI.toFixed(2),
            trendStrength: trendStrength,
            trendDirection: lastPlusDI > lastMinusDI ? 'BULLISH' : 'BEARISH'
        };
    }

    // ── Swing Point Detection ────────────────────────────────
    static findSwingPoints(highs, lows, lookback = 5) {
        if (!highs || highs.length < lookback * 2 + 1) return { swingHigh: null, swingLow: null, shIndex: -1, slIndex: -1 };

        var swingHigh = null, swingLow = null, shIndex = -1, slIndex = -1;

        // Scan from recent to old, find the most recent swing high and swing low
        for (var i = highs.length - 1 - lookback; i >= lookback; i--) {
            // Swing high: higher than `lookback` bars on both sides
            if (swingHigh === null) {
                var isSwingHigh = true;
                for (var j = 1; j <= lookback; j++) {
                    if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) {
                        isSwingHigh = false;
                        break;
                    }
                }
                if (isSwingHigh) {
                    swingHigh = highs[i];
                    shIndex = i;
                }
            }

            // Swing low: lower than `lookback` bars on both sides
            if (swingLow === null) {
                var isSwingLow = true;
                for (var jj = 1; jj <= lookback; jj++) {
                    if (lows[i] >= lows[i - jj] || lows[i] >= lows[i + jj]) {
                        isSwingLow = false;
                        break;
                    }
                }
                if (isSwingLow) {
                    swingLow = lows[i];
                    slIndex = i;
                }
            }

            if (swingHigh !== null && swingLow !== null) break;
        }

        return {
            swingHigh: swingHigh,
            swingLow: swingLow,
            shIndex: shIndex,
            slIndex: slIndex
        };
    }

    // ── RSI Divergence Detection ─────────────────────────────
    static rsiDivergence(closes, rsiValues, lookback = 20) {
        var divergences = [];
        if (!closes || !rsiValues || closes.length < lookback || rsiValues.length < lookback) return divergences;

        // We need at least 2 swing points (peaks or troughs) to detect divergence
        var len = Math.min(closes.length, rsiValues.length);
        // Align RSI to closes (RSI array may be shorter due to warmup)
        var rsiOffset = closes.length - rsiValues.length;

        // Find recent peaks (local maxima) and troughs (local minima) in price
        var peaks = [], troughs = [];
        var scanStart = Math.max(2, len - lookback);

        for (var i = scanStart; i < len - 1; i++) {
            var ci = i; // close index
            var ri = ci - rsiOffset; // corresponding RSI index
            if (ri < 1 || ri >= rsiValues.length - 1) continue;

            // Peak: higher than neighbors
            if (closes[ci] > closes[ci - 1] && closes[ci] > closes[ci + 1]) {
                peaks.push({ priceIdx: ci, price: closes[ci], rsi: rsiValues[ri] });
            }
            // Trough: lower than neighbors
            if (closes[ci] < closes[ci - 1] && closes[ci] < closes[ci + 1]) {
                troughs.push({ priceIdx: ci, price: closes[ci], rsi: rsiValues[ri] });
            }
        }

        // Also check the last bar against the previous bar for the most recent peak/trough
        var lastIdx = len - 1;
        var lastRIdx = lastIdx - rsiOffset;
        if (lastRIdx >= 1 && lastRIdx < rsiValues.length) {
            if (closes[lastIdx] > closes[lastIdx - 1]) {
                peaks.push({ priceIdx: lastIdx, price: closes[lastIdx], rsi: rsiValues[lastRIdx] });
            }
            if (closes[lastIdx] < closes[lastIdx - 1]) {
                troughs.push({ priceIdx: lastIdx, price: closes[lastIdx], rsi: rsiValues[lastRIdx] });
            }
        }

        // Compare most recent 2 peaks for bearish divergence
        if (peaks.length >= 2) {
            var p1 = peaks[peaks.length - 2]; // earlier peak
            var p2 = peaks[peaks.length - 1]; // more recent peak

            // Regular Bearish: price higher high, RSI lower high
            if (p2.price > p1.price && p2.rsi < p1.rsi) {
                divergences.push({
                    type: 'REGULAR_BEARISH',
                    direction: 'BEAR',
                    strength: Math.min(1.0, Math.abs(p2.rsi - p1.rsi) / 10),
                    priceSwing: [p1.price, p2.price],
                    rsiSwing: [p1.rsi, p2.rsi],
                    detail: 'Price higher high but RSI lower high → reversal down'
                });
            }

            // Hidden Bearish: price lower high, RSI higher high (trend continuation down)
            if (p2.price < p1.price && p2.rsi > p1.rsi) {
                divergences.push({
                    type: 'HIDDEN_BEARISH',
                    direction: 'BEAR',
                    strength: Math.min(0.8, Math.abs(p2.rsi - p1.rsi) / 12),
                    priceSwing: [p1.price, p2.price],
                    rsiSwing: [p1.rsi, p2.rsi],
                    detail: 'Price lower high but RSI higher high → trend continuation down'
                });
            }
        }

        // Compare most recent 2 troughs for bullish divergence
        if (troughs.length >= 2) {
            var t1 = troughs[troughs.length - 2]; // earlier trough
            var t2 = troughs[troughs.length - 1]; // more recent trough

            // Regular Bullish: price lower low, RSI higher low
            if (t2.price < t1.price && t2.rsi > t1.rsi) {
                divergences.push({
                    type: 'REGULAR_BULLISH',
                    direction: 'BULL',
                    strength: Math.min(1.0, Math.abs(t2.rsi - t1.rsi) / 10),
                    priceSwing: [t1.price, t2.price],
                    rsiSwing: [t1.rsi, t2.rsi],
                    detail: 'Price lower low but RSI higher low → reversal up'
                });
            }

            // Hidden Bullish: price higher low, RSI lower low (trend continuation up)
            if (t2.price > t1.price && t2.rsi < t1.rsi) {
                divergences.push({
                    type: 'HIDDEN_BULLISH',
                    direction: 'BULL',
                    strength: Math.min(0.8, Math.abs(t2.rsi - t1.rsi) / 12),
                    priceSwing: [t1.price, t2.price],
                    rsiSwing: [t1.rsi, t2.rsi],
                    detail: 'Price higher low but RSI lower low → trend continuation up'
                });
            }
        }

        return divergences;
    }

    // ── Fibonacci Retracement & Extension Levels ─────────────
    static fibonacci(swingHigh, swingLow, direction) {
        if (!swingHigh || !swingLow || swingHigh <= swingLow) {
            return { levels: null, targets: null, swingRange: 0 };
        }

        var range = swingHigh - swingLow;

        // Retracement levels (within the swing range)
        var levels = {};
        var targets = {};

        if (direction === 'UP' || direction === 'BULL') {
            // Price moved up: retrace FROM the high (potential support levels)
            levels = {
                '0.0': +swingHigh.toFixed(2),          // swing high
                '23.6': +(swingHigh - range * 0.236).toFixed(2),
                '38.2': +(swingHigh - range * 0.382).toFixed(2),
                '50.0': +(swingHigh - range * 0.500).toFixed(2),
                '61.8': +(swingHigh - range * 0.618).toFixed(2),
                '78.6': +(swingHigh - range * 0.786).toFixed(2),
                '100.0': +swingLow.toFixed(2)           // swing low
            };
            // Extension targets (above the high)
            targets = {
                '127.2': +(swingLow + range * 1.272).toFixed(2),
                '161.8': +(swingLow + range * 1.618).toFixed(2),
                '200.0': +(swingLow + range * 2.000).toFixed(2),
                '261.8': +(swingLow + range * 2.618).toFixed(2)
            };
        } else {
            // Price moved down: retrace FROM the low (potential resistance levels)
            levels = {
                '0.0': +swingLow.toFixed(2),           // swing low
                '23.6': +(swingLow + range * 0.236).toFixed(2),
                '38.2': +(swingLow + range * 0.382).toFixed(2),
                '50.0': +(swingLow + range * 0.500).toFixed(2),
                '61.8': +(swingLow + range * 0.618).toFixed(2),
                '78.6': +(swingLow + range * 0.786).toFixed(2),
                '100.0': +swingHigh.toFixed(2)          // swing high
            };
            // Extension targets (below the low)
            targets = {
                '127.2': +(swingHigh - range * 1.272).toFixed(2),
                '161.8': +(swingHigh - range * 1.618).toFixed(2),
                '200.0': +(swingHigh - range * 2.000).toFixed(2),
                '261.8': +(swingHigh - range * 2.618).toFixed(2)
            };
        }

        return {
            levels: levels,
            targets: targets,
            swingHigh: +swingHigh.toFixed(2),
            swingLow: +swingLow.toFixed(2),
            swingRange: +range.toFixed(2),
            direction: direction
        };
    }

    // ── Full Analysis for a Ticker ──────────────────────────
    static analyze(candles) {
        if (!candles || candles.length < 30) {
            return { error: 'Insufficient data (need ≥30 candles)' };
        }

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        const lastClose = closes[closes.length - 1];
        const lastHigh = highs[highs.length - 1];
        const lastLow = lows[lows.length - 1];

        // EMAs
        const ema9 = this.ema(closes, 9);
        const ema20 = this.ema(closes, 20);
        const ema50 = this.ema(closes, 50);

        // RSI
        const rsiValues = this.rsi(closes, 14);
        const currentRSI = rsiValues.length > 0 ? +rsiValues[rsiValues.length - 1].toFixed(2) : null;

        // MACD
        const macdData = this.macd(closes);
        const currentMACD = macdData.macd.length > 0 ? +macdData.macd[macdData.macd.length - 1].toFixed(4) : null;
        const currentSignal = macdData.signal.length > 0 ? +macdData.signal[macdData.signal.length - 1].toFixed(4) : null;
        const currentHist = macdData.histogram.length > 0 ? +macdData.histogram[macdData.histogram.length - 1].toFixed(4) : null;

        // Volume
        const volSpikes = this.volumeSpikes(volumes);
        const latestVolSpike = volSpikes.length > 0 && volSpikes[volSpikes.length - 1].index === volumes.length - 1;

        // Pivots
        const pivots = this.pivotPoints(lastHigh, lastLow, lastClose);

        // ATR
        const atrData = this.atr(highs, lows, closes, 14);

        // Bollinger Bands
        const bb = this.bollingerBands(closes, 20, 2);

        // Gaps
        const gaps = this.detectGaps(candles);
        const recentGaps = gaps.slice(-3);

        // ── NEW: ADX (trend strength) ──
        const adxData = this.adx(highs, lows, closes, 14);

        // ── NEW: RSI Divergence ──
        const rsiDivergences = this.rsiDivergence(closes, rsiValues, 20);

        // ── NEW: Swing Points & Fibonacci ──
        const swingPoints = this.findSwingPoints(highs, lows, 5);
        let fibData = { levels: null, targets: null, swingRange: 0 };
        if (swingPoints.swingHigh && swingPoints.swingLow) {
            // Direction based on where price is relative to midpoint
            const swingMid = (swingPoints.swingHigh + swingPoints.swingLow) / 2;
            const fibDir = lastClose > swingMid ? 'UP' : 'DOWN';
            fibData = this.fibonacci(swingPoints.swingHigh, swingPoints.swingLow, fibDir);
        }

        // ── NEW: MACD Histogram Slope (acceleration/deceleration) ──
        let macdSlope = 0;
        if (macdData.histogram.length >= 3) {
            const h = macdData.histogram;
            const h1 = h[h.length - 1];
            const h2 = h[h.length - 2];
            const h3 = h[h.length - 3];
            macdSlope = ((h1 - h2) + (h2 - h3)) / 2; // average slope over 2 bars
        }

        // ── NEW: RSI Rate of Change ──
        let rsiSlope = 0;
        if (rsiValues.length >= 4) {
            const r = rsiValues;
            rsiSlope = (r[r.length - 1] - r[r.length - 3]) / 2; // avg change over 3 bars
        }

        // EMA alignment bias
        const lastEma9 = ema9.length > 0 ? ema9[ema9.length - 1] : null;
        const lastEma20 = ema20.length > 0 ? ema20[ema20.length - 1] : null;
        const lastEma50 = ema50.length > 0 ? ema50[ema50.length - 1] : null;

        let emaBias = 'NEUTRAL';
        if (lastEma9 && lastEma20 && lastEma50) {
            if (lastEma9 > lastEma20 && lastEma20 > lastEma50) emaBias = 'BULLISH';
            else if (lastEma9 < lastEma20 && lastEma20 < lastEma50) emaBias = 'BEARISH';
        }

        // Overall bias (enhanced with ADX and divergence)
        let bias = 'NEUTRAL';
        let bullPoints = 0, bearPoints = 0;

        if (currentRSI !== null) {
            if (currentRSI > 55) bullPoints += 1;
            else if (currentRSI < 45) bearPoints += 1;
            if (currentRSI > 70) bearPoints += 1;
            if (currentRSI < 30) bullPoints += 1;
        }
        if (emaBias === 'BULLISH') bullPoints += 2;
        else if (emaBias === 'BEARISH') bearPoints += 2;

        if (currentHist !== null) {
            if (currentHist > 0) bullPoints += 1;
            else bearPoints += 1;
        }
        if (latestVolSpike) bullPoints += 1;

        // ADX strengthens directional conviction
        if (adxData.adx !== null && adxData.adx >= 25) {
            if (adxData.trendDirection === 'BULLISH') bullPoints += 1;
            else bearPoints += 1;
        }

        // RSI divergence overrides
        rsiDivergences.forEach(function (d) {
            if (d.type === 'REGULAR_BULLISH') bullPoints += 2;
            else if (d.type === 'REGULAR_BEARISH') bearPoints += 2;
            else if (d.type === 'HIDDEN_BULLISH') bullPoints += 1;
            else if (d.type === 'HIDDEN_BEARISH') bearPoints += 1;
        });

        if (bullPoints > bearPoints + 1) bias = 'BULLISH';
        else if (bearPoints > bullPoints + 1) bias = 'BEARISH';

        return {
            price: lastClose,
            rsi: currentRSI,
            rsiValues: rsiValues,
            ema: {
                ema9: lastEma9 ? +lastEma9.toFixed(2) : null,
                ema20: lastEma20 ? +lastEma20.toFixed(2) : null,
                ema50: lastEma50 ? +lastEma50.toFixed(2) : null
            },
            emaBias,
            macd: { macd: currentMACD, signal: currentSignal, histogram: currentHist },
            macdHistogram: macdData.histogram,
            macdSlope: +macdSlope.toFixed(6),
            volumeSpike: latestVolSpike,
            pivots,
            atr: atrData.current,
            atrValues: atrData.values,
            bollingerBands: bb,
            recentGaps,
            patterns: this.detectCandlePatterns(candles),
            // ── New indicators ──
            adx: adxData,
            rsiDivergence: rsiDivergences,
            rsiSlope: +rsiSlope.toFixed(4),
            fibonacci: fibData,
            swingPoints: swingPoints,
            bias,
            biasScore: { bull: bullPoints, bear: bearPoints }
        };
    }
}

module.exports = TechnicalAnalysis;
