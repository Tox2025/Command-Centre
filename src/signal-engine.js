// Signal Engine - Multi-source weighted scoring for trade predictions
// 19 signals across 8 categories with session-aware adjustable weights

const SIGNAL_WEIGHTS = {
    ema_alignment: 5,      // ↑ from 3 — strongest trend predictor from trade data
    rsi_position: 3,       // ↑ from 2 — RSI Bullish had 100% accuracy
    macd_histogram: 2,
    bollinger_position: 1,
    bb_squeeze: 2,
    vwap_deviation: 2,
    call_put_ratio: 3,
    sweep_activity: 2,
    dark_pool_direction: 4, // ↑ from 3 — institutional flow is highly predictive
    insider_congress: 1,
    gex_positioning: 2,
    iv_rank: 1,
    short_interest: 1,
    volume_spike: 2,        // ↑ from 1 — Session Bounce had 80% accuracy
    regime_alignment: 3,
    gamma_wall: 2,
    iv_skew: 1,
    candlestick_pattern: 2,
    news_sentiment: 2,      // ↑ from 1 — News Bullish had 83% accuracy
    multi_tf_confluence: 5,  // multi-timeframe agreement bonus
    rsi_divergence: 3,       // NEW — high-probability reversal/continuation signal
    adx_filter: 0,           // NEW — not directional; used as gate/multiplier on other signals
    volatility_runner: 5,     // NEW — gap-up micro-cap runner (MLEC-style halt setups)
    // Phase 1 API Enhancement signals
    net_premium_momentum: 5,   // smart money net call/put premium flow
    strike_flow_levels: 4,     // options flow concentration at price levels
    greek_flow_momentum: 4,    // delta/gamma exposure shifts
    sector_tide_alignment: 3,  // sector-level call/put flow direction
    etf_tide_macro: 3,         // SPY/QQQ flow for macro direction
    squeeze_composite: 5,      // short volume + FTD squeeze score
    seasonality_alignment: 2,  // historical monthly return patterns
    vol_regime: 3,             // realized vol vs implied vol regime
    insider_conviction: 3,     // insider net buy/sell flow
    spot_gamma_pin: 3,         // gamma pinning detection at spot price
    flow_horizon: 2,           // options flow expiry concentration
    volume_direction: 3         // buy vs sell volume proxy from flow + dark pool
};

// Session multipliers: scale signal weights per trading session
// Must match scheduler session names: OPEN_RUSH, POWER_OPEN, PRE_MARKET, MIDDAY, POWER_HOUR, AFTER_HOURS, OVERNIGHT
const SESSION_MULTIPLIERS = {
    OPEN_RUSH: {   // 9:01-9:20 AM — fast scalps, flow-driven
        ema_alignment: 0.6, rsi_position: 0.8, macd_histogram: 0.8, bollinger_position: 0.6,
        bb_squeeze: 0.4, vwap_deviation: 0.5, call_put_ratio: 1.5, sweep_activity: 1.6,
        dark_pool_direction: 0.8, insider_congress: 0.2, gex_positioning: 1.6,
        iv_rank: 0.3, short_interest: 0.3, volume_spike: 1.5,
        regime_alignment: 0.8, gamma_wall: 1.4, iv_skew: 0.6, candlestick_pattern: 1.3, news_sentiment: 0.5,
        rsi_divergence: 0.7, adx_filter: 1.0, volatility_runner: 1.8,
        net_premium_momentum: 1.6, strike_flow_levels: 1.4, greek_flow_momentum: 1.5,
        sector_tide_alignment: 0.6, etf_tide_macro: 0.6, squeeze_composite: 1.0,
        seasonality_alignment: 0.3, vol_regime: 0.5, insider_conviction: 0.2,
        spot_gamma_pin: 1.4, flow_horizon: 0.8, volume_direction: 1.5
    },
    POWER_OPEN: {  // 9:21-10:00 AM — momentum + flow
        ema_alignment: 0.8, rsi_position: 1.0, macd_histogram: 1.0, bollinger_position: 0.8,
        bb_squeeze: 0.6, vwap_deviation: 0.7, call_put_ratio: 1.3, sweep_activity: 1.4,
        dark_pool_direction: 1.0, insider_congress: 0.3, gex_positioning: 1.5,
        iv_rank: 0.5, short_interest: 0.3, volume_spike: 1.4,
        regime_alignment: 1.0, gamma_wall: 1.3, iv_skew: 0.8, candlestick_pattern: 1.2, news_sentiment: 0.6,
        rsi_divergence: 0.9, adx_filter: 1.0, volatility_runner: 1.6,
        net_premium_momentum: 1.4, strike_flow_levels: 1.3, greek_flow_momentum: 1.3,
        sector_tide_alignment: 0.8, etf_tide_macro: 0.8, squeeze_composite: 1.0,
        seasonality_alignment: 0.4, vol_regime: 0.6, insider_conviction: 0.3,
        spot_gamma_pin: 1.3, flow_horizon: 0.9, volume_direction: 1.3
    },
    PRE_MARKET: {  // 8:30-9:00 AM — news + gap driven
        ema_alignment: 0.5, rsi_position: 0.6, macd_histogram: 0.5, bollinger_position: 0.4,
        bb_squeeze: 0.3, vwap_deviation: 0.3, call_put_ratio: 1.0, sweep_activity: 1.0,
        dark_pool_direction: 0.8, insider_congress: 0.8, gex_positioning: 1.0,
        iv_rank: 0.8, short_interest: 0.5, volume_spike: 0.5,
        regime_alignment: 1.0, gamma_wall: 0.8, iv_skew: 1.0, candlestick_pattern: 0.5, news_sentiment: 1.5,
        rsi_divergence: 0.5, adx_filter: 0.8, volatility_runner: 1.2,
        net_premium_momentum: 0.8, strike_flow_levels: 0.5, greek_flow_momentum: 0.5,
        sector_tide_alignment: 0.5, etf_tide_macro: 0.5, squeeze_composite: 0.8,
        seasonality_alignment: 0.8, vol_regime: 0.8, insider_conviction: 1.0,
        spot_gamma_pin: 0.5, flow_horizon: 0.5, volume_direction: 0.5
    },
    MIDDAY: {      // 10:01 AM-3:00 PM — balanced day trading
        ema_alignment: 1.0, rsi_position: 1.1, macd_histogram: 0.9, bollinger_position: 1.3,
        bb_squeeze: 1.5, vwap_deviation: 1.4, call_put_ratio: 1.0, sweep_activity: 1.0,
        dark_pool_direction: 1.2, insider_congress: 0.5, gex_positioning: 0.8,
        iv_rank: 0.8, short_interest: 0.5, volume_spike: 1.2,
        regime_alignment: 1.2, gamma_wall: 1.0, iv_skew: 1.0, candlestick_pattern: 1.0, news_sentiment: 0.8,
        rsi_divergence: 1.3, adx_filter: 1.2, volatility_runner: 1.0,
        net_premium_momentum: 1.2, strike_flow_levels: 1.2, greek_flow_momentum: 1.2,
        sector_tide_alignment: 1.0, etf_tide_macro: 1.0, squeeze_composite: 1.2,
        seasonality_alignment: 1.0, vol_regime: 1.0, insider_conviction: 0.8,
        spot_gamma_pin: 1.0, flow_horizon: 1.0, volume_direction: 1.0
    },
    POWER_HOUR: {  // 3:01-4:15 PM — closing momentum
        ema_alignment: 1.0, rsi_position: 1.0, macd_histogram: 1.0, bollinger_position: 0.9,
        bb_squeeze: 0.8, vwap_deviation: 1.1, call_put_ratio: 1.4, sweep_activity: 1.3,
        dark_pool_direction: 1.2, insider_congress: 0.5, gex_positioning: 0.7,
        iv_rank: 0.8, short_interest: 0.5, volume_spike: 1.3,
        regime_alignment: 1.1, gamma_wall: 1.2, iv_skew: 1.0, candlestick_pattern: 1.1, news_sentiment: 0.7,
        rsi_divergence: 1.2, adx_filter: 1.0, volatility_runner: 0.8,
        net_premium_momentum: 1.3, strike_flow_levels: 1.3, greek_flow_momentum: 1.2,
        sector_tide_alignment: 1.0, etf_tide_macro: 1.0, squeeze_composite: 1.0,
        seasonality_alignment: 0.8, vol_regime: 0.8, insider_conviction: 0.5,
        spot_gamma_pin: 1.2, flow_horizon: 1.0, volume_direction: 1.2
    },
    AFTER_HOURS: { // 4:16-5:00 PM — reduced signals
        ema_alignment: 1.2, rsi_position: 1.0, macd_histogram: 0.8, bollinger_position: 0.7,
        bb_squeeze: 0.4, vwap_deviation: 0.3, call_put_ratio: 0.5, sweep_activity: 0.4,
        dark_pool_direction: 1.0, insider_congress: 1.0, gex_positioning: 0.3,
        iv_rank: 1.0, short_interest: 1.0, volume_spike: 0.5,
        regime_alignment: 1.2, gamma_wall: 0.5, iv_skew: 1.0, candlestick_pattern: 0.8, news_sentiment: 1.2,
        rsi_divergence: 1.0, adx_filter: 1.0, volatility_runner: 0.3,
        net_premium_momentum: 0.5, strike_flow_levels: 0.5, greek_flow_momentum: 0.5,
        sector_tide_alignment: 1.0, etf_tide_macro: 1.0, squeeze_composite: 0.8,
        seasonality_alignment: 1.2, vol_regime: 1.0, insider_conviction: 1.2,
        spot_gamma_pin: 0.3, flow_horizon: 0.5, volume_direction: 0.4
    },
    OVERNIGHT: {   // 5:01 PM-8:29 AM — swing analysis
        ema_alignment: 1.4, rsi_position: 1.2, macd_histogram: 1.1, bollinger_position: 1.0,
        bb_squeeze: 0.6, vwap_deviation: 0.3, call_put_ratio: 0.6, sweep_activity: 0.5,
        dark_pool_direction: 1.3, insider_congress: 1.5, gex_positioning: 0.3,
        iv_rank: 1.3, short_interest: 1.4, volume_spike: 0.8,
        regime_alignment: 1.5, gamma_wall: 0.5, iv_skew: 1.3, candlestick_pattern: 1.0, news_sentiment: 1.4,
        rsi_divergence: 1.4, adx_filter: 1.3, volatility_runner: 0.2,
        net_premium_momentum: 0.4, strike_flow_levels: 0.4, greek_flow_momentum: 0.4,
        sector_tide_alignment: 1.2, etf_tide_macro: 1.2, squeeze_composite: 1.4,
        seasonality_alignment: 1.4, vol_regime: 1.2, insider_conviction: 1.5,
        spot_gamma_pin: 0.2, flow_horizon: 0.3, volume_direction: 0.3
    }
};

class SignalEngine {
    constructor(weights) {
        this.weights = weights || { ...SIGNAL_WEIGHTS };
    }

    updateWeights(newWeights) {
        Object.assign(this.weights, newWeights);
    }

    // Get effective weight: base weight * session multiplier
    _ew(key, session) {
        const base = this.weights[key] || 0;
        const mult = SESSION_MULTIPLIERS[session];
        return mult ? base * (mult[key] || 1.0) : base;
    }

    // Score a ticker using all available data sources
    score(ticker, data, session) {
        const signals = [];
        let bull = 0, bear = 0;
        const sess = session || null;
        const ta = data.technicals || {};
        const flow = data.flow || [];
        const dp = data.darkPool || [];
        const gex = data.gex || [];
        const ivData = data.ivRank;
        const siData = data.shortInterest;
        const insiderData = data.insider || [];
        const congressData = data.congress || [];
        const quote = data.quote || {};
        const regime = data.regime || null;
        const sentiment = data.sentiment || null;
        const patterns = (ta.patterns || []);

        // 1. EMA Alignment — suppress bearish in RANGING regime (31% accuracy in ranging)
        const w1 = this._ew('ema_alignment', sess);
        const isRanging = regime && regime.regime === 'RANGING';
        if (ta.emaBias === 'BULLISH') {
            bull += w1; signals.push({ name: 'EMA Alignment', dir: 'BULL', weight: w1, detail: '9>20>50 stacked bullish' });
        } else if (ta.emaBias === 'BEARISH') {
            var emaW = isRanging ? w1 * 0.4 : w1;  // Scale down in ranging (no trend to align with)
            bear += emaW; signals.push({ name: 'EMA Alignment', dir: 'BEAR', weight: +emaW.toFixed(2), detail: '9<20<50 stacked bearish' + (isRanging ? ' (ranging dampened)' : '') });
        }

        // 2. RSI Position - Context Aware
        const w2 = this._ew('rsi_position', sess);
        if (ta.rsi !== null && ta.rsi !== undefined) {
            // Check for strong trend context
            const isTrendingUp = regime && (regime.regime === 'TRENDING_UP');
            const isTrendingDown = regime && (regime.regime === 'TRENDING_DOWN');

            if (ta.rsi < 30) {
                if (isTrendingDown) {
                    // In downtrend, oversold is continuation/strong momentum, not necessarily reversal
                    bear += w2 * 0.5; signals.push({ name: 'RSI Bearish Momentum', dir: 'BEAR', weight: +(w2 * 0.5).toFixed(2), detail: 'RSI ' + ta.rsi.toFixed(1) + ' (Trend)' });
                } else {
                    bull += w2; signals.push({ name: 'RSI Oversold', dir: 'BULL', weight: w2, detail: 'RSI ' + ta.rsi.toFixed(1) });
                }
            } else if (ta.rsi > 70) {
                if (isTrendingUp) {
                    // In uptrend, overbought is continuation/strong momentum
                    bull += w2 * 0.5; signals.push({ name: 'RSI Bullish Momentum', dir: 'BULL', weight: +(w2 * 0.5).toFixed(2), detail: 'RSI ' + ta.rsi.toFixed(1) + ' (Trend)' });
                } else {
                    bear += w2; signals.push({ name: 'RSI Overbought', dir: 'BEAR', weight: w2, detail: 'RSI ' + ta.rsi.toFixed(1) });
                }
            } else if (ta.rsi > 55) {
                bull += w2 * 0.5; signals.push({ name: 'RSI Bullish', dir: 'BULL', weight: w2 * 0.5, detail: 'RSI ' + ta.rsi.toFixed(1) });
            } else if (ta.rsi < 45) {
                var rsiBearW = isRanging ? w2 * 0.2 : w2 * 0.5;  // Heavily dampen in ranging (0% accuracy)
                bear += rsiBearW; signals.push({ name: 'RSI Bearish', dir: 'BEAR', weight: +rsiBearW.toFixed(2), detail: 'RSI ' + ta.rsi.toFixed(1) + (isRanging ? ' (ranging dampened)' : '') });
            }
        }

        // 3. MACD Histogram — only fire if magnitude is meaningful (noise reduction)
        const w3 = this._ew('macd_histogram', sess);
        if (ta.macd && ta.macd.histogram !== null) {
            const hist = ta.macd.histogram;
            const atrVal = ta.atr || 1;
            // Only count MACD if histogram is > 0.5% of ATR (prevents noise from tiny values)
            if (Math.abs(hist) > atrVal * 0.005) {
                if (hist > 0) {
                    bull += w3; signals.push({ name: 'MACD Positive', dir: 'BULL', weight: w3, detail: 'Hist ' + hist.toFixed(3) });
                } else {
                    var macdBearW = isRanging ? w3 * 0.25 : w3;  // Heavily dampen in ranging (0% accuracy on 2/19)
                    bear += macdBearW; signals.push({ name: 'MACD Negative', dir: 'BEAR', weight: +macdBearW.toFixed(2), detail: 'Hist ' + hist.toFixed(3) + (isRanging ? ' (ranging dampened)' : '') });
                }
            }
        }

        // 4. Bollinger Band Position — enhanced with volume-confirmed dip buy / overbought exit
        const w4 = this._ew('bollinger_position', sess);
        if (ta.bollingerBands && ta.bollingerBands.position !== null) {
            const pos = ta.bollingerBands.position;
            const hasVolume = ta.volumeSpike || false; // volume confirmation
            const isTrendingUp = regime && regime.regime === 'TRENDING_UP';
            const isTrendingDown = regime && regime.regime === 'TRENDING_DOWN';

            if (pos < 0.10) {
                // Dip buy: at lower BB with volume = strong buy signal
                if (isTrendingDown) {
                    // In downtrend, hugging lower band is bearish continuation
                    bear += w4;
                    signals.push({ name: 'BB Band Walk Down', dir: 'BEAR', weight: w4, detail: 'Pos ' + pos.toFixed(2) });
                } else {
                    var bbBullWeight = hasVolume ? w4 * 2.0 : w4;
                    var bbLabel = hasVolume ? 'BB Dip Buy (Vol)' : 'BB Near Lower';
                    bull += bbBullWeight;
                    signals.push({ name: bbLabel, dir: 'BULL', weight: +bbBullWeight.toFixed(2), detail: 'Pos ' + pos.toFixed(2) + (hasVolume ? ' + volume confirmed' : '') });
                }
            } else if (pos < 0.20) {
                var bbApprWeight = hasVolume ? w4 * 1.2 : w4 * 0.5;
                bull += bbApprWeight;
                signals.push({ name: 'BB Approaching Lower', dir: 'BULL', weight: +bbApprWeight.toFixed(2), detail: 'Position ' + pos.toFixed(2) });
            } else if (pos > 0.90) {
                // Overbought exit: at upper BB with volume = strong sell signal
                if (isTrendingUp) {
                    // In uptrend, hugging upper band is bullish continuation
                    bull += w4;
                    signals.push({ name: 'BB Band Walk Up', dir: 'BULL', weight: w4, detail: 'Pos ' + pos.toFixed(2) });
                } else {
                    var bbBearWeight = hasVolume ? w4 * 2.0 : w4;
                    var bbExitLabel = hasVolume ? 'BB Overbought Exit (Vol)' : 'BB Near Upper';
                    bear += bbBearWeight;
                    signals.push({ name: bbExitLabel, dir: 'BEAR', weight: +bbBearWeight.toFixed(2), detail: 'Pos ' + pos.toFixed(2) + (hasVolume ? ' + sell volume' : '') });
                }
            } else if (pos > 0.80) {
                bear += w4 * 0.5;
                signals.push({ name: 'BB Approaching Upper', dir: 'BEAR', weight: +(w4 * 0.5).toFixed(2), detail: 'Position ' + pos.toFixed(2) });
            }
        }

        // 5. Call/Put Flow Ratio
        const w5 = this._ew('call_put_ratio', sess);
        if (flow.length > 0) {
            let callPrem = 0, putPrem = 0;
            flow.forEach(f => {
                const prem = parseFloat(f.premium || f.total_premium || 0);
                const pc = (f.put_call || f.option_type || f.sentiment || '').toUpperCase();
                if (pc.includes('CALL') || pc.includes('BULLISH') || pc.includes('C')) callPrem += prem;
                else putPrem += prem;
            });
            const total = callPrem + putPrem;
            if (total > 0) {
                const ratio = callPrem / (putPrem || 1);
                if (ratio > 1.5) {
                    bull += w5; signals.push({ name: 'Call Flow Dominant', dir: 'BULL', weight: w5, detail: 'Ratio ' + ratio.toFixed(2) });
                } else if (ratio < 0.67) {
                    bear += w5; signals.push({ name: 'Put Flow Dominant', dir: 'BEAR', weight: w5, detail: 'Ratio ' + ratio.toFixed(2) });
                }
            }
        }

        // 6. Sweep Activity
        const w6 = this._ew('sweep_activity', sess);
        const sweeps = flow.filter(f => {
            const tt = (f.trade_type || f.execution_type || '').toLowerCase();
            return tt.includes('sweep');
        });
        if (sweeps.length > 0) {
            let bullSweeps = 0, bearSweeps = 0;
            sweeps.forEach(s => {
                const pc = (s.put_call || s.option_type || s.sentiment || '').toUpperCase();
                if (pc.includes('CALL') || pc.includes('BULLISH')) bullSweeps++;
                else bearSweeps++;
            });
            if (bullSweeps > bearSweeps) {
                bull += w6; signals.push({ name: 'Bullish Sweeps', dir: 'BULL', weight: w6, detail: bullSweeps + ' sweeps' });
            } else if (bearSweeps > bullSweeps) {
                bear += w6; signals.push({ name: 'Bearish Sweeps', dir: 'BEAR', weight: w6, detail: bearSweeps + ' sweeps' });
            }
        }

        // 7. Dark Pool Direction
        const w7 = this._ew('dark_pool_direction', sess);
        if (dp.length > 0) {
            let dpBull = 0, dpBear = 0;
            dp.forEach(d => {
                const price = parseFloat(d.price || 0);
                const bid = parseFloat(d.nbbo_bid || d.bid || 0);
                const ask = parseFloat(d.nbbo_ask || d.ask || 0);
                const mid = (bid + ask) / 2;
                if (price > 0 && mid > 0) {
                    if (price >= mid) dpBull++; else dpBear++;
                }
            });
            if (dpBull > dpBear * 1.3) {
                bull += w7; signals.push({ name: 'DP Above Mid', dir: 'BULL', weight: w7, detail: dpBull + 'B/' + dpBear + 'S' });
            } else if (dpBear > dpBull * 1.3) {
                bear += w7; signals.push({ name: 'DP Below Mid', dir: 'BEAR', weight: w7, detail: dpBear + 'S/' + dpBull + 'B' });
            }
        }

        // 8. GEX Positioning
        const w8 = this._ew('gex_positioning', sess);
        if (gex.length > 0) {
            const curPrice = parseFloat(quote.last || quote.price || quote.close || 0);
            if (curPrice > 0) {
                let posGexAbove = 0, negGexBelow = 0;
                gex.forEach(g => {
                    const strike = parseFloat(g.strike || 0);
                    const net = parseFloat(g.call_gex || 0) + parseFloat(g.put_gex || 0);
                    if (strike > curPrice && net > 0) posGexAbove += net;
                    if (strike < curPrice && net < 0) negGexBelow += Math.abs(net);
                });
                if (posGexAbove > negGexBelow * 1.5) {
                    bull += w8; signals.push({ name: 'GEX Support Above', dir: 'BULL', weight: w8, detail: 'Positive wall above' });
                } else if (negGexBelow > posGexAbove * 1.5) {
                    bear += w8; signals.push({ name: 'GEX Magnet Below', dir: 'BEAR', weight: w8, detail: 'Negative magnet below' });
                }
            }
        }

        // 9. IV Rank
        const w9 = this._ew('iv_rank', sess);
        if (ivData) {
            const ivArr = Array.isArray(ivData) ? ivData : [ivData];
            const latest = ivArr[ivArr.length - 1] || {};
            const ivRank = parseFloat(latest.iv_rank_1y || latest.iv_rank || 0);
            if (ivRank < 25) {
                // Low IV = cheap options, but NOT directionally predictive (25% accuracy)
                signals.push({ name: 'Low IV', dir: 'NEUTRAL', weight: 0, detail: 'IV Rank ' + ivRank.toFixed(0) + ' (cheap options)' });
            } else if (ivRank > 75) {
                bear += w9; signals.push({ name: 'High IV', dir: 'BEAR', weight: w9, detail: 'IV Rank ' + ivRank.toFixed(0) + ' (fear)' });
            }
        }

        // 10. Short Interest (with data validation — cap at 100% to reject bad data)
        const w10 = this._ew('short_interest', sess);
        if (siData) {
            const siArr = Array.isArray(siData) ? siData : [siData];
            const latest = siArr[siArr.length - 1] || {};
            var siPct = parseFloat(latest.si_float_returned || latest.short_interest_pct || 0);
            if (siPct > 100) siPct = 0; // Bad data — reject impossible SI values
            if (siPct > 15 && bull > bear) {
                bull += w10; signals.push({ name: 'Short Squeeze', dir: 'BULL', weight: w10, detail: siPct.toFixed(1) + '% SI + bullish' });
            } else if (siPct > 15 && bear > bull) {
                bear += w10; signals.push({ name: 'High SI Pressure', dir: 'BEAR', weight: w10, detail: siPct.toFixed(1) + '% SI + bearish' });
            }
        }

        // 11. Insider/Congress Activity
        const w11 = this._ew('insider_congress', sess);
        const recentBuys = insiderData.filter(i => {
            const type = (i.transaction_type || i.acquisition_or_disposition || '').toUpperCase();
            return type.includes('BUY') || type.includes('P') || type === 'A';
        }).length;
        const recentSells = insiderData.filter(i => {
            const type = (i.transaction_type || i.acquisition_or_disposition || '').toUpperCase();
            return type.includes('SELL') || type.includes('S') || type === 'D';
        }).length;
        const congBuys = congressData.filter(c => (c.type || c.transaction_type || '').toLowerCase().includes('purchase')).length;
        const congSells = congressData.filter(c => (c.type || c.transaction_type || '').toLowerCase().includes('sale')).length;
        const smartBuy = recentBuys + congBuys;
        const smartSell = recentSells + congSells;
        if (smartBuy > smartSell && smartBuy > 0) {
            bull += w11; signals.push({ name: 'Insider/Congress Buys', dir: 'BULL', weight: w11, detail: smartBuy + ' buys' });
        } else if (smartSell > smartBuy && smartSell > 0) {
            bear += w11; signals.push({ name: 'Insider/Congress Sells', dir: 'BEAR', weight: w11, detail: smartSell + ' sells' });
        }

        // 12. Volume Spike + Intraday Volume Rate
        const w12 = this._ew('volume_spike', sess);
        if (ta.volumeSpike) {
            const dir = bull > bear ? 'BULL' : 'BEAR';
            const pts = w12;
            if (dir === 'BULL') bull += pts; else bear += pts;
            signals.push({ name: 'Volume Spike', dir: dir, weight: pts, detail: 'Unusual volume detected' });
        }

        // 12b. Intraday price action — detect bounce from session low or rejection from high
        if (quote) {
            const curPrice = parseFloat(quote.last || quote.price || 0);
            const sessionHigh = parseFloat(quote.high || 0);
            const sessionLow = parseFloat(quote.low || 0);
            const sessionRange = sessionHigh - sessionLow;
            if (curPrice > 0 && sessionRange > 0 && sessionHigh > 0) {
                const posInRange = (curPrice - sessionLow) / sessionRange;
                // Bouncing from session low (price now near high after being at low)
                if (posInRange > 0.7 && sessionRange / curPrice * 100 > 1.0) {
                    bull += w12; signals.push({ name: 'Session Bounce', dir: 'BULL', weight: w12, detail: 'From $' + sessionLow.toFixed(2) + ' to $' + curPrice.toFixed(2) + ' (' + (sessionRange / curPrice * 100).toFixed(1) + '% range)' });
                }
                // Rejecting from session high (price now near low after being at high)
                else if (posInRange < 0.3 && sessionRange / curPrice * 100 > 1.0) {
                    bear += w12; signals.push({ name: 'Session Rejection', dir: 'BEAR', weight: w12, detail: 'From $' + sessionHigh.toFixed(2) + ' to $' + curPrice.toFixed(2) + ' (' + (sessionRange / curPrice * 100).toFixed(1) + '% range)' });
                }
            }
        }

        // 13. Bollinger Squeeze (tight bands = breakout imminent)
        const w13 = this._ew('bb_squeeze', sess);
        if (ta.bollingerBands && ta.bollingerBands.bandwidth !== undefined) {
            const bw = ta.bollingerBands.bandwidth;
            const pos = ta.bollingerBands.position;
            if (bw < 0.05) {
                // Tight squeeze - breakout signal based on position
                if (pos > 0.6) {
                    bull += w13; signals.push({ name: 'BB Squeeze Breakout', dir: 'BULL', weight: w13, detail: 'BW ' + bw.toFixed(3) + ' pos ' + pos.toFixed(2) });
                } else if (pos < 0.4) {
                    bear += w13; signals.push({ name: 'BB Squeeze Breakdown', dir: 'BEAR', weight: w13, detail: 'BW ' + bw.toFixed(3) + ' pos ' + pos.toFixed(2) });
                }
            } else if (bw > 0.1 && pos !== null) {
                // Wide bands = mean reversion opportunity (strong in MIDDAY)
                if (pos > 0.9) {
                    bear += w13 * 0.7; signals.push({ name: 'BB Reversion Down', dir: 'BEAR', weight: w13 * 0.7, detail: 'Extended at upper band' });
                } else if (pos < 0.1) {
                    bull += w13 * 0.7; signals.push({ name: 'BB Reversion Up', dir: 'BULL', weight: w13 * 0.7, detail: 'Extended at lower band' });
                }
            }
        }

        // 14. VWAP Deviation (mean reversion for intraday)
        const w14 = this._ew('vwap_deviation', sess);
        if (ta.vwap && quote) {
            const curPrice = parseFloat(quote.last || quote.price || quote.close || 0);
            const vwap = parseFloat(ta.vwap);
            if (curPrice > 0 && vwap > 0) {
                const devPct = (curPrice - vwap) / vwap * 100;
                if (devPct > 1.5) {
                    if (regime && regime.regime === 'TRENDING_UP') {
                        bull += w14 * 0.5; signals.push({ name: 'VWAP Trend Extension', dir: 'BULL', weight: w14 * 0.5, detail: '+' + devPct.toFixed(1) + '% (Trend)' });
                    } else {
                        bear += w14; signals.push({ name: 'Above VWAP Extended', dir: 'BEAR', weight: w14, detail: '+' + devPct.toFixed(1) + '% from VWAP' });
                    }
                } else if (devPct < -1.5) {
                    if (regime && regime.regime === 'TRENDING_DOWN') {
                        bear += w14 * 0.5; signals.push({ name: 'VWAP Trend Extension', dir: 'BEAR', weight: w14 * 0.5, detail: devPct.toFixed(1) + '% (Trend)' });
                    } else {
                        bull += w14; signals.push({ name: 'Below VWAP Extended', dir: 'BULL', weight: w14, detail: devPct.toFixed(1) + '% from VWAP' });
                    }
                } else if (devPct > 0.3 && devPct <= 1.5) {
                    bull += w14 * 0.3; signals.push({ name: 'Above VWAP', dir: 'BULL', weight: w14 * 0.3, detail: '+' + devPct.toFixed(1) + '% trend' });
                } else if (devPct < -0.3 && devPct >= -1.5) {
                    bear += w14 * 0.3; signals.push({ name: 'Below VWAP', dir: 'BEAR', weight: w14 * 0.3, detail: devPct.toFixed(1) + '% trend' });
                }
            }
        }

        // 15. Market Regime Alignment
        const w15 = this._ew('regime_alignment', sess);
        if (regime && regime.regime !== 'UNKNOWN') {
            const r = regime.regime;
            const rConf = (regime.confidence || 50) / 100;
            if (r === 'TRENDING_UP') {
                bull += w15 * rConf; signals.push({ name: 'Regime Trending Up', dir: 'BULL', weight: +(w15 * rConf).toFixed(2), detail: regime.label + ' (' + regime.confidence + '%)' });
            } else if (r === 'TRENDING_DOWN') {
                bear += w15 * rConf; signals.push({ name: 'Regime Trending Down', dir: 'BEAR', weight: +(w15 * rConf).toFixed(2), detail: regime.label + ' (' + regime.confidence + '%)' });
            } else if (r === 'RANGING') {
                // Ranging favors mean-reversion — boost reversal signals implicitly
                if (ta.rsi < 35) { bull += w15 * 0.5; signals.push({ name: 'Regime Range Bounce', dir: 'BULL', weight: +(w15 * 0.5).toFixed(2), detail: 'Ranging + RSI low' }); }
                else if (ta.rsi > 65) { bear += w15 * 0.5; signals.push({ name: 'Regime Range Fade', dir: 'BEAR', weight: +(w15 * 0.5).toFixed(2), detail: 'Ranging + RSI high' }); }
            } else if (r === 'VOLATILE') {
                // Volatile = reduce conviction, but DO NOT bias bearishly unless confirmed
                signals.push({ name: 'High Volatility', dir: 'NEUTRAL', weight: 0, detail: 'Reduce size, no directional bias' });
            }
        }

        // 16. Gamma Wall Proximity
        const w16 = this._ew('gamma_wall', sess);
        if (gex.length > 0 && quote) {
            const curPrice = parseFloat(quote.last || quote.price || quote.close || 0);
            // Find max gamma strike
            let maxGamma = 0, gammaStrike = 0;
            gex.forEach(function (g) {
                var gVal = Math.abs(parseFloat(g.gex || g.gamma || 0));
                if (gVal > maxGamma) { maxGamma = gVal; gammaStrike = parseFloat(g.strike || 0); }
            });
            if (gammaStrike > 0 && curPrice > 0) {
                var distPct = Math.abs(curPrice - gammaStrike) / curPrice * 100;
                if (distPct < 0.5) {
                    // Pinned near gamma wall
                    signals.push({ name: 'Gamma Pin', dir: 'NEUTRAL', weight: 0, detail: 'Near $' + gammaStrike + ' gamma wall' });
                } else if (curPrice > gammaStrike && distPct > 2) {
                    bull += w16 * 0.5; signals.push({ name: 'Above Gamma Wall', dir: 'BULL', weight: +(w16 * 0.5).toFixed(2), detail: 'Free above $' + gammaStrike });
                } else if (curPrice < gammaStrike && distPct > 2) {
                    bear += w16 * 0.5; signals.push({ name: 'Below Gamma Wall', dir: 'BEAR', weight: +(w16 * 0.5).toFixed(2), detail: 'Trapped below $' + gammaStrike });
                }
            }
        }

        // 17. IV Skew (call IV vs put IV)
        const w17 = this._ew('iv_skew', sess);
        if (ivData) {
            const arr = Array.isArray(ivData) ? ivData : [ivData];
            const last = arr[arr.length - 1] || {};
            const callIV = parseFloat(last.call_iv || last.avg_call_iv || 0);
            const putIV = parseFloat(last.put_iv || last.avg_put_iv || 0);
            if (callIV > 0 && putIV > 0) {
                const skew = (callIV - putIV) / ((callIV + putIV) / 2) * 100;
                if (skew > 10) {
                    bull += w17; signals.push({ name: 'Call IV Premium', dir: 'BULL', weight: w17, detail: 'Call IV ' + skew.toFixed(0) + '% higher' });
                } else if (skew < -10) {
                    bear += w17; signals.push({ name: 'Put IV Premium', dir: 'BEAR', weight: w17, detail: 'Put IV ' + Math.abs(skew).toFixed(0) + '% higher' });
                }
            }
        }

        // 18. Candlestick Pattern Confirmation — bullish patterns 1.5x boost (75% accuracy on 2/19)
        const w18 = this._ew('candlestick_pattern', sess);
        if (patterns.length > 0) {
            patterns.forEach(function (p) {
                if (p.direction === 'BULL') {
                    var bullCandleW = w18 * (p.strength || 0.5) * 1.5;  // Boost: Bullish Engulfing had 75% accuracy
                    bull += bullCandleW; signals.push({ name: p.name, dir: 'BULL', weight: +bullCandleW.toFixed(2), detail: 'Candle pattern (boosted)' });
                } else if (p.direction === 'BEAR') {
                    var bearCandleW = w18 * (p.strength || 0.5) * (isRanging ? 0.5 : 1.0);  // Dampen bear candles in ranging
                    bear += bearCandleW; signals.push({ name: p.name, dir: 'BEAR', weight: +bearCandleW.toFixed(2), detail: 'Candle pattern' + (isRanging ? ' (ranging dampened)' : '') });
                }
            });
        }

        // 19. News Sentiment
        const w19 = this._ew('news_sentiment', sess);
        if (sentiment && sentiment.score !== undefined) {
            const score = sentiment.score; // -100 to +100
            if (score > 30) {
                bull += w19 * (score / 100); signals.push({ name: 'News Bullish', dir: 'BULL', weight: +(w19 * score / 100).toFixed(2), detail: 'Sentiment +' + score });
            } else if (score < -30) {
                bear += w19 * (Math.abs(score) / 100); signals.push({ name: 'News Bearish', dir: 'BEAR', weight: +(w19 * Math.abs(score) / 100).toFixed(2), detail: 'Sentiment ' + score });
            }
        }

        // ── 20. Multi-Timeframe Confluence (injected from MultiTFAnalyzer) ──
        const w20 = this._ew('multi_tf_confluence', sess);
        const mtf = data.multiTF || null;
        if (mtf && mtf.confluence) {
            const conf = mtf.confluence;
            if (conf.confluenceBonus > 0 && conf.dominantDirection !== 'NEUTRAL') {
                // Scale confluence bonus by weight
                const bonus = (conf.confluenceBonus / 15) * w20;
                if (conf.dominantDirection === 'BULL') {
                    bull += bonus;
                    signals.push({ name: 'Multi-TF Confluence', dir: 'BULL', weight: +bonus.toFixed(2), detail: conf.timeframesAgreeing + '/3 TFs agree BULL' });
                } else {
                    bear += bonus;
                    signals.push({ name: 'Multi-TF Confluence', dir: 'BEAR', weight: +bonus.toFixed(2), detail: conf.timeframesAgreeing + '/3 TFs agree BEAR' });
                }
            }

            // Short-cover bounce bonus
            if (mtf.shortCoverBounce && mtf.shortCoverBounce.isShortCoverSetup) {
                const bounceBonus = mtf.shortCoverBounce.bounceStrength;
                bull += bounceBonus;
                signals.push({ name: 'Short-Cover Bounce', dir: 'BULL', weight: bounceBonus, detail: mtf.shortCoverBounce.detail });
            }

            // Consolidation breakout bonus
            if (mtf.consolidation && mtf.consolidation.isBreakingOut) {
                const bDir = mtf.consolidation.breakoutDirection;
                if (bDir === 'BULL') {
                    bull += 3;
                    signals.push({ name: 'Breakout', dir: 'BULL', weight: 3, detail: 'BB squeeze breakout UP' });
                } else if (bDir === 'BEAR') {
                    bear += 3;
                    signals.push({ name: 'Breakout', dir: 'BEAR', weight: 3, detail: 'BB squeeze breakout DOWN' });
                }
            }
        }

        // ── 21. RSI Divergence (new high-probability signal) ──
        const w21 = this._ew('rsi_divergence', sess);
        if (ta.rsiDivergence && ta.rsiDivergence.length > 0) {
            ta.rsiDivergence.forEach(function (div) {
                var strength = div.strength || 0.5;
                // Regular divergences get full weight (reversal signals)
                // Hidden divergences get 60% weight (continuation signals)
                var multiplier = div.type.includes('HIDDEN') ? 0.6 : 1.0;
                var pts = w21 * strength * multiplier;
                if (div.direction === 'BULL') {
                    bull += pts;
                    signals.push({ name: 'RSI Divergence ↑', dir: 'BULL', weight: +pts.toFixed(2), detail: div.detail });
                } else if (div.direction === 'BEAR') {
                    bear += pts;
                    signals.push({ name: 'RSI Divergence ↓', dir: 'BEAR', weight: +pts.toFixed(2), detail: div.detail });
                }
            });
        }

        // ── 22. ADX Trend Filter (gate/multiplier, not directional) ──
        if (ta.adx && ta.adx.adx !== null) {
            var adxVal = ta.adx.adx;
            if (adxVal >= 30) {
                // Strong trend: boost trend-following signals by 20%
                var trendBoost = 0.2;
                // Find and boost EMA and MACD signals already scored
                signals.forEach(function (s) {
                    if (s.name.includes('EMA') || s.name.includes('MACD')) {
                        var boost = s.weight * trendBoost;
                        if (s.dir === 'BULL') bull += boost;
                        else if (s.dir === 'BEAR') bear += boost;
                    }
                });
                signals.push({ name: 'ADX Strong Trend', dir: 'NEUTRAL', weight: 0, detail: 'ADX ' + adxVal.toFixed(0) + ' — trend signals boosted 20%' });
            } else if (adxVal < 18) {
                // No trend (choppy): penalty on trend signals, boost mean-reversion, dampen ALL bear signals
                // ADX Choppy had 0% accuracy on 2/19 — choppy conditions produce false bear signals
                signals.forEach(function (s) {
                    if (s.name.includes('EMA') || s.name.includes('MACD')) {
                        var penalty = s.weight * 0.15;
                        if (s.dir === 'BULL') bull -= penalty;
                        else if (s.dir === 'BEAR') bear -= penalty;
                    }
                    if (s.name.includes('BB') || s.name.includes('VWAP') || s.name.includes('Reversion') || s.name.includes('Dip')) {
                        var boost = s.weight * 0.3;
                        if (s.dir === 'BULL') bull += boost;
                        else if (s.dir === 'BEAR') bear += boost;
                    }
                    // Additional bear dampening in choppy conditions (0% accuracy on 2/19)
                    if (s.dir === 'BEAR' && !s.name.includes('BB') && !s.name.includes('Reversion')) {
                        var choppyPenalty = s.weight * 0.25;
                        bear -= choppyPenalty;
                    }
                });
                signals.push({ name: 'ADX Choppy', dir: 'NEUTRAL', weight: 0, detail: 'ADX ' + adxVal.toFixed(0) + ' — trend -15%, mean-reversion +30%, bear -25%' });
            }
        }

        // ── 23. Volatility Runner Detection (MLEC-style gap/halt setups) ──
        var wVR = this._ew('volatility_runner', sess);
        if (data.volatilityRunner) {
            var vr = data.volatilityRunner;
            // Calculate runner quality score
            var gapPct = parseFloat(vr.changePct || 0);
            var rVol = parseFloat(vr.relativeVolume || 0);
            var mktCap = parseFloat(vr.marketCap || 0);
            var dollarVol = parseFloat(vr.dollarVolume || 0);

            // Tiered scoring: the stronger the move, the higher the signal
            var runnerScore = 0;
            if (gapPct >= 20) runnerScore += 2;       // Massive gap (halt territory)
            else if (gapPct >= 10) runnerScore += 1;  // Strong gap

            if (rVol >= 5) runnerScore += 2;           // Extreme volume
            else if (rVol >= 3) runnerScore += 1;      // High volume

            if (mktCap > 0 && mktCap < 50000000) runnerScore += 1; // Micro cap (squeeze potential)
            if (dollarVol > 5000000) runnerScore += 1; // Liquid enough to trade

            // Only fire if at least 3 criteria met (avoids false positives)
            if (runnerScore >= 3) {
                var vrWeight = wVR * (runnerScore / 6); // Scale by quality (max = full weight)
                bull += vrWeight;
                signals.push({
                    name: '🚀 Volatility Runner',
                    dir: 'BULL',
                    weight: +vrWeight.toFixed(2),
                    detail: 'Gap ' + gapPct.toFixed(0) + '% | RVol ' + rVol.toFixed(1) + 'x | Score ' + runnerScore + '/6'
                });
            }
        }

        // ── 24. Net Premium Momentum (smart money flow direction) ──
        var wNPM = this._ew('net_premium_momentum', sess);
        if (data.netPremium) {
            var np = Array.isArray(data.netPremium) ? data.netPremium : [];
            if (np.length >= 3) {
                var recent = np.slice(-3);
                var avgPrem = recent.reduce(function (s, t) { return s + parseFloat(t.net_premium || t.net_call_premium || 0); }, 0) / 3;
                if (avgPrem > 500000) {
                    bull += wNPM; signals.push({ name: '💰 Net Premium Bull', dir: 'BULL', weight: wNPM, detail: 'Avg net premium $' + (avgPrem / 1000).toFixed(0) + 'K (3-tick)' });
                } else if (avgPrem < -500000) {
                    bear += wNPM; signals.push({ name: '💰 Net Premium Bear', dir: 'BEAR', weight: wNPM, detail: 'Avg net premium -$' + (Math.abs(avgPrem) / 1000).toFixed(0) + 'K (3-tick)' });
                }
            }
        }

        // ── 25. Strike Flow Levels (magnetic price levels for S/R) ──
        var wSFL = this._ew('strike_flow_levels', sess);
        if (data.flowPerStrike && quote.price) {
            var fps = Array.isArray(data.flowPerStrike) ? data.flowPerStrike : [];
            var curPrice = parseFloat(quote.price || quote.last || 0);
            if (fps.length > 0 && curPrice > 0) {
                var sorted = fps.filter(function (s) { return s.strike && s.total_premium; }).sort(function (a, b) { return parseFloat(b.total_premium) - parseFloat(a.total_premium); });
                var top = sorted[0];
                if (top) {
                    var topStrike = parseFloat(top.strike);
                    var dist = (topStrike - curPrice) / curPrice;
                    if (dist > 0.005 && dist < 0.05) {
                        bull += wSFL * 0.7; signals.push({ name: '📍 Strike Magnet Above', dir: 'BULL', weight: +(wSFL * 0.7).toFixed(2), detail: 'Heavy flow at $' + topStrike + ' (' + (dist * 100).toFixed(1) + '% above)' });
                    } else if (dist < -0.005 && dist > -0.05) {
                        bear += wSFL * 0.7; signals.push({ name: '📍 Strike Magnet Below', dir: 'BEAR', weight: +(wSFL * 0.7).toFixed(2), detail: 'Heavy flow at $' + topStrike + ' (' + (Math.abs(dist) * 100).toFixed(1) + '% below)' });
                    }
                }
            }
        }

        // ── 26. Greek Flow Momentum (delta/gamma shift detection) ──
        var wGFM = this._ew('greek_flow_momentum', sess);
        if (data.greekFlow) {
            var gfl = Array.isArray(data.greekFlow) ? data.greekFlow : [];
            if (gfl.length >= 2) {
                var lastGF = gfl[gfl.length - 1];
                var prevGF = gfl[gfl.length - 2];
                var deltaShift = parseFloat(lastGF.net_delta || lastGF.delta || 0) - parseFloat(prevGF.net_delta || prevGF.delta || 0);
                if (deltaShift > 0) {
                    bull += wGFM * 0.6; signals.push({ name: '📈 Delta Rising', dir: 'BULL', weight: +(wGFM * 0.6).toFixed(2), detail: 'Net delta shift +' + deltaShift.toFixed(0) });
                } else if (deltaShift < 0) {
                    bear += wGFM * 0.6; signals.push({ name: '📉 Delta Falling', dir: 'BEAR', weight: +(wGFM * 0.6).toFixed(2), detail: 'Net delta shift ' + deltaShift.toFixed(0) });
                }
            }
        }

        // ── 27. Sector Tide Alignment ──
        var wSTA = this._ew('sector_tide_alignment', sess);
        if (data.sectorTide && quote.sector) {
            var secTide = data.sectorTide[quote.sector];
            if (secTide) {
                var callVol = parseFloat(secTide.call_volume || secTide.calls || 0);
                var putVol = parseFloat(secTide.put_volume || secTide.puts || 0);
                var ratio = putVol > 0 ? callVol / putVol : 1;
                if (ratio > 1.3) {
                    bull += wSTA; signals.push({ name: '🌊 Sector Bullish', dir: 'BULL', weight: wSTA, detail: quote.sector + ' C/P ratio ' + ratio.toFixed(2) });
                } else if (ratio < 0.7) {
                    bear += wSTA; signals.push({ name: '🌊 Sector Bearish', dir: 'BEAR', weight: wSTA, detail: quote.sector + ' C/P ratio ' + ratio.toFixed(2) });
                }
            }
        }

        // ── 28. ETF Tide Macro Direction ──
        var wETM = this._ew('etf_tide_macro', sess);
        if (data.etfTide) {
            var spyTide = data.etfTide['SPY'];
            var qqqTide = data.etfTide['QQQ'];
            var macroBull = 0, macroBear = 0;
            [spyTide, qqqTide].forEach(function (t) {
                if (t) {
                    var cv = parseFloat(t.call_volume || t.calls || 0);
                    var pv = parseFloat(t.put_volume || t.puts || 0);
                    if (cv > pv * 1.2) macroBull++;
                    else if (pv > cv * 1.2) macroBear++;
                }
            });
            if (macroBull >= 2) {
                bull += wETM; signals.push({ name: '🏛️ Macro Bullish', dir: 'BULL', weight: wETM, detail: 'SPY+QQQ flow bullish' });
            } else if (macroBear >= 2) {
                bear += wETM; signals.push({ name: '🏛️ Macro Bearish', dir: 'BEAR', weight: wETM, detail: 'SPY+QQQ flow bearish' });
            }
        }

        // ── 29. Squeeze Composite (short volume + FTDs) ──
        var wSQ = this._ew('squeeze_composite', sess);
        if (data.shortVolume || data.failsToDeliver) {
            var sqScore = 0;
            if (data.shortVolume) {
                var svArr = Array.isArray(data.shortVolume) ? data.shortVolume : [];
                var lastSV = svArr[svArr.length - 1];
                if (lastSV) {
                    var svRatio = parseFloat(lastSV.short_volume_ratio || lastSV.short_ratio || 0);
                    if (svRatio > 0.5) sqScore += 2;
                    else if (svRatio > 0.4) sqScore += 1;
                }
            }
            if (data.failsToDeliver) {
                var ftdArr = Array.isArray(data.failsToDeliver) ? data.failsToDeliver : [];
                var lastFTD = ftdArr[ftdArr.length - 1];
                if (lastFTD) {
                    var ftdQty = parseFloat(lastFTD.quantity || lastFTD.fails || 0);
                    if (ftdQty > 1000000) sqScore += 2;
                    else if (ftdQty > 500000) sqScore += 1;
                }
            }
            if (sqScore >= 2) {
                bull += wSQ * (sqScore / 4); signals.push({ name: '🔥 Squeeze Watch', dir: 'BULL', weight: +(wSQ * sqScore / 4).toFixed(2), detail: 'Squeeze score ' + sqScore + '/4' });
            }
        }

        // ── 30. Seasonality Alignment ──
        var wSZN = this._ew('seasonality_alignment', sess);
        if (data.seasonality) {
            var sznData = Array.isArray(data.seasonality) ? data.seasonality : [];
            var curMonth = new Date().getMonth(); // 0-indexed
            var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            var curMonthData = sznData.find(function (m) { return String(m.month || '').toLowerCase() === monthNames[curMonth].toLowerCase(); });
            if (curMonthData) {
                var avgReturn = parseFloat(curMonthData.avg_return || curMonthData.mean || 0);
                if (avgReturn > 2) {
                    bull += wSZN; signals.push({ name: '📅 Seasonal Bull', dir: 'BULL', weight: wSZN, detail: monthNames[curMonth] + ' avg +' + avgReturn.toFixed(1) + '%' });
                } else if (avgReturn < -2) {
                    bear += wSZN; signals.push({ name: '📅 Seasonal Bear', dir: 'BEAR', weight: wSZN, detail: monthNames[curMonth] + ' avg ' + avgReturn.toFixed(1) + '%' });
                }
            }
        }

        // ── 31. Vol Regime (IV vs Realized Vol) ──
        var wVOL = this._ew('vol_regime', sess);
        if (data.realizedVol && data.ivRank) {
            var rvData = Array.isArray(data.realizedVol) ? data.realizedVol : [];
            var lastRV = rvData[rvData.length - 1];
            if (lastRV) {
                var rv = parseFloat(lastRV.realized_vol || lastRV.rv || 0);
                var iv = parseFloat((Array.isArray(data.ivRank) ? data.ivRank[data.ivRank.length - 1] : data.ivRank)?.iv || 0);
                if (iv > 0 && rv > 0) {
                    var ivrvRatio = iv / rv;
                    if (ivrvRatio > 1.3) {
                        signals.push({ name: '📊 IV Premium', dir: 'NEUTRAL', weight: 0, detail: 'IV/RV=' + ivrvRatio.toFixed(2) + ' — options expensive' });
                    } else if (ivrvRatio < 0.8) {
                        signals.push({ name: '📊 IV Discount', dir: 'NEUTRAL', weight: 0, detail: 'IV/RV=' + ivrvRatio.toFixed(2) + ' — options cheap' });
                    }
                }
            }
        }

        // ── 32. Insider Conviction ──
        var wIC = this._ew('insider_conviction', sess);
        if (data.insiderFlow) {
            var ifl = Array.isArray(data.insiderFlow) ? data.insiderFlow : [];
            if (ifl.length > 0) {
                var netBuy = ifl.reduce(function (s, t) {
                    var type = (t.transaction_type || t.txn_type || '').toLowerCase();
                    var val = parseFloat(t.value || t.amount || 0);
                    return s + (type.includes('buy') || type.includes('purchase') ? val : type.includes('sell') || type.includes('sale') ? -val : 0);
                }, 0);
                if (netBuy > 100000) {
                    bull += wIC; signals.push({ name: '🏢 Insider Buying', dir: 'BULL', weight: wIC, detail: 'Net insider buy $' + (netBuy / 1000).toFixed(0) + 'K' });
                } else if (netBuy < -500000) {
                    bear += wIC * 0.5; signals.push({ name: '🏢 Insider Selling', dir: 'BEAR', weight: +(wIC * 0.5).toFixed(2), detail: 'Net insider sell $' + (Math.abs(netBuy) / 1000).toFixed(0) + 'K' });
                }
            }
        }

        // ── 33. Spot Gamma Pin Detection ──
        var wSGP = this._ew('spot_gamma_pin', sess);
        if (data.spotExposures) {
            var spotData = Array.isArray(data.spotExposures) ? data.spotExposures : (data.spotExposures.data ? [data.spotExposures] : []);
            if (spotData.length > 0) {
                var spot = spotData[0];
                var gammaVal = parseFloat(spot.net_gamma || spot.gamma || 0);
                if (Math.abs(gammaVal) > 1000000) {
                    signals.push({ name: '📌 Gamma Pin', dir: 'NEUTRAL', weight: 0, detail: 'High gamma at spot — expect chop' });
                }
            }
        }

        // ── 34. Flow Horizon Classification ──
        var wFH = this._ew('flow_horizon', sess);
        if (data.flowPerExpiry) {
            var fpe = Array.isArray(data.flowPerExpiry) ? data.flowPerExpiry : [];
            if (fpe.length > 0) {
                var nearTerm = 0, farTerm = 0;
                var now = new Date();
                fpe.forEach(function (e) {
                    var expDate = new Date(e.expiry || e.expiration || '');
                    var daysOut = (expDate - now) / (1000 * 60 * 60 * 24);
                    var vol = parseFloat(e.total_volume || e.volume || 0);
                    if (daysOut <= 7) nearTerm += vol;
                    else farTerm += vol;
                });
                if (nearTerm > farTerm * 2) {
                    signals.push({ name: '⏱️ Near-Term Flow', dir: 'NEUTRAL', weight: 0, detail: 'Flow concentrated < 7 DTE — day trade bias' });
                } else if (farTerm > nearTerm * 2) {
                    signals.push({ name: '⏱️ Far-Term Flow', dir: 'NEUTRAL', weight: 0, detail: 'Flow concentrated > 7 DTE — swing bias' });
                }
            }
        }

        // ── 35. Buy/Sell Volume Proxy ──
        var wVD = this._ew('volume_direction', sess);
        if (data.netPremium || (dp && dp.length > 0)) {
            var buyPressure = 0, sellPressure = 0;
            // Net premium direction
            var npa = Array.isArray(data.netPremium) ? data.netPremium : [];
            if (npa.length > 0) {
                var latestNP = npa[npa.length - 1];
                var netVal = parseFloat(latestNP.net_premium || latestNP.net_call_premium || latestNP.value || 0);
                if (netVal > 0) buyPressure += 2;
                else if (netVal < 0) sellPressure += 2;
            }
            // Dark pool block direction
            if (dp && dp.length > 0) {
                var dpBuy = 0, dpSell = 0;
                dp.forEach(function (d) {
                    var close = parseFloat(d.close || d.price || 0);
                    var dpPrice = parseFloat(d.average_price || d.avg_price || d.price || 0);
                    if (dpPrice > close) dpBuy++;
                    else dpSell++;
                });
                if (dpBuy > dpSell) buyPressure += 1;
                else if (dpSell > dpBuy) sellPressure += 1;
            }
            // Flow call/put ratio as volume direction
            if (flow && flow.length > 0) {
                var callVol = 0, putVol = 0;
                flow.forEach(function (f) {
                    var prem = parseFloat(f.premium || f.total_premium || 0);
                    var pc = (f.put_call || f.option_type || f.sentiment || '').toUpperCase();
                    if (pc.includes('CALL') || pc.includes('C') || pc.includes('BULL')) callVol += prem;
                    else putVol += prem;
                });
                if (callVol > putVol * 1.5) buyPressure += 1;
                else if (putVol > callVol * 1.5) sellPressure += 1;
            }
            if (buyPressure > sellPressure + 1) {
                bull += wVD * buyPressure * 0.5;
                signals.push({ name: '💰 Buy Pressure', dir: 'BULL', weight: +(wVD * buyPressure * 0.5).toFixed(2), detail: 'Net premium + DP + flow favor buying (' + buyPressure + ' vs ' + sellPressure + ')' });
            } else if (sellPressure > buyPressure + 1) {
                bear += wVD * sellPressure * 0.5;
                signals.push({ name: '💰 Sell Pressure', dir: 'BEAR', weight: +(wVD * sellPressure * 0.5).toFixed(2), detail: 'Net premium + DP + flow favor selling (' + sellPressure + ' vs ' + buyPressure + ')' });
            }
        }

        // ── 36. Real Tick Data (Polygon.io) — overrides proxy when available ──
        if (data.tickData) {
            var tick = data.tickData;
            var wTick = this._ew('volume_direction', sess) * 1.5; // boost for real data

            // Flow imbalance from actual aggressor classification
            if (tick.flowImbalance !== undefined && tick.totalVolume > 1000) {
                // Remove proxy signal if we have real data (it was less accurate)
                signals = signals.filter(function (s) { return s.name !== '💰 Buy Pressure' && s.name !== '💰 Sell Pressure'; });

                if (tick.flowImbalance > 0.15) {
                    var tickBullW = +(wTick * Math.min(tick.flowImbalance * 3, 2)).toFixed(2);
                    bull += tickBullW;
                    signals.push({ name: '📊 Tick Buy Flow', dir: 'BULL', weight: tickBullW, detail: 'Real aggressor: ' + tick.buyPct + '% buy, imbalance ' + tick.flowImbalance.toFixed(3) });
                } else if (tick.flowImbalance < -0.15) {
                    var tickBearW = +(wTick * Math.min(Math.abs(tick.flowImbalance) * 3, 2)).toFixed(2);
                    bear += tickBearW;
                    signals.push({ name: '📊 Tick Sell Flow', dir: 'BEAR', weight: tickBearW, detail: 'Real aggressor: ' + tick.sellPct + '% sell, imbalance ' + tick.flowImbalance.toFixed(3) });
                }
            }

            // Price vs VWAP — bullish above, bearish below
            if (tick.priceVsVwap !== undefined && tick.vwap > 0) {
                if (tick.priceVsVwap > 0.3) {
                    bull += 1;
                    signals.push({ name: '📊 Above VWAP', dir: 'BULL', weight: 1, detail: 'Price ' + tick.priceVsVwap.toFixed(2) + '% above VWAP' });
                } else if (tick.priceVsVwap < -0.3) {
                    bear += 1;
                    signals.push({ name: '📊 Below VWAP', dir: 'BEAR', weight: 1, detail: 'Price ' + tick.priceVsVwap.toFixed(2) + '% below VWAP' });
                }
            }

            // Large blocks — institutional activity
            if (tick.largeBlockBuys > 0 || tick.largeBlockSells > 0) {
                if (tick.largeBlockBuys > tick.largeBlockSells) {
                    bull += 1.5;
                    signals.push({ name: '📊 Large Blocks', dir: 'BULL', weight: 1.5, detail: tick.largeBlockBuys + ' large buys vs ' + tick.largeBlockSells + ' sells' });
                } else if (tick.largeBlockSells > tick.largeBlockBuys) {
                    bear += 1.5;
                    signals.push({ name: '📊 Large Blocks', dir: 'BEAR', weight: 1.5, detail: tick.largeBlockSells + ' large sells vs ' + tick.largeBlockBuys + ' buys' });
                }
            }
        }

        // ── 37. Polygon Server-Computed TA Validation ──
        // Uses Polygon API's pre-calculated RSI, MACD, EMA to validate our local TA
        if (data.polygonTA) {
            var pTA = data.polygonTA;

            // Polygon RSI validation
            if (pTA.rsi !== null && pTA.rsi !== undefined) {
                if (pTA.rsi < 30) {
                    bull += 1.5;
                    signals.push({ name: '🔷 Polygon RSI', dir: 'BULL', weight: 1.5, detail: 'Server RSI ' + pTA.rsi.toFixed(1) + ' (oversold)' });
                } else if (pTA.rsi > 70) {
                    bear += 1.5;
                    signals.push({ name: '🔷 Polygon RSI', dir: 'BEAR', weight: 1.5, detail: 'Server RSI ' + pTA.rsi.toFixed(1) + ' (overbought)' });
                }
            }

            // Polygon EMA alignment
            if (pTA.emaBias === 'BULLISH') {
                bull += 1;
                signals.push({ name: '🔷 Polygon EMA', dir: 'BULL', weight: 1, detail: 'EMA 9>20>50 stacked bullish' });
            } else if (pTA.emaBias === 'BEARISH') {
                bear += 1;
                signals.push({ name: '🔷 Polygon EMA', dir: 'BEAR', weight: 1, detail: 'EMA 9<20<50 stacked bearish' });
            }

            // Polygon MACD signal
            if (pTA.macdSignal === 'BULL_CROSS') {
                bull += 2;
                signals.push({ name: '🔷 MACD Cross', dir: 'BULL', weight: 2, detail: 'MACD bullish crossover (Polygon)' });
            } else if (pTA.macdSignal === 'BEAR_CROSS') {
                bear += 2;
                signals.push({ name: '🔷 MACD Cross', dir: 'BEAR', weight: 2, detail: 'MACD bearish crossover (Polygon)' });
            }

            // Price vs SMA200 — long-term trend
            if (pTA.trend200 === 'ABOVE') {
                bull += 0.5;
                signals.push({ name: '🔷 Above 200 SMA', dir: 'BULL', weight: 0.5, detail: 'Price above 200-day SMA (uptrend)' });
            } else if (pTA.trend200 === 'BELOW') {
                bear += 0.5;
                signals.push({ name: '🔷 Below 200 SMA', dir: 'BEAR', weight: 0.5, detail: 'Price below 200-day SMA (downtrend)' });
            }
        }

        // Compute final score — CONVICTION SPREAD (not ratio)
        // Old formula: max(bull,bear)/(bull+bear) — caps at ~60% with any opposing signals
        // New formula: 50 + spread/maxWeight*50 — rewards directional AGREEMENT
        const spread = Math.abs(bull - bear);
        const maxWeight = 40;  // ↑ from 37 — accounts for Polygon TA + tick data signals

        // Regime-aware bear gating: in RANGING, require stronger bear spread to declare BEARISH
        // Bear signals had 29% accuracy in ranging on 2/19 — too many false bearish calls
        var bearThreshold = isRanging ? 5 : 2;  // Need 5pt bear lead in ranging vs 2pt normally
        const direction = bull > bear + 2 ? 'BULLISH' : bear > bull + bearThreshold ? 'BEARISH' : 'NEUTRAL';
        const confidence = Math.min(95, Math.round(50 + (spread / maxWeight) * 50));
        const signalCount = signals.length;

        return {
            ticker,
            direction,
            confidence,
            bull: +bull.toFixed(2),
            bear: +bear.toFixed(2),
            spread: +spread.toFixed(2),
            signalCount,
            signals,
            session: sess,
            timestamp: new Date().toISOString(),
            multiTFDetails: mtf ? mtf.confluence.details : [],
            // Feature vector for ML
            features: this._extractFeatures(ta, flow, dp, gex, ivData, siData, quote)
        };
    }

    // Extract numeric feature vector for ML calibrator
    _extractFeatures(ta, flow, dp, gex, ivData, siData, quote) {
        const rsi = (ta.rsi !== null && ta.rsi !== undefined) ? ta.rsi : 50;
        const macdHist = (ta.macd && ta.macd.histogram !== null) ? ta.macd.histogram : 0;
        const emaAlign = ta.emaBias === 'BULLISH' ? 1 : ta.emaBias === 'BEARISH' ? -1 : 0;
        const bbPos = (ta.bollingerBands && ta.bollingerBands.position !== null) ? ta.bollingerBands.position : 0.5;
        const atr = ta.atr || 0;

        let callPrem = 0, putPrem = 0;
        (flow || []).forEach(f => {
            const prem = parseFloat(f.premium || f.total_premium || 0);
            const pc = (f.put_call || f.option_type || '').toUpperCase();
            if (pc.includes('CALL') || pc.includes('C')) callPrem += prem; else putPrem += prem;
        });
        const cpRatio = putPrem > 0 ? callPrem / putPrem : callPrem > 0 ? 2 : 1;

        let dpDir = 0;
        (dp || []).forEach(d => {
            const price = parseFloat(d.price || 0);
            const mid = (parseFloat(d.nbbo_bid || 0) + parseFloat(d.nbbo_ask || 0)) / 2;
            if (price > 0 && mid > 0) dpDir += price >= mid ? 1 : -1;
        });
        dpDir = dp.length > 0 ? dpDir / dp.length : 0;

        let ivRank = 50;
        if (ivData) {
            const arr = Array.isArray(ivData) ? ivData : [ivData];
            const l = arr[arr.length - 1] || {};
            ivRank = parseFloat(l.iv_rank_1y || l.iv_rank || 50);
        }

        let siPct = 0;
        if (siData) {
            const arr = Array.isArray(siData) ? siData : [siData];
            const l = arr[arr.length - 1] || {};
            siPct = parseFloat(l.si_float_returned || l.short_interest_pct || 0);
        }

        const volSpike = ta.volumeSpike ? 1 : 0;

        const bbBandwidth = (ta.bollingerBands && ta.bollingerBands.bandwidth !== undefined) ? ta.bollingerBands.bandwidth : 0.05;
        let vwapDev = 0;
        if (ta.vwap && quote) {
            const curPrice = parseFloat(quote.last || quote.price || quote.close || 0);
            const vwap = parseFloat(ta.vwap);
            if (curPrice > 0 && vwap > 0) vwapDev = (curPrice - vwap) / vwap * 100;
        }

        // New features for signals #15-#19
        const regimeScore = 0; // populated at ensemble level
        const gammaProx = 0; // populated at ensemble level
        const ivSkew = 0;
        const candleScore = 0;
        const sentScore = 0;

        // ── NEW: Enhanced features (#10 ML Feature Engineering) ──

        // Feature 18: ADX trend strength (0-100)
        const adxVal = (ta.adx && ta.adx.adx !== null) ? ta.adx.adx : 20;

        // Feature 19: RSI Divergence score (+1 bull, -1 bear, 0 none)
        let rsiDivScore = 0;
        if (ta.rsiDivergence && ta.rsiDivergence.length > 0) {
            ta.rsiDivergence.forEach(function (d) {
                if (d.direction === 'BULL') rsiDivScore += d.strength;
                else if (d.direction === 'BEAR') rsiDivScore -= d.strength;
            });
            rsiDivScore = Math.max(-1, Math.min(1, rsiDivScore)); // clamp
        }

        // Feature 20: Fibonacci proximity (distance to nearest Fib level as % of swing range)
        let fibProximity = 0.5; // default: midrange
        if (ta.fibonacci && ta.fibonacci.levels && ta.fibonacci.swingRange > 0) {
            var curPrice = parseFloat((quote && (quote.last || quote.price || quote.close)) || ta.price || 0);
            if (curPrice > 0) {
                var minDist = Infinity;
                var levels = ta.fibonacci.levels;
                for (var lvl in levels) {
                    var dist = Math.abs(curPrice - levels[lvl]) / ta.fibonacci.swingRange;
                    if (dist < minDist) minDist = dist;
                }
                fibProximity = Math.min(1, minDist); // 0 = right on a Fib level, 1 = far away
            }
        }

        // Feature 21: RSI slope (rate of change over 3 bars)
        const rsiSlopeVal = ta.rsiSlope || 0;

        // Feature 22: MACD acceleration (histogram slope)
        const macdAccel = ta.macdSlope || 0;

        // Feature 23: ATR rate of change (volatility expanding or contracting)
        let atrChange = 0;
        if (ta.atrValues && ta.atrValues.length >= 5) {
            var av = ta.atrValues;
            atrChange = (av[av.length - 1] - av[av.length - 5]) / (av[av.length - 5] || 1);
        }

        // Feature 24: Interaction — RSI × EMA alignment
        // Captures "oversold in uptrend" (strong bounce) vs "oversold in downtrend" (falling knife)
        const rsiEmaInteraction = ((rsi - 50) / 50) * emaAlign;

        // Feature 25: Interaction — Volume spike × MACD direction
        // Captures "volume confirming momentum"
        const volumeMacdInteraction = volSpike * (macdHist > 0 ? 1 : macdHist < 0 ? -1 : 0);

        return [rsi, macdHist, emaAlign, bbPos, atr, cpRatio, dpDir, ivRank, siPct, volSpike, bbBandwidth, vwapDev, regimeScore, gammaProx, ivSkew, candleScore, sentScore, adxVal, rsiDivScore, fibProximity, rsiSlopeVal, macdAccel, atrChange, rsiEmaInteraction, volumeMacdInteraction];
    }
}

module.exports = { SignalEngine, SIGNAL_WEIGHTS, SESSION_MULTIPLIERS };
