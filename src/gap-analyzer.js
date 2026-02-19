// Gap Analyzer — Detect, classify, and predict gap trade opportunities
// Analyzes gap causation, stock personality, historical fill patterns,
// and current conditions to generate directional bias trade signals.

class GapAnalyzer {
    constructor() {
        this.gapHistory = {};   // ticker → historical gap patterns
        this.currentGaps = [];  // today's active gaps
        this.maxGaps = 30;
    }

    // ── Analyze All Tickers for Gaps ─────────────────────
    analyzeGaps(state) {
        var gaps = [];
        var watchlist = state.tickers || [];
        var processedTickers = {};

        // Build combined ticker list: watchlist + market-wide from flow/DP
        var allTickers = watchlist.slice();

        // Extract tickers from options flow
        (state.optionsFlow || []).forEach(function (f) {
            var t = (f.ticker || f.symbol || f.underlying_symbol || '').toUpperCase();
            if (t && !processedTickers[t] && allTickers.indexOf(t) === -1) {
                allTickers.push(t);
            }
        });

        // Extract tickers from dark pool
        (state.darkPoolRecent || []).forEach(function (d) {
            var t = (d.ticker || d.symbol || '').toUpperCase();
            if (t && !processedTickers[t] && allTickers.indexOf(t) === -1) {
                allTickers.push(t);
            }
        });

        // Extract tickers from top net impact
        (state.topNetImpact || []).forEach(function (n) {
            var t = (n.ticker || n.symbol || '').toUpperCase();
            if (t && !processedTickers[t] && allTickers.indexOf(t) === -1) {
                allTickers.push(t);
            }
        });

        allTickers.forEach(function (ticker) {
            if (processedTickers[ticker]) return;
            processedTickers[ticker] = true;

            var quote = (state.quotes || {})[ticker];
            var ta = (state.technicals || {})[ticker];
            var historical = [];
            var flow = (state.optionsFlow || []).filter(function (f) {
                return (f.ticker || f.symbol) === ticker;
            });
            var news = (state.news || []).filter(function (n) {
                return (n.tickers || []).indexOf(ticker) >= 0 || (n.ticker || '') === ticker;
            });

            // For non-watchlist tickers, try to build a synthetic quote from flow/DP data
            if (!quote) {
                var flowItem = flow[0];
                var dpItem = (state.darkPoolRecent || []).find(function (d) {
                    return (d.ticker || d.symbol) === ticker;
                });
                var price = 0, prevClose = 0;
                if (flowItem) {
                    price = parseFloat(flowItem.price || flowItem.underlying_price || flowItem.stock_price || 0);
                }
                if (dpItem) {
                    price = price || parseFloat(dpItem.price || dpItem.avg_price || 0);
                }
                // Without prev_close, we can't detect gaps for non-watchlist tickers
                // Try Polygon snapshot for prevClose
                var polygonSnap = (state.polygonSnapshots || {})[ticker];
                if (polygonSnap && polygonSnap.prevClose > 0) {
                    price = price || polygonSnap.price || polygonSnap.close || 0;
                    quote = {
                        price: price,
                        last: price,
                        open: polygonSnap.open || price,
                        prev_close: polygonSnap.prevClose,
                        volume: polygonSnap.volume || 0,
                        changePercent: polygonSnap.changePercent || 0
                    };
                } else {
                    if (price <= 0) return;
                    return; // still no prevClose
                }
            }

            var price = parseFloat(quote.last || quote.price || quote.close || 0);
            var prevClose = parseFloat(quote.prev_close || quote.previous_close || quote.prevClose || quote.previousClose || 0);
            var open = parseFloat(quote.open || 0);
            var volume = parseFloat(quote.volume || 0);

            // Fallback: derive prev_close from price and changePercent
            if (prevClose <= 0 && price > 0) {
                var changePct = parseFloat(quote.changePercent || quote.change_percent || 0);
                if (changePct !== 0) {
                    prevClose = price / (1 + changePct / 100);
                }
            }

            // Use open vs prev close for gap detection
            var gapRef = open > 0 ? open : price;
            if (prevClose <= 0 || gapRef <= 0) return;

            var gapPct = ((gapRef - prevClose) / prevClose) * 100;

            // Only flag gaps > 0.5%
            if (Math.abs(gapPct) < 0.5) return;

            var gapDir = gapPct > 0 ? 'UP' : 'DOWN';

            // ── Classify Gap Type ──
            var gapType = this._classifyGap(ticker, gapPct, news, state);

            // ── Analyze Causation ──
            var causation = this._analyzeCausation(news, gapDir, gapPct, state, ticker);

            // ── Stock Personality ──
            var personality = this._analyzePersonality(ticker, gapDir, ta, state);

            // ── Directional Bias ──
            var bias = this._calculateBias(ticker, gapDir, gapPct, ta, flow, personality, price, prevClose, volume, state);

            // ── Generate Trading Signal ──
            var signal = this._generateSignal(gapDir, gapPct, bias, personality, price, prevClose, ta);

            gaps.push({
                ticker: ticker,
                price: price,
                prevClose: prevClose,
                open: open,
                gapPct: +gapPct.toFixed(2),
                gapDir: gapDir,
                gapType: gapType,
                causation: causation,
                personality: personality,
                bias: bias,
                signal: signal,
                volume: volume,
                isWatchlist: watchlist.indexOf(ticker) >= 0,
                timestamp: new Date().toISOString()
            });
        }.bind(this));

        // Sort by absolute gap size
        gaps.sort(function (a, b) { return Math.abs(b.gapPct) - Math.abs(a.gapPct); });
        this.currentGaps = gaps.slice(0, this.maxGaps);
        return this.currentGaps;
    }

    // ── Gap Classification ────────────────────────────────
    _classifyGap(ticker, gapPct, news, state) {
        var earningsToday = state.earningsToday || { premarket: [], afterhours: [] };
        var allEarnings = (earningsToday.premarket || []).concat(earningsToday.afterhours || []);
        var hasEarnings = allEarnings.some(function (e) {
            return (e.ticker || e.symbol || '') === ticker;
        });

        if (hasEarnings) return 'EARNINGS';

        // Check news keywords for classification
        var newsText = news.map(function (n) {
            return ((n.headline || n.title || '') + ' ' + (n.summary || '')).toUpperCase();
        }).join(' ');

        if (newsText.indexOf('FDA') >= 0 || newsText.indexOf('APPROVAL') >= 0 || newsText.indexOf('DRUG') >= 0) return 'FDA/CATALYST';
        if (newsText.indexOf('UPGRADE') >= 0 || newsText.indexOf('DOWNGRADE') >= 0 || newsText.indexOf('PRICE TARGET') >= 0) return 'ANALYST';
        if (newsText.indexOf('ACQUISITION') >= 0 || newsText.indexOf('MERGER') >= 0 || newsText.indexOf('BUYOUT') >= 0) return 'M&A';
        if (newsText.indexOf('SHORT') >= 0 || newsText.indexOf('SQUEEZE') >= 0) return 'SHORT SQUEEZE';
        if (newsText.indexOf('GUIDANCE') >= 0 || newsText.indexOf('OUTLOOK') >= 0) return 'GUIDANCE';
        if (Math.abs(gapPct) > 8) return 'MOMENTUM';

        return 'TECHNICAL';
    }

    // ── Causation Analysis ────────────────────────────────
    _analyzeCausation(news, gapDir, gapPct, state, ticker) {
        var cause = { reason: 'Unknown', detail: '', confidence: 50 };

        if (news.length > 0) {
            var topNews = news[0];
            cause.reason = topNews.headline || topNews.title || 'News catalyst';
            cause.detail = topNews.summary || '';
            cause.confidence = 80;
        }

        // Check if market-wide move
        var tide = state.marketTide;
        if (tide) {
            var tideScore = parseFloat(tide.score || tide.overallScore || 0);
            if (gapDir === 'UP' && tideScore > 65) {
                cause.marketContext = 'Aligned with bullish market';
            } else if (gapDir === 'DOWN' && tideScore < 35) {
                cause.marketContext = 'Aligned with bearish market';
            } else if (gapDir === 'UP' && tideScore < 40) {
                cause.marketContext = 'Against bearish market — relative strength';
                cause.confidence += 10;
            } else if (gapDir === 'DOWN' && tideScore > 60) {
                cause.marketContext = 'Against bullish market — relative weakness';
                cause.confidence += 10;
            }
        }

        return cause;
    }

    // ── Stock Personality Analysis ─────────────────────────
    _analyzePersonality(ticker, gapDir, ta, state) {
        var personality = {
            type: 'UNKNOWN',
            fillRate: null,           // % of gaps filled same day
            avgGapDayRange: null,     // avg range on gap days
            typicalPattern: 'UNKNOWN', // gap-and-go, fade, fill
            description: ''
        };

        // Use RSI and MA data to infer behavior patterns
        if (ta) {
            var rsi = parseFloat(ta.rsi || 0);
            var ema9 = ta.ema ? parseFloat(ta.ema.ema9 || 0) : 0;
            var ema20 = ta.ema ? parseFloat(ta.ema.ema20 || 0) : 0;
            var trendUp = ema9 > ema20;

            if (gapDir === 'UP') {
                if (rsi > 70) {
                    personality.type = 'OVERBOUGHT_GAPPER';
                    personality.typicalPattern = 'FADE';
                    personality.description = 'Overbought territory — historically fades after gap up. Watch for profit-taking pullback.';
                    personality.fillRate = 65;
                } else if (rsi > 55 && trendUp) {
                    personality.type = 'MOMENTUM_RUNNER';
                    personality.typicalPattern = 'GAP_AND_GO';
                    personality.description = 'Strong trend + momentum gap — typically runs further before pulling back.';
                    personality.fillRate = 30;
                } else if (rsi < 40) {
                    personality.type = 'OVERSOLD_BOUNCE';
                    personality.typicalPattern = 'GAP_AND_GO';
                    personality.description = 'Bouncing from oversold — likely buy-the-dip recovery. Watch for follow-through.';
                    personality.fillRate = 40;
                } else {
                    personality.type = 'NEUTRAL_GAPPER';
                    personality.typicalPattern = 'MIXED';
                    personality.description = 'No strong bias — wait for first 30min to establish direction.';
                    personality.fillRate = 50;
                }
            } else {
                // Gap DOWN
                if (rsi < 30) {
                    personality.type = 'OVERSOLD_GAPPER';
                    personality.typicalPattern = 'BOUNCE';
                    personality.description = 'Oversold territory — historically bounces after gap down. Buy-the-dip opportunity.';
                    personality.fillRate = 60;
                } else if (rsi < 45 && !trendUp) {
                    personality.type = 'BREAKDOWN';
                    personality.typicalPattern = 'CONTINUATION';
                    personality.description = 'Weak trend + gap down — typically continues selling. Avoid catching knives.';
                    personality.fillRate = 25;
                } else if (rsi > 60) {
                    personality.type = 'PULLBACK_DIP';
                    personality.typicalPattern = 'FILL';
                    personality.description = 'Strong stock dipping — this is the buy-the-dip setup. Usually fills the gap.';
                    personality.fillRate = 70;
                } else {
                    personality.type = 'NEUTRAL_GAPPER';
                    personality.typicalPattern = 'MIXED';
                    personality.description = 'No strong signal — wait for price action confirmation.';
                    personality.fillRate = 50;
                }
            }
        }

        return personality;
    }

    // ── Directional Bias Calculation ──────────────────────
    _calculateBias(ticker, gapDir, gapPct, ta, flow, personality, price, prevClose, volume, state) {
        var score = 50; // neutral start
        var factors = [];

        // 1. RSI confirmation
        var rsi = ta ? parseFloat(ta.rsi || 50) : 50;
        if (gapDir === 'UP') {
            if (rsi > 70) { score -= 15; factors.push({ name: 'Overbought RSI', impact: -15 }); }
            else if (rsi > 55) { score += 10; factors.push({ name: 'Bullish RSI', impact: +10 }); }
            else if (rsi < 40) { score += 15; factors.push({ name: 'Oversold bounce', impact: +15 }); }
        } else {
            if (rsi < 30) { score += 15; factors.push({ name: 'Oversold RSI (bounce likely)', impact: +15 }); }
            else if (rsi < 45) { score -= 10; factors.push({ name: 'Weak RSI continuation', impact: -10 }); }
            else if (rsi > 60) { score += 10; factors.push({ name: 'Strong stock dipping (buy)', impact: +10 }); }
        }

        // 2. Options flow
        var calls = 0, puts = 0;
        flow.forEach(function (f) {
            var pc = (f.put_call || f.option_type || '').toUpperCase();
            if (pc.indexOf('CALL') >= 0) calls++;
            else if (pc.indexOf('PUT') >= 0) puts++;
        });
        var callRatio = (calls + puts) > 0 ? calls / (calls + puts) : 0.5;
        if (gapDir === 'UP' && callRatio > 0.65) { score += 10; factors.push({ name: 'Bullish flow confirms', impact: +10 }); }
        else if (gapDir === 'UP' && callRatio < 0.4) { score -= 10; factors.push({ name: 'Bearish flow contradicts', impact: -10 }); }
        else if (gapDir === 'DOWN' && callRatio < 0.4) { score -= 10; factors.push({ name: 'Bearish flow confirms sell', impact: -10 }); }
        else if (gapDir === 'DOWN' && callRatio > 0.6) { score += 10; factors.push({ name: 'Bullish flow — dip buying', impact: +10 }); }

        // 3. EMA trend alignment
        if (ta && ta.ema) {
            var ema9 = parseFloat(ta.ema.ema9 || 0);
            var ema20 = parseFloat(ta.ema.ema20 || 0);
            if (gapDir === 'UP' && ema9 > ema20) { score += 8; factors.push({ name: 'Uptrend aligned', impact: +8 }); }
            else if (gapDir === 'DOWN' && ema9 < ema20) { score -= 8; factors.push({ name: 'Downtrend aligned', impact: -8 }); }
            else if (gapDir === 'UP' && ema9 < ema20) { score -= 5; factors.push({ name: 'Against downtrend', impact: -5 }); }
        }

        // 4. Gap size factor
        if (Math.abs(gapPct) > 10) { factors.push({ name: 'Large gap (>10%)', impact: 0 }); }
        else if (Math.abs(gapPct) > 5) { score += 5; factors.push({ name: 'Moderate gap', impact: +5 }); }

        // 5. Fill rate expectation from personality
        if (personality.fillRate !== null) {
            if (personality.typicalPattern === 'FADE' || personality.typicalPattern === 'FILL') {
                factors.push({ name: personality.typicalPattern + ' pattern (' + personality.fillRate + '% fill rate)', impact: 0 });
            }
        }

        // Clamp 0-100
        score = Math.max(0, Math.min(100, score));

        // Determine direction
        var direction;
        if (gapDir === 'UP') {
            direction = score >= 60 ? 'CONTINUE_UP' : score <= 40 ? 'FADE_DOWN' : 'NEUTRAL';
        } else {
            direction = score >= 60 ? 'BOUNCE_UP' : score <= 40 ? 'CONTINUE_DOWN' : 'NEUTRAL';
        }

        return {
            score: score,
            direction: direction,
            label: direction.replace(/_/g, ' '),
            factors: factors
        };
    }

    // ── Generate Trading Signal ───────────────────────────
    _generateSignal(gapDir, gapPct, bias, personality, price, prevClose, ta) {
        var entry = price;
        var stop, target1, target2, strategy;
        var absGap = Math.abs(gapPct);

        if (gapDir === 'UP') {
            if (bias.direction === 'CONTINUE_UP') {
                strategy = 'GAP & GO LONG';
                stop = +(price * 0.97).toFixed(2);
                target1 = +(price * (1 + absGap / 200)).toFixed(2);
                target2 = +(price * (1 + absGap / 100)).toFixed(2);
            } else if (bias.direction === 'FADE_DOWN') {
                strategy = 'FADE THE GAP (SHORT)';
                entry = price;
                stop = +(price * 1.02).toFixed(2);
                target1 = +(prevClose + (price - prevClose) * 0.5).toFixed(2); // 50% fill
                target2 = +(prevClose * 1.002).toFixed(2); // full fill
            } else {
                strategy = 'WAIT FOR CONFIRMATION';
                stop = +(price * 0.97).toFixed(2);
                target1 = +(price * 1.02).toFixed(2);
                target2 = +(price * 1.04).toFixed(2);
            }
        } else {
            // Gap DOWN
            if (bias.direction === 'BOUNCE_UP') {
                strategy = 'BUY THE DIP';
                stop = +(price * 0.97).toFixed(2);
                target1 = +(prevClose - (prevClose - price) * 0.5).toFixed(2); // 50% fill up
                target2 = +(prevClose * 0.998).toFixed(2); // near full fill
            } else if (bias.direction === 'CONTINUE_DOWN') {
                strategy = 'SHORT CONTINUATION';
                stop = +(price * 1.02).toFixed(2);
                target1 = +(price * (1 - absGap / 200)).toFixed(2);
                target2 = +(price * (1 - absGap / 100)).toFixed(2);
            } else {
                strategy = 'WAIT FOR CONFIRMATION';
                stop = +(price * 0.97).toFixed(2);
                target1 = +(price * 1.02).toFixed(2);
                target2 = +(prevClose).toFixed(2);
            }
        }

        return {
            strategy: strategy,
            entry: entry,
            stop: stop,
            target1: target1,
            target2: target2
        };
    }

    // ── Getters ───────────────────────────────────────────
    getGaps() { return this.currentGaps; }
}

module.exports = { GapAnalyzer };
