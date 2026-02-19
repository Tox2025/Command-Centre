// Trading Dashboard — Main Server
// Express + WebSocket for real-time data push

require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const UWClient = require('./src/uw-client');
const TechnicalAnalysis = require('./src/technical');
const AlertEngine = require('./src/alerts');
const { enrichCongressTrades } = require('./src/congress-data');
const { SignalEngine } = require('./src/signal-engine');
const TradeJournal = require('./src/trade-journal');
const MLCalibrator = require('./src/ml-calibrator');
const EarningsCalendar = require('./src/earnings-calendar');
const { MarketRegime } = require('./src/market-regime');
const { NewsSentiment } = require('./src/sentiment');
const { CorrelationGuard } = require('./src/correlation-guard');
const { Notifier } = require('./src/notifier');
const { MarketScanner } = require('./src/market-scanner');
const { SessionScheduler } = require('./src/session-scheduler');
const { XAlertMonitor } = require('./src/x-alert-monitor');
const { GapAnalyzer } = require('./src/gap-analyzer');
const YahooPriceFeed = require('./src/yahoo-price-feed');
const MultiTFAnalyzer = require('./src/multi-tf-analyzer');
const { OpportunityScanner } = require('./src/opportunity-scanner');
const OptionsPaperTrading = require('./src/options-paper-trading');
const EODReporter = require('./src/eod-reporter');
const PolygonTickClient = require('./src/polygon-client');
const PolygonHistorical = require('./src/polygon-historical');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
// Load watchlist: file > env > default
var TICKERS;
try {
    var watchlistPath = path.join(__dirname, 'data', 'watchlist.json');
    if (require('fs').existsSync(watchlistPath)) {
        TICKERS = JSON.parse(require('fs').readFileSync(watchlistPath, 'utf8'));
        console.log('📋 Loaded watchlist from file: ' + TICKERS.join(', '));
    } else {
        TICKERS = (process.env.TICKERS || 'AAPL,MSFT,TSLA').split(',').map(t => t.trim());
    }
} catch (e) {
    TICKERS = (process.env.TICKERS || 'AAPL,MSFT,TSLA').split(',').map(t => t.trim());
}

function saveWatchlist() {
    try {
        var dir = path.join(__dirname, 'data');
        if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
        require('fs').writeFileSync(path.join(dir, 'watchlist.json'), JSON.stringify(state.tickers, null, 2));
    } catch (e) { console.error('Failed to save watchlist:', e.message); }
}

// ── State ─────────────────────────────────────────────────
const uw = new UWClient(process.env.UW_API_KEY);
const alertEngine = new AlertEngine();
const signalEngine = new SignalEngine();
const tradeJournal = new TradeJournal();
const mlCalibrator = new MLCalibrator();
const earningsCalendar = new EarningsCalendar(uw);
const marketRegime = new MarketRegime();
const newsSentiment = new NewsSentiment();
const correlationGuard = new CorrelationGuard();
const notifier = new Notifier();
const scanner = new MarketScanner({ minConfidence: 50, maxCandidates: 10, minPrice: 2 });
const scheduler = new SessionScheduler({ dailyLimit: 15000, safetyMargin: 0.90 });
const xAlertMonitor = new XAlertMonitor({ minScore: 50 });
const gapAnalyzer = new GapAnalyzer();
const yahooPriceFeed = new YahooPriceFeed();
const multiTFAnalyzer = new MultiTFAnalyzer();
const opportunityScanner = new OpportunityScanner(signalEngine, multiTFAnalyzer);
const optionsPaper = new OptionsPaperTrading();
const eodReporter = new EODReporter();
const polygonClient = new PolygonTickClient(process.env.POLYGON_API_KEY);

const state = {
    tickers: TICKERS,
    quotes: {},
    technicals: {},
    optionsFlow: [],
    darkPool: {},
    darkPoolRecent: [],
    gex: {},
    marketTide: null,
    congressTrades: [],
    congressLateReports: [],
    tradeSetups: {},
    alerts: [],
    morningBrief: {},
    // Phase 1 new data
    shortInterest: {},
    ivRank: {},
    maxPain: {},
    oiChange: {},
    stockState: {},
    greeks: {},
    insiderData: {},
    insiderTransactions: [],
    news: [],
    earningsToday: { premarket: [], afterhours: [] },
    earnings: {},
    marketSpike: null,
    totalOptionsVol: null,
    marketOIChange: null,
    marketInsiderBuySells: null,
    lastUpdate: null,
    session: 'LOADING',
    signalScores: {},
    journalStats: {},
    mlStatus: {},
    earningsRisk: {},
    marketRegime: null,
    sentiment: {},
    correlationRisk: {},
    kellySizing: {},
    notifierStatus: {},
    scannerResults: {},
    topNetImpact: [],
    xAlerts: [],
    gapAnalysis: [],
    halts: [],
    multiTF: {},
    hotOpportunities: [],
    // Phase 1 API Enhancement data
    netPremium: {},
    flowPerStrike: {},
    flowPerExpiry: {},
    greekFlow: {},
    spotExposures: {},
    shortVolume: {},
    failsToDeliver: {},
    seasonality: {},
    realizedVol: {},
    termStructure: {},
    insiderFlow: {},
    sectorTide: {},
    etfTide: {},
    economicCalendar: [],
    etfFlows: {},
    chatHistory: new Map(),
    tickData: {}  // Polygon real-time tick summaries
};

// ── Express Setup ─────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// REST API for initial page load
app.get('/api/state', (req, res) => {
    res.json(state);
});

app.get('/api/tickers', (req, res) => {
    res.json(state.tickers);
});

// Add/remove tickers dynamically
app.post('/api/tickers', async (req, res) => {
    const { ticker, action } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
    const sym = ticker.toUpperCase().trim();

    if (action === 'add' && !state.tickers.includes(sym)) {
        state.tickers.push(sym);
        try {
            await fetchTickerData(sym, 'COLD'); // Full data fetch including WARM + COLD tier data
            await scoreTickerSignals(sym); // Run signal scoring + trade setup pipeline
            state.morningBrief = generateMorningBrief(); // Regenerate briefs for all tickers
        } catch (e) {
            console.log('⚠️ Error fetching data for ' + sym + ':', e.message);
        }
        broadcast({ type: 'full_state', data: state });
        saveWatchlist();
        polygonClient.updateSubscriptions(state.tickers);
        console.log('➕ Added ticker: ' + sym + ' (total: ' + state.tickers.length + ')');

        // Background ML: fetch 5yr history for new ticker and retrain
        (async function () {
            try {
                var result = await polygonHistorical.generateAndConvert([sym], 5);
                if (result && result.mlSamples > 30) {
                    // Load cumulative dataset, append, save
                    var cumulPath = path.join(__dirname, 'data', 'ml-training-cumulative.json');
                    var cumulative = [];
                    try { if (require('fs').existsSync(cumulPath)) cumulative = JSON.parse(require('fs').readFileSync(cumulPath, 'utf8')); } catch (e) { }
                    cumulative = cumulative.concat(result.data);
                    require('fs').writeFileSync(cumulPath, JSON.stringify(cumulative));
                    // Retrain both models with cumulative data
                    var recent = cumulative.slice(Math.floor(cumulative.length * 0.6));
                    mlCalibrator.train(recent, 'dayTrade');
                    mlCalibrator.train(cumulative, 'swing');
                    var st = mlCalibrator.getStatus();
                    console.log('🧠 ML auto-trained on ' + sym + ': dayTrade=' + st.dayTrade.accuracy + '% swing=' + st.swing.accuracy + '% (' + cumulative.length + ' cumulative samples)');
                }
            } catch (e) { console.error('ML auto-train error for ' + sym + ':', e.message); }
        })();
    } else if (action === 'remove') {
        state.tickers = state.tickers.filter(t => t !== sym);
        // Clean up removed ticker data
        delete state.signalScores[sym];
        delete state.tradeSetups[sym];
        delete state.kellySizing[sym];
        state.morningBrief = generateMorningBrief();
        broadcast({ type: 'full_state', data: state });
        saveWatchlist();
        polygonClient.updateSubscriptions(state.tickers);
        console.log('➖ Removed ticker: ' + sym + ' (total: ' + state.tickers.length + ')');
    }
    res.json({ tickers: state.tickers });
});

// Multi-timeframe technicals
app.get('/api/technicals/:ticker/:timeframe', async (req, res) => {
    const { ticker, timeframe } = req.params;
    const validTF = ['1m', '5m', '15m', '1h', '4h', '1d'];
    if (!validTF.includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe' });
    try {
        const hist = await uw.getHistoricalPrice(ticker.toUpperCase(), timeframe);
        if (!hist?.data || !Array.isArray(hist.data) || hist.data.length < 30) {
            return res.json({ error: 'Insufficient data for this timeframe' });
        }
        const candles = hist.data.map(d => ({
            date: d.date || d.timestamp, open: parseFloat(d.open),
            high: parseFloat(d.high), low: parseFloat(d.low),
            close: parseFloat(d.close), volume: parseFloat(d.volume || 0)
        }));
        const analysis = TechnicalAnalysis.analyze(candles);
        analysis.timeframe = timeframe;
        res.json(analysis);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 1: New REST Endpoints
app.get('/api/news', (req, res) => res.json(state.news));
app.get('/api/insider', (req, res) => res.json(state.insiderTransactions));
app.get('/api/earnings/today', (req, res) => res.json(state.earningsToday));
app.get('/api/shorts/:ticker', (req, res) => {
    const t = req.params.ticker.toUpperCase();
    res.json(state.shortInterest[t] || null);
});
app.get('/api/ticker/:ticker/deep', (req, res) => {
    const t = req.params.ticker.toUpperCase();
    res.json({
        quote: state.quotes[t],
        technicals: state.technicals[t],
        ivRank: state.ivRank[t],
        maxPain: state.maxPain[t],
        oiChange: state.oiChange[t],
        shortInterest: state.shortInterest[t],
        greeks: state.greeks[t],
        gex: state.gex[t],
        darkPool: state.darkPool[t],
        insider: state.insiderData[t],
        earnings: state.earnings[t],
        setup: state.tradeSetups[t],
        stockState: state.stockState[t]
    });
});
app.get('/api/darkpool/recent', (req, res) => res.json(state.darkPoolRecent));
app.get('/api/market/spike', (req, res) => res.json(state.marketSpike));

// Journal & ML endpoints
app.get('/api/journal/stats', (req, res) => res.json(tradeJournal.getStats()));
app.get('/api/journal/trades', (req, res) => res.json(tradeJournal.getRecentTrades(50)));
app.get('/api/ml/status', (req, res) => res.json(mlCalibrator.getStatus()));
app.get('/api/signals/:ticker', (req, res) => {
    const t = req.params.ticker.toUpperCase();
    res.json(state.signalScores[t] || null);
});
app.get('/api/regime', (req, res) => res.json(state.marketRegime));
app.get('/api/correlation', (req, res) => res.json(state.correlationRisk));
app.get('/api/scanner', (req, res) => res.json(scanner.getResults()));
app.get('/api/tick-data', (req, res) => res.json({ connected: polygonClient.isConnected(), tickers: polygonClient.getSubscribedCount(), data: polygonClient.getAllSummaries() }));
app.get('/api/tick-data/:ticker', (req, res) => { var t = req.params.ticker.toUpperCase(); var s = polygonClient.getTickSummary(t); res.json(s || { error: 'No tick data for ' + t }); });
app.get('/api/polygon/snapshot', async (req, res) => { try { var count = await polygonClient.getSnapshot(); res.json({ updated: count, cached: Object.keys(polygonClient.snapshotCache).length }); } catch (e) { res.json({ error: e.message }); } });
app.get('/api/polygon/snapshot/:ticker', async (req, res) => { try { var d = await polygonClient.getTickerSnapshot(req.params.ticker); res.json(d || { error: 'No data' }); } catch (e) { res.json({ error: e.message }); } });
app.get('/api/polygon/gainers', async (req, res) => { try { res.json(await polygonClient.getGainers()); } catch (e) { res.json([]); } });
app.get('/api/polygon/losers', async (req, res) => { try { res.json(await polygonClient.getLosers()); } catch (e) { res.json([]); } });
app.get('/api/polygon/indicators/:ticker', async (req, res) => { try { res.json(await polygonClient.getAllIndicators(req.params.ticker)); } catch (e) { res.json({ error: e.message }); } });
app.get('/api/polygon/bars/:ticker', (req, res) => { var t = req.params.ticker.toUpperCase(); res.json({ minute: polygonClient.getMinuteBars(t), second: polygonClient.getSecondBars(t) }); });
app.get('/api/polygon/details/:ticker', async (req, res) => { try { res.json(await polygonClient.getTickerDetails(req.params.ticker)); } catch (e) { res.json({ error: e.message }); } });
// ML historical data pipeline endpoints
const polygonHistorical = new PolygonHistorical(process.env.POLYGON_API_KEY || '');
app.get('/api/polygon/ml/generate/:ticker', async (req, res) => {
    try {
        var years = parseInt(req.query.years) || 5;
        var data = await polygonHistorical.generateTrainingData(req.params.ticker.toUpperCase(), years);
        res.json({ success: true, samples: data ? data.length : 0, data: data });
    } catch (e) { res.json({ error: e.message }); }
});
app.post('/api/polygon/ml/batch', async (req, res) => {
    try {
        var tickers = req.body.tickers || state.tickers || [];
        var years = parseInt(req.body.years) || 5;
        var result = await polygonHistorical.generateBatchTrainingData(tickers, years);
        res.json({ success: true, ...result });
    } catch (e) { res.json({ error: e.message }); }
});
app.get('/api/polygon/ml/availability/:ticker', async (req, res) => {
    try {
        var info = await polygonHistorical.checkDataAvailability(req.params.ticker.toUpperCase());
        res.json(info || { error: 'No data' });
    } catch (e) { res.json({ error: e.message }); }
});
// One-click ML retrain: fetch Polygon historical → convert → train both models
app.post('/api/ml/retrain', async (req, res) => {
    try {
        var tickers = req.body.tickers || state.tickers || [];
        var years = parseInt(req.body.years) || 5;
        console.log('🧠 ML Retrain started: ' + tickers.length + ' tickers, ' + years + ' years...');

        // Step 1: Generate and convert historical data
        var result = await polygonHistorical.generateAndConvert(tickers, years);
        if (!result || result.mlSamples < 30) {
            return res.json({ error: 'Insufficient training data (' + (result ? result.mlSamples : 0) + ' samples)' });
        }

        // Step 2: Split into dayTrade (recent 2yr) and swing (all) datasets
        var allData = result.data;
        var midpoint = Math.floor(allData.length * 0.6);
        var recentData = allData.slice(midpoint); // More recent data for dayTrade
        var fullData = allData; // Full dataset for swing

        // Step 3: Train both models
        var dayTradeSuccess = mlCalibrator.train(recentData, 'dayTrade');
        var swingSuccess = mlCalibrator.train(fullData, 'swing');

        var status = mlCalibrator.getStatus();
        console.log('🧠 ML Retrain complete! DayTrade: ' + (dayTradeSuccess ? status.dayTrade.accuracy + '%' : 'failed') +
            ' | Swing: ' + (swingSuccess ? status.swing.accuracy + '%' : 'failed'));

        res.json({
            success: true,
            tickersUsed: tickers.length,
            yearsOfData: years,
            rawSamples: result.rawSamples,
            mlSamples: result.mlSamples,
            bullishSamples: result.bullish,
            bearishSamples: result.bearish,
            dayTrade: {
                trained: dayTradeSuccess,
                samples: recentData.length,
                accuracy: status.dayTrade.accuracy,
                topFeatures: (status.dayTrade.featureImportance || []).slice(0, 5)
            },
            swing: {
                trained: swingSuccess,
                samples: fullData.length,
                accuracy: status.swing.accuracy,
                topFeatures: (status.swing.featureImportance || []).slice(0, 5)
            }
        });
    } catch (e) {
        console.error('ML retrain error:', e.message);
        res.json({ error: e.message });
    }
});
app.get('/api/scanner/clear-cooldown', (req, res) => { scanner.clearCooldown(); res.json({ cleared: true }); });
app.get('/api/budget', (req, res) => res.json(scheduler.getBudget()));
app.get('/api/kelly/:ticker', (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const conf = state.signalScores[t]?.confidence || 60;
    res.json(tradeJournal.calculateKellySize(conf));
});
app.get('/api/sentiment/:ticker', (req, res) => {
    const t = req.params.ticker.toUpperCase();
    res.json(state.sentiment[t] || null);
});
app.get('/api/notifier/status', (req, res) => res.json(notifier.getStatus()));
app.get('/api/paper-trades', (req, res) => {
    const trades = tradeJournal.getPaperTrades().map(t => {
        // Compute missing fields for old trades
        if (t.status !== 'PENDING' && t.pnlPoints === undefined) {
            var exit = t.exitPrice || t.outcome || t.entry;
            var entry = t.paperEntry || t.entry;
            t.pnlPoints = t.direction === 'SHORT' ? +(entry - exit).toFixed(2) : +(exit - entry).toFixed(2);
        }
        if (t.status !== 'PENDING' && !t.exitPrice && t.outcome) {
            t.exitPrice = t.outcome;
        }
        if (t.status === 'PENDING' && t.unrealizedPnlDollar === undefined) {
            var entryP = t.paperEntry || t.entry || 0;
            t.unrealizedPnlDollar = +((t.unrealizedPnl || 0) * entryP / 100).toFixed(2);
        }
        // Ensure pnl field exists (some old trades only have pnlPct)
        if (t.pnl === undefined && t.pnlPct !== undefined && t.pnlPct !== null) {
            t.pnl = t.pnlPct;
        }
        return t;
    });
    res.json(trades);
});
app.post('/api/paper-trades', async (req, res) => {
    try {
        const { ticker } = req.body;
        if (!ticker) return res.status(400).json({ error: 'ticker required' });
        const setup = state.tradeSetups[ticker]; // tradeSetups is an Object, not Array
        if (!setup) return res.status(404).json({ error: 'No active setup for ' + ticker });
        const price = parseFloat((state.quotes[ticker] || {}).last || (state.quotes[ticker] || {}).price || setup.entry || 0);
        const trade = tradeJournal.paperTrade(setup, price);
        if (trade) {
            try { await notifier.sendPaperTrade(trade, 'ENTRY'); } catch (e) { /* optional */ }
        }
        res.json({ success: true, trade });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/paper-trades/close', (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'trade id required' });
        const trade = tradeJournal.trades.find(t => t.id === id && t.status === 'PENDING');
        if (!trade) return res.status(404).json({ error: 'Paper trade not found' });
        const ticker = trade.ticker;
        const currentPrice = parseFloat((state.quotes[ticker] || {}).last || (state.quotes[ticker] || {}).price || 0);
        if (currentPrice > 0) {
            tradeJournal._closeTrade(trade, 'CLOSED', currentPrice);
        } else {
            tradeJournal._closeTrade(trade, 'CLOSED', trade.paperEntry || trade.entry);
        }
        res.json({ success: true, trade });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/paper-trades/stats', (req, res) => {
    const trades = tradeJournal.getPaperTrades().map(t => {
        // Ensure pnl field exists (some old trades only have pnlPct)
        if (t.pnl === undefined && t.pnlPct !== undefined && t.pnlPct !== null) {
            t.pnl = t.pnlPct;
        }
        // Ensure pnlPoints exists for old trades (compute from entry/exit if missing)
        if (t.status !== 'PENDING' && t.pnlPoints === undefined) {
            var exit = t.exitPrice || t.outcome || t.entry;
            var entry = t.paperEntry || t.entry;
            t.pnlPoints = t.direction === 'SHORT' ? +(entry - exit).toFixed(2) : +(exit - entry).toFixed(2);
        }
        // Ensure unrealizedPnlDollar exists for open trades
        if (t.status === 'PENDING' && t.unrealizedPnlDollar === undefined) {
            var entryP = t.paperEntry || t.entry || 0;
            t.unrealizedPnlDollar = +((t.unrealizedPnl || 0) * entryP / 100).toFixed(2);
        }
        return t;
    });
    const closed = trades.filter(t => t.status !== 'PENDING');
    const open = trades.filter(t => t.status === 'PENDING');
    const wins = closed.filter(t => t.pnl > 0).length;
    const losses = closed.filter(t => t.pnl <= 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const totalPnlDollar = closed.reduce((s, t) => s + (t.pnlPoints || 0), 0);
    const unrealizedPnl = open.reduce((s, t) => s + (t.unrealizedPnl || 0), 0);
    const unrealizedPnlDollar = open.reduce((s, t) => s + (t.unrealizedPnlDollar || 0), 0);
    const winRate = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;
    const avgPnl = closed.length > 0 ? +(totalPnl / closed.length).toFixed(2) : 0;

    // ── Daily P&L (today only, ET timezone) ──
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    const todayClosed = closed.filter(t => {
        if (!t.closedAt) return false;
        return new Date(t.closedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === todayStr;
    });
    const todayPnl = todayClosed.reduce((s, t) => s + (t.pnl || 0), 0);
    const todayPnlDollar = todayClosed.reduce((s, t) => s + (t.pnlPoints || 0), 0);
    const todayWins = todayClosed.filter(t => t.pnl > 0).length;
    const todayLosses = todayClosed.filter(t => t.pnl <= 0).length;
    const todayWinRate = todayClosed.length > 0 ? Math.round(todayWins / todayClosed.length * 100) : 0;

    // ── Per-Ticker Breakdown ──
    const byTicker = {};
    closed.forEach(t => {
        if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, trades: 0, wins: 0, losses: 0, pnl: 0, pnlDollar: 0, longs: 0, shorts: 0, longPnl: 0, shortPnl: 0, longPnlDollar: 0, shortPnlDollar: 0 };
        const bt = byTicker[t.ticker];
        bt.trades++;
        if (t.pnl > 0) bt.wins++; else bt.losses++;
        bt.pnl += (t.pnl || 0);
        bt.pnlDollar += (t.pnlPoints || 0);
        if (t.direction === 'LONG') { bt.longs++; bt.longPnl += (t.pnl || 0); bt.longPnlDollar += (t.pnlPoints || 0); }
        else { bt.shorts++; bt.shortPnl += (t.pnl || 0); bt.shortPnlDollar += (t.pnlPoints || 0); }
    });
    const tickerBreakdown = Object.values(byTicker).sort((a, b) => b.pnl - a.pnl);

    // ── Long vs Short Breakdown ──
    const longs = closed.filter(t => t.direction === 'LONG');
    const shorts = closed.filter(t => t.direction === 'SHORT');
    const longWins = longs.filter(t => t.pnl > 0).length;
    const shortWins = shorts.filter(t => t.pnl > 0).length;
    const longPnl = longs.reduce((s, t) => s + (t.pnl || 0), 0);
    const longPnlDollar = longs.reduce((s, t) => s + (t.pnlPoints || 0), 0);
    const shortPnl = shorts.reduce((s, t) => s + (t.pnl || 0), 0);
    const shortPnlDollar = shorts.reduce((s, t) => s + (t.pnlPoints || 0), 0);

    // ── Avg Win / Avg Loss ──
    const winTrades = closed.filter(t => t.pnl > 0);
    const lossTrades = closed.filter(t => t.pnl <= 0);
    const avgWin = winTrades.length > 0 ? +(winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length).toFixed(2) : 0;
    const avgWinDollar = winTrades.length > 0 ? +(winTrades.reduce((s, t) => s + (t.pnlPoints || 0), 0) / winTrades.length).toFixed(2) : 0;
    const avgLoss = lossTrades.length > 0 ? +(lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length).toFixed(2) : 0;
    const avgLossDollar = lossTrades.length > 0 ? +(lossTrades.reduce((s, t) => s + (t.pnlPoints || 0), 0) / lossTrades.length).toFixed(2) : 0;

    // ── Best/Worst with details ──
    const sortedByPnl = [...closed].sort((a, b) => b.pnl - a.pnl);
    const bestTrade = sortedByPnl[0] || null;
    const worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;

    res.json({
        accountSize: 100000,
        totalTrades: trades.length,
        openTrades: open.length,
        closedTrades: closed.length,
        wins, losses, winRate, totalPnl: +totalPnl.toFixed(2), totalPnlDollar: +totalPnlDollar.toFixed(2),
        unrealizedPnl: +unrealizedPnl.toFixed(2), unrealizedPnlDollar: +unrealizedPnlDollar.toFixed(2),
        avgPnl, avgWin, avgLoss, avgWinDollar: +avgWinDollar, avgLossDollar: +avgLossDollar,
        bestTrade: bestTrade ? { ticker: bestTrade.ticker, pnl: +bestTrade.pnl.toFixed(2), pnlPoints: +(bestTrade.pnlPoints || 0).toFixed(2), direction: bestTrade.direction } : null,
        worstTrade: worstTrade ? { ticker: worstTrade.ticker, pnl: +worstTrade.pnl.toFixed(2), pnlPoints: +(worstTrade.pnlPoints || 0).toFixed(2), direction: worstTrade.direction } : null,
        // Daily
        today: { closed: todayClosed.length, pnl: +todayPnl.toFixed(2), pnlDollar: +todayPnlDollar.toFixed(2), wins: todayWins, losses: todayLosses, winRate: todayWinRate },
        // Long vs Short
        longStats: { trades: longs.length, wins: longWins, pnl: +longPnl.toFixed(2), pnlDollar: +longPnlDollar.toFixed(2), winRate: longs.length > 0 ? Math.round(longWins / longs.length * 100) : 0 },
        shortStats: { trades: shorts.length, wins: shortWins, pnl: +shortPnl.toFixed(2), pnlDollar: +shortPnlDollar.toFixed(2), winRate: shorts.length > 0 ? Math.round(shortWins / shorts.length * 100) : 0 },
        // Per-ticker
        tickerBreakdown: tickerBreakdown
    });
});

// ── Options Paper Trading API ────────────────────────────
app.get('/api/options-paper/trades', (req, res) => {
    res.json(optionsPaper.getTrades());
});
app.get('/api/options-paper/open-positions', (req, res) => {
    res.json(optionsPaper.getOpenTrades());
});
app.post('/api/options-paper/open', async (req, res) => {
    try {
        var body = req.body;
        if (!body.ticker) return res.status(400).json({ error: 'ticker required' });
        var trade = optionsPaper.openTrade(body);
        if (!trade) return res.json({ success: false, error: 'Duplicate trade or invalid params' });
        console.log('📋 Options paper trade: ' + trade.optionType.toUpperCase() + ' ' + trade.ticker + ' $' + trade.strike + ' @ $' + trade.entryPremium + ' (' + trade.contracts + ' contracts)');
        res.json({ success: true, trade: trade });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/options-paper/close', (req, res) => {
    try {
        var id = req.body.id;
        if (!id) return res.status(400).json({ error: 'trade id required' });
        var trade = optionsPaper.closeTrade(id);
        if (!trade) return res.status(404).json({ error: 'Open options trade not found' });
        console.log('📋 Closed options paper: ' + trade.ticker + ' ' + trade.optionType.toUpperCase() + ' $' + trade.strike + ' P&L: $' + trade.pnl + ' (' + trade.pnlPct + '%)');
        res.json({ success: true, trade: trade });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/options-paper/stats', (req, res) => {
    res.json(optionsPaper.getStats());
});
app.get('/api/options-paper/training-data', (req, res) => {
    res.json(optionsPaper.getTrainingData());
});
app.post('/api/options-paper/auto-enter/:ticker', async (req, res) => {
    try {
        var ticker = req.params.ticker.toUpperCase();
        var recRes = await fetch('http://localhost:' + PORT + '/api/options-recommend/' + ticker);
        var recData = await recRes.json();
        if (recData.error) return res.json({ success: false, error: recData.error });

        var rec = recData.recommendation;
        var trade = optionsPaper.openTrade({
            ticker: ticker,
            optionType: rec.optionType,
            strategy: rec.strategy,
            strike: rec.strike,
            dte: rec.dte,
            premium: rec.estimatedPremium,
            contracts: rec.contracts,
            stockPrice: recData.price,
            confidence: rec.confidence,
            direction: rec.direction,
            signals: recData.topSignals || [],
            reasoning: recData.reasoning || [],
            ivRank: recData.analysis ? recData.analysis.ivRank : 0,
            horizon: rec.horizon,
            session: state.session || 'UNKNOWN',
            autoEntry: true,
            features: recData.analysis || {}
        });

        if (!trade) return res.json({ success: false, error: 'Duplicate or invalid' });
        console.log('🤖 Auto options paper: ' + rec.optionType.toUpperCase() + ' ' + ticker + ' $' + rec.strike + ' @ $' + rec.estimatedPremium + ' (conf: ' + rec.confidence + '%)');
        res.json({ success: true, trade: trade, recommendation: recData });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backtest', async (req, res) => {
    try {
        const results = await runBacktest();
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── EOD Reporting APIs ────────────────────────────────────
app.get('/api/eod-reports', (req, res) => {
    res.json(eodReporter.listReports());
});

app.get('/api/eod-report/:date', (req, res) => {
    const report = eodReporter.getReport(req.params.date);
    if (report) res.json(report);
    else res.status(404).json({ error: 'Report not found' });
});

app.post('/api/eod-report/generate', (req, res) => {
    try {
        const report = eodReporter.generateReport(state, tradeJournal, optionsPaper);
        res.json({ success: true, report });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// TradingView webhook receiver
app.post('/webhook/tradingview', (req, res) => {
    console.log('📡 TradingView Webhook:', JSON.stringify(req.body));
    const alert = {
        id: `tv-${Date.now()}`,
        time: new Date().toISOString(),
        session: AlertEngine.getCurrentSession(),
        ticker: req.body.ticker || req.body.symbol || 'UNKNOWN',
        type: 'TRADINGVIEW',
        direction: (req.body.action || '').toUpperCase() === 'BUY' ? 'BULLISH' : 'BEARISH',
        message: `📺 TV Alert: ${req.body.message || req.body.action || JSON.stringify(req.body)}`,
        severity: 'HIGH'
    };
    alertEngine.addAlerts([alert]);
    state.alerts = alertEngine.getAlerts();
    broadcast({ type: 'alert', data: alert });
    res.json({ received: true });
});

// ── X Alert Validation ───────────────────────────────────
// Manual validation from dashboard
app.post('/api/validate-ticker', async (req, res) => {
    try {
        var ticker = (req.body.ticker || '').toUpperCase().trim();
        var source = req.body.source || 'Manual';
        var text = req.body.text || '';
        if (!ticker) return res.status(400).json({ error: 'No ticker provided' });

        console.log('🎯 Validating X alert: ' + ticker + ' (source: ' + source + ')');
        var result = await xAlertMonitor.ingestAlert(ticker, source, text, uw);
        scheduler.trackCalls(5); // 5 API calls per validation // 4 API calls per validation

        // If validated, send Telegram notification
        if (result && result.status === 'VALIDATED') {
            var msg = xAlertMonitor.formatTelegramMessage(result);
            if (msg) notifier.sendTelegram(msg);
        }

        // Update state and broadcast
        state.xAlerts = xAlertMonitor.getAlerts();
        broadcast({ type: 'full_state', data: state });

        res.json(result);
    } catch (e) {
        console.error('Validation error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Webhook for Telegram-forwarded X alerts
app.post('/webhook/x-alert', async (req, res) => {
    try {
        var ticker = (req.body.ticker || '').toUpperCase().trim();
        var source = req.body.source || 'X/Telegram';
        var text = req.body.text || req.body.message || '';

        // Try to extract ticker from text if not provided
        if (!ticker && text) {
            var match = text.match(/\$([A-Z]{1,6})/i);
            if (match) ticker = match[1].toUpperCase();
        }
        if (!ticker) return res.status(400).json({ error: 'No ticker found' });

        console.log('🎯 X Alert webhook: ' + ticker + ' from ' + source);
        var result = await xAlertMonitor.ingestAlert(ticker, source, text, uw);
        scheduler.trackCalls(5); // 5 API calls per validation

        if (result && result.status === 'VALIDATED') {
            var msg = xAlertMonitor.formatTelegramMessage(result);
            if (msg) notifier.sendTelegram(msg);
        }

        state.xAlerts = xAlertMonitor.getAlerts();
        broadcast({ type: 'full_state', data: state });

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get all X alerts
app.get('/api/x-alerts', (req, res) => {
    res.json(xAlertMonitor.getAlerts());
});

// Delete an X alert
app.delete('/api/x-alerts/:ticker', (req, res) => {
    var ticker = req.params.ticker.toUpperCase();
    xAlertMonitor.alerts = xAlertMonitor.alerts.filter(a => a.ticker !== ticker);
    xAlertMonitor.clearCooldown(ticker);
    state.xAlerts = xAlertMonitor.getAlerts();
    broadcast({ type: 'full_state', data: state });
    res.json({ deleted: ticker });
});

// Get gap analysis
app.get('/api/gaps', (req, res) => {
    res.json(gapAnalyzer.getGaps());
});

// Scan market for low-float movers
app.post('/api/scan-low-float', async (req, res) => {
    try {
        console.log('🔎 Manual low-float market scan triggered');
        var results = await xAlertMonitor.scanMarket(state, uw);
        scheduler.trackCalls(results.length * 6); // 6 calls per candidate (5 UW + 1 Yahoo)
        state.xAlerts = xAlertMonitor.getAlerts();
        broadcast({ type: 'full_state', data: state });
        res.json({
            scanned: results.length,
            results: results,
            validated: results.filter(function (r) { return r.status === 'VALIDATED'; }).length,
            weak: results.filter(function (r) { return r.status === 'WEAK'; }).length
        });
    } catch (e) {
        console.error('Low-float scan error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── AI Chatbot with Full Market Data Context ──────────────
app.post('/api/chat', async (req, res) => {
    try {
        var userMsg = (req.body.message || '').trim();
        var ticker = req.body.ticker || null;
        if (!userMsg) return res.status(400).json({ error: 'Message required' });

        // Backend ticker detection fallback (handles lowercase, e.g. "when are nvda earnings")
        if (!ticker) {
            var upperMsg = userMsg.toUpperCase();
            var allKnownTickers = Object.keys(state.quotes);
            for (var i = 0; i < allKnownTickers.length; i++) {
                if (upperMsg.indexOf(allKnownTickers[i]) !== -1 && allKnownTickers[i].length >= 2) {
                    ticker = allKnownTickers[i];
                    break;
                }
            }
        }
        if (!process.env.GEMINI_API_KEY) return res.json({ reply: 'GEMINI_API_KEY not configured in .env' });

        // Build rich market context
        var context = '=== LIVE TRADING DASHBOARD DATA ===\n';
        context += 'Time: ' + new Date().toISOString() + '\n';
        context += 'Session: ' + (state.session || 'UNKNOWN') + '\n';
        context += 'Market Regime: ' + JSON.stringify(state.marketRegime || 'N/A') + '\n\n';

        // Watchlist quotes
        context += '--- WATCHLIST QUOTES ---\n';
        state.tickers.forEach(function (t) {
            var q = state.quotes[t];
            if (q) {
                context += t + ': $' + (q.price || q.last || 'N/A') + ' | Change: ' + (q.change_percent || q.changePercent || 'N/A') + '%';
                if (q.next_earnings_date) context += ' | Next Earnings: ' + q.next_earnings_date;
                var ta = state.technicals[t];
                if (ta) context += ' | RSI: ' + (ta.rsi ? ta.rsi.toFixed(1) : 'N/A') + ' | Bias: ' + (ta.bias || 'N/A');
                var sig = state.signalScores[t];
                if (sig) context += ' | Signal: ' + (sig.direction || 'N/A') + ' ' + (sig.confidence || 0) + '% conf';
                context += '\n';
            }
        });

        // Specific ticker deep dive
        if (ticker) {
            context += '\n--- DETAILED DATA FOR ' + ticker + ' ---\n';
            var tq = state.quotes[ticker];
            if (tq) context += 'Quote: ' + JSON.stringify(tq) + '\n';
            var tta = state.technicals[ticker];
            if (tta) context += 'Technicals: RSI=' + (tta.rsi || 'N/A') + ' MACD=' + JSON.stringify(tta.macd || {}) + ' EMA=' + JSON.stringify(tta.ema || {}) + ' Bias=' + (tta.bias || 'N/A') + '\n';
            var tsig = state.signalScores[ticker];
            if (tsig) context += 'Signal Score: ' + JSON.stringify({ direction: tsig.direction, confidence: tsig.confidence, signals: (tsig.signals || []).slice(0, 5) }) + '\n';
            var tear = state.earnings[ticker];
            if (tear) context += 'Earnings: ' + JSON.stringify(Array.isArray(tear) ? tear.slice(0, 2) : tear) + '\n';
            // Fallback: check quote's next_earnings_date
            if (!tear && tq && tq.next_earnings_date) context += 'Next Earnings Date: ' + tq.next_earnings_date + ' (announce: ' + (tq.announce_time || 'unknown') + ')\n';
            var tsi = state.shortInterest[ticker];
            if (tsi) context += 'Short Interest: ' + JSON.stringify(Array.isArray(tsi) ? tsi[tsi.length - 1] : tsi) + '\n';
            var tiv = state.ivRank[ticker];
            if (tiv) context += 'IV Rank: ' + JSON.stringify(Array.isArray(tiv) ? tiv[tiv.length - 1] : tiv) + '\n';
            var tmp = state.maxPain[ticker];
            if (tmp) context += 'Max Pain: ' + JSON.stringify(Array.isArray(tmp) ? tmp.slice(0, 3) : tmp) + '\n';
            var tdp = state.darkPool[ticker];
            if (tdp && Array.isArray(tdp)) context += 'Dark Pool (last 3): ' + JSON.stringify(tdp.slice(0, 3)) + '\n';
            var tgex = state.gex[ticker];
            if (tgex) context += 'GEX: ' + JSON.stringify(Array.isArray(tgex) ? tgex.slice(0, 3) : tgex) + '\n';

            // NEW API data for ticker
            var tnp = state.netPremium[ticker];
            if (tnp) context += 'Net Premium: ' + JSON.stringify(Array.isArray(tnp) ? tnp.slice(-3) : tnp) + '\n';
            var tsv = state.shortVolume[ticker];
            if (tsv) context += 'Short Volume: ' + JSON.stringify(Array.isArray(tsv) ? tsv.slice(-1) : tsv) + '\n';
            var tftd = state.failsToDeliver[ticker];
            if (tftd) context += 'FTDs: ' + JSON.stringify(Array.isArray(tftd) ? tftd.slice(-1) : tftd) + '\n';
            var tszn = state.seasonality[ticker];
            if (tszn) context += 'Seasonality: ' + JSON.stringify(Array.isArray(tszn) ? tszn.slice(0, 3) : tszn) + '\n';
            var tifl = state.insiderFlow[ticker];
            if (tifl) context += 'Insider Flow: ' + JSON.stringify(Array.isArray(tifl) ? tifl.slice(0, 3) : tifl) + '\n';
        }

        // Earnings calendar
        if (state.earningsToday) {
            var preEarn = (state.earningsToday.premarket || []).slice(0, 5).map(function (e) { return e.ticker + ' (' + (e.report_time || '') + ')' }).join(', ');
            var postEarn = (state.earningsToday.afterhours || []).slice(0, 5).map(function (e) { return e.ticker + ' (' + (e.report_time || '') + ')' }).join(', ');
            if (preEarn || postEarn) {
                context += '\n--- EARNINGS TODAY ---\n';
                if (preEarn) context += 'Pre-market: ' + preEarn + '\n';
                if (postEarn) context += 'After-hours: ' + postEarn + '\n';
            }
        }

        // Upcoming earnings from state.earnings AND quote data
        context += '\n--- UPCOMING EARNINGS ---\n';
        var earningsReported = {};
        state.tickers.forEach(function (t) {
            var e = state.earnings[t];
            if (e) {
                var items = Array.isArray(e) ? e : [e];
                items.slice(0, 2).forEach(function (item) {
                    context += t + ': ' + (item.report_date || item.date || 'N/A') + ' ' + (item.report_time || '') + '\n';
                });
                earningsReported[t] = true;
            }
        });
        // Also check next_earnings_date from ALL quotes (covers non-watchlist tickers)
        Object.keys(state.quotes).forEach(function (t) {
            if (!earningsReported[t] && state.quotes[t].next_earnings_date) {
                context += t + ': ' + state.quotes[t].next_earnings_date + ' (' + (state.quotes[t].announce_time || 'unknown') + ')\n';
            }
        });

        // Options flow summary
        var flowSummary = (state.optionsFlow || []).slice(0, 10).map(function (f) {
            return (f.ticker || f.symbol || '?') + ' ' + (f.put_call || f.option_type || '') + ' $' + ((parseFloat(f.premium || 0) / 1000).toFixed(0)) + 'K';
        }).join(', ');
        if (flowSummary) context += '\n--- RECENT OPTIONS FLOW ---\n' + flowSummary + '\n';

        // Congressional trades
        var congRecent = (state.congressTrades || []).slice(0, 5).map(function (c) {
            return (c.ticker || '?') + ' ' + (c.name || '') + ' ' + (c.txn_type || '') + ' ' + (c.amounts || '');
        }).join('; ');
        if (congRecent) context += '\n--- CONGRESSIONAL TRADES ---\n' + congRecent + '\n';

        // Paper trading stats
        var paperTrades = tradeJournal.getPaperTrades();
        var openPaper = paperTrades.filter(function (t) { return t.status === 'OPEN'; });
        var closedPaper = paperTrades.filter(function (t) { return t.status !== 'OPEN' && t.status !== 'PENDING'; });
        var paperWins = closedPaper.filter(function (t) { return t.pnl > 0; }).length;
        context += '\n--- PAPER TRADING ---\n';
        context += 'Open: ' + openPaper.length + ' | Closed: ' + closedPaper.length + ' | Win Rate: ' + (closedPaper.length > 0 ? Math.round(paperWins / closedPaper.length * 100) + '%' : 'N/A') + '\n';
        if (openPaper.length > 0) {
            context += 'Open positions: ' + openPaper.map(function (t) { return t.ticker + ' ' + t.direction + ' @ $' + (t.paperEntry || t.entry || 0).toFixed(2); }).join(', ') + '\n';
        }

        // Alerts
        var recentAlerts = (state.alerts || []).slice(0, 5).map(function (a) {
            return (a.ticker || '') + ': ' + (a.message || '').substring(0, 80);
        }).join('; ');
        if (recentAlerts) context += '\n--- RECENT ALERTS ---\n' + recentAlerts + '\n';

        // Gap analysis
        var gaps = gapAnalyzer.getGaps();
        if (gaps && gaps.length > 0) {
            context += '\n--- GAP ANALYSIS ---\n' + gaps.slice(0, 5).map(function (g) { return g.ticker + ' gap ' + (g.gapPercent || 0).toFixed(1) + '%'; }).join(', ') + '\n';
        }

        // Sector Tides
        if (Object.keys(state.sectorTide).length > 0) {
            context += '\n--- SECTOR TIDES ---\n';
            Object.keys(state.sectorTide).forEach(function (sec) {
                var st = state.sectorTide[sec];
                if (st) context += sec + ': calls=' + (st.call_volume || st.calls || 0) + ' puts=' + (st.put_volume || st.puts || 0) + '\n';
            });
        }

        // ETF Tides
        if (Object.keys(state.etfTide).length > 0) {
            context += '\n--- ETF FLOW TIDES ---\n';
            Object.keys(state.etfTide).forEach(function (etf) {
                var et = state.etfTide[etf];
                if (et) context += etf + ': calls=' + (et.call_volume || et.calls || 0) + ' puts=' + (et.put_volume || et.puts || 0) + '\n';
            });
        }

        // Economic Calendar
        if (state.economicCalendar && state.economicCalendar.length > 0) {
            context += '\n--- ECONOMIC CALENDAR ---\n';
            state.economicCalendar.slice(0, 8).forEach(function (ev) {
                context += (ev.date || '') + ' ' + (ev.event || ev.name || '') + ' | Expected: ' + (ev.expected || ev.forecast || 'N/A') + '\n';
            });
        }

        // Polygon Real-Time Tick Data
        var tickSummaries = polygonClient.getAllSummaries();
        if (Object.keys(tickSummaries).length > 0) {
            context += '\n--- REAL-TIME TICK DATA (Polygon) ---\n';
            Object.keys(tickSummaries).forEach(function (tkr) {
                var td = tickSummaries[tkr];
                context += tkr + ': Buy=' + td.buyPct + '% Sell=' + td.sellPct + '% Imbalance=' + (td.flowImbalance || 0) + ' VWAP=$' + (td.vwap || 0) + ' Vol=' + (td.totalVolume || 0);
                if (td.largeBlockBuys > 0 || td.largeBlockSells > 0) {
                    context += ' LargeBlocks(buy=' + td.largeBlockBuys + ' sell=' + td.largeBlockSells + ')';
                }
                context += '\n';
            });
        }

        // Polygon Snapshot Data (gainers context)
        var snapshots = polygonClient.snapshotCache || {};
        var watchTickers = state.tickers || [];
        var snapKeys = Object.keys(snapshots).filter(function (k) { return watchTickers.indexOf(k) >= 0; });
        if (snapKeys.length > 0) {
            context += '\n--- POLYGON SNAPSHOT ---\n';
            snapKeys.forEach(function (tkr) {
                var s = snapshots[tkr];
                if (s) context += tkr + ': $' + (s.price || 0) + ' chg=' + (s.changePercent || 0).toFixed(2) + '% vol=' + (s.volume || 0) + ' prevClose=$' + (s.prevClose || 0) + '\n';
            });
        }

        // Slash command handling
        var slashResult = null;
        if (userMsg.startsWith('/')) {
            var cmd = userMsg.split(' ')[0].toLowerCase();
            var cmdArg = userMsg.split(' ').slice(1).join(' ').toUpperCase().trim();
            if (cmd === '/scan') {
                slashResult = 'SCANNER RESULTS:\n' + JSON.stringify(state.scannerResults || {}, null, 1);
            } else if (cmd === '/earnings') {
                slashResult = 'UPCOMING EARNINGS:\n';
                Object.keys(state.earnings).forEach(function (t) {
                    var e = state.earnings[t];
                    var items = Array.isArray(e) ? e : [e];
                    items.slice(0, 2).forEach(function (item) { slashResult += t + ': ' + (item.report_date || item.date || 'N/A') + '\n'; });
                });
            } else if (cmd === '/positions') {
                var pp = tradeJournal.getPaperTrades().filter(function (t) { return t.status === 'OPEN'; });
                slashResult = 'OPEN POSITIONS (' + pp.length + '):\n';
                pp.forEach(function (t) { slashResult += t.ticker + ' ' + t.direction + ' @ $' + (t.paperEntry || 0).toFixed(2) + ' P&L: $' + (t.pnl || 0).toFixed(2) + '\n'; });
            } else if (cmd === '/brief') {
                slashResult = 'Generating morning brief...\n' + JSON.stringify(state.morningBrief || {}, null, 1);
            } else if (cmd === '/compare' && cmdArg) {
                var tickers = cmdArg.split(/[,\s]+/);
                slashResult = 'COMPARISON:\n';
                tickers.forEach(function (t) {
                    var q = state.quotes[t] || {};
                    var sig = state.signalScores[t] || {};
                    slashResult += t + ': $' + (q.price || q.last || '?') + ' ' + (sig.direction || '?') + ' ' + (sig.confidence || 0) + '% conf\n';
                });
            }
        }

        // Conversation memory: store and retrieve last 10 messages per session
        var sessionId = req.body.sessionId || 'default';
        if (!state.chatHistory.has(sessionId)) state.chatHistory.set(sessionId, []);
        var history = state.chatHistory.get(sessionId);
        history.push({ role: 'user', text: userMsg });
        if (history.length > 20) history.splice(0, history.length - 20);

        // Build conversation history context
        var historyContext = '';
        if (history.length > 1) {
            historyContext = '\n--- CONVERSATION HISTORY ---\n';
            history.slice(-10, -1).forEach(function (msg) {
                historyContext += (msg.role === 'user' ? 'User: ' : 'Assistant: ') + msg.text.substring(0, 200) + '\n';
            });
        }

        // Build Gemini request
        var genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        var model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        var systemPrompt = 'You are an expert AI trading assistant embedded in a live trading dashboard. '
            + 'You have access to real-time market data, technical analysis, options flow, dark pool activity, '
            + 'congressional trades, earnings calendars, signal scores, paper trading history, '
            + 'net premium flow, sector tides, ETF tides, economic calendar, short squeeze data, and seasonality. '
            + 'Answer questions using the live data provided below. Be specific with numbers. '
            + 'If asked about earnings, give the exact date. If asked about a ticker, reference the actual price and signals. '
            + 'Keep responses concise but detailed. Use bullet points for clarity. '
            + 'If data is not available for a specific query, say so clearly.\n\n'
            + context + historyContext;

        var userContent = slashResult ? slashResult + '\nUser question: ' + userMsg : 'User question: ' + userMsg;
        var result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContent }] }],
            generationConfig: { maxOutputTokens: 1500, temperature: 0.3 }
        });

        var reply = result.response.text();
        // Store assistant reply in history
        history.push({ role: 'assistant', text: reply });
        if (history.length > 20) history.splice(0, history.length - 20);
        res.json({ reply: reply });
    } catch (e) {
        console.error('Chat error:', e.message);
        res.json({ reply: 'Error: ' + e.message });
    }
});

// ── Smart Options Recommendation Engine ──────────────────
app.get('/api/options-recommend/:ticker', async (req, res) => {
    try {
        var ticker = req.params.ticker.toUpperCase();
        var price = 0;
        var q = state.quotes[ticker];
        if (q) price = parseFloat(q.price || q.last) || 0;

        if (!price) {
            return res.json({ error: 'No price data for ' + ticker + '. Add to watchlist first.' });
        }

        // Get signal direction and confidence
        var signal = state.signalScores[ticker] || {};
        var direction = signal.direction || 'NEUTRAL';
        var confidence = signal.confidence || 50;
        var signals = signal.signals || [];

        // Get IV data
        var ivData = state.ivRank[ticker];
        var ivRank = 50; // default mid
        var ivValue = 0.3; // default 30% IV
        if (ivData) {
            var ivArr = Array.isArray(ivData) ? ivData : [ivData];
            var lastIV = ivArr[ivArr.length - 1] || {};
            ivRank = parseFloat(lastIV.iv_rank || lastIV.ivRank || 50);
            ivValue = parseFloat(lastIV.implied_volatility || lastIV.iv || 0.3);
        }

        // Get ATR for move estimation
        var ta = state.technicals[ticker] || {};
        var atr = parseFloat(ta.atr) || (price * 0.02); // fallback 2% of price
        var rsi = ta.rsi || 50;

        // Get ADX trend strength
        var adxData = ta.adx || {};
        var adxValue = adxData.adx || null;
        var trendStrength = adxData.trendStrength || 'UNKNOWN';

        // Get RSI divergence
        var rsiDivergences = ta.rsiDivergence || [];

        // Get Fibonacci levels
        var fibData = ta.fibonacci || {};

        // Get multi-TF data
        var mtf = (state.multiTF || {})[ticker];
        var mtfDirection = mtf && mtf.confluence ? mtf.confluence.dominantDirection : null;
        var mtfAgreeing = mtf && mtf.confluence ? mtf.confluence.timeframesAgreeing : 0;

        // Get short interest for bounce play
        var siData = state.shortInterest[ticker];
        var siPct = 0;
        if (siData) {
            var siArr = Array.isArray(siData) ? siData : [siData];
            var lastSI = siArr[siArr.length - 1] || {};
            siPct = parseFloat(lastSI.si_float_returned || lastSI.short_interest_pct || 0);
        }

        // Determine trade horizon
        var session = state.session || 'OVERNIGHT';
        var isActive = ['OPEN_RUSH', 'POWER_OPEN', 'PRE_MARKET', 'MIDDAY', 'POWER_HOUR'].includes(session);
        var horizon = isActive ? 'day_trade' : 'swing';

        // ── Decision Logic ──

        // 1. Pick direction (call vs put)
        var optionType = 'call'; // default
        var strategy = 'long_call';
        var reasoning = [];

        if (direction === 'BEARISH') {
            optionType = 'put';
            strategy = 'long_put';
            reasoning.push('Signal direction: BEARISH (' + confidence + '% conf)');
        } else if (direction === 'BULLISH') {
            optionType = 'call';
            strategy = 'long_call';
            reasoning.push('Signal direction: BULLISH (' + confidence + '% conf)');
        } else {
            // Neutral — use multi-TF or RSI for tiebreak
            if (mtfDirection === 'BULL') {
                optionType = 'call';
                strategy = 'long_call';
                reasoning.push('Neutral signals, but multi-TF leans BULL');
            } else if (mtfDirection === 'BEAR') {
                optionType = 'put';
                strategy = 'long_put';
                reasoning.push('Neutral signals, but multi-TF leans BEAR');
            } else if (rsi < 40) {
                optionType = 'call'; // oversold bounce
                strategy = 'long_call';
                reasoning.push('Neutral, but RSI oversold (' + rsi.toFixed(0) + ') — bounce expected');
            } else if (rsi > 60) {
                optionType = 'put';
                strategy = 'long_put';
                reasoning.push('Neutral, but RSI overbought (' + rsi.toFixed(0) + ') — pullback expected');
            } else {
                // True neutral — suggest straddle for volatility play
                if (ivRank < 30) {
                    strategy = 'straddle';
                    reasoning.push('Neutral direction + low IV (' + ivRank.toFixed(0) + '%) — straddle for breakout');
                } else {
                    optionType = 'call';
                    strategy = 'long_call';
                    reasoning.push('No strong signal — defaulting to long call (speculative)');
                }
            }
        }

        // Short-cover bounce override
        if (mtf && mtf.shortCoverBounce && mtf.shortCoverBounce.isShortCoverSetup && siPct > 8) {
            optionType = 'call';
            strategy = 'long_call';
            reasoning.push('🔄 SHORT-COVER BOUNCE detected (SI: ' + siPct.toFixed(1) + '%) — calls for snap-back');
        }

        // RSI divergence override — high-probability reversal signal
        if (rsiDivergences.length > 0) {
            var strongDiv = rsiDivergences.find(function (d) { return d.type.includes('REGULAR') && d.strength > 0.5; });
            if (strongDiv) {
                if (strongDiv.direction === 'BULL' && optionType !== 'call') {
                    optionType = 'call';
                    strategy = 'long_call';
                    reasoning.push('🔄 RSI DIVERGENCE override: ' + strongDiv.detail);
                } else if (strongDiv.direction === 'BEAR' && optionType !== 'put') {
                    optionType = 'put';
                    strategy = 'long_put';
                    reasoning.push('🔄 RSI DIVERGENCE override: ' + strongDiv.detail);
                } else {
                    reasoning.push('📊 RSI Divergence confirms direction: ' + strongDiv.detail);
                }
            }
        }

        // ADX context
        if (adxValue !== null) {
            if (trendStrength === 'STRONG_TREND') {
                reasoning.push('📈 ADX ' + adxValue.toFixed(0) + ' = STRONG trend — high conviction ' + (adxData.trendDirection || ''));
            } else if (trendStrength === 'NO_TREND') {
                reasoning.push('⚠️ ADX ' + adxValue.toFixed(0) + ' = NO trend (choppy) — reduced conviction');
            }
        }

        // Multi-TF confluence boost
        if (mtfAgreeing >= 2) {
            reasoning.push('✅ ' + mtfAgreeing + '/3 timeframes agree → high conviction');
        }

        // 2. Pick DTE based on horizon
        var dte = 0;
        if (horizon === 'day_trade') {
            dte = 0; // 0DTE for day trades (cheapest gamma)
            reasoning.push('Day trade: 0DTE for max gamma leverage');
        } else {
            // Swing: 14-30 DTE
            if (ivRank > 60) {
                dte = 14; // shorter DTE when IV is high (cheaper theta decay)
                reasoning.push('Swing: 14 DTE (IV high at ' + ivRank.toFixed(0) + '% — minimize theta)');
            } else {
                dte = 30; // longer DTE when IV is low (more time)
                reasoning.push('Swing: 30 DTE (IV low — pay for time)');
            }
        }

        // 3. Pick strike
        var strike = 0;
        var strikeType = 'ATM';
        if (strategy === 'straddle') {
            strike = Math.round(price); // ATM for straddle
            strikeType = 'ATM';
            reasoning.push('Straddle strike: ATM at $' + strike);
        } else if (horizon === 'day_trade') {
            // Day trade: slightly ITM for higher delta (0.60-0.70)
            if (optionType === 'call') {
                strike = Math.round((price - atr * 0.3) * 2) / 2; // $0.50 rounded
                strikeType = 'Slightly ITM';
            } else {
                strike = Math.round((price + atr * 0.3) * 2) / 2;
                strikeType = 'Slightly ITM';
            }
            reasoning.push('Day trade: slightly ITM ($' + strike + ') for higher delta (~0.65)');
        } else {
            // Swing: ATM or slightly OTM for R:R
            if (optionType === 'call') {
                strike = Math.round(price * 2) / 2; // nearest $0.50
                if (confidence >= 65) {
                    // High conviction: go ATM for max delta
                    strikeType = 'ATM';
                    reasoning.push('High conviction: ATM strike $' + strike + ' for max delta');
                } else {
                    // Moderate: slightly OTM for cheaper premium
                    strike = Math.round((price + atr * 0.5) * 2) / 2;
                    strikeType = 'Slightly OTM';
                    reasoning.push('Moderate conviction: slightly OTM $' + strike + ' for better R:R');
                }
            } else {
                strike = Math.round(price * 2) / 2;
                if (confidence >= 65) {
                    strikeType = 'ATM';
                    reasoning.push('High conviction: ATM strike $' + strike + ' for max delta');
                } else {
                    strike = Math.round((price - atr * 0.5) * 2) / 2;
                    strikeType = 'Slightly OTM';
                    reasoning.push('Moderate conviction: slightly OTM $' + strike + ' for better R:R');
                }
            }
        }

        // 4. Estimate premium (Black-Scholes approximation)
        var dteFrac = Math.max(dte, 1) / 365;
        var moneyness = Math.abs(price - strike) / price;
        // Simplified premium estimate: ATM ≈ price × IV × sqrt(T/365) × 0.4
        var estimatedPremium = price * ivValue * Math.sqrt(dteFrac) * 0.4;
        // Adjust for moneyness
        if (moneyness > 0.02) {
            estimatedPremium *= (1 - moneyness * 2); // OTM is cheaper
        }
        estimatedPremium = Math.max(0.05, estimatedPremium);
        estimatedPremium = Math.round(estimatedPremium * 100) / 100;

        // 5. Calculate expected move — use Fibonacci targets instead of flat ATR
        var expectedMove = atr * (horizon === 'day_trade' ? 1.0 : 3.0); // ATR fallback
        var fibTarget = null;
        var fibTargetLevel = null;

        if (fibData && fibData.targets && fibData.swingRange > 0) {
            var fibTargets = fibData.targets;
            if (optionType === 'call') {
                // For calls: target is nearest Fib extension above current price
                var bestTarget = null;
                for (var lvl in fibTargets) {
                    var targetPrice = fibTargets[lvl];
                    if (targetPrice > price) {
                        if (!bestTarget || targetPrice < bestTarget.price) {
                            bestTarget = { price: targetPrice, level: lvl + '%' };
                        }
                    }
                }
                if (bestTarget) {
                    expectedMove = bestTarget.price - price;
                    fibTarget = bestTarget.price;
                    fibTargetLevel = bestTarget.level;
                    reasoning.push('🎯 Fibonacci target: $' + bestTarget.price.toFixed(2) + ' (' + bestTarget.level + ' ext) → +$' + expectedMove.toFixed(2) + ' move');
                }
            } else {
                // For puts: target is nearest Fib retracement below current price
                var levels = fibData.levels || {};
                var bestLevel = null;
                for (var lk in levels) {
                    var levelPrice = levels[lk];
                    if (levelPrice < price) {
                        if (!bestLevel || levelPrice > bestLevel.price) {
                            bestLevel = { price: levelPrice, level: lk + '%' };
                        }
                    }
                }
                if (bestLevel) {
                    expectedMove = price - bestLevel.price;
                    fibTarget = bestLevel.price;
                    fibTargetLevel = bestLevel.level;
                    reasoning.push('🎯 Fibonacci target: $' + bestLevel.price.toFixed(2) + ' (' + bestLevel.level + ' retr) → -$' + expectedMove.toFixed(2) + ' move');
                }
            }
        }

        // ATR-based fallback reasoning if no Fib target found
        if (!fibTarget) {
            reasoning.push('Target: ' + (horizon === 'day_trade' ? '1' : '3') + ' ATR move = $' + expectedMove.toFixed(2));
        }

        var expectedProfitPct = ((expectedMove / estimatedPremium) - 1) * 100;

        // 6. Risk assessment
        var riskLevel = 'MODERATE';
        if (confidence >= 70 && mtfAgreeing >= 2) riskLevel = 'LOW';
        else if (confidence < 55 || direction === 'NEUTRAL') riskLevel = 'HIGH';

        // IV-based strategy override: if IV rank is very high, suggest spreads
        var ivWarning = null;
        if (ivRank > 70 && (strategy === 'long_call' || strategy === 'long_put')) {
            ivWarning = '⚠️ IV Rank is ' + ivRank.toFixed(0) + '% — options are expensive. Consider a spread to reduce cost.';
            // Suggest spread version
            var spreadStrat = strategy === 'long_call' ? 'bull_call_spread' : 'bear_put_spread';
            var spreadStrike2 = optionType === 'call' ? strike + atr : strike - atr;
            spreadStrike2 = Math.round(spreadStrike2 * 2) / 2;
            reasoning.push(ivWarning);
        }

        // Top supporting signals
        var topSignals = signals
            .filter(function (s) {
                return (optionType === 'call' && s.dir === 'BULL') || (optionType === 'put' && s.dir === 'BEAR');
            })
            .sort(function (a, b) { return b.weight - a.weight; })
            .slice(0, 4)
            .map(function (s) { return s.name + ' (' + s.detail + ')'; });

        res.json({
            ticker: ticker,
            price: price,
            recommendation: {
                strategy: strategy,
                optionType: optionType,
                strike: strike,
                strikeType: strikeType,
                dte: dte,
                estimatedPremium: estimatedPremium,
                contracts: 1,
                horizon: horizon,
                direction: direction,
                confidence: confidence,
                riskLevel: riskLevel,
                expectedMove: +expectedMove.toFixed(2),
                expectedProfitPct: Math.round(expectedProfitPct),
                maxLoss: +(estimatedPremium * 100).toFixed(2) // per contract
            },
            analysis: {
                ivRank: +ivRank.toFixed(1),
                ivValue: +(ivValue * 100).toFixed(1),
                atr: +atr.toFixed(2),
                rsi: rsi ? +rsi.toFixed(1) : null,
                shortInterest: +siPct.toFixed(1),
                mtfAgreeing: mtfAgreeing,
                mtfDirection: mtfDirection,
                emaBias: ta.emaBias || 'NEUTRAL',
                adx: adxData.adx || null,
                trendStrength: trendStrength,
                rsiDivergence: rsiDivergences.length > 0 ? rsiDivergences.map(function (d) { return { type: d.type, strength: d.strength, detail: d.detail }; }) : [],
                fibonacci: fibData.levels ? { levels: fibData.levels, targets: fibData.targets, swingRange: fibData.swingRange } : null,
                fibTarget: fibTarget,
                fibTargetLevel: fibTargetLevel
            },
            reasoning: reasoning,
            topSignals: topSignals,
            ivWarning: ivWarning,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── AI Chatbot Endpoint ──────────────────────────────────
app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.json({ reply: '⚠️ Chatbot not configured yet. Add GEMINI_API_KEY to your .env file.\n\nGet a free key at: https://aistudio.google.com/apikey' });
    }

    const { message, ticker } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    // Build context from dashboard state
    let context = 'You are an expert trading analyst assistant for a live trading dashboard. ';
    context += 'Answer concisely and actionably. Use numbers and data when available. ';
    context += 'Current session: ' + (state.session || 'UNKNOWN') + '. ';

    // Market regime
    if (state.marketRegime) {
        context += 'Market regime: ' + (state.marketRegime.label || state.marketRegime.regime) + '. ';
    }

    // Tide
    if (state.marketTide) {
        context += 'Market tide score: ' + JSON.stringify(state.marketTide).substring(0, 200) + '. ';
    }

    // Ticker-specific context
    if (ticker) {
        const q = state.quotes[ticker];
        if (q) context += ticker + ' quote: $' + q.price + ' (' + (q.changePercent > 0 ? '+' : '') + q.changePercent + '%), vol=' + q.volume + '. ';

        const brief = (state.morningBrief || {})[ticker];
        if (brief) context += ticker + ' morning brief: ' + brief.direction + ' (' + brief.confidence + '% conf), bull=' + brief.bull + ', bear=' + brief.bear + '. Signals: ' + (brief.signals || []).join(', ') + '. ';

        const setup = state.tradeSetups[ticker];
        if (setup) context += ticker + ' trade setup: ' + setup.direction + ', entry=$' + setup.entry + ', T1=$' + setup.target1 + ', T2=$' + setup.target2 + ', stop=$' + setup.stop + ', R:R=' + setup.riskReward + ', conf=' + setup.confidence + '%. ';

        const ta = state.technicals[ticker];
        if (ta) context += ticker + ' technicals: RSI=' + (ta.rsi || '--') + ', bias=' + (ta.bias || '--') + '. ';

        const dp = state.darkPool[ticker];
        if (dp) context += ticker + ' dark pool: ' + JSON.stringify(dp).substring(0, 200) + '. ';

        const gex = state.gex[ticker];
        if (gex) context += ticker + ' GEX: ' + JSON.stringify(gex).substring(0, 200) + '. ';

        const si = state.shortInterest[ticker];
        if (si) context += ticker + ' short interest: ' + JSON.stringify(si).substring(0, 150) + '. ';

        const sent = (state.sentiment || {})[ticker];
        if (sent) context += ticker + ' sentiment: ' + sent.label + ' (score=' + sent.score + '). ';

        const kelly = (state.kellySizing || {})[ticker];
        if (kelly) context += ticker + ' kelly sizing: ' + kelly.pct + '% of portfolio. ';
    }

    // Recent alerts for context
    const recentAlerts = state.alerts.slice(-5).map(a => a.ticker + ': ' + a.msg).join('; ');
    if (recentAlerts) context += 'Recent alerts: ' + recentAlerts + '. ';

    try {
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: context + '\n\nUser question: ' + message }] }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 800,
                        topP: 0.9
                    }
                })
            }
        );

        const data = await geminiRes.json();
        const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI. Check your API key.';
        res.json({ reply });
    } catch (e) {
        console.error('Chat API error:', e.message);
        res.json({ reply: '❌ Error connecting to Gemini API: ' + e.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`\n🚀 Trading Dashboard running at http://localhost:${PORT}`);
    console.log(`📡 Watching: ${TICKERS.join(', ')}`);
    console.log(`🕐 Session: ${AlertEngine.sessionLabel(AlertEngine.getCurrentSession())}`);
    console.log(`\n💡 TradingView Webhook URL: http://localhost:${PORT}/webhook/tradingview`);
    console.log('');

    // Connect Polygon.io real-time tick data
    if (process.env.POLYGON_API_KEY) {
        polygonClient.connect(TICKERS);
        console.log('📊 Polygon tick data: connecting for ' + TICKERS.length + ' tickers');
    } else {
        console.log('⚠️ POLYGON_API_KEY not set — tick data disabled');
    }
});

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`🔗 Dashboard client connected (${clients.size} total)`);

    // Send current state immediately
    ws.send(JSON.stringify({ type: 'full_state', data: state }));

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`🔌 Client disconnected (${clients.size} remaining)`);
    });
});

function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of clients) {
        if (client.readyState === 1) {
            client.send(payload);
        }
    }
}

// ── Volatility Runner Scanner ─────────────────────────────
// Discovers MLEC-style micro-cap runners: gap >10%, volume >500k, market cap <$50M
state.volatilityRunners = {};        // { ticker: { changePct, volume, relativeVolume, marketCap, dollarVolume, discoveredAt } }
state.volatilityRunnerCooldown = {};  // { ticker: timestamp }

async function scanVolatilityRunners() {
    try {
        // Only scan during active market sessions
        var activeSession = ['OPEN_RUSH', 'POWER_OPEN', 'PRE_MARKET', 'MIDDAY', 'POWER_HOUR'].includes(state.session);
        if (!activeSession) return;

        // Use UW screener to find big movers
        var screenResult = await uw.screenStocks({
            change_min: 10,           // >10% gap
            volume_min: 500000,       // minimum liquidity
            marketcap_max: 50000000   // micro-cap only (<$50M)
        });

        var candidates = (screenResult?.data || []);
        if (!Array.isArray(candidates) || candidates.length === 0) return;

        var newRunners = 0;
        var now = Date.now();
        var cooldownMs = 10 * 60 * 1000; // 10 min cooldown per ticker

        for (var i = 0; i < candidates.length && i < 10; i++) {
            var c = candidates[i];
            var ticker = (c.ticker || c.symbol || '').toUpperCase();
            if (!ticker) continue;

            // Skip watchlist tickers (already being scored)
            if (state.tickers.includes(ticker)) continue;

            // Skip ETFs & common indices
            var etfExclude = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'UVXY', 'SQQQ', 'TQQQ'];
            if (etfExclude.includes(ticker)) continue;

            // Cooldown check
            if (state.volatilityRunnerCooldown[ticker] && now - state.volatilityRunnerCooldown[ticker] < cooldownMs) continue;

            var changePct = parseFloat(c.change || c.change_percent || c.change_pct || 0);
            var volume = parseFloat(c.volume || c.total_volume || 0);
            var avgVol = parseFloat(c.avg30_volume || c.avg_volume || c.average_volume || 0);
            var relVol = avgVol > 0 ? volume / avgVol : 0;
            var mktCap = parseFloat(c.marketcap || c.market_cap || 0);
            var price = parseFloat(c.last || c.close || c.price || 0);
            var dollarVol = volume * price;

            // Must have relative volume > 3x to qualify
            if (relVol < 3 && avgVol > 0) continue;

            var runnerData = {
                ticker: ticker,
                changePct: changePct,
                volume: volume,
                relativeVolume: relVol,
                marketCap: mktCap,
                dollarVolume: dollarVol,
                price: price,
                discoveredAt: new Date().toISOString()
            };

            state.volatilityRunners[ticker] = runnerData;
            state.volatilityRunnerCooldown[ticker] = now;
            newRunners++;

            console.log('\ud83d\ude80 Volatility Runner Found: ' + ticker +
                ' | Gap +' + changePct.toFixed(1) + '% | Vol ' + (volume / 1000).toFixed(0) + 'K' +
                ' | RVol ' + relVol.toFixed(1) + 'x | MCap $' + (mktCap / 1000000).toFixed(1) + 'M');
        }

        if (newRunners > 0) {
            console.log('\ud83d\ude80 Volatility Scanner: ' + newRunners + ' new runners found (' + Object.keys(state.volatilityRunners).length + ' total tracked)');
        }
    } catch (e) {
        console.error('Volatility scanner error:', e.message);
    }
}

// ── Score a single ticker: signal engine + ML ensemble + trade setup ──
async function scoreTickerSignals(ticker) {
    try {
        // Fetch multi-timeframe analysis during market hours (uses Yahoo — free)
        var multiTFData = null;
        var isMarketSession = ['OPEN_RUSH', 'POWER_OPEN', 'PRE_MARKET', 'MIDDAY', 'POWER_HOUR'].includes(state.session);
        if (isMarketSession && state.multiTF && state.multiTF[ticker]) {
            multiTFData = state.multiTF[ticker];
        }

        const data = {
            technicals: state.technicals[ticker],
            flow: (state.optionsFlow || []).filter(f => (f.ticker || f.symbol) === ticker),
            darkPool: Array.isArray(state.darkPool[ticker]?.data) ? state.darkPool[ticker].data : (Array.isArray(state.darkPool[ticker]) ? state.darkPool[ticker] : []),
            gex: Array.isArray(state.gex[ticker]?.data) ? state.gex[ticker].data : (Array.isArray(state.gex[ticker]) ? state.gex[ticker] : []),
            ivRank: state.ivRank[ticker],
            shortInterest: state.shortInterest[ticker],
            insider: state.insiderData[ticker] || [],
            congress: (state.congressTrades || []).filter(c => (c.ticker || c.symbol) === ticker),
            quote: state.quotes[ticker] || {},
            regime: state.marketRegime,
            sentiment: state.sentiment[ticker] || null,
            multiTF: multiTFData,
            volatilityRunner: state.volatilityRunners[ticker] || null,
            // Phase 1 API enhancements
            netPremium: state.netPremium[ticker] || null,
            flowPerStrike: state.flowPerStrike[ticker] || null,
            flowPerExpiry: state.flowPerExpiry[ticker] || null,
            greekFlow: state.greekFlow[ticker] || null,
            spotExposures: state.spotExposures[ticker] || null,
            shortVolume: state.shortVolume[ticker] || null,
            failsToDeliver: state.failsToDeliver[ticker] || null,
            seasonality: state.seasonality[ticker] || null,
            realizedVol: state.realizedVol[ticker] || null,
            termStructure: state.termStructure[ticker] || null,
            insiderFlow: state.insiderFlow[ticker] || null,
            sectorTide: state.sectorTide || {},
            etfTide: state.etfTide || {},
            economicCalendar: state.economicCalendar || [],
            tickData: polygonClient.getTickSummary(ticker) || null,
            polygonTA: null,
            polygonSnapshot: polygonClient.getSnapshotData(ticker) || null,
            polygonMinuteBars: polygonClient.getMinuteBars(ticker) || []
        };

        // Fetch Polygon TA indicators (async) — signal #37 needs this
        try {
            if (process.env.POLYGON_API_KEY) {
                data.polygonTA = await polygonClient.getAllIndicators(ticker);
            }
        } catch (taErr) { /* optional — signal #37 will just skip */ }

        const signalResult = signalEngine.score(ticker, data, state.session);

        // Detect trade horizon: day trade for active sessions, swing otherwise
        const isSwingSession = ['OVERNIGHT', 'AFTER_HOURS'].includes(state.session);
        const mlTimeframe = isSwingSession ? 'swing' : 'dayTrade';

        // Apply ML ensemble with appropriate timeframe model
        const ensemble = mlCalibrator.ensemble(signalResult.confidence, signalResult.features, mlTimeframe);
        // Keep technical confidence as primary (user trades on technicals)
        signalResult.technicalConfidence = signalResult.confidence; // Pure technical score
        signalResult.mlConfidence = ensemble.mlConfidence || null;  // Pure ML score
        signalResult.blendedConfidence = ensemble.confidence;       // Blended score
        // confidence stays as technical — user's primary decision score
        signalResult.ensemble = ensemble;

        state.signalScores[ticker] = signalResult;

        // Generate session-aware trade setup
        if (signalResult.direction !== 'NEUTRAL' && state.technicals[ticker]) {
            const ta = state.technicals[ticker];
            const price = parseFloat(state.quotes[ticker]?.last || state.quotes[ticker]?.price || 0);
            const atr = ta.atr || 1;
            if (price > 0) {
                const dir = signalResult.direction === 'BULLISH' ? 'LONG' : 'SHORT';

                // ── Intraday Volatility Detection ──
                // Detect if this ticker is volatile right now (day trade opportunity)
                const quote = state.quotes[ticker] || {};
                const changePct = Math.abs(parseFloat(quote.changePercent || quote.change_percent || quote.change || 0));
                const volume = parseFloat(quote.volume || 0);
                const avgVol = parseFloat(quote.avg30_volume || quote.avgVolume || 0);
                const volRatio = avgVol > 0 ? volume / avgVol : 0;
                const isVolatile = changePct > 1.5 || volRatio > 1.5;
                const isHighlyVolatile = changePct > 3.0 || volRatio > 2.5;

                // Session-aware ATR multiplier for target/stop sizing
                // Uses ACTUAL scheduler session names (OPEN_RUSH, POWER_OPEN, MIDDAY, etc.)
                const sessionMultipliers = {
                    'OPEN_RUSH': 0.4,       // First 20 min — tight scalps (widened from 0.3)
                    'POWER_OPEN': 0.4,      // 9:21-10:00 AM — scalp/day trade (reduced from 0.5)
                    'PRE_MARKET': 0.4,      // 8:30-9:00 AM — pre-market
                    'MIDDAY': 0.5,          // 10:01 AM-3:00 PM — day trade (reduced from 0.7)
                    'POWER_HOUR': 0.4,      // 3:01-4:15 PM — day trade (reduced from 0.6)
                    'AFTER_HOURS': 0.6,     // 4:16-5:00 PM — extended hours (reduced from 0.8)
                    'OVERNIGHT': 0.8        // 5:01 PM-8:29 AM — swing
                };
                var atrMult = sessionMultipliers[state.session] || 0.5;

                // For volatile stocks WIDEN stops (they need more room, not less!)
                if (isHighlyVolatile) {
                    atrMult = Math.max(atrMult, 0.8);  // At least 0.8x ATR for explosive moves
                } else if (isVolatile) {
                    atrMult = Math.max(atrMult, 0.6);  // At least 0.6x ATR for active movers
                }

                const scaledATR = atr * atrMult;

                const confFactor = signalResult.confidence >= 75 ? 0.75 : signalResult.confidence >= 60 ? 1.0 : 1.5;
                var stopDist = scaledATR * confFactor;

                // Minimum stop-loss floor — prevent too-tight stops on higher-priced stocks
                // SNPS $437 had $5 stop (1.1%) → guaranteed stop-outs on intraday volatility
                var minStopPct = price > 100 ? 0.02 : price > 50 ? 0.025 : 0.03; // 2%, 2.5%, 3%
                var minStopDist = price * minStopPct;
                if (stopDist < minStopDist) stopDist = minStopDist;

                // Determine horizon label (uses actual scheduler session names)
                var horizon = 'Swing (2-5d)';
                if (state.session === 'OPEN_RUSH' || state.session === 'POWER_OPEN') {
                    horizon = 'Scalp / Day Trade';
                } else if (state.session === 'MIDDAY' || state.session === 'POWER_HOUR') {
                    horizon = isVolatile ? 'Day Trade (volatile)' : 'Day Trade';
                } else if (state.session === 'PRE_MARKET') {
                    horizon = 'Intraday';
                } else if (state.session === 'AFTER_HOURS') {
                    horizon = 'Extended Hours';
                }

                const setup = {
                    ticker, direction: dir, entry: price, confidence: signalResult.confidence,
                    target1: dir === 'LONG' ? +(price + scaledATR).toFixed(2) : +(price - scaledATR).toFixed(2),
                    target2: dir === 'LONG' ? +(price + scaledATR * 2).toFixed(2) : +(price - scaledATR * 2).toFixed(2),
                    stop: dir === 'LONG' ? +(price - stopDist).toFixed(2) : +(price + stopDist).toFixed(2),
                    riskReward: +(scaledATR / stopDist).toFixed(2),
                    signals: signalResult.signals,
                    session: state.session,
                    horizon: horizon,
                    atrMultiplier: atrMult,
                    isVolatile: isVolatile,
                    changePct: +changePct.toFixed(2),
                    volumeRatio: +volRatio.toFixed(2)
                };

                // Kelly Criterion position sizing
                var kelly = tradeJournal.calculateKellySize(signalResult.confidence);
                setup.kellySizing = kelly;
                state.kellySizing[ticker] = kelly;

                state.tradeSetups[ticker] = setup;
                tradeJournal.logSetup(setup, signalResult);

                // ── Auto Paper Trade: mirror every unique setup ─────────────────────
                // logSetup above already deduplicates (30min cooldown, any status)
                // Only additional guard: don't re-enter after 3+ consecutive losses
                var maxConsecLosses = 3;
                var consecLosses = tradeJournal.getConsecutiveLosses(ticker, dir);

                if (consecLosses < maxConsecLosses) {
                    var cooldownMs = 30 * 60 * 1000;
                    var autoTrade = tradeJournal.paperTrade(setup, price, cooldownMs);
                    if (autoTrade) {
                        console.log('📝 Auto paper trade: ' + dir + ' ' + ticker + ' @ $' + price.toFixed(2) + ' (conf: ' + signalResult.confidence + '%, signals: ' + (signalResult.signals || []).length + ', ' + horizon + ')');
                        try { notifier.sendPaperTrade(autoTrade, 'ENTRY'); } catch (ne) { /* optional */ }
                    }
                } else {
                    console.log('⏭️  Paper trade blocked ' + dir + ' ' + ticker + ': losing_streak=' + consecLosses + '/' + maxConsecLosses);
                }

                // Check earnings risk
                try {
                    var risk = await earningsCalendar.getEarningsRisk(ticker, 5);
                    state.earningsRisk[ticker] = risk;
                    if (risk.level === 'HIGH') setup.earningsWarning = risk.message;
                } catch (e) { /* earnings API optional */ }

                // Send notification for high-confidence setups
                try {
                    await notifier.alert(setup, {
                        regime: state.marketRegime ? state.marketRegime.label : '',
                        session: state.session,
                        earnings: setup.earningsWarning || ''
                    });
                } catch (e) { /* notifier optional */ }
            }
        }
    } catch (e) {
        console.error(`⚠️ Signal scoring error for ${ticker}:`, e.message);
    }
}

// ── Data Fetching ─────────────────────────────────────────

async function fetchTickerData(ticker, tier) {
    var callCount = 0;
    try {
        // ── HOT tier (every cycle) ──
        // Quote
        const quote = await uw.getStockQuote(ticker);
        if (quote?.data) state.quotes[ticker] = quote.data;
        callCount++;

        // Options volume levels
        const optVol = await uw.getOptionVolumeLevels(ticker);
        if (optVol?.data) state.quotes[ticker] = { ...state.quotes[ticker], optionVolume: optVol.data };
        callCount++;

        // Dark pool
        const dp = await uw.getDarkPoolLevels(ticker);
        if (dp?.data) state.darkPool[ticker] = dp.data;
        callCount++;

        // GEX
        const gex = await uw.getGEXByStrike(ticker);
        if (gex?.data) state.gex[ticker] = gex.data;
        callCount++;

        // Historical for technicals
        const hist = await uw.getHistoricalPrice(ticker);
        if (hist?.data && Array.isArray(hist.data) && hist.data.length > 0) {
            const candles = hist.data.map(d => ({
                date: d.date || d.timestamp,
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close),
                volume: parseFloat(d.volume || 0)
            }));
            const analysis = TechnicalAnalysis.analyze(candles);
            state.technicals[ticker] = analysis;
            const currentPrice = candles[candles.length - 1].close;
            const prevClose = candles.length > 1 ? candles[candles.length - 2].close : currentPrice;
            const changeAmt = currentPrice - prevClose;
            const changePct = prevClose ? (changeAmt / prevClose * 100) : 0;
            const lastCandle = candles[candles.length - 1];
            // Inject price data into quotes (UW getStockQuote returns info, not price)
            state.quotes[ticker] = {
                ...state.quotes[ticker],
                price: currentPrice,
                last: currentPrice,
                close: currentPrice,
                open: lastCandle.open,
                high: lastCandle.high,
                low: lastCandle.low,
                prev_close: prevClose,
                previousClose: prevClose,
                prevClose: prevClose,
                change: parseFloat(changeAmt.toFixed(2)),
                change_amount: parseFloat(changeAmt.toFixed(2)),
                changePercent: parseFloat(changePct.toFixed(2)),
                change_percent: parseFloat(changePct.toFixed(2)),
                volume: lastCandle.volume
            };
            const setup = alertEngine.generateTradeSetup(ticker, analysis, currentPrice);
            if (setup) state.tradeSetups[ticker] = setup;
            const techAlerts = alertEngine.evaluateTechnicals(ticker, analysis);
            if (techAlerts.length > 0) alertEngine.addAlerts(techAlerts);
        }
        callCount++;

        // Options flow
        const flow = await uw.getFlowByTicker(ticker);
        if (flow?.data) {
            const flowAlerts = alertEngine.evaluateFlowAlerts(flow, ticker);
            if (flowAlerts.length > 0) alertEngine.addAlerts(flowAlerts);
        }
        callCount++;

        // Net Premium Ticks (smart money direction) — HOT
        try {
            const netPrem = await uw.getNetPremium(ticker);
            if (netPrem?.data) state.netPremium[ticker] = netPrem.data;
            callCount++;
        } catch (e) { /* optional */ }

        // Flow Per Strike (magnetic price levels) — HOT
        try {
            const fps = await uw.getFlowPerStrike(ticker);
            if (fps?.data) state.flowPerStrike[ticker] = fps.data;
            callCount++;
        } catch (e) { /* optional */ }

        // Dark pool alerts (no API call, uses cached data)
        if (state.darkPool[ticker]) {
            const dpAlerts = alertEngine.evaluateDarkPool(ticker, { data: state.darkPool[ticker] });
            if (dpAlerts.length > 0) alertEngine.addAlerts(dpAlerts);
        }

        // ── WARM tier (every 5th cycle) ──
        if (tier === 'WARM' || tier === 'COLD') {
            const ivr = await uw.getIVRank(ticker);
            if (ivr?.data) state.ivRank[ticker] = ivr.data;
            callCount++;

            const mp = await uw.getMaxPain(ticker);
            if (mp?.data) state.maxPain[ticker] = mp.data;
            callCount++;

            const oic = await uw.getOIChange(ticker);
            if (oic?.data) state.oiChange[ticker] = oic.data;
            callCount++;

            const gr = await uw.getGreeks(ticker);
            if (gr?.data) state.greeks[ticker] = gr.data;
            callCount++;

            // Greek Flow (delta/gamma shifts) — WARM
            try {
                const gf = await uw.getGreekFlow(ticker);
                if (gf?.data) state.greekFlow[ticker] = gf.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Spot Exposures (pinning detection) — WARM
            try {
                const spot = await uw.getSpotExposures(ticker);
                if (spot?.data) state.spotExposures[ticker] = spot.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Flow Per Expiry (trade horizon) — WARM
            try {
                const fpe = await uw.getFlowPerExpiry(ticker);
                if (fpe?.data) state.flowPerExpiry[ticker] = fpe.data;
                callCount++;
            } catch (e) { /* optional */ }
        }

        // ── COLD tier (every 15th cycle) ──
        if (tier === 'COLD') {
            const si = await uw.getShortInterest(ticker);
            if (si?.data) state.shortInterest[ticker] = si.data;
            callCount++;

            const ss = await uw.getStockState(ticker);
            if (ss?.data) state.stockState[ticker] = ss.data;
            callCount++;

            const ins = await uw.getInsiderByTicker(ticker);
            if (ins?.data) state.insiderData[ticker] = ins.data;
            callCount++;

            const earn = await uw.getEarnings(ticker);
            if (earn?.data) state.earnings[ticker] = earn.data;
            callCount++;

            // Short Volume & Ratio (squeeze detection) — COLD
            try {
                const sv = await uw.getShortVolume(ticker);
                if (sv?.data) state.shortVolume[ticker] = sv.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Fails to Deliver (forced buying pressure) — COLD
            try {
                const ftd = await uw.getFailsToDeliver(ticker);
                if (ftd?.data) state.failsToDeliver[ticker] = ftd.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Seasonality (monthly bias) — COLD
            try {
                const szn = await uw.getTickerSeasonality(ticker);
                if (szn?.data) state.seasonality[ticker] = szn.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Realized Volatility (IV vs RV) — COLD
            try {
                const rv = await uw.getRealizedVol(ticker);
                if (rv?.data) state.realizedVol[ticker] = rv.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Term Structure (contango/backwardation) — COLD
            try {
                const ts = await uw.getTermStructure(ticker);
                if (ts?.data) state.termStructure[ticker] = ts.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Insider Ticker Flow (net buying/selling) — COLD
            try {
                const itf = await uw.getInsiderTickerFlow(ticker);
                if (itf?.data) state.insiderFlow[ticker] = itf.data;
                callCount++;
            } catch (e) { /* optional */ }
        }

    } catch (err) {
        console.error(`Error fetching data for ${ticker}:`, err.message);
    }
    return callCount;
}

async function fetchMarketData(tier) {
    var callCount = 0;
    try {
        // ── HOT tier (every cycle) ──
        const tide = await uw.getMarketTide();
        if (tide?.data) state.marketTide = tide.data;
        callCount++;

        const flow = await uw.getFlowAlerts();
        if (flow?.data) state.optionsFlow = Array.isArray(flow.data) ? flow.data.slice(0, 50) : [];
        callCount++;

        const dpRecent = await uw.getDarkPoolRecent();
        if (dpRecent?.data) state.darkPoolRecent = Array.isArray(dpRecent.data) ? dpRecent.data.slice(0, 30) : [];
        callCount++;

        const news = await uw.getNewsHeadlines();
        if (news?.data) state.news = Array.isArray(news.data) ? news.data.slice(0, 25) : [];
        callCount++;

        const spike = await uw.getMarketSpike();
        if (spike?.data) state.marketSpike = spike.data;
        callCount++;

        const tni = await uw.getTopNetImpact();
        if (tni?.data) state.topNetImpact = Array.isArray(tni.data) ? tni.data.slice(0, 20) : [];
        callCount++;

        // ── WARM tier (every 5th cycle) ──
        if (tier === 'WARM' || tier === 'COLD') {
            const totVol = await uw.getTotalOptionsVolume();
            if (totVol?.data) state.totalOptionsVol = totVol.data;
            callCount++;

            const mOI = await uw.getMarketOIChange();
            if (mOI?.data) state.marketOIChange = mOI.data;
            callCount++;

            const mIns = await uw.getInsiderBuySells();
            if (mIns?.data) state.marketInsiderBuySells = mIns.data;
            callCount++;

            // Sector Tides (sector rotation) — WARM
            try {
                var sectors = ['Technology', 'Healthcare', 'Financial', 'Energy', 'Consumer Cyclical', 'Industrials', 'Communication Services'];
                for (var si = 0; si < sectors.length; si++) {
                    var sectTide = await uw.getSectorTide(sectors[si]);
                    if (sectTide?.data) state.sectorTide[sectors[si]] = sectTide.data;
                    callCount++;
                }
            } catch (e) { /* optional */ }

            // ETF Tides (macro direction) — WARM
            try {
                var etfs = ['SPY', 'QQQ', 'IWM'];
                for (var ei = 0; ei < etfs.length; ei++) {
                    var eTide = await uw.getETFTide(etfs[ei]);
                    if (eTide?.data) state.etfTide[etfs[ei]] = eTide.data;
                    callCount++;
                }
            } catch (e) { /* optional */ }
        }

        // ── COLD tier (every 15th cycle) ──
        if (tier === 'COLD') {
            const congress = await uw.getCongressTrades();
            if (congress?.data) {
                const raw = Array.isArray(congress.data) ? congress.data.slice(0, 30) : [];
                state.congressTrades = enrichCongressTrades(raw);
            }
            callCount++;

            const congTrader = await uw.getCongressTrader();
            if (congTrader?.data) state.congressTrader = congTrader.data;
            callCount++;

            const congLate = await uw.getCongressLateReports();
            if (congLate?.data) state.congressLateReports = Array.isArray(congLate.data) ? congLate.data.slice(0, 20) : [];
            callCount++;

            const insTx = await uw.getInsiderTransactions();
            if (insTx?.data) state.insiderTransactions = Array.isArray(insTx.data) ? insTx.data.slice(0, 30) : [];
            callCount++;

            const earnPM = await uw.getEarningsPremarket();
            if (earnPM?.data) state.earningsToday.premarket = Array.isArray(earnPM.data) ? earnPM.data : [];
            callCount++;

            const earnAH = await uw.getEarningsAfterhours();
            if (earnAH?.data) state.earningsToday.afterhours = Array.isArray(earnAH.data) ? earnAH.data : [];
            callCount++;

            // Economic Calendar (macro events) — COLD
            try {
                const econ = await uw.getEconomicCalendar();
                if (econ?.data) state.economicCalendar = Array.isArray(econ.data) ? econ.data.slice(0, 30) : [];
                callCount++;
            } catch (e) { /* optional */ }

            // ETF Flows (institutional positioning) — COLD
            try {
                var etfList = ['SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV'];
                for (var efi = 0; efi < etfList.length; efi++) {
                    var ef = await uw.getETFFlow(etfList[efi]);
                    if (ef?.data) state.etfFlows[etfList[efi]] = ef.data;
                    callCount++;
                }
            } catch (e) { /* optional */ }
        }

    } catch (err) {
        console.error('Error fetching market data:', err.message);
    }
    return callCount;
}

async function refreshAll() {
    // Check API budget before fetching
    if (!scheduler.isWithinBudget()) {
        console.log('⚠️  API budget limit reached (' + scheduler.dailyCallCount + '/' + scheduler.dailyLimit + ') — skipping fetch cycle');
        return;
    }

    var tier = scheduler.getDataTier();
    var totalCalls = 0;
    console.log(`\n🔄 Refreshing [${tier}] — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} EST`);
    state.session = AlertEngine.getCurrentSession();

    // Fetch each ticker (tiered)
    for (const ticker of state.tickers) {
        totalCalls += await fetchTickerData(ticker, tier);
    }

    // Fetch market-wide data (tiered)
    totalCalls += await fetchMarketData(tier);

    // Track API calls
    scheduler.trackCalls(totalCalls);

    // Update alerts
    state.alerts = alertEngine.getAlerts();
    state.lastUpdate = new Date().toISOString();

    // Merge Yahoo real-time prices (provides fresh prev_close, open, volume)
    try {
        var yahooQuotes = await yahooPriceFeed.fetchQuotes(state.tickers);
        state.quotes = yahooPriceFeed.mergeWithUW(state.quotes, yahooQuotes);
    } catch (e) { console.error('Yahoo price feed error:', e.message); }

    // Analyze gaps (needs prev_close from quotes)
    try {
        state.polygonSnapshots = polygonClient.snapshotCache || {};
        state.gapAnalysis = gapAnalyzer.analyzeGaps(state);
    } catch (e) { console.error('Gap analysis error:', e.message); }

    // Detect market regime
    try {
        var regimeInput = {
            vix: state.marketSpike,
            marketTide: state.marketTide,
            breadth: null, // populated from market data if available
            adx: null
        };
        state.marketRegime = marketRegime.detect(regimeInput);
    } catch (e) { state.marketRegime = { regime: 'UNKNOWN', label: 'Unknown', confidence: 0 }; }

    // Analyze news sentiment per ticker
    for (const ticker of state.tickers) {
        var tickerNews = (state.news || []).filter(function (n) {
            return (n.tickers || []).includes(ticker) || (n.headline || n.title || '').toUpperCase().includes(ticker);
        });
        if (tickerNews.length > 0) {
            state.sentiment[ticker] = newsSentiment.analyze(ticker, tickerNews);
        }
    }

    // Run signal engine scoring for each ticker (uses shared scoreTickerSignals helper)
    for (const ticker of state.tickers) {
        await scoreTickerSignals(ticker);
    }
    // Correlation guard check across all setups
    state.correlationRisk = correlationGuard.checkConcentration(state.tradeSetups);
    state.notifierStatus = notifier.getStatus();

    // ── Volatility Runner Scanner ──
    try {
        await scanVolatilityRunners();
        // Score any newly discovered runners through the full signal pipeline
        var runnerTickers = Object.keys(state.volatilityRunners);
        for (var ri = 0; ri < runnerTickers.length; ri++) {
            var rt = runnerTickers[ri];
            // Only score runners not already on watchlist (watchlist tickers already scored above)
            if (!state.tickers.includes(rt)) {
                // Fetch minimal data for the runner (quote + flow)
                try {
                    var rQuote = await uw.getStockQuote(rt);
                    if (rQuote?.data) state.quotes[rt] = rQuote.data;
                    scheduler.trackCalls(1);

                    // Fetch Yahoo price for more accurate data
                    try {
                        var yQuotes = await yahooPriceFeed.fetchQuotes([rt]);
                        state.quotes = yahooPriceFeed.mergeWithUW(state.quotes, yQuotes);
                    } catch (ye) { /* optional */ }

                    await scoreTickerSignals(rt);
                } catch (re) {
                    console.error('Runner scoring error for ' + rt + ':', re.message);
                }
            }
        }
    } catch (e) { console.error('Volatility scanner pipeline error:', e.message); }

    // ── Market Scanner (deferred 60s to avoid rate limit overlap) ──
    // Fetch Polygon snapshot for bid/ask updates + scanner candidates
    try {
        await polygonClient.getSnapshot();
    } catch (pe) { /* optional */ }

    var polygonGainers = [];
    var polygonLosers = [];
    try {
        polygonGainers = await polygonClient.getGainers();
        polygonLosers = await polygonClient.getLosers();
    } catch (pe) { /* optional */ }

    var scannerMarketData = {
        optionsFlow: state.optionsFlow,
        darkPoolRecent: state.darkPoolRecent,
        topNetImpact: state.topNetImpact,
        marketInsiderBuySells: state.marketInsiderBuySells,
        insiderTransactions: state.insiderTransactions,
        news: state.news,
        polygonGainers: polygonGainers,
        polygonLosers: polygonLosers
    };
    // Defer scanner scoring to 60s from now so UW rate limit window resets
    setTimeout(async function () {
        try {
            // Log feed sizes for debugging
            console.log('🔍 Scanner feeds: flow=' + (scannerMarketData.optionsFlow || []).length +
                ', dp=' + (scannerMarketData.darkPoolRecent || []).length +
                ', tni=' + (scannerMarketData.topNetImpact || []).length +
                ', insider=' + (scannerMarketData.insiderTransactions || []).length +
                ', news=' + (scannerMarketData.news || []).length +
                ' | watchlist=' + (state.tickers || []).length + ' tickers excluded');
            var candidates = scanner.harvest(scannerMarketData, state.tickers);
            console.log('🔍 Scanner harvest: ' + candidates.length + ' candidates' + (candidates.length > 0 ? ' — top: ' + candidates.slice(0, 5).map(function (c) { return c.ticker + '(' + c.weight.toFixed(1) + '/' + c.sources.length + 'src)'; }).join(', ') : ''));
            var newHits = await scanner.scan(scannerMarketData, state.tickers, uw, state.session);
            state.scannerResults = scanner.getResults();

            // Notify on new scanner discoveries
            for (var si = 0; si < newHits.length; si++) {
                var hit = newHits[si];
                try {
                    var scanMsg = '🔍 *Scanner Discovery: ' + hit.ticker + '*\n';
                    scanMsg += (hit.direction === 'BULLISH' ? '🟢' : hit.direction === 'BEARISH' ? '🔴' : '⚪');
                    scanMsg += ' ' + hit.direction + ' — ' + hit.confidence + '% confidence\n';
                    scanMsg += 'Price: $' + (hit.price || 0) + '\n';
                    scanMsg += 'Sources: ' + hit.sources.join(', ') + '\n';
                    if (hit.details && hit.details.length > 0) {
                        scanMsg += 'Details: ' + hit.details.slice(0, 3).join(' | ') + '\n';
                    }
                    scanMsg += 'Signals: ' + hit.signals.map(function (s) { return s.name; }).join(', ');
                    await notifier._sendTelegram(scanMsg);
                } catch (ne) { /* optional */ }
            }

            // Always broadcast updated state so scanner results persist on dashboard
            broadcast({ type: 'full_state', data: state });
            console.log('🔍 Scanner: ' + (newHits.length || 0) + ' new discoveries (' + (state.scannerResults.results || []).length + ' total)');
        } catch (e) {
            console.error('Scanner deferred error:', e.message);
        }
    }, 60000);

    // Check trade outcomes against current prices
    tradeJournal.checkOutcomes(state.quotes);

    // Update paper trade P&L and notify Spidey on significant moves
    var paperUpdated = tradeJournal.updatePaperPnL(state.quotes);
    optionsPaper.updatePrices(state.quotes); // Update options paper trades too
    if (paperUpdated > 0) {
        var paperTrades = tradeJournal.getPaperTrades();
        paperTrades.forEach(function (pt) {
            if (pt.status !== 'PENDING') return;
            // Notify on significant moves (> 1% change)
            var pnl = Math.abs(pt.unrealizedPnl || 0);
            if (pnl >= 1 && !pt._lastNotifiedPnl || Math.abs(pnl - (pt._lastNotifiedPnl || 0)) >= 1) {
                pt._lastNotifiedPnl = pnl;
                try { notifier.sendPaperTrade(pt, 'UPDATE'); } catch (e) { /* optional */ }
            }
        });
    }

    state.journalStats = tradeJournal.getStats();
    state.mlStatus = mlCalibrator.getStatus();

    // Train ML if enough data - train BOTH models
    const trainingData = tradeJournal.getTrainingData();
    if (trainingData.length >= 30 && trainingData.length % 10 === 0) {
        // Train dayTrade model with all data (intraday focus)
        const trainedDT = mlCalibrator.train(trainingData, 'dayTrade');
        if (trainedDT) {
            const sugDT = mlCalibrator.getSuggestedWeights('dayTrade');
            if (sugDT) signalEngine.updateWeights(sugDT);
        }
        // Train swing model with all data (will learn swing patterns)
        mlCalibrator.train(trainingData, 'swing');
    }

    // Generate morning brief
    state.morningBrief = generateMorningBrief();

    // Send morning brief to Discord #morning-brief channel (once per day)
    try {
        await notifier.sendBrief(state.morningBrief, state.session, state.marketRegime);
    } catch (e) { /* brief notification optional */ }

    // Save state to disk for persistence across restarts
    scheduler.saveState(state);

    // Log cycle stats
    scheduler.logCycle(tier, state.tickers.length, totalCalls);

    // Broadcast update
    broadcast({ type: 'full_state', data: state });

    console.log(`✅ Updated ${state.tickers.length} tickers | ${state.alerts.length} alerts | Session: ${AlertEngine.sessionLabel(state.session)}`);

    // ── Automatic EOD Report Generation ──
    const now = new Date();
    const estTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const hour = estTime.getHours();
    const min = estTime.getMinutes();

    // Run at 4:20 PM EST (market closed + 20 mins for data to settle)
    if (hour === 16 && min >= 20 && min < 30 && !state.eodReportGenerated) {
        console.log('📉 Market Closed — Generating EOD Report...');
        state.polygonTickSummaries = polygonClient.getAllSummaries();
        eodReporter.generateReport(state, tradeJournal, optionsPaper);
        state.eodReportGenerated = true;
    }
    // Reset flag next day
    if (hour === 9 && min === 0) {
        state.eodReportGenerated = false;
        state.mlNightlyRetrained = false;
    }

    // 2b. Nightly ML retrain (5:00 PM EST — after EOD report settles)
    if (hour === 17 && min >= 0 && min < 10 && !state.mlNightlyRetrained) {
        state.mlNightlyRetrained = true;
        (async function () {
            try {
                console.log('🧠 Nightly ML retrain starting...');
                var cumulPath = path.join(__dirname, 'data', 'ml-training-cumulative.json');
                var cumulative = [];
                try { if (require('fs').existsSync(cumulPath)) cumulative = JSON.parse(require('fs').readFileSync(cumulPath, 'utf8')); } catch (e) { }

                // Add any watchlist tickers not yet in cumulative
                var trainedTickers = {};
                cumulative.forEach(function (d) { if (d._ticker) trainedTickers[d._ticker] = true; });
                var newTickers = (state.tickers || []).filter(function (t) { return !trainedTickers[t]; });
                if (newTickers.length > 0) {
                    console.log('🧠 Fetching history for ' + newTickers.length + ' new tickers: ' + newTickers.join(', '));
                    var newData = await polygonHistorical.generateAndConvert(newTickers, 5);
                    if (newData && newData.data) cumulative = cumulative.concat(newData.data);
                    require('fs').writeFileSync(cumulPath, JSON.stringify(cumulative));
                }

                if (cumulative.length >= 30) {
                    var recent = cumulative.slice(Math.floor(cumulative.length * 0.6));
                    mlCalibrator.train(recent, 'dayTrade');
                    mlCalibrator.train(cumulative, 'swing');
                    var st = mlCalibrator.getStatus();
                    console.log('🧠 Nightly retrain complete: dayTrade=' + st.dayTrade.accuracy + '% (' + recent.length + ' samples) | swing=' + st.swing.accuracy + '% (' + cumulative.length + ' samples)');
                } else {
                    console.log('🧠 Nightly retrain skipped: only ' + cumulative.length + ' samples (need 30+)');
                }
            } catch (e) { console.error('Nightly ML retrain error:', e.message); }
        })();
    }

    // 3. Auto-close Day Trades (3:55 PM ET or later if missed)
    // If server restarts after 3:55 PM, this ensures they still close immediately
    if ((hour >= 16 || (hour === 15 && min >= 55)) && !state.dayTradesClosed) {
        console.log('⏰ End of Day: Auto-closing intraday paper trades...');
        state.dayTradesClosed = true;

        const currentPriceFn = (ticker) => {
            const q = state.quotes[ticker];
            return parseFloat(q?.last || q?.price || q?.close || 0);
        };

        const openTrades = tradeJournal.getPaperTrades().filter(t => t.status === 'PENDING');
        let closedCount = 0;
        openTrades.forEach(t => {
            const h = (t.horizon || '').toLowerCase();
            if (h.includes('day') || h.includes('scalp') || h.includes('intraday')) {
                const exitPrice = currentPriceFn(t.ticker);
                if (exitPrice > 0) {
                    // Determine P&L-based status so _recalcStats can properly track wins/losses
                    const entryPrice = t.paperEntry || t.entry || 0;
                    const isLong = t.direction === 'LONG';
                    const pnl = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
                    const status = pnl > 0 ? 'WIN_T1' : 'LOSS_STOP';
                    tradeJournal._closeTrade(t, status, exitPrice);
                    closedCount++;
                }
            }
        });
        if (closedCount > 0) {
            tradeJournal._save();
            console.log(`✅ Closed ${closedCount} day trades for EOD.`);
        }
        state.dayTradesClosed = true;
    }
    // Reset flag next morning
    if (hour === 9 && min === 0) state.dayTradesClosed = false;
}

// ── Halt/Unhalt Detection ──────────────────────────────────
// Fetches from NASDAQ Trading Halts RSS feed (free, real-time)
var haltRefreshTimer = null;
var HALT_REFRESH_MS = 60000; // 60 seconds

async function fetchTradingHalts() {
    try {
        const https = require('https');
        const url = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';

        const xml = await new Promise(function (resolve, reject) {
            https.get(url, function (res) {
                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () { resolve(data); });
                res.on('error', reject);
            }).on('error', reject);
        });

        // Simple XML parsing for RSS items
        var items = xml.split('<item>').slice(1);
        var halts = [];
        var now = Date.now();
        var cutoffMs = 24 * 60 * 60 * 1000; // last 24 hours

        items.forEach(function (item) {
            var ticker = (item.match(/<ndaq:IssueSymbol>(.*?)<\/ndaq:IssueSymbol>/i) || [])[1] || '';
            var name = (item.match(/<ndaq:IssueName>(.*?)<\/ndaq:IssueName>/i) || [])[1] || '';
            var market = (item.match(/<ndaq:Market>(.*?)<\/ndaq:Market>/i) || [])[1] || '';
            var reasonCode = (item.match(/<ndaq:ReasonCode>(.*?)<\/ndaq:ReasonCode>/i) || [])[1] || '';
            var haltDate = (item.match(/<ndaq:HaltDate>(.*?)<\/ndaq:HaltDate>/i) || [])[1] || '';
            var haltTime = (item.match(/<ndaq:HaltTime>(.*?)<\/ndaq:HaltTime>/i) || [])[1] || '';
            var resumeDate = (item.match(/<ndaq:ResumptionDate>(.*?)<\/ndaq:ResumptionDate>/i) || [])[1] || '';
            var resumeTime = (item.match(/<ndaq:ResumptionTradeTime>(.*?)<\/ndaq:ResumptionTradeTime>/i) || [])[1] || '';
            var resumeQuoteTime = (item.match(/<ndaq:ResumptionQuoteTime>(.*?)<\/ndaq:ResumptionQuoteTime>/i) || [])[1] || '';

            if (!ticker || ticker.length > 6) return;

            // Parse halt time
            var haltTs = haltDate && haltTime ? new Date(haltDate + ' ' + haltTime).getTime() : 0;
            if (haltTs > 0 && (now - haltTs) > cutoffMs) return; // skip old

            // Determine halt reason
            var reasons = {
                'LUDP': 'LULD Pause',
                'LUDS': 'LULD Pause (Straddle)',
                'T1': 'News Pending',
                'T2': 'News Released',
                'T5': 'ETF Component',
                'T6': 'Extraordinary Event',
                'T8': 'Exchange Decision',
                'T12': 'IPO Issue',
                'H4': 'Non-Compliance',
                'H9': 'Not Current',
                'H10': 'SEC Suspension',
                'H11': 'Regulatory',
                'M1': 'MWCB Level 1',
                'M2': 'MWCB Level 2',
                'M3': 'MWCB Level 3'
            };
            var reason = reasons[reasonCode] || reasonCode || 'Unknown';

            // Determine status
            var isResumed = !!(resumeTime || resumeQuoteTime);
            var status = isResumed ? 'RESUMED' : 'HALTED';

            // Get price/change from our quotes if we track this ticker
            var q = state.quotes[ticker.toUpperCase()] || {};
            var price = parseFloat(q.price || q.last || 0);
            var changePct = parseFloat(q.changePercent || q.change_percent || 0);

            halts.push({
                ticker: ticker.toUpperCase(),
                name: name,
                market: market,
                status: status,
                reason: reason,
                reasonCode: reasonCode,
                haltTime: haltTime,
                haltDate: haltDate,
                resumeTime: resumeTime || resumeQuoteTime || '',
                price: price,
                changePct: +changePct.toFixed(2),
                timestamp: haltTs || now,
                isWatchlist: state.tickers.includes(ticker.toUpperCase())
            });
        });

        // Sort by newest first, watchlist tickers at top
        halts.sort(function (a, b) {
            if (a.isWatchlist && !b.isWatchlist) return -1;
            if (!a.isWatchlist && b.isWatchlist) return 1;
            return b.timestamp - a.timestamp;
        });

        // Check for new halts on watchlist tickers
        var prevHalted = (state.halts || []).filter(function (h) { return h.status === 'HALTED'; }).map(function (h) { return h.ticker; });
        halts.forEach(function (h) {
            if (h.status === 'HALTED' && h.isWatchlist && !prevHalted.includes(h.ticker)) {
                try {
                    var msg = '🛑 *HALT: ' + h.ticker + '*\n';
                    msg += 'Reason: ' + h.reason + '\n';
                    msg += 'Time: ' + h.haltTime + '\n';
                    if (h.price) msg += 'Last Price: $' + h.price + '\n';
                    if (h.changePct) msg += 'Change: ' + h.changePct + '%';
                    notifier._sendTelegram(msg);
                } catch (e) { /* optional */ }
            }
        });

        state.halts = halts.slice(0, 50); // keep last 50
    } catch (e) {
        // Silent — halt feed is best-effort
        console.error('Halt feed error:', e.message);
    }
}

function startHaltRefresh() {
    if (haltRefreshTimer) clearInterval(haltRefreshTimer);
    // Initial fetch
    fetchTradingHalts();
    // Then every 60s during all hours
    haltRefreshTimer = setInterval(fetchTradingHalts, HALT_REFRESH_MS);
}

// ── Dynamic Polling Loop ─────────────────────────────────
// Session-aware: 1 min at open, 10 min midday, 60 min overnight
var refreshTimer = null;
function scheduleNext() {
    var intervalMs = scheduler.getSessionInterval();
    var session = scheduler.getSessionName();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async function () {
        try {
            await refreshAll();
        } catch (e) {
            console.error('Refresh error:', e.message);
        }
        scheduleNext(); // schedule again with potentially new interval
    }, intervalMs);
}

// ── Mid-cycle Yahoo Price Refresh ────────────────────────
// Fetches live prices from Yahoo Finance during all sessions
// Session-aware intervals: faster during active trading, slower overnight
// Covers ALL tickers on the command centre, not just watchlist
var yahooRefreshTimer = null;

// Session-aware Yahoo refresh intervals (ms)
var YAHOO_INTERVALS = {
    'OPEN_RUSH': 10000,  // 10s — fastest during open chaos
    'POWER_OPEN': 10000,  // 10s — fast for day trade entries
    'PRE_MARKET': 15000,  // 15s — pre-market gaps changing fast
    'MIDDAY': 15000,  // 15s — still active, just slower
    'POWER_HOUR': 15000,  // 15s — closing momentum
    'AFTER_HOURS': 30000,  // 30s — after hours
    'OVERNIGHT': 60000   // 60s — overnight, minimal movement
};

function getYahooInterval() {
    var session = scheduler.getSessionName();
    return YAHOO_INTERVALS[session] || 30000;
}

// Collect ALL tickers visible on the command centre
function getAllCommandCentreTickers() {
    var tickerSet = {};

    // 1. Watchlist (always)
    (state.tickers || []).forEach(function (t) { tickerSet[t] = true; });

    // 2. Options flow tickers
    (state.optionsFlow || []).forEach(function (f) {
        var t = (f.ticker || f.symbol || f.underlying_symbol || '').toUpperCase();
        if (t && t.length <= 5) tickerSet[t] = true;
    });

    // 3. Dark pool tickers
    (state.darkPoolRecent || []).forEach(function (d) {
        var t = (d.ticker || d.symbol || '').toUpperCase();
        if (t && t.length <= 5) tickerSet[t] = true;
    });

    // 4. Top net impact tickers
    (state.topNetImpact || []).forEach(function (n) {
        var t = (n.ticker || n.symbol || '').toUpperCase();
        if (t && t.length <= 5) tickerSet[t] = true;
    });

    // 5. Active trade setup tickers
    Object.keys(state.tradeSetups || {}).forEach(function (t) { tickerSet[t] = true; });

    // 6. Open paper trade tickers
    tradeJournal.getPaperTrades().forEach(function (pt) {
        if (pt.status === 'PENDING' && pt.ticker) tickerSet[pt.ticker] = true;
    });

    // 7. X alert tickers
    (state.xAlerts || []).forEach(function (a) {
        if (a.ticker) tickerSet[a.ticker.toUpperCase()] = true;
    });

    // Cap at 50 tickers to avoid overloading Yahoo
    var all = Object.keys(tickerSet).filter(function (t) {
        return t && /^[A-Z]{1,5}$/.test(t);
    });
    return all.slice(0, 50);
}

function startYahooPriceRefresh() {
    if (yahooRefreshTimer) clearTimeout(yahooRefreshTimer);

    async function yahooTick() {
        try {
            var allTickers = getAllCommandCentreTickers();
            if (allTickers.length === 0) { scheduleYahoo(); return; }

            var yahooQuotes = await yahooPriceFeed.fetchQuotes(allTickers);
            if (Object.keys(yahooQuotes).length > 0) {
                // Merge Yahoo prices into state quotes
                state.quotes = yahooPriceFeed.mergeWithUW(state.quotes, yahooQuotes);

                // Re-run gap analysis with fresh Yahoo prev_close/open data
                state.polygonSnapshots = polygonClient.snapshotCache || {};
                state.gapAnalysis = gapAnalyzer.analyzeGaps(state);

                // Update paper trade P&L with fresh prices
                tradeJournal.updatePaperPnL(state.quotes);
                tradeJournal.checkOutcomes(state.quotes);

                // During market hours, run multi-TF analysis for watchlist tickers
                var isActive = ['OPEN_RUSH', 'POWER_OPEN', 'PRE_MARKET', 'MIDDAY', 'POWER_HOUR'].includes(scheduler.getSessionName());
                if (isActive) {
                    try {
                        var siMap = {};
                        Object.keys(state.shortInterest || {}).forEach(function (t) {
                            var si = state.shortInterest[t];
                            var arr = Array.isArray(si) ? si : [si];
                            var last = arr[arr.length - 1] || {};
                            siMap[t] = parseFloat(last.si_float_returned || last.short_interest_pct || 0);
                        });
                        // Analyze watchlist tickers with multi-TF (most important)
                        var mtfTickers = (state.tickers || []).slice(0, 10);
                        state.multiTF = await multiTFAnalyzer.analyzeBatch(mtfTickers, siMap);

                        // Run opportunity scanner for non-watchlist high-probability trades
                        state.hotOpportunities = await opportunityScanner.scan(state, scheduler.getSessionName());
                        if (state.hotOpportunities.length > 0) {
                            console.log('🔥 Hot opportunities: ' + state.hotOpportunities.map(function (o) { return o.ticker + ' ' + o.direction + ' ' + o.confidence + '%'; }).join(', '));
                        }
                    } catch (mtfErr) {
                        // Multi-TF is best-effort
                    }
                }

                // Broadcast fresh prices to all clients
                broadcast({ type: 'full_state', data: state });
            }
        } catch (e) {
            // Silent — Yahoo refresh is best-effort
        }
        scheduleYahoo();
    }

    function scheduleYahoo() {
        var interval = getYahooInterval();
        yahooRefreshTimer = setTimeout(yahooTick, interval);
    }

    scheduleYahoo();
}

// Load cached state on startup (so dashboard shows data immediately)
var cachedState = scheduler.loadState();
if (cachedState) {
    // Merge cached state into current state (keep tickers from .env)
    var keepKeys = ['tickers'];
    Object.keys(cachedState).forEach(function (k) {
        if (keepKeys.indexOf(k) === -1 && cachedState[k] !== undefined) {
            state[k] = cachedState[k];
        }
    });
    console.log('📂 Dashboard preloaded with cached data');
}

// Initial fetch (COLD tier to populate everything)
scheduler.cycleCount = 14; // next getDataTier() call returns COLD
refreshAll().then(() => {
    console.log('\n⏱️  Dynamic scheduling active — interval adjusts per market session');
    console.log('📊 Session: ' + scheduler.getSessionName() + ' | Interval: ' + (scheduler.getSessionInterval() / 1000) + 's');
    scheduleNext();
    startYahooPriceRefresh();
    startHaltRefresh();
    console.log('📈 Yahoo price feed active — session-aware (' + (getYahooInterval() / 1000) + 's current, covers all command centre tickers)');
    console.log('🛑 Halt detection active — checking every ' + (HALT_REFRESH_MS / 1000) + 's');
});

// ── Morning Brief Generator ──────────────────────────────
function generateMorningBrief() {
    const brief = {};
    for (const ticker of state.tickers) {
        const q = state.quotes[ticker] || {};
        const setup = state.tradeSetups[ticker];
        const score = state.signalScores[ticker];
        const price = q.last || q.price || q.close || 0;

        if (score) {
            brief[ticker] = {
                ticker,
                direction: score.direction,
                confidence: score.confidence,
                signals: score.signals.map(s => s.name + ' (' + s.dir + ')'),
                signalDetails: score.signals,
                price,
                ensemble: score.ensemble || null,
                session: score.session || state.session,
                earningsRisk: (state.earningsRisk || {})[ticker] || null,
                setup: setup ? { entry: setup.entry, target1: setup.target1, target2: setup.target2, stop: setup.stop, rr: setup.riskReward } : null,
                bull: score.bull,
                bear: score.bear,
                // Polygon tick data summary
                tickData: (function () {
                    var td = polygonClient.getTickSummary(ticker);
                    if (!td) return null;
                    return { buyPct: td.buyPct, sellPct: td.sellPct, flowImbalance: td.flowImbalance, vwap: td.vwap, totalVolume: td.totalVolume, largeBlockBuys: td.largeBlockBuys, largeBlockSells: td.largeBlockSells };
                })(),
                // Polygon snapshot data
                snapshotData: polygonClient.getSnapshotData(ticker) || null
            };
        }
    }
    return brief;
}

// ── Backtest Runner ──────────────────────────────────────
async function runBacktest() {
    console.log('Running backtest for all tickers...');
    const allResults = [];

    for (const ticker of state.tickers) {
        try {
            // Fetch 6 months of daily candles for backtesting
            const candles = await uw.getHistoricalCandles(ticker, '1d', 180);
            if (!candles || candles.length < 50) {
                console.log('Backtest: Skipping ' + ticker + ' (insufficient data)');
                continue;
            }

            const results = tradeJournal.backtest(ticker, candles, signalEngine);
            allResults.push(...results);
            console.log('Backtest: ' + ticker + ' -> ' + results.length + ' trades simulated');
        } catch (e) {
            console.error('Backtest error for ' + ticker + ':', e.message);
        }
    }

    // Feed backtest results to BOTH ML models
    if (allResults.length >= 30) {
        const trainingData = allResults.map(r => ({
            features: r.features,
            label: r.label,
            confidence: r.confidence,
            pnlPct: r.pnlPct
        }));

        // Train dayTrade model
        const trainedDT = mlCalibrator.train(trainingData, 'dayTrade');
        if (trainedDT) {
            const sugDT = mlCalibrator.getSuggestedWeights('dayTrade');
            if (sugDT) signalEngine.updateWeights(sugDT);
            console.log('DayTrade ML trained on ' + trainingData.length + ' backtest trades');
        }

        // Train swing model
        const trainedSW = mlCalibrator.train(trainingData, 'swing');
        if (trainedSW) {
            console.log('Swing ML trained on ' + trainingData.length + ' backtest trades');
        }

        // Save backtest results to journal for reference
        const fs = require('fs');
        const btPath = path.join(__dirname, 'data', 'backtest-results.json');
        if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
        fs.writeFileSync(btPath, JSON.stringify({
            date: new Date().toISOString(),
            totalTrades: allResults.length,
            wins: allResults.filter(r => r.label === 1).length,
            losses: allResults.filter(r => r.label === 0).length,
            winRate: +(allResults.filter(r => r.label === 1).length / allResults.length * 100).toFixed(1),
            avgPnl: +(allResults.reduce((a, r) => a + r.pnlPct, 0) / allResults.length).toFixed(2),
            results: allResults
        }, null, 2));
    }

    const mlSt = mlCalibrator.getStatus();
    return {
        totalTrades: allResults.length,
        wins: allResults.filter(r => r.label === 1).length,
        losses: allResults.filter(r => r.label === 0).length,
        winRate: allResults.length > 0 ? +(allResults.filter(r => r.label === 1).length / allResults.length * 100).toFixed(1) : 0,
        avgPnl: allResults.length > 0 ? +(allResults.reduce((a, r) => a + r.pnlPct, 0) / allResults.length).toFixed(2) : 0,
        dayTradeML: mlSt.dayTrade,
        swingML: mlSt.swing
    };
}

console.log(`\n\u23F3 Starting Trading Dashboard...`);
console.log(`\uD83D\uDCCA Tickers: ${TICKERS.join(', ')}`);
console.log(`\u23F1\uFE0F  Session: ${scheduler.getSessionName()} | Interval: ${scheduler.getSessionInterval() / 1000}s`);
