/**
 * Market Regime Detector
 *
 * Detects market regime from SPY/QQQ behavior and adjusts trading parameters.
 * Regime types: TRENDING_UP, TRENDING_DOWN, CHOPPY, BREAKOUT, UNKNOWN
 */

function MarketRegimeDetector() {
  this.REGIMES = {
    TRENDING_UP: 'TRENDING_UP',
    TRENDING_DOWN: 'TRENDING_DOWN',
    CHOPPY: 'CHOPPY',
    BREAKOUT: 'BREAKOUT',
    UNKNOWN: 'UNKNOWN'
  };

  this._history = [];
  this._maxHistory = 100;
  this._lastRegime = null;
  this._bbWidthHistory = [];
  this._maxBBWidthHistory = 10;
}

/**
 * Determine trend direction for a single instrument.
 * @param {Object} data - { price, ema20, ema50, adx, bbWidth, rsi, atr }
 * @returns {string} 'UP', 'DOWN', or 'NEUTRAL'
 */
MarketRegimeDetector.prototype._determineTrend = function (data) {
  if (
    data.price > data.ema20 &&
    data.ema20 > data.ema50
  ) {
    return 'UP';
  }
  if (
    data.price < data.ema20 &&
    data.ema20 < data.ema50
  ) {
    return 'DOWN';
  }
  return 'NEUTRAL';
};

/**
 * Detect whether a squeeze release (breakout) is occurring.
 * A squeeze release is identified when Bollinger bandwidth transitions
 * from a recent low to a significantly higher value.
 * @param {number} currentBBWidth - Current Bollinger bandwidth
 * @returns {boolean}
 */
MarketRegimeDetector.prototype._isSqueezeRelease = function (currentBBWidth) {
  if (this._bbWidthHistory.length < 3) {
    return false;
  }

  var recentMin = Infinity;
  for (var i = 0; i < this._bbWidthHistory.length; i++) {
    if (this._bbWidthHistory[i] < recentMin) {
      recentMin = this._bbWidthHistory[i];
    }
  }

  // Squeeze release: current bandwidth is at least 1.5x the recent minimum
  // and the recent minimum was relatively low (below the average)
  var sum = 0;
  for (var j = 0; j < this._bbWidthHistory.length; j++) {
    sum += this._bbWidthHistory[j];
  }
  var avg = sum / this._bbWidthHistory.length;

  return recentMin < avg * 0.8 && currentBBWidth > recentMin * 1.5;
};

/**
 * Record Bollinger bandwidth for squeeze detection.
 * @param {number} bbWidth
 */
MarketRegimeDetector.prototype._trackBBWidth = function (bbWidth) {
  this._bbWidthHistory.push(bbWidth);
  if (this._bbWidthHistory.length > this._maxBBWidthHistory) {
    this._bbWidthHistory.shift();
  }
};

/**
 * Add a regime entry to the internal history.
 * @param {Object} entry
 */
MarketRegimeDetector.prototype._addToHistory = function (entry) {
  this._history.push(entry);
  if (this._history.length > this._maxHistory) {
    this._history.shift();
  }
};

/**
 * Detect the current market regime from SPY and QQQ data.
 *
 * @param {Object} spyData - { price, ema20, ema50, adx, bbWidth, rsi, atr }
 * @param {Object} qqData  - { price, ema20, ema50, adx, bbWidth, rsi, atr }
 * @returns {Object} { regime, confidence, spyTrend, qqTrend, description }
 */
MarketRegimeDetector.prototype.detect = function (spyData, qqData) {
  // Validate inputs
  if (!spyData || !qqData) {
    return {
      regime: this.REGIMES.UNKNOWN,
      confidence: 0,
      spyTrend: 'UNKNOWN',
      qqTrend: 'UNKNOWN',
      description: 'Insufficient data provided'
    };
  }

  var spyTrend = this._determineTrend(spyData);
  var qqTrend = this._determineTrend(qqData);

  // Track Bollinger bandwidth for squeeze detection
  this._trackBBWidth(spyData.bbWidth);

  var regime = this.REGIMES.UNKNOWN;
  var confidence = 0;
  var description = '';

  // --- BREAKOUT detection (check first, as it overrides trend regimes) ---
  var squeezeRelease = this._isSqueezeRelease(spyData.bbWidth);
  if (squeezeRelease) {
    regime = this.REGIMES.BREAKOUT;
    confidence = 70;
    description = 'Squeeze release detected — volatility expanding from compressed state';

    // Boost confidence if both instruments agree on direction
    if (spyTrend === qqTrend && spyTrend !== 'NEUTRAL') {
      confidence += 10;
      description += ' with aligned ' + spyTrend + ' momentum';
    }

    // ADX confirmation
    if (spyData.adx > 20) {
      confidence += 5;
    }
  }
  // --- TRENDING_UP ---
  else if (
    spyData.price > spyData.ema20 &&
    spyData.ema20 > spyData.ema50 &&
    spyData.adx > 25
  ) {
    regime = this.REGIMES.TRENDING_UP;
    confidence = 60;
    description = 'SPY in uptrend — price above 20 EMA, 20 EMA above 50 EMA, ADX > 25';

    // QQQ confirmation boosts confidence
    if (qqTrend === 'UP') {
      confidence += 15;
      description += '; QQQ confirms uptrend';
    } else if (qqTrend === 'DOWN') {
      confidence -= 10;
      description += '; QQQ diverging — caution';
    }

    // Strong ADX adds confidence
    if (spyData.adx > 35) {
      confidence += 5;
      description += '; strong trend strength (ADX ' + spyData.adx.toFixed(1) + ')';
    }

    // RSI confirmation
    if (spyData.rsi > 50 && spyData.rsi < 75) {
      confidence += 5;
    } else if (spyData.rsi >= 75) {
      confidence -= 5;
      description += '; overbought RSI warning';
    }
  }
  // --- TRENDING_DOWN ---
  else if (
    spyData.price < spyData.ema20 &&
    spyData.ema20 < spyData.ema50 &&
    spyData.adx > 25
  ) {
    regime = this.REGIMES.TRENDING_DOWN;
    confidence = 60;
    description = 'SPY in downtrend — price below 20 EMA, 20 EMA below 50 EMA, ADX > 25';

    // QQQ confirmation
    if (qqTrend === 'DOWN') {
      confidence += 15;
      description += '; QQQ confirms downtrend';
    } else if (qqTrend === 'UP') {
      confidence -= 10;
      description += '; QQQ diverging — caution';
    }

    // Strong ADX
    if (spyData.adx > 35) {
      confidence += 5;
      description += '; strong trend strength (ADX ' + spyData.adx.toFixed(1) + ')';
    }

    // RSI confirmation
    if (spyData.rsi < 50 && spyData.rsi > 25) {
      confidence += 5;
    } else if (spyData.rsi <= 25) {
      confidence -= 5;
      description += '; oversold RSI warning';
    }
  }
  // --- CHOPPY ---
  else if (spyData.adx < 20) {
    regime = this.REGIMES.CHOPPY;
    confidence = 55;
    description = 'Low ADX (' + spyData.adx.toFixed(1) + ') — range-bound / choppy market';

    if (qqData.adx < 20) {
      confidence += 10;
      description += '; QQQ also range-bound';
    }
  }
  // --- CHOPPY fallback: BB expanding with no clear trend ---
  else if (
    spyTrend === 'NEUTRAL' &&
    spyData.bbWidth > 0 &&
    this._bbWidthHistory.length >= 2 &&
    spyData.bbWidth > this._bbWidthHistory[this._bbWidthHistory.length - 2] * 1.1
  ) {
    regime = this.REGIMES.CHOPPY;
    confidence = 45;
    description = 'Bollinger bandwidth expanding with no directional trend — choppy conditions';
  }
  // --- UNKNOWN fallback ---
  else {
    regime = this.REGIMES.UNKNOWN;
    confidence = 20;
    description = 'No clear regime detected — mixed signals';

    if (spyTrend !== 'NEUTRAL') {
      description += '; SPY leans ' + spyTrend + ' but criteria not fully met';
    }
  }

  // Clamp confidence to 0-100
  if (confidence > 100) {
    confidence = 100;
  }
  if (confidence < 0) {
    confidence = 0;
  }

  var result = {
    regime: regime,
    confidence: confidence,
    spyTrend: spyTrend,
    qqTrend: qqTrend,
    description: description
  };

  // Log regime change
  if (this._lastRegime !== regime) {
    console.log(
      '[RegimeDetector] Regime changed: ' +
      (this._lastRegime || 'NONE') +
      ' -> ' +
      regime +
      ' (confidence: ' + confidence + '%) — ' +
      description
    );
    this._lastRegime = regime;
  }

  // Record to history
  this._addToHistory({
    timestamp: new Date().toISOString(),
    regime: regime,
    confidence: confidence,
    spyTrend: spyTrend,
    qqTrend: qqTrend,
    description: description
  });

  return result;
};

/**
 * Adjust trade parameters based on the detected market regime.
 *
 * @param {string} regime   - One of TRENDING_UP, TRENDING_DOWN, CHOPPY, BREAKOUT, UNKNOWN
 * @param {Object} params   - { confidence, direction, sizing }
 * @returns {Object} Adjusted params with the same shape plus any modifications
 */
MarketRegimeDetector.prototype.adjustTradeParams = function (regime, params) {
  if (!params) {
    return params;
  }

  // Clone to avoid mutating the original
  var adjusted = {
    confidence: params.confidence,
    direction: params.direction,
    sizing: params.sizing
  };

  switch (regime) {
    case this.REGIMES.TRENDING_UP:
      // Full size, favor LONG
      // No sizing reduction
      if (adjusted.direction === 'LONG') {
        adjusted.confidence = adjusted.confidence + 5;
      } else if (adjusted.direction === 'SHORT') {
        adjusted.confidence = adjusted.confidence - 10;
      }
      break;

    case this.REGIMES.TRENDING_DOWN:
      // Half size, favor SHORT
      adjusted.sizing = adjusted.sizing * 0.5;
      if (adjusted.direction === 'SHORT') {
        adjusted.confidence = adjusted.confidence + 5;
      } else if (adjusted.direction === 'LONG') {
        adjusted.confidence = adjusted.confidence - 10;
      }
      break;

    case this.REGIMES.CHOPPY:
      // Quarter size, skip if confidence < 65
      adjusted.sizing = adjusted.sizing * 0.25;
      if (adjusted.confidence < 65) {
        adjusted.sizing = 0;
        adjusted.skip = true;
        adjusted.skipReason = 'Choppy regime with confidence below 65';
      }
      break;

    case this.REGIMES.BREAKOUT:
      // Full size, both directions allowed, wider stops
      adjusted.widerStops = true;
      adjusted.stopMultiplier = 1.5;
      break;

    case this.REGIMES.UNKNOWN:
      // No adjustment
      break;

    default:
      // Unrecognised regime — no adjustment
      break;
  }

  // Clamp confidence to 0-100
  if (adjusted.confidence > 100) {
    adjusted.confidence = 100;
  }
  if (adjusted.confidence < 0) {
    adjusted.confidence = 0;
  }

  return adjusted;
};

/**
 * Return the last 20 regime changes with timestamps.
 *
 * @returns {Array<Object>} Array of regime history entries (most recent last)
 */
MarketRegimeDetector.prototype.getRegimeHistory = function () {
  var start = this._history.length > 20 ? this._history.length - 20 : 0;
  return this._history.slice(start);
};

module.exports = MarketRegimeDetector;
