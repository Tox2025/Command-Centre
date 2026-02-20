const fs = require('fs');
const path = require('path');

class EODReporter {
    constructor(dataDir) {
        this.dataDir = dataDir || path.join(__dirname, '../data/eod-reports');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    generateReport(state, tradeJournal, optionsPaper) {
        // Use US Eastern (market) time, not UTC — prevents "tomorrow" dates after 7pm ET
        const now = new Date();
        const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const date = eastern.getFullYear() + '-' +
            String(eastern.getMonth() + 1).padStart(2, '0') + '-' +
            String(eastern.getDate()).padStart(2, '0');
        const reportId = date;
        const timestamp = now.toISOString();

        // 1. Signal Accuracy Analysis
        const signalAccuracy = this.analyzeSignalAccuracy(state);

        // 2. Paper Trading P&L
        const paperStats = tradeJournal.getStats();
        // Filter for today's trades only (using Eastern market time)
        const todayStr = eastern.toLocaleDateString('en-US');
        const todayTrades = tradeJournal.getPaperTrades().filter(t => {
            const tDate = new Date(t.entryTime).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
            return tDate === todayStr;
        });
        const todayStats = {
            totalTrades: todayTrades.length,
            wins: todayTrades.filter(t => t.pnl > 0).length,
            losses: todayTrades.filter(t => t.pnl <= 0 && t.status === 'CLOSED').length,
            pnlPoints: todayTrades.reduce((s, t) => s + (t.pnlPoints || 0), 0),
            totalPnl: todayTrades.reduce((s, t) => {
                if (t.pnlTotal !== undefined) return s + t.pnlTotal;
                // Fallback for calculating historical P&L ($) if fields missing
                let shares = t.shares;
                if (!shares) {
                    const entry = t.paperEntry || t.entry || 0;
                    const stop = t.stop || 0;
                    const risk = Math.abs(entry - stop);
                    shares = risk > 0 ? Math.floor(2000 / risk) : 1;
                }
                return s + ((t.pnlPoints || 0) * shares);
            }, 0),
            winRate: 0,
            byHorizon: {}
        };
        todayStats.winRate = todayTrades.filter(t => t.status === 'CLOSED').length > 0
            ? Math.round(todayStats.wins / todayTrades.filter(t => t.status === 'CLOSED').length * 100)
            : 0;

        // Break down by Horizon
        const horizons = ['Scalp / Day Trade', 'Day Trade', 'Day Trade (volatile)', 'Swing (2-5d)', 'Intraday', 'Extended Hours'];
        horizons.forEach(h => {
            const hTrades = todayTrades.filter(t => (t.horizon || 'Swing').includes(h.split(' ')[0])); // loose match
            if (hTrades.length > 0) {
                todayStats.byHorizon[h] = {
                    count: hTrades.length,
                    pnl: hTrades.reduce((s, t) => s + (t.pnlTotal || 0), 0)
                };
            }
        });

        // 3. Options Paper Stats
        const optionsStats = optionsPaper.getStats(); // Already has today/total logic

        // 4. Regime Analysis
        const regime = state.marketRegime || { regime: 'UNKNOWN' };

        // 5. Generate Recommendations
        const recommendations = this.generateRecommendations(signalAccuracy, regime);

        const report = {
            id: reportId,
            date: date,
            timestamp: timestamp,
            marketRegime: regime,
            tide: state.marketTide,
            performance: {
                paper: todayStats,
                options: optionsStats.today || {}
            },
            signalAnalysis: {
                tickersTracked: Object.keys(state.signalScores || {}).length,
                accuracy: signalAccuracy.overallAccuracy,
                bullAccuracy: signalAccuracy.bullAccuracy,
                bearAccuracy: signalAccuracy.bearAccuracy,
                bestSignals: signalAccuracy.bestSignals,
                worstSignals: signalAccuracy.worstSignals,
                techVsMl: signalAccuracy.techVsMl || null
            },
            recommendations: recommendations,
            // Polygon tick data EOD summary
            polygonTickData: (function () {
                try {
                    var tickSummaries = {};
                    var tickers = Object.keys(state.signalScores || {});
                    tickers.forEach(function (t) {
                        var td = (state.polygonTickSummaries || {})[t];
                        if (td) {
                            tickSummaries[t] = {
                                totalVolume: td.totalVolume || 0,
                                buyPct: td.buyPct || 50,
                                sellPct: td.sellPct || 50,
                                flowImbalance: td.flowImbalance || 0,
                                vwap: td.vwap || 0,
                                largeBlockBuys: td.largeBlockBuys || 0,
                                largeBlockSells: td.largeBlockSells || 0
                            };
                        }
                    });
                    return Object.keys(tickSummaries).length > 0 ? tickSummaries : null;
                } catch (e) { return null; }
            })()
        };

        // Save report
        const filepath = path.join(this.dataDir, reportId + '.json');
        fs.writeFileSync(filepath, JSON.stringify(report, null, 2));

        console.log(`📝 EOD Report generated: ${filepath}`);
        return report;
    }

    analyzeSignalAccuracy(state) {
        const scores = state.signalScores || {};
        const quotes = state.quotes || {};
        const technicals = state.technicals || {};

        let correct = 0, total = 0;
        let bullCorrect = 0, bullTotal = 0;
        let bearCorrect = 0, bearTotal = 0;
        const signalPerf = {}; // Map: "Signal Name" -> { fires: 0, correct: 0 }

        for (const ticker in scores) {
            const score = scores[ticker];
            const q = quotes[ticker];
            const tech = technicals[ticker];

            if (!q || !score) continue;

            const price = parseFloat(q.last || q.price || 0);
            const open = parseFloat(q.open || 0);
            const prevClose = parseFloat(q.prev_close || q.previousClose || 0);

            if (open === 0) continue;

            // Determine actual day direction
            // If we are running this EOD, we compare close to open (intraday) or close to prevClose (daily)
            // Let's use Open-to-Close for intraday accuracy
            const dayChangePct = (price - open) / open * 100;
            const dayDirection = dayChangePct > 0.5 ? 'BULLISH' : dayChangePct < -0.5 ? 'BEARISH' : 'NEUTRAL';

            if (score.direction === 'BULLISH') {
                bullTotal++;
                if (dayDirection === 'BULLISH') {
                    bullCorrect++;
                    correct++;
                } else if (dayDirection === 'NEUTRAL') {
                    // split credit?
                }
                total++;
            } else if (score.direction === 'BEARISH') {
                bearTotal++;
                if (dayDirection === 'BEARISH') {
                    bearCorrect++;
                    correct++;
                }
                total++;
            }

            // Analyze individual signals (skip NEUTRAL signals — they don't predict direction)
            (score.signals || []).forEach(sig => {
                // NEUTRAL signals (ADX Choppy, Low IV, Gamma Pin, High Volatility) should not be
                // counted in accuracy because they have no directional prediction
                if (sig.dir === 'NEUTRAL') return;

                if (!signalPerf[sig.name]) signalPerf[sig.name] = { fires: 0, correct: 0, totalWeight: 0 };
                signalPerf[sig.name].fires++;
                signalPerf[sig.name].totalWeight += Math.abs(sig.weight);

                // Did this signal align with reality?
                const isBull = sig.dir === 'BULL';
                const isBear = sig.dir === 'BEAR';

                if ((isBull && dayDirection === 'BULLISH') || (isBear && dayDirection === 'BEARISH')) {
                    signalPerf[sig.name].correct++;
                }
            });
        }

        const overallAccuracy = total > 0 ? Math.round(correct / total * 100) : 0;
        const bullAcc = bullTotal > 0 ? Math.round(bullCorrect / bullTotal * 100) : 0;
        const bearAcc = bearTotal > 0 ? Math.round(bearCorrect / bearTotal * 100) : 0;

        // Sort signals
        const signalsList = Object.keys(signalPerf).map(k => ({
            name: k,
            fires: signalPerf[k].fires,
            accuracy: Math.round(signalPerf[k].correct / signalPerf[k].fires * 100)
        }));

        const bestSignals = signalsList.filter(s => s.fires >= 3).sort((a, b) => b.accuracy - a.accuracy).slice(0, 5);
        const worstSignals = signalsList.filter(s => s.fires >= 3).sort((a, b) => a.accuracy - b.accuracy).slice(0, 5);

        // ── Tech vs ML Accuracy Comparison ──
        let techCorrect = 0, techTotal = 0;
        let mlCorrect = 0, mlTotal = 0;
        let bothAgree = 0, techOnlyRight = 0, mlOnlyRight = 0, bothWrong = 0;

        for (const ticker in scores) {
            const score = scores[ticker];
            const q = quotes[ticker];
            if (!q || !score) continue;

            const price = parseFloat(q.last || q.price || 0);
            const open2 = parseFloat(q.open || 0);
            if (open2 === 0) continue;

            const dayChangePct2 = (price - open2) / open2 * 100;
            const dayDir2 = dayChangePct2 > 0.5 ? 'BULLISH' : dayChangePct2 < -0.5 ? 'BEARISH' : 'NEUTRAL';
            if (dayDir2 === 'NEUTRAL') continue;

            // Tech prediction (based on technicalConfidence / confidence)
            var techConf = score.technicalConfidence || score.confidence || 50;
            var techDir = score.direction; // direction is based on technical
            var techRight = techDir === dayDir2;

            // ML prediction (based on mlConfidence)
            var mlConf = score.mlConfidence;
            if (mlConf !== null && mlConf !== undefined) {
                var mlDir = mlConf > 55 ? 'BULLISH' : mlConf < 45 ? 'BEARISH' : 'NEUTRAL';
                if (mlDir !== 'NEUTRAL') {
                    mlTotal++;
                    if (mlDir === dayDir2) mlCorrect++;

                    techTotal++;
                    if (techRight) techCorrect++;

                    // Agreement tracking
                    if (techRight && mlDir === dayDir2) bothAgree++;
                    else if (techRight && mlDir !== dayDir2) techOnlyRight++;
                    else if (!techRight && mlDir === dayDir2) mlOnlyRight++;
                    else bothWrong++;
                }
            }
        }

        return {
            overallAccuracy,
            bullAccuracy: bullAcc,
            bearAccuracy: bearAcc,
            bestSignals,
            worstSignals,
            // Tech vs ML comparison
            techVsMl: {
                techAccuracy: techTotal > 0 ? Math.round(techCorrect / techTotal * 100) : null,
                mlAccuracy: mlTotal > 0 ? Math.round(mlCorrect / mlTotal * 100) : null,
                techTotal,
                mlTotal,
                bothAgree,
                techOnlyRight,
                mlOnlyRight,
                bothWrong,
                winner: techTotal > 0 ? (techCorrect > mlCorrect ? 'TECH' : mlCorrect > techCorrect ? 'ML' : 'TIE') : null
            }
        };
    }

    generateRecommendations(accuracy, regime) {
        const recs = [];

        if (accuracy.overallAccuracy < 50) {
            recs.push(`⚠️ Overall signal accuracy is low (${accuracy.overallAccuracy}%). detailed review needed.`);
        }

        if (accuracy.bullAccuracy > accuracy.bearAccuracy + 20) {
            recs.push(`📈 Bull signals significantly outperforming bear signals. Consider increasing bull thresholds or reducing bear weights in this regime (${regime.regime}).`);
        } else if (accuracy.bearAccuracy > accuracy.bullAccuracy + 20) {
            recs.push(`📉 Bear signals outperforming. Market may be weaker than technicals suggest.`);
        }

        accuracy.worstSignals.forEach(s => {
            if (s.accuracy < 40) {
                recs.push(`🔧 Weight Adjustment: "${s.name}" has low accuracy (${s.accuracy}%). Consider reducing its weight or gating it.`);
            }
        });

        if (regime.regime === 'VOLATILE' && accuracy.overallAccuracy < 50) {
            recs.push(`🌪️ Volatility is hurting predictive power. Recommend widening stop losses and reducing position sizes.`);
        }

        if (regime.regime === 'RANGING') {
            recs.push(`📊 RANGING regime detected — trend-following bear signals (MACD Negative, RSI Bearish, EMA Bearish) are auto-dampened to 40% weight. Mean-reversion signals boosted.`);
            if (accuracy.bearAccuracy < 30) {
                recs.push(`🔻 Bear accuracy very low (${accuracy.bearAccuracy}%) — regime dampening is correctly reducing false bear signals.`);
            }
        }

        // Auto-boost/reduce recommendations with specific values
        accuracy.bestSignals.forEach(s => {
            if (s.accuracy >= 80 && s.fires >= 5) {
                recs.push(`✅ Signal Boost: "${s.name}" has ${s.accuracy}% accuracy over ${s.fires} fires — consider increasing weight.`);
            }
        });

        return recs;
    }

    listReports() {
        if (!fs.existsSync(this.dataDir)) return [];
        return fs.readdirSync(this.dataDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''))
            .sort().reverse();
    }

    getReport(date) {
        const filepath = path.join(this.dataDir, date + '.json');
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf8'));
        }
        return null;
    }
}

module.exports = EODReporter;
