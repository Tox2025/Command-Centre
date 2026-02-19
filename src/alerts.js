// Alert Engine — Session-based entry/exit signal detection

class AlertEngine {
    constructor() {
        this.alerts = [];
        this.maxAlerts = 200;
    }

    // ── Session Detection (EST) ─────────────────────────────
    static getCurrentSession() {
        const now = new Date();
        // Convert to EST
        const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const h = est.getHours();
        const m = est.getMinutes();
        const t = h * 60 + m;

        if (t < 4 * 60) return 'CLOSED';
        if (t < 9 * 60 + 30) return 'PRE_MARKET';
        if (t < 10 * 60) return 'OPEN';
        if (t < 15 * 60) return 'MIDDAY';
        if (t < 16 * 60) return 'POWER_HOUR';
        if (t < 20 * 60) return 'POST_MARKET';
        return 'CLOSED';
    }

    static sessionLabel(session) {
        const labels = {
            PRE_MARKET: '🌅 Pre-Market (4:00–9:30)',
            OPEN: '🔔 Open (9:30–10:00)',
            MIDDAY: '☀️ Midday (10:00–3:00)',
            POWER_HOUR: '⚡ Power Hour (3:00–4:00)',
            POST_MARKET: '🌙 Post-Market (4:00–8:00)',
            CLOSED: '🔒 Market Closed'
        };
        return labels[session] || session;
    }

    // ── Evaluate Options Flow for Unusual Activity ──────────
    evaluateFlowAlerts(flowData, ticker) {
        if (!flowData?.data) return [];
        const newAlerts = [];

        for (const flow of flowData.data) {
            // Detect unusually large premium
            const premium = parseFloat(flow.premium || flow.total_premium || 0);
            const type = (flow.put_call || flow.sentiment || '').toUpperCase();
            const isCall = type.includes('CALL') || type.includes('BULLISH');
            const isPut = type.includes('PUT') || type.includes('BEARISH');
            const isSweep = (flow.trade_type || flow.execution_type || '').toLowerCase().includes('sweep');

            if (premium > 100000) {
                newAlerts.push({
                    id: `flow-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    time: new Date().toISOString(),
                    session: AlertEngine.getCurrentSession(),
                    ticker: flow.ticker || flow.symbol || ticker,
                    type: 'OPTIONS_FLOW',
                    direction: isCall ? 'BULLISH' : isPut ? 'BEARISH' : 'NEUTRAL',
                    message: `${isSweep ? '🔥 SWEEP ' : ''}${isCall ? 'CALL' : 'PUT'} flow $${(premium / 1000).toFixed(0)}K`,
                    premium,
                    severity: premium > 500000 ? 'HIGH' : premium > 200000 ? 'MEDIUM' : 'LOW',
                    details: flow
                });
            }
        }
        return newAlerts;
    }

    // ── Evaluate Technical Signals ──────────────────────────
    evaluateTechnicals(ticker, analysis) {
        if (!analysis || analysis.error) return [];
        const newAlerts = [];
        const session = AlertEngine.getCurrentSession();

        // RSI extremes
        if (analysis.rsi !== null) {
            if (analysis.rsi < 30) {
                newAlerts.push(this._makeAlert(ticker, 'RSI_OVERSOLD', 'BULLISH',
                    `RSI ${analysis.rsi} — oversold bounce potential`, 'MEDIUM', session));
            } else if (analysis.rsi > 70) {
                newAlerts.push(this._makeAlert(ticker, 'RSI_OVERBOUGHT', 'BEARISH',
                    `RSI ${analysis.rsi} — overbought reversal risk`, 'MEDIUM', session));
            }
        }

        // EMA crossover signal
        if (analysis.emaBias === 'BULLISH' && analysis.macd?.histogram > 0) {
            newAlerts.push(this._makeAlert(ticker, 'EMA_BULLISH_ALIGNED', 'BULLISH',
                `EMAs aligned bullish (9>20>50) + MACD positive`, 'HIGH', session));
        } else if (analysis.emaBias === 'BEARISH' && analysis.macd?.histogram < 0) {
            newAlerts.push(this._makeAlert(ticker, 'EMA_BEARISH_ALIGNED', 'BEARISH',
                `EMAs aligned bearish (9<20<50) + MACD negative`, 'HIGH', session));
        }

        // Volume spike
        if (analysis.volumeSpike) {
            newAlerts.push(this._makeAlert(ticker, 'VOLUME_SPIKE', analysis.bias,
                `🔊 Unusual volume spike detected`, 'HIGH', session));
        }

        // Gap detection
        if (analysis.recentGaps && analysis.recentGaps.length > 0) {
            const lastGap = analysis.recentGaps[analysis.recentGaps.length - 1];
            newAlerts.push(this._makeAlert(ticker, lastGap.type, lastGap.type === 'GAP_UP' ? 'BULLISH' : 'BEARISH',
                `${lastGap.type === 'GAP_UP' ? '📈' : '📉'} ${lastGap.type} ${lastGap.pct}%`, 'MEDIUM', session));
        }

        return newAlerts;
    }

    // ── Evaluate Dark Pool Prints ───────────────────────────
    evaluateDarkPool(ticker, dpData) {
        if (!dpData?.data) return [];
        const newAlerts = [];
        const session = AlertEngine.getCurrentSession();

        // Look for large dark pool prints
        const levels = Array.isArray(dpData.data) ? dpData.data : [];
        for (const level of levels.slice(0, 5)) {
            const vol = parseFloat(level.off_lit_vol || level.volume || 0);
            if (vol > 100000) {
                newAlerts.push(this._makeAlert(ticker, 'DARK_POOL_PRINT', 'NEUTRAL',
                    `🏦 Dark pool print: ${(vol / 1000).toFixed(0)}K shares @ $${level.price || '?'}`,
                    'MEDIUM', session));
            }
        }
        return newAlerts;
    }

    // ── Generate Trade Setup ────────────────────────────────
    generateTradeSetup(ticker, analysis, currentPrice) {
        if (!analysis || analysis.error || !currentPrice) return null;

        const direction = analysis.bias === 'BULLISH' ? 'LONG' : analysis.bias === 'BEARISH' ? 'SHORT' : null;
        if (!direction) return null;

        const atr = Math.abs(analysis.pivots.r1 - analysis.pivots.s1) / 2;

        if (direction === 'LONG') {
            return {
                ticker,
                direction: 'LONG',
                entry: +currentPrice.toFixed(2),
                target1: +(currentPrice + atr).toFixed(2),
                target2: +(currentPrice + atr * 2).toFixed(2),
                stop: +(currentPrice - atr * 0.5).toFixed(2),
                riskReward: +(atr / (atr * 0.5)).toFixed(1),
                confidence: Math.min(85, 50 + analysis.biasScore.bull * 7),
                pivots: analysis.pivots,
                session: AlertEngine.getCurrentSession()
            };
        } else {
            return {
                ticker,
                direction: 'SHORT',
                entry: +currentPrice.toFixed(2),
                target1: +(currentPrice - atr).toFixed(2),
                target2: +(currentPrice - atr * 2).toFixed(2),
                stop: +(currentPrice + atr * 0.5).toFixed(2),
                riskReward: +(atr / (atr * 0.5)).toFixed(1),
                confidence: Math.min(85, 50 + analysis.biasScore.bear * 7),
                pivots: analysis.pivots,
                session: AlertEngine.getCurrentSession()
            };
        }
    }

    // ── Helpers ─────────────────────────────────────────────
    _makeAlert(ticker, type, direction, message, severity, session) {
        return {
            id: `${type}-${ticker}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            time: new Date().toISOString(),
            session,
            ticker,
            type,
            direction,
            message,
            severity
        };
    }

    addAlerts(newAlerts) {
        this.alerts = [...newAlerts, ...this.alerts].slice(0, this.maxAlerts);
        return newAlerts.length;
    }

    getAlerts(filter = {}) {
        let result = [...this.alerts];
        if (filter.ticker) result = result.filter(a => a.ticker === filter.ticker);
        if (filter.session) result = result.filter(a => a.session === filter.session);
        if (filter.direction) result = result.filter(a => a.direction === filter.direction);
        if (filter.severity) result = result.filter(a => a.severity === filter.severity);
        return result;
    }
}

module.exports = AlertEngine;
