/**
 * Setup Detector — Conditional pattern matching for high-probability trade setups.
 * Only fires when multiple conditions align simultaneously.
 * Backtest-proven patterns only (>55% accuracy at 1hr horizon).
 */

class SetupDetector {
    constructor() {
        this.lastSetups = {};
    }

    /**
     * Detect all matching setups from technicals + quote + flow data.
     * Returns array of { setup, direction, strength, detail }
     */
    detectAll(ta, quote, flow, regime) {
        if (!ta || !ta.rsi) return [];
        const setups = [];
        const q = quote || {};
        const bb = ta.bollingerBands || {};
        const macd = ta.macd || {};
        const adx = ta.adx || {};
        const ema = ta.ema || {};

        // Derived values
        const price = ta.price || q.price || 0;
        const hasVolSpike = ta.volumeSpike || false;
        const rsi = ta.rsi || 50;
        const bbPos = bb.position != null ? bb.position : 0.5;
        const bbBW = bb.bandwidth || 5;
        const hist = macd.histogram || 0;
        const macdSlope = ta.macdSlope || 0;
        const adxVal = adx.adx || 0;
        const emaBias = ta.emaBias || 'NEUTRAL';

        // Flow data (real options data when available)
        const flowDir = this._getFlowDirection(flow);

        // ── TIER 1: Backtest winners (>55% at 1hr) ──────────────

        // MOMENTUM_BREAKOUT_SHORT — 59% acc, MFE/MAE=1.63 (best overall)
        if (emaBias === 'BEARISH' && hasVolSpike && adxVal > 25 &&
            hist < 0 && macdSlope < 0 && rsi > 28 && rsi < 45) {
            const str = Math.min(1, (adxVal - 20) / 30 + 0.5);
            setups.push({
                setup: 'MOMENTUM_BREAKOUT_SHORT', direction: 'BEARISH',
                strength: +str.toFixed(2),
                detail: `ADX=${adxVal} RSI=${rsi.toFixed(0)} MACD hist=${hist.toFixed(3)} + vol spike`
            });
        }

        // VOLUME_CLIMAX_REVERSAL_LONG — 63.6% acc (best reversal)
        if (hasVolSpike && rsi < 30 && bbPos < 0.10 && macdSlope > 0) {
            const str = Math.min(1, (30 - rsi) / 15 + 0.4);
            setups.push({
                setup: 'VOLUME_CLIMAX_REVERSAL_LONG', direction: 'BULLISH',
                strength: +str.toFixed(2),
                detail: `RSI=${rsi.toFixed(0)} BB pos=${bbPos.toFixed(2)} + extreme volume + MACD turning`
            });
        }

        // BB_SQUEEZE_BREAKOUT_SHORT — 70% acc (highest, small sample)
        if (bbBW < 2.0 && bbPos < 0.05 && hasVolSpike &&
            adxVal > 20 && emaBias === 'BEARISH') {
            setups.push({
                setup: 'BB_SQUEEZE_BREAKOUT_SHORT', direction: 'BEARISH',
                strength: 0.85,
                detail: `BB squeeze (bw=${bbBW.toFixed(1)}) + breakdown + vol spike + ADX=${adxVal}`
            });
        }

        // EMA_TREND_PULLBACK_SHORT — 50.9% acc, MFE/MAE=1.20
        if (emaBias === 'BEARISH' && adxVal > 20 && rsi > 45 && rsi < 60 &&
            hist < 0 && macdSlope < 0 && hasVolSpike) {
            setups.push({
                setup: 'EMA_TREND_PULLBACK_SHORT', direction: 'BEARISH',
                strength: 0.70,
                detail: `EMA bearish stack + RSI=${rsi.toFixed(0)} mid-range + MACD fading + vol`
            });
        }

        // ── TIER 2: Useful with flow confirmation ───────────────

        // MOMENTUM_BREAKOUT_LONG — 45.8% base, but with flow = stronger
        if (emaBias === 'BULLISH' && hasVolSpike && adxVal > 25 &&
            hist > 0 && macdSlope > 0 && rsi > 55 && rsi < 72) {
            const flowBoost = flowDir === 'BULLISH' ? 0.2 : 0;
            const str = Math.min(1, 0.55 + flowBoost);
            setups.push({
                setup: 'MOMENTUM_BREAKOUT_LONG', direction: 'BULLISH',
                strength: +str.toFixed(2),
                detail: `ADX=${adxVal} RSI=${rsi.toFixed(0)} MACD hist=${hist.toFixed(3)} + vol` +
                    (flowDir === 'BULLISH' ? ' + CALL flow confirm' : '')
            });
        }

        // RSI_OVERSOLD_BOUNCE — 45.5% base, but with flow + BB = stronger
        if (rsi < 25 && hasVolSpike && bbPos < 0.15 && macdSlope > 0) {
            const flowBoost = flowDir === 'BULLISH' ? 0.15 : 0;
            const str = Math.min(1, 0.55 + flowBoost);
            setups.push({
                setup: 'RSI_OVERSOLD_BOUNCE', direction: 'BULLISH',
                strength: +str.toFixed(2),
                detail: `RSI=${rsi.toFixed(0)} extreme + BB pos=${bbPos.toFixed(2)} + MACD turning` +
                    (flowDir === 'BULLISH' ? ' + CALL flow' : '')
            });
        }

        // MACD_BEARISH_CROSS — 44.1% base, with flow = tradeable
        if (hist < 0 && macdSlope < -0.001 && emaBias === 'BEARISH' &&
            rsi > 40 && rsi < 60 && hasVolSpike) {
            const flowBoost = flowDir === 'BEARISH' ? 0.2 : 0;
            if (flowBoost > 0) { // Only fire if flow confirms
                setups.push({
                    setup: 'MACD_BEARISH_CROSS', direction: 'BEARISH',
                    strength: +(0.60 + flowBoost).toFixed(2),
                    detail: `MACD cross down + EMA bear + PUT flow confirm`
                });
            }
        }

        return setups;
    }

    /**
     * Get options flow direction from real flow data
     */
    _getFlowDirection(flow) {
        if (!flow || !Array.isArray(flow) || flow.length === 0) return 'NEUTRAL';
        let callPrem = 0, putPrem = 0;
        flow.forEach(f => {
            const prem = parseFloat(f.premium || f.total_premium || 0);
            const pc = (f.put_call || f.option_type || f.sentiment || '').toUpperCase();
            if (pc.includes('CALL') || pc.includes('BULLISH') || pc.includes('C')) callPrem += prem;
            else putPrem += prem;
        });
        const total = callPrem + putPrem;
        if (total === 0) return 'NEUTRAL';
        const ratio = callPrem / (putPrem || 1);
        if (ratio > 1.5) return 'BULLISH';
        if (ratio < 0.67) return 'BEARISH';
        return 'NEUTRAL';
    }
}

module.exports = SetupDetector;
