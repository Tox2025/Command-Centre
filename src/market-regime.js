// Market Regime Detection
// Classifies market as TRENDING_UP, TRENDING_DOWN, RANGING, or VOLATILE
// Uses ADX (trend strength), VIX level, and market breadth

const REGIMES = {
    TRENDING_UP: { label: 'Trending Up', strategy: 'momentum_long', color: '#10b981' },
    TRENDING_DOWN: { label: 'Trending Down', strategy: 'momentum_short', color: '#ef4444' },
    RANGING: { label: 'Range-Bound', strategy: 'mean_reversion', color: '#3b82f6' },
    VOLATILE: { label: 'High Volatility', strategy: 'reduce_size', color: '#f59e0b' },
    UNKNOWN: { label: 'Unknown', strategy: 'neutral', color: '#64748b' }
};

// Strategy bias per regime — which signal types to favor
const REGIME_SIGNAL_BIAS = {
    TRENDING_UP: { ema_alignment: 1.4, rsi_position: 0.8, macd_histogram: 1.3, bb_squeeze: 0.7, vwap_deviation: 0.8 },
    TRENDING_DOWN: { ema_alignment: 1.4, rsi_position: 0.8, macd_histogram: 1.3, bb_squeeze: 0.7, vwap_deviation: 0.8 },
    RANGING: { ema_alignment: 0.6, rsi_position: 1.4, macd_histogram: 0.7, bb_squeeze: 1.5, vwap_deviation: 1.5 },
    VOLATILE: { ema_alignment: 0.5, rsi_position: 1.0, macd_histogram: 0.5, bb_squeeze: 0.8, vwap_deviation: 1.2, volume_spike: 1.3 }
};

class MarketRegime {
    constructor() {
        this.currentRegime = 'UNKNOWN';
        this.regimeConfidence = 0;
        this.history = [];
        this.maxHistory = 100;
    }

    // Detect regime from available market data
    detect(marketData) {
        var vixLevel = this._getVIX(marketData);
        var adxValues = this._getADX(marketData);
        var breadth = this._getBreadth(marketData);
        var tideData = marketData.marketTide;

        var scores = { TRENDING_UP: 0, TRENDING_DOWN: 0, RANGING: 0, VOLATILE: 0 };
        var totalWeight = 0;

        // 1. VIX Analysis (weight: 30%)
        if (vixLevel !== null) {
            totalWeight += 30;
            if (vixLevel > 30) {
                scores.VOLATILE += 30;
            } else if (vixLevel > 20) {
                scores.VOLATILE += 15;
                scores.TRENDING_DOWN += 10;
                scores.RANGING += 5;
            } else if (vixLevel > 15) {
                scores.RANGING += 15;
                scores.TRENDING_UP += 10;
                scores.TRENDING_DOWN += 5;
            } else {
                scores.TRENDING_UP += 20;
                scores.RANGING += 10;
            }
        }

        // 2. ADX / Trend Strength (weight: 35%)
        if (adxValues.adx !== null) {
            totalWeight += 35;
            var adx = adxValues.adx;
            var diPlus = adxValues.diPlus || 0;
            var diMinus = adxValues.diMinus || 0;

            if (adx > 25) {
                // Strong trend
                if (diPlus > diMinus) {
                    scores.TRENDING_UP += 35;
                } else {
                    scores.TRENDING_DOWN += 35;
                }
            } else if (adx > 20) {
                // Weak trend
                if (diPlus > diMinus) {
                    scores.TRENDING_UP += 15;
                } else {
                    scores.TRENDING_DOWN += 15;
                }
                scores.RANGING += 15;
            } else {
                // No trend
                scores.RANGING += 30;
                scores.VOLATILE += 5;
            }
        }

        // 3. Market Breadth / Tide (weight: 20%)
        if (breadth.ratio !== null) {
            totalWeight += 20;
            var ratio = breadth.ratio; // advance/decline ratio
            if (ratio > 1.5) {
                scores.TRENDING_UP += 20;
            } else if (ratio > 1.1) {
                scores.TRENDING_UP += 10;
                scores.RANGING += 10;
            } else if (ratio > 0.9) {
                scores.RANGING += 20;
            } else if (ratio > 0.65) {
                scores.TRENDING_DOWN += 10;
                scores.RANGING += 10;
            } else {
                scores.TRENDING_DOWN += 20;
            }
        }

        // 4. Market Tide sentiment (weight: 15%)
        if (tideData) {
            totalWeight += 15;
            var bullPct = parseFloat(tideData.bull_pct || tideData.bullish_pct || 50);
            if (bullPct > 65) {
                scores.TRENDING_UP += 15;
            } else if (bullPct > 55) {
                scores.TRENDING_UP += 8;
                scores.RANGING += 7;
            } else if (bullPct > 45) {
                scores.RANGING += 15;
            } else if (bullPct > 35) {
                scores.TRENDING_DOWN += 8;
                scores.RANGING += 7;
            } else {
                scores.TRENDING_DOWN += 15;
            }
        }

        // Determine winner
        var maxScore = 0, winner = 'UNKNOWN';
        for (var regime in scores) {
            if (scores[regime] > maxScore) {
                maxScore = scores[regime];
                winner = regime;
            }
        }

        var confidence = totalWeight > 0 ? Math.round(maxScore / totalWeight * 100) : 0;

        this.currentRegime = winner;
        this.regimeConfidence = confidence;

        // Track history for regime persistence
        this.history.push({ regime: winner, confidence: confidence, timestamp: Date.now() });
        if (this.history.length > this.maxHistory) this.history.shift();

        return this.getRegime();
    }

    getRegime() {
        var info = REGIMES[this.currentRegime] || REGIMES.UNKNOWN;
        return {
            regime: this.currentRegime,
            label: info.label,
            confidence: this.regimeConfidence,
            strategy: info.strategy,
            color: info.color,
            signalBias: REGIME_SIGNAL_BIAS[this.currentRegime] || {},
            persistence: this._calcPersistence(),
            recentHistory: this.history.slice(-5)
        };
    }

    // How long has current regime been active (in refresh cycles)
    _calcPersistence() {
        if (this.history.length === 0) return 0;
        var count = 0;
        for (var i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].regime === this.currentRegime) count++;
            else break;
        }
        return count;
    }

    _getVIX(data) {
        // Try to get VIX from market spike data or quotes
        if (data.marketSpike && data.marketSpike.vix) return parseFloat(data.marketSpike.vix);
        if (data.quotes && data.quotes['VIX']) return parseFloat(data.quotes['VIX'].last || data.quotes['VIX'].price || 0);
        // Estimate from options IV if available
        if (data.ivRank) {
            var ivs = Object.values(data.ivRank);
            if (ivs.length > 0) {
                var avgIV = 0;
                ivs.forEach(function (iv) {
                    var arr = Array.isArray(iv) ? iv : [iv];
                    var l = arr[arr.length - 1] || {};
                    avgIV += parseFloat(l.iv_rank_1y || l.iv_rank || 50);
                });
                avgIV /= ivs.length;
                // High average IV rank suggests elevated volatility
                if (avgIV > 70) return 25; // approximate VIX
                if (avgIV > 50) return 18;
                return 14;
            }
        }
        return null;
    }

    _getADX(data) {
        // Compute average ADX across tracked tickers
        var adxSum = 0, count = 0;
        var diPlusSum = 0, diMinusSum = 0;
        if (data.technicals) {
            for (var ticker in data.technicals) {
                var ta = data.technicals[ticker];
                if (ta && ta.adx !== undefined && ta.adx !== null) {
                    adxSum += ta.adx;
                    diPlusSum += (ta.diPlus || ta.di_plus || 0);
                    diMinusSum += (ta.diMinus || ta.di_minus || 0);
                    count++;
                }
            }
        }
        if (count === 0) {
            // Fallback: estimate from EMA alignment
            var bullCount = 0, bearCount = 0, total = 0;
            if (data.technicals) {
                for (var t in data.technicals) {
                    var tech = data.technicals[t];
                    if (tech && tech.emaBias) {
                        if (tech.emaBias === 'BULLISH') bullCount++;
                        else if (tech.emaBias === 'BEARISH') bearCount++;
                        total++;
                    }
                }
            }
            if (total > 0) {
                var dominance = Math.max(bullCount, bearCount) / total;
                return {
                    adx: dominance > 0.7 ? 28 : dominance > 0.5 ? 22 : 15,
                    diPlus: bullCount > bearCount ? 25 : 15,
                    diMinus: bearCount > bullCount ? 25 : 15
                };
            }
            return { adx: null, diPlus: null, diMinus: null };
        }
        return { adx: adxSum / count, diPlus: diPlusSum / count, diMinus: diMinusSum / count };
    }

    _getBreadth(data) {
        // Market breadth from quote data: how many tickers are up vs down
        var advances = 0, declines = 0;
        if (data.quotes) {
            for (var ticker in data.quotes) {
                var q = data.quotes[ticker];
                var change = parseFloat(q.change_pct || q.changePct || q.change_percent || 0);
                if (change > 0) advances++;
                else if (change < 0) declines++;
            }
        }
        if (advances + declines === 0) return { ratio: null, advances: 0, declines: 0 };
        return {
            ratio: declines > 0 ? +(advances / declines).toFixed(2) : advances > 0 ? 3.0 : 1.0,
            advances: advances,
            declines: declines
        };
    }
}

module.exports = { MarketRegime, REGIMES, REGIME_SIGNAL_BIAS };
