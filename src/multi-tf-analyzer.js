// Multi-Timeframe Analyzer — mirrors the user's actual day trading strategy
// Fetches 1m, 5m, 15m, daily, weekly candles from Polygon REST API
// RSI, MACD, BB, Volume, EMA on each timeframe for confluence scoring
//
// Key concepts:
// - Confluence: when all 3 TFs agree on direction = very high probability
// - Consolidation: BB squeeze + ATR compression = breakout imminent
// - Short-cover bounce: oversold RSI + lower BB on a heavily shorted stock = snap-back

const TechnicalAnalysis = require('./technical');

class MultiTFAnalyzer {
    constructor(polygonClient) {
        this.polygonClient = polygonClient || null;
        this.cache = {};         // ticker -> { tf -> { candles, analysis, timestamp } }
        this.maxCacheAge = 60000; // 60s cache for intraday data
        this.dailyCacheAge = 300000;  // 5min cache for daily candles
        this.weeklyCacheAge = 1800000; // 30min cache for weekly candles
    }

    // ── Fetch candles from Polygon REST API ────────────────
    async _fetchCandles(ticker, interval, rangeDays) {
        try {
            var now = Date.now();
            var cacheKey = ticker + '_' + interval;
            var cached = this.cache[cacheKey];
            var cacheLimit = interval === '1wk' ? this.weeklyCacheAge : interval === '1d' ? this.dailyCacheAge : this.maxCacheAge;
            if (cached && (now - cached.timestamp) < cacheLimit) {
                return cached.candles;
            }

            if (!this.polygonClient) {
                return cached ? cached.candles : [];
            }

            // Map interval to Polygon multiplier + timespan
            var polyMap = {
                '1m': { multiplier: 1, timespan: 'minute' },
                '5m': { multiplier: 5, timespan: 'minute' },
                '15m': { multiplier: 15, timespan: 'minute' },
                '1d': { multiplier: 1, timespan: 'day' },
                '1wk': { multiplier: 1, timespan: 'week' }
            };
            var poly = polyMap[interval] || { multiplier: 1, timespan: 'day' };

            var fromDate = new Date();
            fromDate.setDate(fromDate.getDate() - rangeDays);
            var fromStr = fromDate.toISOString().split('T')[0];
            var toStr = new Date().toISOString().split('T')[0];

            var result = await this.polygonClient.getAggregates(ticker, poly.multiplier, poly.timespan, fromStr, toStr);

            if (!result || result.length === 0) {
                return cached ? cached.candles : [];
            }

            // getAggregates already maps to { open, high, low, close, volume, date }
            var candles = result.filter(function (c) { return c.close !== null && c.close !== undefined; });

            this.cache[cacheKey] = { candles: candles, timestamp: now };
            return candles;
        } catch (e) {
            var cached2 = this.cache[ticker + '_' + interval];
            return cached2 ? cached2.candles : [];
        }
    }

    // ── Run full TA on a candle set ────────────────────────────
    _analyzeTimeframe(candles) {
        if (!candles || candles.length < 30) {
            return null;
        }
        return TechnicalAnalysis.analyze(candles);
    }

    // ── Detect consolidation / breakout ───────────────────────
    _detectConsolidation(analysis5m, analysis15m) {
        var result = {
            isConsolidating: false,
            isBreakingOut: false,
            breakoutDirection: null,
            squeezeStrength: 0
        };

        // Check BB squeeze on 5m and 15m
        var bb5 = analysis5m && analysis5m.bollingerBands;
        var bb15 = analysis15m && analysis15m.bollingerBands;

        if (bb5 && bb15) {
            var bw5 = bb5.bandwidth || 0;
            var bw15 = bb15.bandwidth || 0;

            // Squeeze: bandwidth below typical threshold
            // Normal BB bandwidth is ~4-8%, squeeze is < 2%
            if (bw5 < 0.02 && bw15 < 0.03) {
                result.isConsolidating = true;
                result.squeezeStrength = 3; // both TFs squeezing
            } else if (bw5 < 0.025 || bw15 < 0.03) {
                result.isConsolidating = true;
                result.squeezeStrength = 2; // one TF squeezing
            }

            // Breakout detection: price just moved outside squeeze
            if (result.isConsolidating) {
                var pos5 = bb5.position || 0.5;
                if (pos5 > 0.9) {
                    result.isBreakingOut = true;
                    result.breakoutDirection = 'BULL';
                } else if (pos5 < 0.1) {
                    result.isBreakingOut = true;
                    result.breakoutDirection = 'BEAR';
                }
            }
        }

        // ATR compression check on 5m
        if (analysis5m && analysis5m.atr && analysis5m.atrValues && analysis5m.atrValues.length > 5) {
            var vals = analysis5m.atrValues;
            var recent = vals[vals.length - 1];
            var avg = 0;
            for (var i = Math.max(0, vals.length - 20); i < vals.length; i++) avg += vals[i];
            avg /= Math.min(20, vals.length);
            if (recent < avg * 0.5) {
                result.isConsolidating = true;
                result.squeezeStrength = Math.max(result.squeezeStrength, 2);
            }
        }

        return result;
    }

    // ── Detect short-cover bounce opportunity ─────────────────
    _detectShortCoverBounce(analysis1m, analysis5m, shortInterestPct) {
        var result = {
            isShortCoverSetup: false,
            bounceStrength: 0,
            detail: ''
        };

        // Need oversold RSI + near/below lower BB on short timeframes
        var checks = [
            { name: '1m', ta: analysis1m },
            { name: '5m', ta: analysis5m }
        ];

        var oversoldCount = 0;
        var lowerBBCount = 0;

        checks.forEach(function (c) {
            if (!c.ta) return;

            // RSI oversold
            if (c.ta.rsi !== null && c.ta.rsi < 30) {
                oversoldCount++;
            } else if (c.ta.rsi !== null && c.ta.rsi < 35) {
                oversoldCount += 0.5;
            }

            // Near or below lower BB
            if (c.ta.bollingerBands && c.ta.bollingerBands.position !== null) {
                if (c.ta.bollingerBands.position < 0.1) {
                    lowerBBCount++;
                } else if (c.ta.bollingerBands.position < 0.2) {
                    lowerBBCount += 0.5;
                }
            }
        });

        if (oversoldCount >= 1 && lowerBBCount >= 1) {
            result.isShortCoverSetup = true;
            result.bounceStrength = Math.round(oversoldCount + lowerBBCount);

            // Higher short interest = stronger bounce potential
            if (shortInterestPct > 15) {
                result.bounceStrength += 2;
                result.detail = 'High SI (' + shortInterestPct.toFixed(1) + '%) + oversold + lower BB → strong cover bounce';
            } else if (shortInterestPct > 8) {
                result.bounceStrength += 1;
                result.detail = 'Moderate SI (' + shortInterestPct.toFixed(1) + '%) + oversold + lower BB → cover bounce';
            } else {
                result.detail = 'Oversold + lower BB → potential bounce';
            }
        }

        return result;
    }

    // ── Main: Multi-TF confluence scoring ─────────────────────
    async analyze(ticker, shortInterestPct) {
        var siPct = shortInterestPct || 0;

        // Fetch all five timeframes in parallel (intraday + swing)
        var results = await Promise.all([
            this._fetchCandles(ticker, '1m', 1),    // 1 day of 1m candles
            this._fetchCandles(ticker, '5m', 5),    // 5 days of 5m candles
            this._fetchCandles(ticker, '15m', 10),  // 10 days of 15m candles
            this._fetchCandles(ticker, '1d', 180),  // 180 days of daily candles
            this._fetchCandles(ticker, '1wk', 365)  // 1 year of weekly candles
        ]);

        var candles1m = results[0];
        var candles5m = results[1];
        var candles15m = results[2];
        var candlesDaily = results[3];
        var candlesWeekly = results[4];

        // Run TA on each
        var ta1m = this._analyzeTimeframe(candles1m);
        var ta5m = this._analyzeTimeframe(candles5m);
        var ta15m = this._analyzeTimeframe(candles15m);
        var taDaily = this._analyzeTimeframe(candlesDaily);
        var taWeekly = this._analyzeTimeframe(candlesWeekly);

        // ── Confluence Scoring ──
        var confluence = {
            bullSignals: 0,
            bearSignals: 0,
            timeframesAgreeing: 0,
            dominantDirection: 'NEUTRAL',
            confluenceBonus: 0,
            details: [],
            rsi: {},
            macd: {},
            bb: {},
            ema: {}
        };

        var tfResults = [
            { name: '1m', ta: ta1m, weight: 1 },
            { name: '5m', ta: ta5m, weight: 1 },
            { name: '15m', ta: ta15m, weight: 1 },
            { name: '1d', ta: taDaily, weight: 2 },
            { name: '1wk', ta: taWeekly, weight: 3 }
        ];

        var bullTFs = 0, bearTFs = 0;

        var intradayBull = 0, intradayBear = 0;
        var swingBull = 0, swingBear = 0;

        tfResults.forEach(function (tf) {
            if (!tf.ta) return;
            var w = tf.weight || 1;
            var tfBull = 0, tfBear = 0;

            // RSI
            if (tf.ta.rsi !== null && tf.ta.rsi !== undefined) {
                confluence.rsi[tf.name] = tf.ta.rsi;
                if (tf.ta.rsi < 30) { tfBull += 2; confluence.details.push(tf.name + ' RSI oversold (' + tf.ta.rsi.toFixed(1) + ')'); }
                else if (tf.ta.rsi < 40) { tfBull += 1; }
                else if (tf.ta.rsi > 70) { tfBear += 2; confluence.details.push(tf.name + ' RSI overbought (' + tf.ta.rsi.toFixed(1) + ')'); }
                else if (tf.ta.rsi > 60) { tfBear += 1; }
            }

            // MACD — only significant histograms
            if (tf.ta.macd && tf.ta.macd.histogram !== null) {
                var hist = tf.ta.macd.histogram;
                var atr = tf.ta.atr || 1;
                confluence.macd[tf.name] = hist;
                if (Math.abs(hist) > atr * 0.005) {
                    if (hist > 0) { tfBull += 1; }
                    else { tfBear += 1; }
                }
            }

            // EMA bias
            if (tf.ta.emaBias) {
                confluence.ema[tf.name] = tf.ta.emaBias;
                if (tf.ta.emaBias === 'BULLISH') { tfBull += 2; confluence.details.push(tf.name + ' EMA bullish stacked'); }
                else if (tf.ta.emaBias === 'BEARISH') { tfBear += 2; confluence.details.push(tf.name + ' EMA bearish stacked'); }
            }

            // BB position
            if (tf.ta.bollingerBands && tf.ta.bollingerBands.position !== null) {
                var pos = tf.ta.bollingerBands.position;
                confluence.bb[tf.name] = pos;
                if (pos < 0.15) { tfBull += 1; }
                else if (pos > 0.85) { tfBear += 1; }
            }

            // Volume spike
            if (tf.ta.volumeSpike) {
                if (tfBull > tfBear) tfBull += 1;
                else if (tfBear > tfBull) tfBear += 1;
            }

            // Apply weight multiplier (daily 2x, weekly 3x)
            var weightedBull = tfBull * w;
            var weightedBear = tfBear * w;

            // Track intraday vs swing separately
            if (tf.name === '1d' || tf.name === '1wk') {
                if (weightedBull > weightedBear) swingBull += weightedBull;
                else swingBear += weightedBear;
            } else {
                if (weightedBull > weightedBear) intradayBull += weightedBull;
                else intradayBear += weightedBear;
            }

            // Determine this TF's direction
            if (tfBull > tfBear + 1) {
                bullTFs++;
                confluence.bullSignals += weightedBull;
            } else if (tfBear > tfBull + 1) {
                bearTFs++;
                confluence.bearSignals += weightedBear;
            }
        });

        // Confluence bonus based on TF agreement (now out of 5 TFs)
        if (bullTFs >= 4 || bearTFs >= 4) {
            confluence.timeframesAgreeing = bullTFs >= 4 ? bullTFs : bearTFs;
            confluence.confluenceBonus = 20;
            confluence.dominantDirection = bullTFs >= 4 ? 'BULL' : 'BEAR';
            confluence.details.push('🔥 ' + confluence.timeframesAgreeing + '/5 TIMEFRAMES AGREE: ' + confluence.dominantDirection);
        } else if (bullTFs >= 3 || bearTFs >= 3) {
            confluence.timeframesAgreeing = 3;
            confluence.confluenceBonus = 15;
            confluence.dominantDirection = bullTFs >= 3 ? 'BULL' : 'BEAR';
            confluence.details.push('🔥 3/5 timeframes agree: ' + confluence.dominantDirection);
        } else if (bullTFs >= 2 || bearTFs >= 2) {
            confluence.timeframesAgreeing = 2;
            confluence.confluenceBonus = 8;
            confluence.dominantDirection = bullTFs >= 2 ? 'BULL' : 'BEAR';
            confluence.details.push('✅ 2/5 timeframes agree: ' + confluence.dominantDirection);
        } else if (bullTFs === 1 && bearTFs === 0) {
            confluence.timeframesAgreeing = 1;
            confluence.confluenceBonus = 2;
            confluence.dominantDirection = 'BULL';
        } else if (bearTFs === 1 && bullTFs === 0) {
            confluence.timeframesAgreeing = 1;
            confluence.confluenceBonus = 2;
            confluence.dominantDirection = 'BEAR';
        }

        // Swing trade classification
        var swingBias = 'NEUTRAL';
        if (swingBull > swingBear + 2) swingBias = 'BULL';
        else if (swingBear > swingBull + 2) swingBias = 'BEAR';
        confluence.swingBias = swingBias;
        confluence.swingStrength = Math.abs(swingBull - swingBear);
        confluence.intradayBias = intradayBull > intradayBear ? 'BULL' : intradayBear > intradayBull ? 'BEAR' : 'NEUTRAL';
        if (swingBias !== 'NEUTRAL') {
            confluence.details.push('📅 Swing bias: ' + swingBias + ' (daily+weekly strength: ' + confluence.swingStrength.toFixed(1) + ')');
        }

        // ── Consolidation / Breakout ──
        var consolidation = this._detectConsolidation(ta5m, ta15m);
        if (consolidation.isBreakingOut) {
            confluence.confluenceBonus += 5;
            confluence.details.push('💥 BREAKOUT from consolidation → ' + consolidation.breakoutDirection);
        } else if (consolidation.isConsolidating) {
            confluence.details.push('📊 Consolidating (squeeze strength: ' + consolidation.squeezeStrength + '/3) — watch for breakout');
        }

        // ── Short-Cover Bounce ──
        var shortCover = this._detectShortCoverBounce(ta1m, ta5m, siPct);
        if (shortCover.isShortCoverSetup) {
            confluence.confluenceBonus += shortCover.bounceStrength * 2;
            confluence.dominantDirection = 'BULL'; // cover bounces are bullish
            confluence.details.push('🔄 SHORT-COVER BOUNCE: ' + shortCover.detail);
        }

        return {
            ticker: ticker,
            confluence: confluence,
            consolidation: consolidation,
            shortCoverBounce: shortCover,
            timeframes: {
                '1m': ta1m ? { rsi: ta1m.rsi, macd: ta1m.macd, emaBias: ta1m.emaBias, bb: ta1m.bollingerBands, volumeSpike: ta1m.volumeSpike, adx: ta1m.adx, rsiDivergence: ta1m.rsiDivergence, fibonacci: ta1m.fibonacci, macdSlope: ta1m.macdSlope, rsiSlope: ta1m.rsiSlope } : null,
                '5m': ta5m ? { rsi: ta5m.rsi, macd: ta5m.macd, emaBias: ta5m.emaBias, bb: ta5m.bollingerBands, volumeSpike: ta5m.volumeSpike, adx: ta5m.adx, rsiDivergence: ta5m.rsiDivergence, fibonacci: ta5m.fibonacci, macdSlope: ta5m.macdSlope, rsiSlope: ta5m.rsiSlope } : null,
                '15m': ta15m ? { rsi: ta15m.rsi, macd: ta15m.macd, emaBias: ta15m.emaBias, bb: ta15m.bollingerBands, volumeSpike: ta15m.volumeSpike, adx: ta15m.adx, rsiDivergence: ta15m.rsiDivergence, fibonacci: ta15m.fibonacci, macdSlope: ta15m.macdSlope, rsiSlope: ta15m.rsiSlope } : null,
                '1d': taDaily ? { rsi: taDaily.rsi, macd: taDaily.macd, emaBias: taDaily.emaBias, bb: taDaily.bollingerBands, volumeSpike: taDaily.volumeSpike, adx: taDaily.adx, rsiDivergence: taDaily.rsiDivergence, fibonacci: taDaily.fibonacci, macdSlope: taDaily.macdSlope, rsiSlope: taDaily.rsiSlope } : null,
                '1wk': taWeekly ? { rsi: taWeekly.rsi, macd: taWeekly.macd, emaBias: taWeekly.emaBias, bb: taWeekly.bollingerBands, volumeSpike: taWeekly.volumeSpike, adx: taWeekly.adx, rsiDivergence: taWeekly.rsiDivergence, fibonacci: taWeekly.fibonacci, macdSlope: taWeekly.macdSlope, rsiSlope: taWeekly.rsiSlope } : null
            },
            timestamp: new Date().toISOString()
        };
    }

    // ── Batch analyze multiple tickers ────────────────────────
    async analyzeBatch(tickers, shortInterestMap) {
        var self = this;
        var siMap = shortInterestMap || {};
        var results = {};

        // Process in parallel — Polygon is fast, no need for sequential throttling
        for (var i = 0; i < tickers.length; i++) {
            try {
                results[tickers[i]] = await self.analyze(tickers[i], siMap[tickers[i]] || 0);
            } catch (e) {
                // Skip failed tickers silently
            }
        }

        return results;
    }
}

module.exports = MultiTFAnalyzer;
