// Trading Dashboard — Main Server
// Express + WebSocket for real-time data push

require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const { UWClient, UWWebSocketClient } = require('./src/uw-client');
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
// Yahoo Finance removed — Polygon REST + WS is the sole price source
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
const uwWS = new UWWebSocketClient(process.env.UW_API_KEY);  // D1/D2: Lit + Off-Lit trade streams
const alertEngine = new AlertEngine();
const signalEngine = new SignalEngine();
const tradeJournal = new TradeJournal();
const mlCalibrator = new MLCalibrator();

// Auto-load ML model from persisted cumulative training data
(function () {
    try {
        var cumulPath = path.join(__dirname, 'data', 'ml-training-cumulative.json');
        if (require('fs').existsSync(cumulPath)) {
            var cumulative = JSON.parse(require('fs').readFileSync(cumulPath, 'utf8'));
            if (cumulative && cumulative.length >= 30) {
                var recent = cumulative.slice(Math.floor(cumulative.length * 0.6));
                mlCalibrator.train(recent, 'dayTrade');
                mlCalibrator.train(cumulative, 'swing');
                var st = mlCalibrator.getStatus();
                console.log('🧠 ML models loaded from disk: dayTrade=' + st.dayTrade.accuracy + '% (' + recent.length + ' samples) | swing=' + st.swing.accuracy + '% (' + cumulative.length + ' samples)');
            }
        }
    } catch (e) { console.error('ML auto-load error:', e.message); }
})();
const earningsCalendar = new EarningsCalendar(uw);
const marketRegime = new MarketRegime();
const newsSentiment = new NewsSentiment();
const correlationGuard = new CorrelationGuard();
const notifier = new Notifier();
const polygonClient = new PolygonTickClient(process.env.POLYGON_API_KEY);
const scanner = new MarketScanner({ minConfidence: 40, maxCandidates: 10, minPrice: 2, polygonClient: polygonClient });
const scheduler = new SessionScheduler({ dailyLimit: 15000, safetyMargin: 0.90 });
const xAlertMonitor = new XAlertMonitor({ minScore: 50 });
const gapAnalyzer = new GapAnalyzer();
// yahooPriceFeed removed — replaced by Polygon REST snapshots
const multiTFAnalyzer = new MultiTFAnalyzer(polygonClient);
const opportunityScanner = new OpportunityScanner(signalEngine, multiTFAnalyzer);
const optionsPaper = new OptionsPaperTrading();
const eodReporter = new EODReporter();

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
    liveDiscoveries: [],       // Active discoveries for dashboard (runners, halts, scanner)
    discoveryHistory: [],      // Performance tracking log
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
    tickData: {},  // Polygon real-time tick summaries
    // Phase 2 new data
    nope: {},
    flowPerStrikeIntraday: {},
    analystRatings: {},
    institutionHoldings: {},
    institutionActivity: {},
    shortVolumesByExchange: {},
    fdaCalendar: [],
    priceTargets: {},
    // Tier 2 new integrations
    ivSkew: {},
    volStats: {},
    litFlow: {},
    marketCorrelations: null,
    unusualOptions: []
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
                    // Cap at 50K samples to prevent unbounded growth
                    if (cumulative.length > 50000) cumulative = cumulative.slice(-50000);
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
        stockState: state.stockState[t],
        // Phase E data
        oiPerStrike: (state.oiPerStrike || {})[t] || null,
        oiPerExpiry: (state.oiPerExpiry || {})[t] || null,
        atmChains: (state.atmChains || {})[t] || null,
        stockPriceLevels: (state.stockPriceLevels || {})[t] || null,
        stockVolumePriceLevels: (state.stockVolumePriceLevels || {})[t] || null,
        // Phase F data
        expiryBreakdown: (state.expiryBreakdown || {})[t] || null,
        spotGEXByExpiryStrike: (state.spotGEXByExpiryStrike || {})[t] || null,
        tickerOwnership: (state.tickerOwnership || {})[t] || null,
        politicianHolders: (state.politicianHolders || {})[t] || null,
        seasonalityYearMonth: (state.seasonalityYearMonth || {})[t] || null
    });
});
app.get('/api/darkpool/recent', (req, res) => res.json(state.darkPoolRecent));
app.get('/api/market/spike', (req, res) => res.json(state.marketSpike));

// Phase E: On-demand Option Contract Data (fetched when user opens detail view)
app.get('/api/option-contract/:id/flow', async (req, res) => {
    try {
        const data = await uw.getOptionContractFlow(req.params.id);
        res.json(data?.data || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/option-contract/:id/historic', async (req, res) => {
    try {
        const data = await uw.getOptionContractHistoric(req.params.id);
        res.json(data?.data || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/option-contract/:id/intraday', async (req, res) => {
    try {
        const data = await uw.getOptionContractIntraday(req.params.id);
        res.json(data?.data || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/option-contract/:id/volume-profile', async (req, res) => {
    try {
        const data = await uw.getOptionContractVolumeProfile(req.params.id);
        res.json(data?.data || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/options-tape/:date', async (req, res) => {
    try {
        const data = await uw.getFullOptionsTape(req.params.date);
        res.json(data?.data || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Journal & ML endpoints
app.get('/api/journal/stats', (req, res) => res.json(tradeJournal.getStats()));
app.get('/api/journal/trades', (req, res) => res.json(tradeJournal.getRecentTrades(50)));
app.get('/api/ml/status', (req, res) => res.json(mlCalibrator.getStatus()));

// ── EOD Report endpoints ──
app.get('/api/eod-reports', (req, res) => {
    try {
        res.json(eodReporter.listReports());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/eod-report/generate', async (req, res) => {
    try {
        const report = eodReporter.generateReport(state, tradeJournal, optionsPaper);
        res.json({ success: true, report });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.get('/api/eod-report/:date', (req, res) => {
    try {
        const report = eodReporter.getReport(req.params.date);
        if (!report) return res.status(404).json({ error: 'Report not found' });
        res.json(report);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
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

        // Step 4: Persist cumulative training data so ML survives restarts
        try {
            var cumulPath = path.join(__dirname, 'data', 'ml-training-cumulative.json');
            if (allData.length > 50000) allData = allData.slice(-50000);
            require('fs').writeFileSync(cumulPath, JSON.stringify(allData));
            console.log('🧠 ML training data saved: ' + allData.length + ' samples → ' + cumulPath);
        } catch (saveErr) { console.error('ML data save error:', saveErr.message); }

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
app.get('/api/discovery-performance', (req, res) => res.json(getDiscoveryPerformanceStats()));
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
    const totalPnlDollar = closed.reduce((s, t) => s + (t.pnlTotal || t.pnlPoints || 0), 0);
    const unrealizedPnl = open.reduce((s, t) => s + (t.unrealizedPnlTotal || t.unrealizedPnlDollar || 0), 0);
    const unrealizedPnlDollar = open.reduce((s, t) => s + (t.unrealizedPnlTotal || t.unrealizedPnlDollar || 0), 0);
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
    const todayPnlDollar = todayClosed.reduce((s, t) => s + (t.pnlTotal || t.pnlPoints || 0), 0);
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
        bt.pnlDollar += (t.pnlTotal || t.pnlPoints || 0);
        if (t.direction === 'LONG') { bt.longs++; bt.longPnl += (t.pnl || 0); bt.longPnlDollar += (t.pnlTotal || t.pnlPoints || 0); }
        else { bt.shorts++; bt.shortPnl += (t.pnl || 0); bt.shortPnlDollar += (t.pnlTotal || t.pnlPoints || 0); }
    });
    const tickerBreakdown = Object.values(byTicker).sort((a, b) => b.pnl - a.pnl);

    // ── Long vs Short Breakdown ──
    const longs = closed.filter(t => t.direction === 'LONG');
    const shorts = closed.filter(t => t.direction === 'SHORT');
    const longWins = longs.filter(t => t.pnl > 0).length;
    const shortWins = shorts.filter(t => t.pnl > 0).length;
    const longPnl = longs.reduce((s, t) => s + (t.pnl || 0), 0);
    const longPnlDollar = longs.reduce((s, t) => s + (t.pnlTotal || t.pnlPoints || 0), 0);
    const shortPnl = shorts.reduce((s, t) => s + (t.pnl || 0), 0);
    const shortPnlDollar = shorts.reduce((s, t) => s + (t.pnlTotal || t.pnlPoints || 0), 0);

    // ── Avg Win / Avg Loss ──
    const winTrades = closed.filter(t => t.pnl > 0);
    const lossTrades = closed.filter(t => t.pnl <= 0);
    const avgWin = winTrades.length > 0 ? +(winTrades.reduce((s, t) => s + (t.pnl || 0), 0) / winTrades.length).toFixed(2) : 0;
    const avgWinDollar = winTrades.length > 0 ? +(winTrades.reduce((s, t) => s + (t.pnlTotal || t.pnlPoints || 0), 0) / winTrades.length).toFixed(2) : 0;
    const avgLoss = lossTrades.length > 0 ? +(lossTrades.reduce((s, t) => s + (t.pnl || 0), 0) / lossTrades.length).toFixed(2) : 0;
    const avgLossDollar = lossTrades.length > 0 ? +(lossTrades.reduce((s, t) => s + (t.pnlTotal || t.pnlPoints || 0), 0) / lossTrades.length).toFixed(2) : 0;

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
        var result = await xAlertMonitor.ingestAlert(ticker, source, text, uw, polygonClient);
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
        var result = await xAlertMonitor.ingestAlert(ticker, source, text, uw, polygonClient);
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
        var results = await xAlertMonitor.scanMarket(state, uw, polygonClient);
        scheduler.trackCalls(results.length * 7); // 5 UW + 2 Polygon calls per candidate
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
            if (tta) {
                var ttaMacd = tta.macd || {};
                context += 'Technicals: RSI=' + (tta.rsi || 'N/A');
                context += ' MACD={hist:' + (ttaMacd.histogram || 'N/A') + ',signal:' + (ttaMacd.signal || 'N/A') + '}';
                if (tta.ema) context += ' EMA9=' + (tta.ema.ema9 || 'N/A') + ' EMA20=' + (tta.ema.ema20 || 'N/A') + ' EMA50=' + (tta.ema.ema50 || 'N/A');
                context += ' Bias=' + (tta.bias || 'N/A') + ' EMAbias=' + (tta.emaBias || 'N/A');
                if (tta.atr) context += ' ATR=' + tta.atr;
                if (tta.pivots) context += ' Support=$' + (tta.pivots.s1 || 'N/A') + '/$' + (tta.pivots.s2 || 'N/A') + ' Resistance=$' + (tta.pivots.r1 || 'N/A') + '/$' + (tta.pivots.r2 || 'N/A') + ' Pivot=$' + (tta.pivots.pp || 'N/A');
                if (tta.bollingerBands) context += ' BB={upper:' + (tta.bollingerBands.upper || 'N/A') + ',lower:' + (tta.bollingerBands.lower || 'N/A') + ',pos:' + (tta.bollingerBands.position || 'N/A') + '}';
                if (tta.adx) context += ' ADX=' + (tta.adx.adx || 'N/A') + '(' + (tta.adx.trendStrength || '') + ' dir=' + (tta.adx.trendDirection || '') + ')';
                if (tta.fibonacci && tta.fibonacci.levels) context += ' Fib=' + JSON.stringify(tta.fibonacci.levels);
                if (tta.rsiDivergence && tta.rsiDivergence.length > 0) context += ' RSI_Div=' + tta.rsiDivergence.map(function (d) { return d.type; }).join(',');
                if (tta.patterns && tta.patterns.length > 0) context += ' Patterns=' + tta.patterns.map(function (p) { return p.name + '(' + p.direction + ')'; }).join(',');
                if (tta.macdSlope != null) context += ' MACDslope=' + tta.macdSlope;
                if (tta.rsiSlope != null) context += ' RSIslope=' + tta.rsiSlope;
                if (tta.swingPoints) context += ' SwingHigh=$' + (tta.swingPoints.swingHigh || 'N/A') + ' SwingLow=$' + (tta.swingPoints.swingLow || 'N/A');
                context += '\n';
            }
            var tsig = state.signalScores[ticker];
            if (tsig) context += 'Signal Score: ' + JSON.stringify({ direction: tsig.direction, confidence: tsig.confidence, signals: (tsig.signals || []).slice(0, 10) }) + '\n';
            var tear = state.earnings[ticker];
            if (tear) context += 'Earnings: ' + JSON.stringify(Array.isArray(tear) ? tear.slice(0, 2) : tear) + '\n';
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
            // Options flow data
            var tnp = state.netPremium[ticker];
            if (tnp) context += 'Net Premium: ' + JSON.stringify(Array.isArray(tnp) ? tnp.slice(-3) : tnp) + '\n';
            var toic = state.oiChange[ticker];
            if (toic) context += 'OI Change: ' + JSON.stringify(Array.isArray(toic) ? toic.slice(-3) : toic) + '\n';
            var tfps = state.flowPerStrike[ticker];
            if (tfps) context += 'Flow Per Strike (top 5): ' + JSON.stringify(Array.isArray(tfps) ? tfps.slice(0, 5) : tfps) + '\n';
            var tfpe = state.flowPerExpiry[ticker];
            if (tfpe) context += 'Flow Per Expiry: ' + JSON.stringify(Array.isArray(tfpe) ? tfpe.slice(0, 5) : tfpe) + '\n';
            var tgkf = state.greekFlow[ticker];
            if (tgkf) context += 'Greek Flow: ' + JSON.stringify(Array.isArray(tgkf) ? tgkf.slice(-3) : tgkf) + '\n';
            var tspx = state.spotExposures[ticker];
            if (tspx) context += 'Spot Exposures: ' + JSON.stringify(Array.isArray(tspx) ? tspx.slice(0, 5) : tspx) + '\n';
            // Volume & Short data
            var tsv = state.shortVolume[ticker];
            if (tsv) context += 'Short Volume: ' + JSON.stringify(Array.isArray(tsv) ? tsv.slice(-1) : tsv) + '\n';
            var tftd = state.failsToDeliver[ticker];
            if (tftd) context += 'FTDs: ' + JSON.stringify(Array.isArray(tftd) ? tftd.slice(-1) : tftd) + '\n';
            // Volatility
            var trv = state.realizedVol[ticker];
            if (trv) context += 'Realized Vol: ' + JSON.stringify(Array.isArray(trv) ? trv.slice(-1) : trv) + '\n';
            var tts = state.termStructure[ticker];
            if (tts) context += 'Vol Term Structure: ' + JSON.stringify(Array.isArray(tts) ? tts.slice(0, 5) : tts) + '\n';
            // Seasonality & Insider
            var tszn = state.seasonality[ticker];
            if (tszn) context += 'Seasonality: ' + JSON.stringify(Array.isArray(tszn) ? tszn.slice(0, 3) : tszn) + '\n';
            var tifl = state.insiderFlow[ticker];
            if (tifl) context += 'Insider Flow: ' + JSON.stringify(Array.isArray(tifl) ? tifl.slice(0, 3) : tifl) + '\n';
            // Risk & Sizing
            var terisk = state.earningsRisk[ticker];
            if (terisk) context += 'Earnings Risk: ' + JSON.stringify(terisk) + '\n';
            var tcorr = state.correlationRisk[ticker];
            if (tcorr) context += 'Correlation Risk: ' + JSON.stringify(tcorr) + '\n';
            var tkelly = state.kellySizing[ticker];
            if (tkelly) context += 'Kelly Sizing: ' + JSON.stringify(tkelly) + '\n';
            var tsent = state.sentiment[ticker];
            if (tsent) context += 'Sentiment: ' + JSON.stringify(tsent) + '\n';
            // Signal breakdown
            if (tsig && tsig.signals && tsig.signals.length > 0) {
                context += 'Active Signals: ' + tsig.signals.map(function (s) { return s.name + '(' + s.dir + ' w=' + s.weight + ')'; }).join(', ') + '\n';
            }
            // Multi-TF analysis
            var mtf = state.multiTF && state.multiTF[ticker];
            if (mtf) context += 'Multi-TF Analysis: ' + JSON.stringify(mtf) + '\n';
            // Trade setup
            var tSetup = state.tradeSetups[ticker];
            if (tSetup) context += 'Trade Setup: ' + tSetup.direction + ' Entry=$' + tSetup.entry + ' Stop=$' + tSetup.stop + ' T1=$' + tSetup.target1 + ' T2=$' + tSetup.target2 + ' Conf=' + tSetup.confidence + '% ML=' + (tSetup.mlConfidence || '--') + '% Horizon=' + (tSetup.horizon || '') + '\n';
            // Morning Brief
            var tbrief = state.morningBrief[ticker];
            if (tbrief) context += 'Morning Brief: ' + JSON.stringify(tbrief) + '\n';
            // Polygon TA
            var pTA = state.polygonTA && state.polygonTA[ticker];
            if (pTA) context += 'Polygon TA: ' + JSON.stringify(pTA) + '\n';
            // Phase 2 data
            var tNope = state.nope && state.nope[ticker];
            if (tNope) {
                var nVal = parseFloat(tNope.nope || tNope.value || tNope.nope_value || 0);
                context += 'NOPE: ' + nVal.toFixed(2) + ' (' + (nVal > 5 ? 'BULLISH hedging pressure' : nVal < -5 ? 'BEARISH hedging pressure' : 'NEUTRAL') + ')\n';
            }
            var tAnalyst = state.analystRatings && state.analystRatings[ticker];
            if (tAnalyst) {
                var ar = Array.isArray(tAnalyst) ? tAnalyst[0] : tAnalyst;
                if (ar) context += 'Analyst: ' + (ar.consensus || ar.rating || 'N/A') + ' target=$' + (ar.price_target || ar.avg_price_target || 'N/A') + ' analysts=' + (ar.analyst_count || ar.num_analysts || '?') + '\n';
            }
            var tInst = state.institutionActivity && state.institutionActivity[ticker];
            if (tInst) {
                var instArr = Array.isArray(tInst) ? tInst : [tInst];
                var instBuys = instArr.filter(function (x) { var t = (x.transaction_type || x.type || '').toUpperCase(); return t.includes('BUY') || t.includes('ACQUIRE'); }).length;
                var instSells = instArr.length - instBuys;
                context += 'Institutional Flow: ' + instBuys + ' buys / ' + instSells + ' sells (' + (instBuys > instSells ? 'ACCUMULATING' : instSells > instBuys ? 'DISTRIBUTING' : 'BALANCED') + ')\n';
            }
            var tFDA = (state.fdaCalendar || []).filter(function (f) { return (f.ticker || f.symbol || '').toUpperCase() === ticker.toUpperCase(); });
            if (tFDA.length > 0) {
                tFDA.forEach(function (f) {
                    context += 'FDA EVENT: ' + (f.event_type || f.type || 'FDA') + ' ' + (f.drug || f.drug_name || '') + ' on ' + (f.event_date || f.date || 'TBD') + '\n';
                });
            }
            var tMagnets = state.flowPerStrikeIntraday && state.flowPerStrikeIntraday[ticker];
            if (tMagnets) {
                var magArr = Array.isArray(tMagnets) ? tMagnets : (tMagnets.data || []);
                var topMag = magArr.slice().sort(function (a, b) { return parseFloat(b.volume || b.total_volume || 0) - parseFloat(a.volume || a.total_volume || 0); }).slice(0, 3);
                if (topMag.length > 0) context += 'Strike Magnets: ' + topMag.map(function (m) { return '$' + m.strike + '(' + (m.volume || m.total_volume || 0) + ' vol)'; }).join(', ') + '\n';
            }

            // Phase E-F: OI per strike (support/resistance from options positioning)
            var tOIS = state.oiPerStrike && state.oiPerStrike[ticker];
            if (tOIS && Array.isArray(tOIS)) {
                var topCallOI = tOIS.slice().sort(function (a, b) { return parseFloat(b.call_oi || b.call_open_interest || 0) - parseFloat(a.call_oi || a.call_open_interest || 0); }).slice(0, 3);
                var topPutOI = tOIS.slice().sort(function (a, b) { return parseFloat(b.put_oi || b.put_open_interest || 0) - parseFloat(a.put_oi || a.put_open_interest || 0); }).slice(0, 3);
                context += 'OI Per Strike — Top Call OI: ' + topCallOI.map(function (s) { return '$' + s.strike + '(' + (s.call_oi || s.call_open_interest || 0) + ')'; }).join(', ');
                context += ' | Top Put OI: ' + topPutOI.map(function (s) { return '$' + s.strike + '(' + (s.put_oi || s.put_open_interest || 0) + ')'; }).join(', ') + '\n';
            }
            // Phase E-F: OI per expiry
            var tOIE = state.oiPerExpiry && state.oiPerExpiry[ticker];
            if (tOIE) context += 'OI Per Expiry: ' + JSON.stringify(Array.isArray(tOIE) ? tOIE.slice(0, 5) : tOIE) + '\n';
            // Phase E-F: Expiry Breakdown (volume concentration)
            var tExpBk = state.expiryBreakdown && state.expiryBreakdown[ticker];
            if (tExpBk && Array.isArray(tExpBk)) {
                context += 'Expiry Breakdown: ' + tExpBk.slice(0, 5).map(function (e) {
                    return (e.expiry || e.expiration_date || '?') + ' call_vol=' + (e.call_volume || 0) + ' put_vol=' + (e.put_volume || 0);
                }).join(', ') + '\n';
            }
            // Phase E-F: Granular GEX by expiry+strike
            var tGEXgran = state.spotGEXByExpiryStrike && state.spotGEXByExpiryStrike[ticker];
            if (tGEXgran && Array.isArray(tGEXgran)) {
                var totalGEX = 0; var nearGEX = 0;
                var gxPrice = parseFloat((state.quotes[ticker] || {}).price || 0);
                tGEXgran.forEach(function (g) { totalGEX += parseFloat(g.gex || g.gamma_exposure || 0); });
                context += 'Granular GEX: total=' + totalGEX.toFixed(0) + ' (' + (totalGEX > 0 ? 'POSITIVE — pinning' : 'NEGATIVE — acceleration') + ') across ' + tGEXgran.length + ' strike-expiry combos\n';
            }
            // Phase E-F: GEX by expiry
            var tGEXexp = state.spotGEXByExpiry && state.spotGEXByExpiry[ticker];
            if (tGEXexp) context += 'GEX By Expiry: ' + JSON.stringify(Array.isArray(tGEXexp) ? tGEXexp.slice(0, 5) : tGEXexp) + '\n';
            // Phase E-F: Greek flow by expiry
            var tGFexp = state.greekFlowByExpiry && state.greekFlowByExpiry[ticker];
            if (tGFexp) context += 'Greek Flow By Expiry: ' + JSON.stringify(Array.isArray(tGFexp) ? tGFexp.slice(0, 5) : tGFexp) + '\n';
            // Phase E-F: Institutional Ownership
            var tOwn = state.tickerOwnership && state.tickerOwnership[ticker];
            if (tOwn && Array.isArray(tOwn)) {
                var buyers = 0; var sellers = 0;
                tOwn.slice(0, 10).forEach(function (h) { var chg = parseFloat(h.change || h.shares_change || 0); if (chg > 0) buyers++; if (chg < 0) sellers++; });
                context += 'Institutional Ownership: ' + tOwn.length + ' holders — top 10: ' + buyers + ' buying, ' + sellers + ' selling\n';
                context += 'Top Holders: ' + tOwn.slice(0, 5).map(function (h) { return (h.name || h.institution || '?') + ' (' + (h.shares || h.current_shares || 0) + ' shares, chg=' + (h.change || h.shares_change || 0) + ')'; }).join(', ') + '\n';
            }
            // Phase E-F: Seasonality year-month
            var tSznYM = state.seasonalityYearMonth && state.seasonalityYearMonth[ticker];
            if (tSznYM) context += 'Seasonality Year-Month: ' + JSON.stringify(Array.isArray(tSznYM) ? tSznYM.slice(0, 3) : tSznYM) + '\n';
        }

        // Earnings calendar with beat/miss analysis
        if (state.earningsToday) {
            var todayDate = new Date().toISOString().slice(0, 10);
            var enriched = state.earningsToday.enriched || {};
            var reactions = state.earningsToday.reactions || {};

            // Helper to format a single earnings entry with enrichment
            var formatEarning = function (e) {
                var tkr = e.ticker || e.symbol || '?';
                var info = tkr;
                if (e.name || e.company) info += ' (' + (e.name || e.company) + ')';
                // Add enriched beat/miss data if available
                var enr = enriched[tkr];
                if (enr) {
                    if (enr.beat) info += ' [' + enr.beat + ']';
                    if (enr.eps_actual != null) info += ' EPS_actual=$' + enr.eps_actual;
                    if (enr.eps_estimate != null) info += ' est=$' + enr.eps_estimate;
                    if (enr.surprise_pct) info += ' surprise=' + enr.surprise_pct;
                    if (enr.revenue_actual != null) info += ' rev=$' + (parseFloat(enr.revenue_actual) / 1e9).toFixed(2) + 'B';
                    if (enr.revenue_estimate != null) info += ' rev_est=$' + (parseFloat(enr.revenue_estimate) / 1e9).toFixed(2) + 'B';
                    if (enr.guidance) info += ' guidance=' + enr.guidance;
                }
                // Add price reaction
                var rx = reactions[tkr];
                if (rx) {
                    if (rx.change_pct != null) info += ' day_chg=' + rx.change_pct + '%';
                    if (rx.afterhours_change != null) info += ' AH_chg=' + rx.afterhours_change + '%';
                    else if (rx.afterhours_price && rx.price) {
                        var ahPct = ((parseFloat(rx.afterhours_price) - parseFloat(rx.price)) / parseFloat(rx.price) * 100).toFixed(1);
                        info += ' AH_move=' + ahPct + '%';
                    }
                }
                return info;
            };

            var preList = (state.earningsToday.premarket || []).slice(0, 25);
            var postList = (state.earningsToday.afterhours || []).slice(0, 25);

            if (preList.length > 0 || postList.length > 0) {
                context += '\n--- EARNINGS TODAY (' + todayDate + ') ---\n';
                if (preList.length > 0) {
                    context += 'Pre-market (' + (state.earningsToday.premarket || []).length + ' total):\n';
                    preList.forEach(function (e) { context += '  ' + formatEarning(e) + '\n'; });
                }
                if (postList.length > 0) {
                    context += 'After-hours (' + (state.earningsToday.afterhours || []).length + ' total):\n';
                    postList.forEach(function (e) { context += '  ' + formatEarning(e) + '\n'; });
                }
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

        // Options flow summary (expanded)
        var flowSummary = (state.optionsFlow || []).slice(0, 20).map(function (f) {
            return (f.ticker || f.symbol || '?') + ' ' + (f.put_call || f.option_type || '') + ' $' + ((parseFloat(f.premium || 0) / 1000).toFixed(0)) + 'K' + (f.trade_type ? ' ' + f.trade_type : '');
        }).join(', ');
        if (flowSummary) context += '\n--- RECENT OPTIONS FLOW (' + (state.optionsFlow || []).length + ' alerts) ---\n' + flowSummary + '\n';

        // Congressional trades (expanded)
        var congRecent = (state.congressTrades || []).slice(0, 10).map(function (c) {
            return (c.ticker || '?') + ' ' + (c.name || c.politician || '') + ' ' + (c.txn_type || c.transaction_type || '') + ' ' + (c.amounts || c.amount || '');
        }).join('; ');
        if (congRecent) context += '\n--- CONGRESSIONAL TRADES ---\n' + congRecent + '\n';
        if (state.congressLateReports && state.congressLateReports.length > 0) {
            context += 'Late Reports: ' + state.congressLateReports.slice(0, 5).map(function (r) { return (r.ticker || '?') + ' ' + (r.name || ''); }).join(', ') + '\n';
        }

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

        // Technical Analysis for each watchlist ticker (use correct nested paths)
        var hasTechnicals = false;
        watchTickers.forEach(function (tkr) {
            var ta = state.technicals[tkr];
            if (ta) {
                if (!hasTechnicals) { context += '\n--- TECHNICAL ANALYSIS ---\n'; hasTechnicals = true; }
                context += tkr + ':';
                if (ta.rsi != null) context += ' RSI=' + (typeof ta.rsi === 'number' ? ta.rsi.toFixed(1) : ta.rsi);
                if (ta.ema && ta.ema.ema9) context += ' EMA9=$' + ta.ema.ema9;
                if (ta.ema && ta.ema.ema20) context += ' EMA20=$' + ta.ema.ema20;
                if (ta.ema && ta.ema.ema50) context += ' EMA50=$' + ta.ema.ema50;
                if (ta.emaBias) context += ' EMAbias=' + ta.emaBias;
                if (ta.atr != null) context += ' ATR=$' + (typeof ta.atr === 'number' ? ta.atr.toFixed(2) : ta.atr);
                if (ta.pivots) {
                    context += ' Support=$' + (ta.pivots.s1 || 'N/A') + '/$' + (ta.pivots.s2 || 'N/A');
                    context += ' Resistance=$' + (ta.pivots.r1 || 'N/A') + '/$' + (ta.pivots.r2 || 'N/A');
                    context += ' Pivot=$' + (ta.pivots.pp || 'N/A');
                }
                if (ta.macd && ta.macd.histogram != null) context += ' MACD_Hist=' + (ta.macd.histogram > 0 ? '+' : '') + ta.macd.histogram;
                if (ta.bollingerBands) context += ' BB=' + (ta.bollingerBands.lower || '') + '-' + (ta.bollingerBands.upper || '') + '(pos:' + (ta.bollingerBands.position || '') + ')';
                if (ta.adx && ta.adx.adx != null) context += ' ADX=' + ta.adx.adx + '(' + (ta.adx.trendStrength || '') + ')';
                if (ta.fibonacci && ta.fibonacci.levels) context += ' Fib=' + JSON.stringify(ta.fibonacci.levels);
                if (ta.rsiDivergence && ta.rsiDivergence.length > 0) context += ' RSI_Div=' + ta.rsiDivergence.map(function (d) { return d.type + '(' + d.direction + ')'; }).join(',');
                if (ta.patterns && ta.patterns.length > 0) context += ' Patterns=' + ta.patterns.map(function (p) { return p.name + '(' + p.direction + ')'; }).join(',');
                context += '\n';
            }
        });

        // Trade Setups (entry, stop, targets)
        var setupKeys = Object.keys(state.tradeSetups || {});
        if (setupKeys.length > 0) {
            context += '\n--- ACTIVE TRADE SETUPS ---\n';
            setupKeys.forEach(function (tkr) {
                var s = state.tradeSetups[tkr];
                if (s) context += tkr + ': ' + s.direction + ' Entry=$' + s.entry + ' Stop=$' + s.stop + ' T1=$' + s.target1 + ' T2=$' + s.target2 + ' Conf=' + s.confidence + '% ML=' + (s.mlConfidence || '--') + '% ' + (s.horizon || '') + '\n';
            });
        }

        // ── MARKET-WIDE INTELLIGENCE (previously missing) ──

        // Market Tide (overall market bullish/bearish flow)
        if (state.marketTide) {
            context += '\n--- MARKET TIDE ---\n' + JSON.stringify(state.marketTide) + '\n';
        }

        // Market Spike (VIX/volatility events)
        if (state.marketSpike) {
            context += '\n--- MARKET SPIKE (VIX) ---\n' + JSON.stringify(state.marketSpike) + '\n';
        }

        // Dark Pool Recent (market-wide large block prints)
        if (state.darkPoolRecent && state.darkPoolRecent.length > 0) {
            context += '\n--- DARK POOL RECENT (market-wide) ---\n';
            state.darkPoolRecent.slice(0, 15).forEach(function (d) {
                context += (d.ticker || d.symbol || '?') + ': $' + ((parseFloat(d.notional_value || d.premium || 0) / 1000000).toFixed(1)) + 'M vol=' + (d.volume || d.size || 0) + '\n';
            });
        }

        // Top Net Premium Impact (biggest options premium movers)
        if (state.topNetImpact && state.topNetImpact.length > 0) {
            context += '\n--- TOP NET PREMIUM IMPACT ---\n';
            state.topNetImpact.slice(0, 10).forEach(function (t) {
                context += (t.ticker || t.symbol || '?') + ': net_premium=$' + ((parseFloat(t.net_premium || t.net_call_premium || 0) / 1000).toFixed(0)) + 'K\n';
            });
        }

        // News Headlines
        if (state.news && state.news.length > 0) {
            context += '\n--- NEWS HEADLINES ---\n';
            state.news.slice(0, 15).forEach(function (n) {
                context += (n.tickers ? '[' + (Array.isArray(n.tickers) ? n.tickers.join(',') : n.tickers) + '] ' : '') + (n.headline || n.title || '') + '\n';
            });
        }

        // Scanner Results
        if (state.scannerResults && (Array.isArray(state.scannerResults) ? state.scannerResults.length > 0 : Object.keys(state.scannerResults).length > 0)) {
            context += '\n--- SCANNER RESULTS ---\n' + JSON.stringify(state.scannerResults, null, 1) + '\n';
        }

        // Hot Opportunities
        if (state.hotOpportunities && state.hotOpportunities.length > 0) {
            context += '\n--- HOT OPPORTUNITIES ---\n';
            state.hotOpportunities.slice(0, 10).forEach(function (h) {
                context += (h.ticker || '?') + ': ' + (h.reason || h.type || '') + ' conf=' + (h.confidence || 0) + '%\n';
            });
        }

        // X/Twitter Alerts
        if (state.xAlerts && state.xAlerts.length > 0) {
            context += '\n--- X/TWITTER ALERTS ---\n';
            state.xAlerts.slice(0, 10).forEach(function (x) {
                context += (x.ticker || '?') + ': ' + (x.text || x.message || x.content || '').substring(0, 120) + '\n';
            });
        }

        // Trading Halts
        if (state.halts && state.halts.length > 0) {
            context += '\n--- TRADING HALTS ---\n';
            state.halts.slice(0, 10).forEach(function (h) {
                context += (h.ticker || h.symbol || '?') + ': ' + (h.reason || h.type || 'HALTED') + ' ' + (h.halt_date || h.date || '') + '\n';
            });
        }

        // Market Insider Buy/Sells
        if (state.marketInsiderBuySells) {
            context += '\n--- MARKET INSIDER BUY/SELLS ---\n' + JSON.stringify(state.marketInsiderBuySells).substring(0, 500) + '\n';
        }

        // Insider Transactions (market-wide)
        if (state.insiderTransactions && state.insiderTransactions.length > 0) {
            context += '\n--- INSIDER TRANSACTIONS ---\n';
            state.insiderTransactions.slice(0, 10).forEach(function (tx) {
                context += (tx.ticker || tx.symbol || '?') + ' ' + (tx.insider_name || tx.name || '') + ' ' + (tx.transaction_type || tx.acquisition_or_disposition || '') + ' ' + (tx.shares || tx.amount || '') + ' shares\n';
            });
        }

        // Total Options Volume
        if (state.totalOptionsVol) {
            context += '\n--- TOTAL OPTIONS VOLUME ---\n' + JSON.stringify(state.totalOptionsVol).substring(0, 300) + '\n';
        }

        // Market OI Change
        if (state.marketOIChange) {
            context += '\n--- MARKET OI CHANGE ---\n' + JSON.stringify(state.marketOIChange).substring(0, 300) + '\n';
        }

        // Morning Brief (market-wide summary)
        if (state.morningBrief && Object.keys(state.morningBrief).length > 0) {
            context += '\n--- MORNING BRIEF ---\n';
            Object.keys(state.morningBrief).slice(0, 10).forEach(function (tkr) {
                var mb = state.morningBrief[tkr];
                if (mb) context += tkr + ': ' + (mb.direction || '?') + ' ' + (mb.confidence || 0) + '% bull=' + (mb.bull || 0) + ' bear=' + (mb.bear || 0) + '\n';
            });
        }

        // Journal Stats
        if (state.journalStats && Object.keys(state.journalStats).length > 0) {
            context += '\n--- JOURNAL STATS ---\n' + JSON.stringify(state.journalStats) + '\n';
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
        // Ensure chatHistory is a Map (can get corrupted if state was serialized)
        if (!(state.chatHistory instanceof Map)) state.chatHistory = new Map();
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

        // Build Gemini request — upgraded to Gemini 3 Flash
        var genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        var model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        var systemPrompt = 'You are an expert AI trading analyst — the oracle of a live trading command centre. '
            + 'You have access to ALL real-time intelligence:\n'
            + '- QUOTES: price, change%, volume, prev close, earnings dates\n'
            + '- TECHNICALS: RSI, EMA9/20/50, MACD histogram/signal/slope, ATR, Bollinger Bands, ADX trend strength, '
            + 'Fibonacci levels, RSI divergences, candlestick patterns, swing points, pivot support/resistance (S1/S2/R1/R2/PP)\n'
            + '- OPTIONS: flow alerts (sweeps, blocks), net premium, flow per strike & expiry, OI change, max pain, IV rank, '
            + 'GEX, Greek flow, spot exposures, vol term structure, realized vol\n'
            + '- DARK POOL: per-ticker levels + market-wide recent block prints\n'
            + '- MARKET WIDE: market tide (bull/bear flow), VIX spike, sector tides, ETF tides, total options volume, market OI change\n'
            + '- SMART MONEY: congressional trades, insider transactions & flow, short interest, short volume, FTDs\n'
            + '- NEWS & ALERTS: headlines, scanner results, hot opportunities, X/Twitter alerts, trading halts\n'
            + '- EARNINGS: today premarket/afterhours calendar + per-ticker upcoming dates\n'
            + '- PAPER TRADING: open positions, closed P&L, win rate, journal stats\n'
            + '- ANALYSIS: signal engine scores (direction, confidence, active signals), trade setups (entry/stop/targets), '
            + 'morning brief, multi-timeframe analysis, seasonality, earnings risk, correlation risk, Kelly sizing, sentiment\n'
            + '- REAL-TIME: Polygon tick data (buy/sell volume, VWAP, flow imbalance, large blocks)\n'
            + '- OPTIONS STRUCTURE: OI per strike (call/put walls = S/R), OI per expiry, expiry breakdown (volume concentration), '
            + 'granular GEX by expiry+strike (pinning vs acceleration), Greek flow by expiry\n'
            + '- OWNERSHIP: institutional holders (accumulating/distributing), top holders with share changes\n'
            + '- SEASONALITY: year-month granular historical performance (avg return, win rate per month)\n\n'
            + 'RULES:\n'
            + '1. Always reference SPECIFIC numbers from the data provided. Quote exact prices, levels, percentages.\n'
            + '2. For support/resistance: use pivot levels S1/S2/R1/R2, EMA9/20/50, Bollinger Bands, Fibonacci, and VWAP.\n'
            + '3. For trade ideas: include specific entry, stop, and target prices using the trade setup if available.\n'
            + '4. For dark pool: analyze notional value significance and direction.\n'
            + '5. For flow analysis: combine options flow + dark pool + tick imbalance + net premium for conviction.\n'
            + '6. For earnings questions: check EARNINGS TODAY section first for today\'s premarket/afterhours list.\n'
            + '7. Use bullet points. Be direct and actionable like a prop desk analyst.\n'
            + '8. If data is not in the context below, say so and explain what would be needed.\n\n'
            + context + historyContext;

        var userContent = slashResult ? slashResult + '\nUser question: ' + userMsg : 'User question: ' + userMsg;

        // Retry with exponential backoff for rate limits (429)
        var reply = null;
        var maxRetries = 3;
        for (var attempt = 0; attempt < maxRetries; attempt++) {
            try {
                var result = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContent }] }],
                    generationConfig: { maxOutputTokens: 2500, temperature: 0.3 }
                });
                reply = result.response.text();
                break; // Success — exit retry loop
            } catch (retryErr) {
                var is429 = retryErr.message && (retryErr.message.includes('429') || retryErr.message.includes('Resource exhausted'));
                if (is429 && attempt < maxRetries - 1) {
                    var waitMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
                    console.log('Chat: Gemini rate limited, retrying in ' + (waitMs / 1000) + 's (attempt ' + (attempt + 1) + '/' + maxRetries + ')');
                    await new Promise(function (resolve) { setTimeout(resolve, waitMs); });
                } else {
                    throw retryErr; // Non-429 error or final attempt — let outer catch handle it
                }
            }
        }

        if (!reply) reply = 'Rate limited by Gemini API. Please wait a moment and try again.';

        // Store assistant reply in history
        history.push({ role: 'assistant', text: reply });
        if (history.length > 20) history.splice(0, history.length - 20);
        res.json({ reply: reply });
    } catch (e) {
        console.error('Chat error:', e.message);
        var userError = e.message && e.message.includes('429')
            ? '⏳ Gemini API is rate limited. Please wait 30 seconds and try again.'
            : 'Error: ' + e.message;
        res.json({ reply: userError });
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
// (Dead /api/chat duplicate removed — first handler at line 789 is active)

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

    // D1/D2: Connect UW WebSocket for lit/off-lit trade streams
    if (process.env.UW_API_KEY) {
        uwWS.connect(TICKERS);
        console.log('🐋 UW WebSocket: connecting for lit/off-lit trades');
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

            // Send Telegram alert for each runner
            try {
                var runnerMsg = '\ud83d\ude80 *Volatility Runner: ' + ticker + '*\n';
                runnerMsg += 'Gap: +' + changePct.toFixed(1) + '%\n';
                runnerMsg += 'Price: $' + price.toFixed(2) + '\n';
                runnerMsg += 'Volume: ' + (volume / 1000).toFixed(0) + 'K';
                if (relVol > 0) runnerMsg += ' (' + relVol.toFixed(1) + 'x avg)';
                runnerMsg += '\n';
                runnerMsg += 'MCap: $' + (mktCap / 1000000).toFixed(1) + 'M\n';
                runnerMsg += 'Dollar Vol: $' + (dollarVol / 1000000).toFixed(1) + 'M';
                notifier._sendTelegram(runnerMsg);
            } catch (ne) { /* optional */ }
        }

        // Full signal scoring for top 2 volatility runners
        if (newRunners > 0) {
            console.log('\ud83d\ude80 Volatility Scanner: ' + newRunners + ' new runners found (' + Object.keys(state.volatilityRunners).length + ' total tracked)');
            var runnerTickers = Object.keys(state.volatilityRunners).slice(-newRunners);
            for (var ri = 0; ri < Math.min(runnerTickers.length, 2); ri++) {
                try {
                    var runnerScore = await scoreDiscoveredTicker(runnerTickers[ri], 'VolatilityRunner');
                    var runnerData = state.volatilityRunners[runnerTickers[ri]] || {};
                    trackDiscovery(runnerTickers[ri], 'VolatilityRunner', runnerScore, {
                        price: runnerScore ? runnerScore.price : 0,
                        gapPct: runnerData.changePct || 0,
                        volume: runnerData.volume || 0,
                        rVol: runnerData.relVol || 0
                    });
                    if (runnerScore && runnerScore.confidence >= 55) {
                        var scoreMsg = '\ud83c\udfaf *Runner Signal: ' + runnerTickers[ri] + '*\n';
                        scoreMsg += (runnerScore.direction === 'BULLISH' ? '\ud83d\udfe2' : '\ud83d\udd34') + ' ' + runnerScore.direction + ' — ' + runnerScore.confidence + '% confidence\n';
                        if (runnerScore.mlConfidence) scoreMsg += 'ML Score: ' + runnerScore.mlConfidence + '%\n';
                        scoreMsg += 'Signals: ' + runnerScore.signals.slice(0, 5).map(function (s) { return s.name; }).join(', ');
                        notifier._sendTelegram(scoreMsg);
                    }
                } catch (rsErr) { /* optional */ }
            }
        }
    } catch (e) {
        console.error('Volatility scanner error:', e.message);
    }
}

// ── Score a discovered (non-watchlist) ticker: on-demand full signal scoring ──
// Fetches UW data fresh, runs multi-TF, pipes through signal engine
// Used by: scanner discoveries, volatility runners, halt resumes
async function scoreDiscoveredTicker(ticker, source) {
    try {
        var t = ticker.toUpperCase();
        console.log('🎯 Full scoring: ' + t + ' (source: ' + (source || 'discovery') + ')');

        // 1. Fetch UW data on-demand (flow, dark pool, GEX, IV, SI)
        var uwFlow = [], uwDP = [], uwGex = [], uwIV = null, uwSI = null, uwQuote = {};
        try {
            var results = await Promise.all([
                uw.getFlowByTicker(t).catch(function () { return null; }),
                uw.getDarkPoolData(t).catch(function () { return null; }),
                uw.getGEXByTicker(t).catch(function () { return null; }),
                uw.getIVRank(t).catch(function () { return null; }),
                uw.getShortInterest(t).catch(function () { return null; }),
                uw.getStockQuote(t).catch(function () { return null; })
            ]);
            uwFlow = results[0]?.data || [];
            uwDP = results[1]?.data || [];
            uwGex = results[2]?.data || [];
            uwIV = results[3]?.data || null;
            uwSI = results[4]?.data || null;
            uwQuote = results[5]?.data || {};
        } catch (e) { /* partial data is fine */ }

        // 2. Get Polygon snapshot for price/volume
        var snap = null;
        try {
            snap = await polygonClient.getTickerSnapshot(t);
        } catch (e) { /* optional */ }

        var price = 0, volume = 0;
        if (snap) {
            price = snap.lastTrade ? snap.lastTrade.p : (snap.day ? snap.day.c : 0);
            volume = snap.day ? snap.day.v : 0;
        }
        if (!price && uwQuote) price = parseFloat(uwQuote.last || uwQuote.price || 0);

        // 3. Run multi-TF analysis
        var mtfData = null;
        var isMarketSession = ['OPEN_RUSH', 'POWER_OPEN', 'PRE_MARKET', 'MIDDAY', 'POWER_HOUR'].includes(state.session);
        if (isMarketSession) {
            try {
                var siPct = 0;
                if (uwSI) {
                    var siArr = Array.isArray(uwSI) ? uwSI : [uwSI];
                    siPct = parseFloat((siArr[siArr.length - 1] || {}).si_float_returned || 0);
                }
                mtfData = await multiTFAnalyzer.analyze(t, siPct);
            } catch (e) { /* optional */ }
        }

        // 4. Build TA from Polygon candles (daily)
        var ta = {};
        try {
            var fromDate = new Date();
            fromDate.setDate(fromDate.getDate() - 60);
            var candles = await polygonClient.getAggregates(t, 1, 'day', fromDate.toISOString().split('T')[0], new Date().toISOString().split('T')[0]);
            if (candles && candles.length >= 30) {
                var TechnicalAnalysis = require('./src/technical');
                ta = TechnicalAnalysis.analyze(candles) || {};
            }
        } catch (e) { /* optional */ }

        // 5. Assemble data object (same shape as scoreTickerSignals)
        var data = {
            technicals: ta,
            flow: uwFlow,
            darkPool: uwDP,
            gex: uwGex,
            ivRank: uwIV,
            shortInterest: uwSI,
            insider: [],
            congress: [],
            congressTrader: state.congressTrader || null,
            congressLateReports: state.congressLateReports || null,
            quote: { price: price, last: price, volume: volume, ...(uwQuote || {}) },
            regime: state.marketRegime,
            sentiment: null,
            multiTF: mtfData,
            volatilityRunner: state.volatilityRunners[t] || null,
            tickData: polygonClient.getTickSummary(t) || null,
            polygonTA: null,
            polygonSnapshot: polygonClient.getSnapshotData(t) || null,
            polygonMinuteBars: polygonClient.getMinuteBars(t) || [],
            // Phase 3 GAP data — ensure discovered tickers get full signal treatment
            maxPain: state.maxPain[t] || null,
            oiChange: state.oiChange[t] || null,
            greeks: state.greeks[t] || null,
            stockState: state.stockState[t] || null,
            earnings: state.earnings[t] || null,
            etfFlows: state.etfFlows || {},
            // Phase 2 data available from state
            nope: state.nope[t] || null,
            sectorTide: state.sectorTide || {},
            etfTide: state.etfTide || {},
            economicCalendar: state.economicCalendar || [],
            fdaCalendar: state.fdaCalendar || [],
            // Phase C data
            financials: state.financials ? state.financials[t] : null,
            relatedCompanies: state.relatedCompanies ? state.relatedCompanies[t] : null,
            splits: state.splits ? state.splits[t] : null,
            dividends: state.dividends ? state.dividends[t] : null,
            marketHolidays: state.marketHolidays || [],
            // Phase E data
            oiPerStrike: (state.oiPerStrike || {})[t] || null,
            oiPerExpiry: (state.oiPerExpiry || {})[t] || null,
            atmChains: (state.atmChains || {})[t] || null,
            stockPriceLevels: (state.stockPriceLevels || {})[t] || null,
            stockVolumePriceLevels: (state.stockVolumePriceLevels || {})[t] || null,
            // Phase F data
            expiryBreakdown: (state.expiryBreakdown || {})[t] || null,
            spotGEXByExpiryStrike: (state.spotGEXByExpiryStrike || {})[t] || null,
            tickerOwnership: (state.tickerOwnership || {})[t] || null,
            politicianHolders: (state.politicianHolders || {})[t] || null,
            seasonalityYearMonth: (state.seasonalityYearMonth || {})[t] || null,
            // Tier 2 data
            ivSkew: (state.ivSkew || {})[t] || null,
            volStats: (state.volStats || {})[t] || null,
            litFlow: (state.litFlow || {})[t] || null,
            marketCorrelations: state.marketCorrelations || null
        };

        // Fetch Polygon TA indicators
        try {
            if (process.env.POLYGON_API_KEY) {
                data.polygonTA = await polygonClient.getAllIndicators(t);
            }
        } catch (e) { /* optional */ }

        // 6. Score through signal engine
        var signalResult = signalEngine.score(t, data, state.session);

        // 7. ML ensemble
        var isSwingSession = ['OVERNIGHT', 'AFTER_HOURS'].includes(state.session);
        var mlTimeframe = isSwingSession ? 'swing' : 'dayTrade';
        var ensemble = mlCalibrator.ensemble(signalResult.confidence, signalResult.features, mlTimeframe);
        signalResult.technicalConfidence = signalResult.confidence;
        signalResult.mlConfidence = ensemble.mlConfidence || null;
        signalResult.blendedConfidence = ensemble.confidence;
        signalResult.ensemble = ensemble;
        signalResult.price = price;
        signalResult.source = source || 'discovery';

        console.log('✅ Full score: ' + t + ' → ' + signalResult.direction + ' ' + signalResult.confidence +
            '% (signals: ' + signalResult.signals.length + ', ML: ' + (ensemble.mlConfidence || 'N/A') + '%)');

        // Auto-subscribe to Polygon WebSocket for real-time data
        subscribeDiscoveredTicker(t);

        return signalResult;
    } catch (e) {
        console.error('scoreDiscoveredTicker error for ' + ticker + ':', e.message);
        return null;
    }
}

// ── Discovery WebSocket Subscription Management ──────────
// Track discovered tickers with expiry for auto-cleanup
state.discoverySubscriptions = {};  // { ticker: { subscribedAt, expiresAt, source } }
var DISCOVERY_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

function subscribeDiscoveredTicker(ticker) {
    var t = ticker.toUpperCase();

    // Skip if already on watchlist (already subscribed)
    if ((state.tickers || []).includes(t)) return;

    // Skip if already subscribed as discovery
    if (state.discoverySubscriptions[t]) {
        // Extend expiry
        state.discoverySubscriptions[t].expiresAt = Date.now() + DISCOVERY_EXPIRY_MS;
        return;
    }

    state.discoverySubscriptions[t] = {
        subscribedAt: Date.now(),
        expiresAt: Date.now() + DISCOVERY_EXPIRY_MS,
        source: 'discovery'
    };

    // Update Polygon WS subscriptions (watchlist + discoveries)
    var allSubs = (state.tickers || []).concat(Object.keys(state.discoverySubscriptions));
    var unique = allSubs.filter(function (t, i) { return allSubs.indexOf(t) === i; });
    polygonClient.updateSubscriptions(unique);

    console.log('📡 Discovery subscribed to WS: ' + t + ' (expires in 2h, total: ' + unique.length + ')');
}

function cleanupExpiredDiscoveries() {
    var now = Date.now();
    var expired = [];
    Object.keys(state.discoverySubscriptions).forEach(function (t) {
        if (state.discoverySubscriptions[t].expiresAt < now) {
            expired.push(t);
            delete state.discoverySubscriptions[t];
        }
    });

    if (expired.length > 0) {
        // Update Polygon WS subscriptions (remove expired)
        var allSubs = (state.tickers || []).concat(Object.keys(state.discoverySubscriptions));
        var unique = allSubs.filter(function (t, i) { return allSubs.indexOf(t) === i; });
        polygonClient.updateSubscriptions(unique);
        console.log('📡 Discovery cleanup: removed ' + expired.join(', ') + ' (total: ' + unique.length + ')');
    }
}

// Run cleanup every 15 minutes
setInterval(cleanupExpiredDiscoveries, 15 * 60 * 1000);

// ── F1: Smart Price Target Helper (ATR + Fib + Strike Magnets) ──
// Module-scoped so both trackDiscovery and scoreTickerSignals can access it
function snapToStructure(price, atrTarget, atrStop, dir, ticker) {
    // Collect structural levels from Fib + flow-per-strike
    var levels = [];

    // Fibonacci levels
    var ta = state.technicals[ticker] || {};
    if (ta.fibonacci && ta.fibonacci.levels) {
        var fibLevels = ta.fibonacci.levels;
        for (var key in fibLevels) {
            if (fibLevels.hasOwnProperty(key)) {
                var lv = parseFloat(fibLevels[key]);
                if (lv > 0) levels.push({ price: lv, source: 'fib_' + key });
            }
        }
    }
    // Pivot levels (S1/S2/R1/R2/PP)
    if (ta.pivots) {
        ['s1', 's2', 'r1', 'r2', 'pp'].forEach(function (k) {
            if (ta.pivots[k]) levels.push({ price: parseFloat(ta.pivots[k]), source: 'pivot_' + k });
        });
    }

    // High-volume strikes from flow-per-strike (daily)
    var fps = state.flowPerStrike[ticker];
    if (fps) {
        var fpsArr = Array.isArray(fps) ? fps : (fps.data || []);
        // Sort by volume, take top 10 most significant strikes
        fpsArr.slice().sort(function (a, b) {
            return parseFloat(b.volume || b.total_volume || 0) - parseFloat(a.volume || a.total_volume || 0);
        }).slice(0, 10).forEach(function (s) {
            var strike = parseFloat(s.strike || s.strike_price || 0);
            if (strike > 0) levels.push({ price: strike, source: 'strike_daily' });
        });
    }

    // Intraday strike magnets
    var isf = state.flowPerStrikeIntraday && state.flowPerStrikeIntraday[ticker];
    if (isf) {
        var isfArr = Array.isArray(isf) ? isf : (isf.data || []);
        isfArr.slice().sort(function (a, b) {
            return parseFloat(b.volume || b.total_volume || 0) - parseFloat(a.volume || a.total_volume || 0);
        }).slice(0, 10).forEach(function (s) {
            var strike = parseFloat(s.strike || s.strike_price || 0);
            if (strike > 0) levels.push({ price: strike, source: 'strike_intraday' });
        });
    }

    if (levels.length === 0) {
        return { target1: atrTarget, stop: atrStop, snapped: false };
    }

    // Snap target: find nearest structural level in the direction of the target
    // within 30% of ATR distance (don't snap too far from ATR target)
    var atrDist = Math.abs(atrTarget - price);
    var snapRange = atrDist * 0.3; // snap within 30% of ATR range

    var bestTarget = atrTarget;
    var bestTargetDist = Infinity;
    var targetSource = null;

    levels.forEach(function (lv) {
        if (dir === 'LONG' && lv.price > price && lv.price <= atrTarget + snapRange) {
            var dist = Math.abs(lv.price - atrTarget);
            if (dist < bestTargetDist) { bestTargetDist = dist; bestTarget = lv.price; targetSource = lv.source; }
        } else if (dir === 'SHORT' && lv.price < price && lv.price >= atrTarget - snapRange) {
            var dist2 = Math.abs(lv.price - atrTarget);
            if (dist2 < bestTargetDist) { bestTargetDist = dist2; bestTarget = lv.price; targetSource = lv.source; }
        }
    });

    // Snap stop: find nearest support (LONG) or resistance (SHORT) level
    // that's beyond the ATR stop but within 50% extra range (prefer structural stops)
    var stopDist = Math.abs(atrStop - price);
    var stopSnapRange = stopDist * 0.5;
    var bestStop = atrStop;
    var bestStopDist = Infinity;
    var stopSource = null;

    levels.forEach(function (lv) {
        if (dir === 'LONG' && lv.price < price && lv.price >= atrStop - stopSnapRange && lv.price <= atrStop + stopSnapRange) {
            var dist = Math.abs(lv.price - atrStop);
            if (dist < bestStopDist) { bestStopDist = dist; bestStop = lv.price; stopSource = lv.source; }
        } else if (dir === 'SHORT' && lv.price > price && lv.price >= atrStop - stopSnapRange && lv.price <= atrStop + stopSnapRange) {
            var dist2 = Math.abs(lv.price - atrStop);
            if (dist2 < bestStopDist) { bestStopDist = dist2; bestStop = lv.price; stopSource = lv.source; }
        }
    });

    return {
        target1: +bestTarget.toFixed(2),
        stop: +bestStop.toFixed(2),
        snapped: targetSource !== null || stopSource !== null,
        targetSource: targetSource,
        stopSource: stopSource
    };
}

// ── Discovery Tracking + Auto Trade Setup ────────────────
// Records discoveries for dashboard display and performance tracking
// Auto-generates trade setups for high-confidence discoveries (≥70%)
function trackDiscovery(ticker, source, signalResult, meta) {
    var t = ticker.toUpperCase();
    var now = Date.now();

    // Build discovery object for dashboard
    var discovery = {
        ticker: t,
        source: source,
        discoveredAt: now,
        discoveredAtISO: new Date(now).toISOString(),
        price: (signalResult && signalResult.price) || (meta && meta.price) || 0,
        direction: signalResult ? signalResult.direction : 'NEUTRAL',
        confidence: signalResult ? signalResult.confidence : 0,
        mlConfidence: signalResult ? signalResult.mlConfidence : null,
        topSignals: signalResult ? signalResult.signals.slice(0, 5).map(function (s) { return s.name; }) : [],
        gapPct: meta ? meta.gapPct : null,
        volume: meta ? meta.volume : null,
        rVol: meta ? meta.rVol : null,
        haltReason: meta ? meta.haltReason : null,
        age: null
    };

    // Remove existing entry for same ticker (update if re-scored)
    state.liveDiscoveries = state.liveDiscoveries.filter(function (d) { return d.ticker !== t; });
    state.liveDiscoveries.unshift(discovery); // newest first

    // Cap to 20 active discoveries
    if (state.liveDiscoveries.length > 20) state.liveDiscoveries = state.liveDiscoveries.slice(0, 20);

    // Update ages for all discoveries
    state.liveDiscoveries.forEach(function (d) {
        var mins = Math.round((now - d.discoveredAt) / 60000);
        d.age = mins < 60 ? mins + 'm ago' : Math.round(mins / 60) + 'h ago';
    });

    // Expire discoveries older than 4 hours
    state.liveDiscoveries = state.liveDiscoveries.filter(function (d) {
        return (now - d.discoveredAt) < 4 * 60 * 60 * 1000;
    });


    // ── Auto Trade Setup for High-Confidence Discoveries ──
    if (signalResult && signalResult.confidence >= 70 && signalResult.direction !== 'NEUTRAL') {
        try {
            var price = signalResult.price;
            if (!price || price <= 0) return;

            var dir = signalResult.direction === 'BULLISH' ? 'LONG' : 'SHORT';

            // ATR-based targets (use 2% of price as rough ATR if unavailable)
            var atrEst = price * 0.02;
            var ta = signalResult.signals || [];
            // Try to get ATR from signal data
            ta.forEach(function (s) {
                if (s.name === 'ATR Regime' && s.raw && s.raw.atr) atrEst = s.raw.atr;
            });

            var scaledATR = atrEst * 1.5;
            var stopDist = atrEst * 0.8;

            var rawT1 = dir === 'LONG' ? +(price + scaledATR).toFixed(2) : +(price - scaledATR).toFixed(2);
            var rawStop = dir === 'LONG' ? +(price - stopDist).toFixed(2) : +(price + stopDist).toFixed(2);

            // F1: Snap to structural levels (Fib + strikes)
            var snapped = snapToStructure(price, rawT1, rawStop, dir, t);

            var setup = {
                ticker: t,
                direction: dir,
                entry: price,
                confidence: signalResult.confidence,
                technicalConfidence: signalResult.technicalConfidence || signalResult.confidence,
                mlConfidence: signalResult.mlConfidence || null,
                blendedConfidence: signalResult.blendedConfidence || null,
                target1: snapped.target1,
                target2: dir === 'LONG' ? +(price + scaledATR * 2).toFixed(2) : +(price - scaledATR * 2).toFixed(2),
                stop: snapped.stop,
                riskReward: +(Math.abs(snapped.target1 - price) / Math.abs(price - snapped.stop)).toFixed(2),
                signals: signalResult.signals,
                session: state.session,
                horizon: 'Intraday',
                source: source,
                discoverySetup: true,
                structureSnap: snapped.snapped ? { target: snapped.targetSource, stop: snapped.stopSource } : null
            };

            // Kelly sizing
            var kelly = tradeJournal.calculateKellySize(signalResult.confidence);
            setup.kellySizing = kelly;

            state.tradeSetups[t] = setup;
            discovery.tradeSetup = setup;

            console.log('🎯 Auto trade setup: ' + t + ' ' + dir + ' Entry: $' + price +
                ' T1: $' + setup.target1 + ' Stop: $' + setup.stop + ' R:R: ' + setup.riskReward);

            // Telegram alert with trade setup
            var setupMsg = '🎯 *Discovery Trade Setup: ' + t + '*\n';
            setupMsg += (dir === 'LONG' ? '🟢' : '🔴') + ' ' + dir + ' — ' + signalResult.confidence + '% confidence\n';
            setupMsg += 'Entry: $' + price + '\n';
            setupMsg += 'Target 1: $' + setup.target1 + '\n';
            setupMsg += 'Target 2: $' + setup.target2 + '\n';
            setupMsg += 'Stop: $' + setup.stop + '\n';
            setupMsg += 'R:R: ' + setup.riskReward + '\n';
            setupMsg += 'Source: ' + source;
            notifier._sendTelegram(setupMsg);

            // ── Auto Paper Trade for Discovery Setups ──
            // Same logic as watchlist: cooldown + consecutive loss guard
            tradeJournal.logSetup(setup, signalResult);
            var maxConsecLosses = 3;
            var consecLosses = tradeJournal.getConsecutiveLosses(t, dir);
            if (consecLosses < maxConsecLosses) {
                var cooldownMs = 30 * 60 * 1000;
                var autoTrade = tradeJournal.paperTrade(setup, price, cooldownMs);
                if (autoTrade) {
                    console.log('📝 Discovery paper trade: ' + dir + ' ' + t + ' @ $' + price.toFixed(2) +
                        ' (conf: ' + signalResult.confidence + '%, source: ' + source + ')');
                    try { notifier.sendPaperTrade(autoTrade, 'ENTRY'); } catch (ne) { /* optional */ }
                }
            } else {
                console.log('⏭️  Discovery paper blocked ' + dir + ' ' + t + ': streak=' + consecLosses);
            }
        } catch (setupErr) {
            console.error('Auto trade setup error for ' + t + ':', setupErr.message);
        }
    }

    // Record to history for performance tracking
    state.discoveryHistory.push({
        ticker: t,
        source: source,
        discoveredAt: now,
        priceAtDiscovery: discovery.price,
        direction: discovery.direction,
        confidence: discovery.confidence,
        checked1h: false,
        checked4h: false,
        checkedEOD: false
    });

    // Cap history to 200 entries
    if (state.discoveryHistory.length > 200) {
        state.discoveryHistory = state.discoveryHistory.slice(-200);
    }
}

// ── Discovery Performance Tracking ───────────────────────
// Checks how discoveries performed after 1h, 4h, and EOD
// Saves results to data/scanner-performance.json
var PERF_FILE = require('path').join(__dirname, 'data', 'scanner-performance.json');

function checkDiscoveryPerformance() {
    var now = Date.now();
    var oneHour = 60 * 60 * 1000;
    var fourHours = 4 * 60 * 60 * 1000;
    var eodHours = 8 * 60 * 60 * 1000; // approximate EOD delta

    state.discoveryHistory.forEach(function (d) {
        if (!d.priceAtDiscovery || d.priceAtDiscovery <= 0) return;
        var elapsed = now - d.discoveredAt;

        // Get current price
        var currentPrice = 0;
        var q = state.quotes[d.ticker];
        if (q) currentPrice = parseFloat(q.last || q.price || 0);
        if (!currentPrice) {
            var ts = polygonClient.getTickSummary(d.ticker);
            if (ts) currentPrice = ts.lastPrice || 0;
        }
        if (!currentPrice || currentPrice <= 0) return;

        var changePct = ((currentPrice - d.priceAtDiscovery) / d.priceAtDiscovery * 100);

        // Determine if prediction was correct
        var correct = false;
        if (d.direction === 'BULLISH' && changePct > 0) correct = true;
        if (d.direction === 'BEARISH' && changePct < 0) correct = true;

        // 1-hour check
        if (!d.checked1h && elapsed >= oneHour) {
            d.checked1h = true;
            d.price1h = currentPrice;
            d.pnl1h = +changePct.toFixed(2);
            d.correct1h = correct;
        }

        // 4-hour check
        if (!d.checked4h && elapsed >= fourHours) {
            d.checked4h = true;
            d.price4h = currentPrice;
            d.pnl4h = +changePct.toFixed(2);
            d.correct4h = correct;
        }

        // EOD check (~8h from discovery)
        if (!d.checkedEOD && elapsed >= eodHours) {
            d.checkedEOD = true;
            d.priceEOD = currentPrice;
            d.pnlEOD = +changePct.toFixed(2);
            d.correctEOD = correct;
        }
    });

    // Save to file periodically
    try {
        var stats = getDiscoveryPerformanceStats();
        var fs = require('fs');
        fs.writeFileSync(PERF_FILE, JSON.stringify({
            lastUpdated: new Date().toISOString(),
            stats: stats,
            history: state.discoveryHistory.slice(-100) // last 100
        }, null, 2));
    } catch (e) { /* best-effort */ }
}

function getDiscoveryPerformanceStats() {
    var history = state.discoveryHistory;
    if (!history || history.length === 0) return { total: 0 };

    var checked1h = history.filter(function (d) { return d.checked1h; });
    var checked4h = history.filter(function (d) { return d.checked4h; });
    var checkedEOD = history.filter(function (d) { return d.checkedEOD; });

    var calc = function (arr, field, correctField) {
        if (arr.length === 0) return { count: 0, hitRate: 0, avgReturn: 0 };
        var correct = arr.filter(function (d) { return d[correctField]; }).length;
        var totalReturn = arr.reduce(function (sum, d) { return sum + (d[field] || 0); }, 0);
        return {
            count: arr.length,
            hitRate: +(correct / arr.length * 100).toFixed(1),
            avgReturn: +(totalReturn / arr.length).toFixed(2)
        };
    };

    // By source
    var sources = {};
    ['Scanner', 'VolatilityRunner', 'HaltResume'].forEach(function (src) {
        var srcHistory = history.filter(function (d) { return d.source === src; });
        var src1h = srcHistory.filter(function (d) { return d.checked1h; });
        sources[src] = {
            total: srcHistory.length,
            checked: src1h.length,
            hitRate: src1h.length > 0 ? +(src1h.filter(function (d) { return d.correct1h; }).length / src1h.length * 100).toFixed(1) : 0,
            avgReturn: src1h.length > 0 ? +(src1h.reduce(function (s, d) { return s + (d.pnl1h || 0); }, 0) / src1h.length).toFixed(2) : 0
        };
    });

    return {
        total: history.length,
        performance1h: calc(checked1h, 'pnl1h', 'correct1h'),
        performance4h: calc(checked4h, 'pnl4h', 'correct4h'),
        performanceEOD: calc(checkedEOD, 'pnlEOD', 'correctEOD'),
        bySource: sources
    };
}

// Check performance every 30 minutes
setInterval(checkDiscoveryPerformance, 30 * 60 * 1000);

// ── Score a single ticker: signal engine + ML ensemble + trade setup ──
async function scoreTickerSignals(ticker) {
    try {
        // Fetch multi-timeframe analysis during market hours (uses Polygon REST)
        var multiTFData = null;
        var isMarketSession = ['OPEN_RUSH', 'POWER_OPEN', 'PRE_MARKET', 'MIDDAY', 'POWER_HOUR'].includes(state.session);
        if (isMarketSession && state.multiTF && state.multiTF[ticker]) {
            multiTFData = state.multiTF[ticker];
        }

        const data = {
            technicals: state.technicals[ticker],
            flow: (state.optionsFlow || []).filter(f => (f.ticker || f.symbol) === ticker),
            // BUG-3/4 FIX: data is now stored as flat arrays, read directly
            darkPool: Array.isArray(state.darkPool[ticker]) ? state.darkPool[ticker] : [],
            gex: Array.isArray(state.gex[ticker]) ? state.gex[ticker] : [],
            ivRank: state.ivRank[ticker],
            shortInterest: state.shortInterest[ticker],
            insider: state.insiderData[ticker] || [],
            congress: (state.congressTrades || []).filter(c => (c.ticker || c.symbol) === ticker),
            congressTrader: state.congressTrader || null,
            congressLateReports: state.congressLateReports || null,
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
            polygonMinuteBars: polygonClient.getMinuteBars(ticker) || [],
            // Earnings gap trade data (signal #38)
            earningsEnriched: (state.earningsToday && state.earningsToday.enriched) ? state.earningsToday.enriched[ticker] || null : null,
            earningsReaction: (state.earningsToday && state.earningsToday.reactions) ? state.earningsToday.reactions[ticker] || null : null,
            // Phase 2 data
            nope: state.nope[ticker] || null,
            flowPerStrikeIntraday: state.flowPerStrikeIntraday[ticker] || null,
            analystRatings: state.analystRatings[ticker] || null,
            institutionHoldings: state.institutionHoldings[ticker] || null,
            institutionActivity: state.institutionActivity[ticker] || null,
            shortVolumesByExchange: state.shortVolumesByExchange[ticker] || null,
            fdaCalendar: state.fdaCalendar || [],
            // GAP-1 through GAP-6: Previously fetched but never passed to signal engine
            maxPain: state.maxPain[ticker] || null,
            oiChange: state.oiChange[ticker] || null,
            greeks: state.greeks[ticker] || null,
            stockState: state.stockState[ticker] || null,
            earnings: state.earnings[ticker] || null,
            etfFlows: state.etfFlows || {},
            // Phase B — New UW endpoints
            shortInterestV2: state.shortInterestV2 ? state.shortInterestV2[ticker] : null,
            interpolatedIV: state.interpolatedIV ? state.interpolatedIV[ticker] : null,
            riskReversalSkew: state.riskReversalSkew ? state.riskReversalSkew[ticker] : null,
            insiderSectorFlow: state.insiderSectorFlow || {},
            // Phase C — Polygon expansion
            financials: state.financials ? state.financials[ticker] : null,
            relatedCompanies: state.relatedCompanies ? state.relatedCompanies[ticker] : null,
            splits: state.splits ? state.splits[ticker] : null,
            dividends: state.dividends ? state.dividends[ticker] : null,
            marketHolidays: state.marketHolidays || [],
            // Phase E data
            oiPerStrike: (state.oiPerStrike || {})[ticker] || null,
            oiPerExpiry: (state.oiPerExpiry || {})[ticker] || null,
            atmChains: (state.atmChains || {})[ticker] || null,
            stockPriceLevels: (state.stockPriceLevels || {})[ticker] || null,
            stockVolumePriceLevels: (state.stockVolumePriceLevels || {})[ticker] || null,
            // Phase F data
            expiryBreakdown: (state.expiryBreakdown || {})[ticker] || null,
            spotGEXByExpiryStrike: (state.spotGEXByExpiryStrike || {})[ticker] || null,
            tickerOwnership: (state.tickerOwnership || {})[ticker] || null,
            politicianHolders: (state.politicianHolders || {})[ticker] || null,
            seasonalityYearMonth: (state.seasonalityYearMonth || {})[ticker] || null,
            // Tier 2 data
            ivSkew: (state.ivSkew || {})[ticker] || null,
            volStats: (state.volStats || {})[ticker] || null,
            litFlow: (state.litFlow || {})[ticker] || null,
            marketCorrelations: state.marketCorrelations || null
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

                // F1: Compute raw ATR targets then snap to structural levels
                var rawT1 = dir === 'LONG' ? +(price + scaledATR).toFixed(2) : +(price - scaledATR).toFixed(2);
                var rawStop = dir === 'LONG' ? +(price - stopDist).toFixed(2) : +(price + stopDist).toFixed(2);
                var snapped = snapToStructure(price, rawT1, rawStop, dir, ticker);

                const setup = {
                    ticker, direction: dir, entry: price, confidence: signalResult.confidence,
                    technicalConfidence: signalResult.technicalConfidence || signalResult.confidence,
                    mlConfidence: signalResult.mlConfidence || null,
                    blendedConfidence: signalResult.blendedConfidence || null,
                    target1: snapped.target1,
                    target2: dir === 'LONG' ? +(price + scaledATR * 2).toFixed(2) : +(price - scaledATR * 2).toFixed(2),
                    stop: snapped.stop,
                    riskReward: +(Math.abs(snapped.target1 - price) / Math.max(0.01, Math.abs(price - snapped.stop))).toFixed(2),
                    signals: signalResult.signals,
                    session: state.session,
                    horizon: horizon,
                    atrMultiplier: atrMult,
                    isVolatile: isVolatile,
                    changePct: +changePct.toFixed(2),
                    volumeRatio: +volRatio.toFixed(2),
                    structureSnap: snapped.snapped ? { target: snapped.targetSource, stop: snapped.stopSource } : null
                };

                // Kelly Criterion position sizing
                var kelly = tradeJournal.calculateKellySize(signalResult.confidence);
                setup.kellySizing = kelly;
                state.kellySizing[ticker] = kelly;

                state.tradeSetups[ticker] = setup;
                tradeJournal.logSetup(setup, signalResult);

                // ── Squeeze Alert: notify on high-probability squeeze detections ──
                try {
                    var sqData = { svRatio: 0, ftdQty: 0, utilPct: 0, score: 0 };
                    var svArr = Array.isArray(state.shortVolume[ticker]) ? state.shortVolume[ticker] : [];
                    var lastSV = svArr.length > 0 ? svArr[svArr.length - 1] : null;
                    if (lastSV) { sqData.svRatio = parseFloat(lastSV.short_volume_ratio || lastSV.short_ratio || 0); if (sqData.svRatio > 0.5) sqData.score += 2; else if (sqData.svRatio > 0.4) sqData.score += 1; }
                    var ftdArr = Array.isArray(state.failsToDeliver[ticker]) ? state.failsToDeliver[ticker] : [];
                    var lastFTD = ftdArr.length > 0 ? ftdArr[ftdArr.length - 1] : null;
                    if (lastFTD) { sqData.ftdQty = parseFloat(lastFTD.quantity || lastFTD.fails || 0); if (sqData.ftdQty > 1000000) sqData.score += 2; else if (sqData.ftdQty > 500000) sqData.score += 1; }
                    var siObj = Array.isArray(state.shortInterest[ticker]) ? state.shortInterest[ticker][0] : state.shortInterest[ticker];
                    if (siObj) { sqData.utilPct = parseFloat(siObj.utilization || siObj.borrow_utilization || 0); if (sqData.utilPct > 90) sqData.score += 2; else if (sqData.utilPct > 70) sqData.score += 1; }

                    state.squeezeScores = state.squeezeScores || {};
                    state.squeezeScores[ticker] = sqData;

                    // Alert on high squeeze scores (4+/6) — with 2h cooldown per ticker
                    if (sqData.score >= 4) {
                        state.squeezeCooldown = state.squeezeCooldown || {};
                        var lastAlert = state.squeezeCooldown[ticker] || 0;
                        if (Date.now() - lastAlert > 2 * 60 * 60 * 1000) {
                            state.squeezeCooldown[ticker] = Date.now();
                            var sqMsg = '🔥 *SQUEEZE ALERT: ' + ticker + '* (Score: ' + sqData.score + '/6)\n'
                                + '• Short Volume: ' + (sqData.svRatio * 100).toFixed(0) + '%' + (sqData.svRatio > 0.5 ? ' ✅' : '') + '\n'
                                + '• FTDs: ' + (sqData.ftdQty > 1e6 ? (sqData.ftdQty / 1e6).toFixed(1) + 'M' : (sqData.ftdQty / 1e3).toFixed(0) + 'K') + ' shares' + (sqData.ftdQty > 1e6 ? ' ✅' : '') + '\n'
                                + '• Borrow Util: ' + sqData.utilPct.toFixed(0) + '%' + (sqData.utilPct > 90 ? ' ✅' : '') + '\n'
                                + '• Price: $' + price.toFixed(2) + ' | Dir: ' + dir + ' | Conf: ' + signalResult.confidence + '%';
                            console.log('🔥 SQUEEZE ALERT: ' + ticker + ' score=' + sqData.score + '/6');
                            try { notifier.alert({ ticker: ticker, confidence: signalResult.confidence, direction: dir }, { customMessage: sqMsg }); } catch (ne) { /* optional */ }
                        }
                    }
                } catch (sqErr) { /* squeeze alert is optional */ }

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
        // A8: Company metadata — prefer Polygon (free), fall back to UW
        var quoteInfo = {};
        var pDetails = polygonClient.getDetails(ticker);  // cached from getTickerDetails
        if (pDetails) {
            quoteInfo = { ticker: pDetails.ticker, name: pDetails.name, market_cap: pDetails.market_cap, exchange: pDetails.exchange, sic_description: pDetails.sic_description };
        } else {
            try {
                pDetails = await polygonClient.getTickerDetails(ticker);
                if (pDetails) quoteInfo = { ticker: pDetails.ticker, name: pDetails.name, market_cap: pDetails.market_cap, exchange: pDetails.exchange, sic_description: pDetails.sic_description };
            } catch (e) { /* Polygon failed, try UW */ }
            if (!quoteInfo.ticker) {
                const quote = await uw.getStockQuote(ticker);
                quoteInfo = quote?.data || {};
                callCount++;
            }
        }

        // Options volume levels
        const optVol = await uw.getOptionVolumeLevels(ticker);
        var optVolData = optVol?.data || null;
        callCount++;

        // Dark pool (store as flat array — BUG-3 fix)
        const dp = await uw.getDarkPoolLevels(ticker);
        if (dp?.data) state.darkPool[ticker] = Array.isArray(dp.data) ? dp.data : [dp.data];
        callCount++;

        // GEX (store as flat array — BUG-4 fix)
        const gex = await uw.getGEXByStrike(ticker);
        if (gex?.data) state.gex[ticker] = Array.isArray(gex.data) ? gex.data : [gex.data];
        callCount++;

        // A9: Historical candles — prefer Polygon getAggregates (free), fall back to UW
        var histCandles = [];
        try {
            var toDate = new Date().toISOString().split('T')[0];
            var fromDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            histCandles = await polygonClient.getAggregates(ticker, 1, 'day', fromDate, toDate);
        } catch (e) { /* Polygon failed */ }
        if (histCandles.length < 30) {
            // Fallback to UW historical if Polygon returned insufficient data
            try {
                const hist = await uw.getHistoricalPrice(ticker);
                if (hist?.data && Array.isArray(hist.data) && hist.data.length > 0) {
                    histCandles = hist.data.map(d => ({
                        date: d.date || d.timestamp,
                        open: parseFloat(d.open),
                        high: parseFloat(d.high),
                        low: parseFloat(d.low),
                        close: parseFloat(d.close),
                        volume: parseFloat(d.volume || 0)
                    }));
                }
                callCount++;
            } catch (e) { /* both failed */ }
        }
        if (histCandles.length > 0) {
            const candles = histCandles;
            const analysis = TechnicalAnalysis.analyze(candles);
            state.technicals[ticker] = analysis;
            const lastCandle = candles[candles.length - 1];
            const histClose = lastCandle.close;
            const prevClose = candles.length > 1 ? candles[candles.length - 2].close : histClose;

            // BUG-1 FIX: Use Polygon live price during market hours, fall back to historical close
            var liveSnapshot = polygonClient.getSnapshotData(ticker);
            var livePrice = null;
            if (liveSnapshot && liveSnapshot.lastTrade && liveSnapshot.lastTrade.p) {
                livePrice = parseFloat(liveSnapshot.lastTrade.p);
            } else if (liveSnapshot && liveSnapshot.min && liveSnapshot.min.c) {
                livePrice = parseFloat(liveSnapshot.min.c);
            }
            var currentPrice = (livePrice && livePrice > 0) ? livePrice : histClose;

            const changeAmt = currentPrice - prevClose;
            const changePct = prevClose ? (changeAmt / prevClose * 100) : 0;

            // BUG-2 FIX: Build quote object ONCE with canonical keys
            state.quotes[ticker] = {
                ...quoteInfo,                         // Company info from getStockQuote
                optionVolume: optVolData,              // Options volume merged in
                price: currentPrice,
                last: currentPrice,
                close: histClose,                     // Historical close (daily)
                open: lastCandle.open,
                high: lastCandle.high,
                low: lastCandle.low,
                prevClose: prevClose,                  // Single canonical key
                change: parseFloat(changeAmt.toFixed(2)),
                changePercent: parseFloat(changePct.toFixed(2)),
                volume: lastCandle.volume,
                livePrice: livePrice,                 // Null if no Polygon data
                priceSource: livePrice ? 'polygon_live' : 'uw_historical'
            };
            const setup = alertEngine.generateTradeSetup(ticker, analysis, currentPrice);
            if (setup) {
                // Only use alert engine setup if signal engine didn't already produce one
                // Signal engine setups have real signals and accurate confidence — never overwrite them
                if (!state.tradeSetups[ticker]) {
                    setup.source = 'alert_engine';  // Mark so we know it's a fallback
                    state.tradeSetups[ticker] = setup;
                } else {
                    // Merge pivot data into existing signal-engine setup (enrich, don't replace)
                    if (analysis.pivots) state.tradeSetups[ticker].pivots = analysis.pivots;
                }
            }
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

            // NOPE — Net Options Pricing Effect (directional predictor) — WARM
            try {
                const nope = await uw.getNOPE(ticker);
                if (nope?.data) state.nope[ticker] = nope.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Intraday Strike Flow (real-time magnetic levels) — WARM
            try {
                const isf = await uw.getFlowPerStrikeIntraday(ticker);
                if (isf?.data) state.flowPerStrikeIntraday[ticker] = isf.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Phase E: OI Per Strike (S/R from open interest) — WARM
            try {
                const oiStrike = await uw.getOIPerStrike(ticker);
                if (oiStrike?.data) { state.oiPerStrike = state.oiPerStrike || {}; state.oiPerStrike[ticker] = oiStrike.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Phase E: OI Per Expiry (activity concentration by expiry) — WARM
            try {
                const oiExp = await uw.getOIPerExpiry(ticker);
                if (oiExp?.data) { state.oiPerExpiry = state.oiPerExpiry || {}; state.oiPerExpiry[ticker] = oiExp.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Tier 2: Lit Flow (lit vs dark routing split) — WARM
            try {
                const litf = await uw.getLitFlow(ticker);
                if (litf?.data) { state.litFlow = state.litFlow || {}; state.litFlow[ticker] = litf.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Phase E: ATM Chains — Uses nearest expiry from OI data
            try {
                var oiExpData = (state.oiPerExpiry || {})[ticker];
                if (oiExpData && Array.isArray(oiExpData) && oiExpData.length > 0) {
                    // Sort by volume descending to get the most active expiry
                    var sortedExp = oiExpData.slice().sort(function (a, b) { return (b.volume || 0) - (a.volume || 0); });
                    var nearestExpiry = sortedExp[0].expiry || sortedExp[0].expiration_date;
                    if (nearestExpiry) {
                        const atm = await uw.getATMChains(ticker + '?expiration=' + nearestExpiry);
                        if (atm?.data) { state.atmChains = state.atmChains || {}; state.atmChains[ticker] = atm.data; }
                        callCount++;
                    }
                }
            } catch (e) { /* optional — ATM chains may still 422 on some tickers */ }

            // Phase E: Stock Price Levels — DISABLED: endpoint returns 404 (not in UW API spec)
            // try {
            //     const spl = await uw.getStockPriceLevels(ticker);
            //     if (spl?.data) { state.stockPriceLevels = state.stockPriceLevels || {}; state.stockPriceLevels[ticker] = spl.data; }
            //     callCount++;
            // } catch (e) { /* optional */ }

            // Phase E: Stock Volume Price Levels — DISABLED: endpoint returns 404 (not in UW API spec)
            // try {
            //     const svpl = await uw.getStockVolumePriceLevels(ticker);
            //     if (svpl?.data) { state.stockVolumePriceLevels = state.stockVolumePriceLevels || {}; state.stockVolumePriceLevels[ticker] = svpl.data; }
            //     callCount++;
            // } catch (e) { /* optional */ }

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

            // Institution Holdings (big money ownership) — COLD
            try {
                const ih = await uw.getInstitutionHoldings(ticker);
                if (ih?.data) state.institutionHoldings[ticker] = ih.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Institution Activity (recent institutional buys/sells) — COLD
            try {
                const ia = await uw.getInstitutionActivity(ticker);
                if (ia?.data) state.institutionActivity[ticker] = ia.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Analyst Ratings (consensus + targets) — COLD
            try {
                const ar = await uw.getAnalystRatingsByTicker(ticker);
                if (ar?.data) state.analystRatings[ticker] = ar.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Short Volumes by Exchange — COLD
            try {
                const sve = await uw.getShortVolumesByExchange(ticker);
                if (sve?.data) state.shortVolumesByExchange[ticker] = sve.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Interpolated IV (better IV surface for options pricing) — COLD (NEW)
            try {
                const iiv = await uw.getInterpolatedIV(ticker);
                if (iiv?.data) state.interpolatedIV = state.interpolatedIV || {}, state.interpolatedIV[ticker] = iiv.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Short Interest V2 with float data — COLD (NEW)
            try {
                const siV2 = await uw.getShortInterestV2(ticker);
                if (siV2?.data) state.shortInterestV2 = state.shortInterestV2 || {}, state.shortInterestV2[ticker] = siV2.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Risk Reversal Skew (put/call sentiment) — COLD (NEW)
            try {
                const rrs = await uw.getRiskReversalSkew(ticker);
                if (rrs?.data) state.riskReversalSkew = state.riskReversalSkew || {}, state.riskReversalSkew[ticker] = rrs.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Phase C: Polygon Financials (quarterly data)
            try {
                const fins = await polygonClient.getFinancials(ticker, 4);
                if (fins.length > 0) { state.financials = state.financials || {}; state.financials[ticker] = fins; }
            } catch (e) { /* optional */ }

            // Phase C: Related Companies (sympathy play detection)
            try {
                const rels = await polygonClient.getRelatedCompanies(ticker);
                if (rels.length > 0) { state.relatedCompanies = state.relatedCompanies || {}; state.relatedCompanies[ticker] = rels; }
            } catch (e) { /* optional */ }

            // Phase C: Splits (prevent false signals)
            try {
                const spl = await polygonClient.getSplits(ticker, 3);
                if (spl.length > 0) { state.splits = state.splits || {}; state.splits[ticker] = spl; }
            } catch (e) { /* optional */ }

            // Phase C: Dividends (prevent false signals)
            try {
                const divs = await polygonClient.getDividends(ticker, 3);
                if (divs.length > 0) { state.dividends = state.dividends || {}; state.dividends[ticker] = divs; }
            } catch (e) { /* optional */ }

            // Phase F: Expiry Breakdown (where options activity is concentrated) — COLD
            try {
                const eb = await uw.getExpiryBreakdown(ticker);
                if (eb?.data) { state.expiryBreakdown = state.expiryBreakdown || {}; state.expiryBreakdown[ticker] = eb.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Phase F: Spot GEX by Expiry+Strike (granular GEX) — COLD
            try {
                const sgex = await uw.getSpotGEXByExpiryStrike(ticker);
                if (sgex?.data) { state.spotGEXByExpiryStrike = state.spotGEXByExpiryStrike || {}; state.spotGEXByExpiryStrike[ticker] = sgex.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Phase F: Ticker Ownership (who holds this stock) — COLD
            try {
                const own = await uw.getTickerOwnership(ticker);
                if (own?.data) { state.tickerOwnership = state.tickerOwnership || {}; state.tickerOwnership[ticker] = own.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Phase F: Politician Holdings — DISABLED: enterprise-only endpoint (422)
            // try {
            //     const phold = await uw.getPoliticianHolders(ticker);
            //     if (phold?.data) { state.politicianHolders = state.politicianHolders || {}; state.politicianHolders[ticker] = phold.data; }
            //     callCount++;
            // } catch (e) { /* optional */ }

            // Phase F: Seasonality Year-Month (granular seasonality) — COLD
            try {
                const sznYM = await uw.getSeasonalityYearMonth(ticker);
                if (sznYM?.data) { state.seasonalityYearMonth = state.seasonalityYearMonth || {}; state.seasonalityYearMonth[ticker] = sznYM.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Tier 2: IV Skew (put/call skew = institutional sentiment) — COLD
            try {
                const ivs = await uw.getIVSkew(ticker);
                if (ivs?.data) { state.ivSkew = state.ivSkew || {}; state.ivSkew[ticker] = ivs.data; }
                callCount++;
            } catch (e) { /* optional */ }

            // Tier 2: Vol Stats (realized vs implied comparison) — COLD
            try {
                const vs = await uw.getVolStats(ticker);
                if (vs?.data) { state.volStats = state.volStats || {}; state.volStats[ticker] = vs.data; }
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
            // Phase C: Market Holidays (auto-disable scheduler on closures)
            try {
                const holidays = await polygonClient.getMarketHolidays();
                if (holidays.length > 0) state.marketHolidays = holidays;
            } catch (e) { /* optional */ }

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

            // Enrich earnings with individual EPS results + quote for beat/miss analysis
            try {
                var allEarningsTickers = []
                    .concat((state.earningsToday.premarket || []).map(function (e) { return e.ticker || e.symbol; }))
                    .concat((state.earningsToday.afterhours || []).map(function (e) { return e.ticker || e.symbol; }))
                    .filter(Boolean)
                    .slice(0, 20); // Limit to 20 to avoid rate limit

                for (var eti = 0; eti < allEarningsTickers.length; eti++) {
                    var et = allEarningsTickers[eti];
                    try {
                        // Fetch individual earnings data (EPS actual vs estimate)
                        var earnData = await uw.getEarnings(et);
                        callCount++;
                        if (earnData?.data) {
                            var earr = Array.isArray(earnData.data) ? earnData.data : [earnData.data];
                            // Find today's or most recent earnings entry
                            var latestE = earr[0]; // Usually the latest
                            if (latestE) {
                                var epsActual = latestE.eps || latestE.eps_actual || latestE.reported_eps || null;
                                var epsEst = latestE.eps_estimate || latestE.eps_consensus || latestE.consensus_eps || null;
                                var revActual = latestE.revenue || latestE.reported_revenue || null;
                                var revEst = latestE.revenue_estimate || latestE.revenue_consensus || null;
                                var enriched = {
                                    eps_actual: epsActual,
                                    eps_estimate: epsEst,
                                    revenue_actual: revActual,
                                    revenue_estimate: revEst,
                                    beat: (epsActual != null && epsEst != null) ? (parseFloat(epsActual) > parseFloat(epsEst) ? 'BEAT' : parseFloat(epsActual) < parseFloat(epsEst) ? 'MISS' : 'MET') : null,
                                    surprise_pct: (epsActual != null && epsEst != null && parseFloat(epsEst) !== 0) ? (((parseFloat(epsActual) - parseFloat(epsEst)) / Math.abs(parseFloat(epsEst))) * 100).toFixed(1) + '%' : null,
                                    guidance: latestE.guidance || latestE.forward_guidance || null,
                                    report_date: latestE.report_date || latestE.date || null
                                };
                                // Store enriched data on the earnings entry
                                if (!state.earningsToday.enriched) state.earningsToday.enriched = {};
                                state.earningsToday.enriched[et] = enriched;
                            }
                        }
                        // Also fetch quote for after-hours price reaction
                        var eq = await uw.getStockQuote(et);
                        callCount++;
                        if (eq?.data) {
                            if (!state.earningsToday.reactions) state.earningsToday.reactions = {};
                            state.earningsToday.reactions[et] = {
                                price: eq.data.last || eq.data.price || eq.data.close || null,
                                change_pct: eq.data.change_percent || eq.data.changePercent || null,
                                afterhours_price: eq.data.afterhours_price || eq.data.ah_price || eq.data.extended_hours_price || null,
                                afterhours_change: eq.data.afterhours_change_percent || eq.data.ah_change_pct || null,
                                volume: eq.data.volume || null,
                                prev_close: eq.data.prev_close || eq.data.previousClose || null
                            };
                        }
                        // Small delay to respect rate limits
                        if (eti < allEarningsTickers.length - 1) {
                            await new Promise(function (resolve) { setTimeout(resolve, 300); });
                        }
                    } catch (enrichErr) {
                        // Skip failed enrichments silently
                    }
                }
                console.log('Enriched ' + Object.keys(state.earningsToday.enriched || {}).length + ' earnings tickers with EPS data');
            } catch (enrichAllErr) {
                console.log('Earnings enrichment error:', enrichAllErr.message);
            }

            // Economic Calendar (macro events) — COLD
            try {
                const econ = await uw.getEconomicCalendar();
                if (econ?.data) state.economicCalendar = Array.isArray(econ.data) ? econ.data.slice(0, 30) : [];
                callCount++;
            } catch (e) { /* optional */ }

            // FDA Calendar (biotech event risk) — COLD
            try {
                const fda = await uw.getFDACalendar();
                if (fda?.data) state.fdaCalendar = Array.isArray(fda.data) ? fda.data.slice(0, 30) : [];
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

            // Short Screener (auto-discover squeeze candidates) — COLD (NEW)
            try {
                const ss = await uw.getShortScreener({ min_short_interest: 20, limit: 30 });
                if (ss?.data) state.shortScreener = Array.isArray(ss.data) ? ss.data : [];
                callCount++;
            } catch (e) { /* optional */ }

            // Insider Sector Flow (sector-level insider sentiment) — COLD (NEW)
            try {
                var sectorFlowSectors = ['Technology', 'Healthcare', 'Financial', 'Energy'];
                state.insiderSectorFlow = state.insiderSectorFlow || {};
                for (var isfi = 0; isfi < sectorFlowSectors.length; isfi++) {
                    var isf = await uw.getInsiderSectorFlow(sectorFlowSectors[isfi]);
                    if (isf?.data) state.insiderSectorFlow[sectorFlowSectors[isfi]] = isf.data;
                    callCount++;
                }
            } catch (e) { /* optional */ }

            // Tier 2: Market Correlations (cross-asset hedging) — COLD
            try {
                const mc = await uw.getMarketCorrelations();
                if (mc?.data) state.marketCorrelations = mc.data;
                callCount++;
            } catch (e) { /* optional */ }

            // Tier 3: Screen Option Contracts (auto-discover unusual options) — COLD
            try {
                const soc = await uw.screenOptionContracts({ min_premium: 100000, limit: 20 });
                if (soc?.data) state.unusualOptions = Array.isArray(soc.data) ? soc.data : [];
                callCount++;
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

    // I1: Holiday auto-disable — skip cycles on market holidays
    try {
        var holidays = state.marketHolidays || [];
        if (holidays.length > 0) {
            var todayStr = new Date().toISOString().slice(0, 10);
            var todayHoliday = holidays.find(function (h) {
                return h.date === todayStr && h.status === 'closed';
            });
            if (todayHoliday) {
                console.log('🏖️  Market holiday: ' + (todayHoliday.name || todayHoliday.exchange) + ' — skipping fetch cycle');
                return;
            }
            // Check for early close
            var earlyClose = holidays.find(function (h) {
                return h.date === todayStr && h.status === 'early-close';
            });
            if (earlyClose) {
                var nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
                var etHour = new Date(nowET).getHours();
                if (etHour >= 13) { // Markets close at 1pm ET on early close days
                    console.log('🏖️  Early close day: ' + (earlyClose.name || '') + ' — market closed at 1pm ET, skipping');
                    return;
                }
            }
        }
    } catch (e) { /* holiday check non-critical */ }

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

    // Merge Polygon real-time prices (REST snapshots + WebSocket ticks)
    try {
        (state.tickers || []).forEach(function (ticker) {
            var tickSummary = polygonClient.getTickSummary(ticker);
            if (tickSummary && tickSummary.lastPrice > 0) {
                if (!state.quotes[ticker]) state.quotes[ticker] = {};
                state.quotes[ticker].last = tickSummary.lastPrice;
                state.quotes[ticker].price = tickSummary.lastPrice;
                state.quotes[ticker].bid = tickSummary.bid || state.quotes[ticker].bid;
                state.quotes[ticker].ask = tickSummary.ask || state.quotes[ticker].ask;
                state.quotes[ticker].vwap = tickSummary.vwap || state.quotes[ticker].vwap;
                state.quotes[ticker].priceSource = 'polygon-ws';
            }
        });
    } catch (e) { console.error('Polygon price feed error:', e.message); }

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
                    // A8: Use Polygon snapshot for runner quotes (free), UW fallback
                    var rSnap = await polygonClient.getTickerSnapshot(rt);
                    if (rSnap && (rSnap.day || rSnap.lastTrade)) {
                        state.quotes[rt] = state.quotes[rt] || {};
                        state.quotes[rt].price = rSnap.lastTrade?.p || rSnap.day?.c || 0;
                        state.quotes[rt].last = state.quotes[rt].price;
                        state.quotes[rt].volume = rSnap.day?.v || 0;
                        state.quotes[rt].changePercent = rSnap.todaysChangePerc || 0;
                    } else {
                        var rQuote = await uw.getStockQuote(rt);
                        if (rQuote?.data) state.quotes[rt] = rQuote.data;
                        scheduler.trackCalls(1);
                    }

                    // (Polygon snapshot already fetched above in A8 migration)
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
            var newHits = await scanner.scan(scannerMarketData, state.tickers, uw, state.session, polygonClient);
            state.scannerResults = scanner.getResults();

            // Run multi-TF analysis on scanner discoveries (same depth as watchlist)
            if (newHits.length > 0 && (state.session === 'REGULAR' || state.session === 'PRE_MARKET')) {
                for (var mi = 0; mi < Math.min(newHits.length, 3); mi++) {
                    try {
                        var mtfResult = await multiTFAnalyzer.analyze(newHits[mi].ticker, 0);
                        if (mtfResult && mtfResult.confluence) {
                            newHits[mi].multiTF = mtfResult;
                            newHits[mi].confluenceBonus = mtfResult.confluence.confluenceBonus || 0;
                            newHits[mi].intradayBias = mtfResult.confluence.intradayBias || 'NEUTRAL';
                            if (mtfResult.confluence.dominantDirection === (newHits[mi].direction === 'BULLISH' ? 'BULL' : 'BEAR')) {
                                newHits[mi].confidence = Math.min(95, (newHits[mi].confidence || 50) + mtfResult.confluence.confluenceBonus);
                                newHits[mi].signals.push({ name: 'Multi-TF Confluence', dir: newHits[mi].direction === 'BULLISH' ? 'BULL' : 'BEAR', detail: mtfResult.confluence.timeframesAgreeing + '/5 TFs agree' });
                            }
                            console.log('📊 Scanner MTF: ' + newHits[mi].ticker + ' → ' + (mtfResult.confluence.dominantDirection || 'NEUTRAL') + ' (' + (mtfResult.confluence.timeframesAgreeing || 0) + '/5 TFs, bonus: +' + (mtfResult.confluence.confluenceBonus || 0) + ')');
                        }
                    } catch (mtfErr) { /* multi-TF optional */ }
                }
                state.scannerResults = scanner.getResults(); // refresh with MTF enrichment
            }

            // Full signal scoring for top scanner discoveries (38-signal engine + ML)
            for (var fi = 0; fi < Math.min(newHits.length, 3); fi++) {
                try {
                    var fullScore = await scoreDiscoveredTicker(newHits[fi].ticker, 'Scanner');
                    if (fullScore) {
                        newHits[fi].fullSignalScore = fullScore;
                        newHits[fi].signalDirection = fullScore.direction;
                        newHits[fi].signalConfidence = fullScore.confidence;
                        newHits[fi].mlConfidence = fullScore.mlConfidence;
                        newHits[fi].topSignals = fullScore.signals.slice(0, 5).map(function (s) { return s.name + ' (' + s.dir + ')'; });
                        trackDiscovery(newHits[fi].ticker, 'Scanner', fullScore, {
                            price: fullScore.price || newHits[fi].price || 0
                        });
                    }
                } catch (fsErr) { /* optional */ }
            }

            // Notify on new scanner discoveries with full signal detail
            for (var si = 0; si < newHits.length; si++) {
                var hit = newHits[si];
                try {
                    var scanMsg = '🔍 *Scanner Discovery: ' + hit.ticker + '*\n';
                    scanMsg += (hit.direction === 'BULLISH' ? '🟢' : hit.direction === 'BEARISH' ? '🔴' : '⚪');
                    scanMsg += ' ' + hit.direction + '\n';
                    scanMsg += 'Price: $' + (hit.price || 0) + '\n';
                    scanMsg += 'Sources: ' + hit.sources.join(', ') + '\n';

                    // Full signal engine results
                    if (hit.fullSignalScore) {
                        scanMsg += '\n📊 *Signal Engine:*\n';
                        scanMsg += 'Direction: ' + hit.signalDirection + ' — ' + hit.signalConfidence + '% confidence\n';
                        if (hit.mlConfidence) scanMsg += 'ML Score: ' + hit.mlConfidence + '%\n';
                        if (hit.topSignals && hit.topSignals.length > 0) {
                            scanMsg += 'Top Signals: ' + hit.topSignals.join(', ') + '\n';
                        }
                    }

                    // Multi-TF confluence
                    if (hit.multiTF && hit.multiTF.confluence) {
                        var conf = hit.multiTF.confluence;
                        scanMsg += '\n📈 *Multi-TF:* ' + (conf.dominantDirection || 'NEUTRAL') + ' (' + (conf.timeframesAgreeing || 0) + '/5 TFs agree)\n';
                        if (conf.swingBias && conf.swingBias !== 'NEUTRAL') {
                            scanMsg += 'Swing Bias: ' + conf.swingBias + '\n';
                        }
                    }

                    if (hit.details && hit.details.length > 0) {
                        scanMsg += '\nDetails: ' + hit.details.slice(0, 3).join(' | ');
                    }

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

    // Force-close intraday paper trades at 4:05 PM ET (before EOD report)
    if (hour === 16 && min >= 5 && min < 15 && !state.intradayCloseRan) {
        var intradayClosed = tradeJournal.closeIntradayTrades(state.quotes);
        if (intradayClosed > 0) {
            console.log('📊 EOD: Closed ' + intradayClosed + ' intraday paper trades at market close');
        }
        state.intradayCloseRan = true;
    }

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
        state.intradayCloseRan = false;
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
                    if (cumulative.length > 50000) cumulative = cumulative.slice(-50000);
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
        var prevResumed = (state.halts || []).filter(function (h) { return h.status === 'RESUMED'; }).map(function (h) { return h.ticker; });
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

        // ── Halt Resume Auto-Ingestion ──────────────────────────
        // When any ticker resumes from halt (especially LULD/volatility),
        // auto-score it and alert — these often move 20%+ post-resume
        var resumedTickers = halts.filter(function (h) {
            return h.status === 'RESUMED' && !prevResumed.includes(h.ticker);
        });

        for (var hi = 0; hi < Math.min(resumedTickers.length, 3); hi++) {
            var resumed = resumedTickers[hi];
            try {
                console.log('🔓 Halt resume detected: ' + resumed.ticker + ' (' + resumed.reason + ')');

                // Send immediate resume alert
                var resumeMsg = '🔓 *HALT RESUMED: ' + resumed.ticker + '*\n';
                resumeMsg += 'Reason: ' + resumed.reason + '\n';
                resumeMsg += 'Time: ' + (resumed.resumeTime || resumed.haltTime) + '\n';
                if (resumed.price) resumeMsg += 'Last Price: $' + resumed.price + '\n';
                await notifier._sendTelegram(resumeMsg);

                // Skip watchlist tickers (already being scored) and index tickers
                var skipTickers = ['SPX', 'SPXW', 'VIX', 'SPY', 'QQQ'];
                if (state.tickers.includes(resumed.ticker) || skipTickers.includes(resumed.ticker)) continue;

                // Full signal scoring for resumed ticker
                var haltScore = await scoreDiscoveredTicker(resumed.ticker, 'HaltResume');
                trackDiscovery(resumed.ticker, 'HaltResume', haltScore, {
                    price: resumed.price || 0,
                    haltReason: resumed.reason
                });
                if (haltScore && haltScore.confidence >= 50) {
                    var haltMsg = '🎯 *Halt Resume Signal: ' + resumed.ticker + '*\n';
                    haltMsg += (haltScore.direction === 'BULLISH' ? '🟢' : '🔴') + ' ' + haltScore.direction + ' — ' + haltScore.confidence + '% confidence\n';
                    if (haltScore.mlConfidence) haltMsg += 'ML Score: ' + haltScore.mlConfidence + '%\n';
                    haltMsg += 'Halt Reason: ' + resumed.reason + '\n';
                    haltMsg += 'Signals: ' + haltScore.signals.slice(0, 5).map(function (s) { return s.name; }).join(', ');
                    await notifier._sendTelegram(haltMsg);
                }

                // Also ingest into X-alert monitor for tracking
                try {
                    await xAlertMonitor.ingestAlert(resumed.ticker, 'HaltResume', 'Resumed from halt: ' + resumed.reason, uw, polygonClient);
                    state.xAlerts = xAlertMonitor.getAlerts();
                } catch (xErr) { /* optional */ }

            } catch (hre) {
                console.error('Halt resume scoring error for ' + resumed.ticker + ':', hre.message);
            }
        }

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

// ── Mid-cycle Polygon Price Refresh ──────────────────────
// Fetches live prices from Polygon REST snapshots during all sessions
// Session-aware intervals: faster during active trading, slower overnight
// Covers ALL tickers on the command centre, not just watchlist
var polygonRefreshTimer = null;

// Session-aware refresh intervals (ms)
var POLYGON_REFRESH_INTERVALS = {
    'OPEN_RUSH': 10000,  // 10s — fastest during open chaos
    'POWER_OPEN': 10000,  // 10s — fast for day trade entries
    'PRE_MARKET': 15000,  // 15s — pre-market gaps changing fast
    'MIDDAY': 15000,  // 15s — still active, just slower
    'POWER_HOUR': 15000,  // 15s — closing momentum
    'AFTER_HOURS': 30000,  // 30s — after hours
    'OVERNIGHT': 60000   // 60s — overnight, minimal movement
};

function getPolygonRefreshInterval() {
    var session = scheduler.getSessionName();
    return POLYGON_REFRESH_INTERVALS[session] || 30000;
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

    // 8. Scanner discovery tickers
    ((state.scannerResults || {}).results || []).forEach(function (r) {
        if (r.ticker) tickerSet[r.ticker.toUpperCase()] = true;
    });

    // 9. Volatility runner tickers
    Object.keys(state.volatilityRunners || {}).forEach(function (t) { tickerSet[t] = true; });

    // Cap at 50 tickers to avoid API overload
    var all = Object.keys(tickerSet).filter(function (t) {
        return t && /^[A-Z]{1,5}$/.test(t);
    });
    return all.slice(0, 50);
}

function startPolygonPriceRefresh() {
    if (polygonRefreshTimer) clearTimeout(polygonRefreshTimer);

    async function polygonTick() {
        try {
            var allTickers = getAllCommandCentreTickers();
            if (allTickers.length === 0) { schedulePolygonRefresh(); return; }

            // Batch fetch Polygon snapshots (single API call for all tickers)
            var updatedCount = 0;
            try {
                // Fetch individual snapshots for each ticker (Polygon REST)
                var snapPromises = allTickers.map(function (t) {
                    return polygonClient.getTickerSnapshot(t).catch(function () { return null; });
                });
                var snaps = await Promise.all(snapPromises);

                for (var si = 0; si < allTickers.length; si++) {
                    var t = allTickers[si];
                    var snap = snaps[si];
                    if (!snap) continue;

                    if (!state.quotes[t]) state.quotes[t] = {};
                    var q = state.quotes[t];

                    // Price data
                    if (snap.lastTrade && snap.lastTrade.p > 0) {
                        q.last = snap.lastTrade.p;
                        q.price = snap.lastTrade.p;
                    } else if (snap.day && snap.day.c > 0) {
                        q.last = snap.day.c;
                        q.price = snap.day.c;
                    }

                    // Day OHLCV
                    if (snap.day) {
                        q.open = snap.day.o || q.open;
                        q.high = snap.day.h || q.high;
                        q.low = snap.day.l || q.low;
                        q.volume = snap.day.v || q.volume;
                        q.vwap = snap.day.vw || q.vwap;
                    }

                    // Previous close (for gap analysis)
                    if (snap.prevDay && snap.prevDay.c > 0) {
                        q.prev_close = snap.prevDay.c;
                        q.previousClose = snap.prevDay.c;
                    }

                    // Change calculations
                    if (q.last > 0 && q.prev_close > 0) {
                        q.change = q.last - q.prev_close;
                        q.changePct = ((q.last - q.prev_close) / q.prev_close * 100);
                        q.changePercent = q.changePct;
                    }

                    q.priceSource = 'polygon-rest';
                    updatedCount++;
                }
            } catch (snapErr) { /* partial data is fine */ }

            // Polygon WebSocket override for watchlist tickers (real-time > REST)
            var polygonOverrideCount = 0;
            (state.tickers || []).forEach(function (ticker) {
                var tickSummary = polygonClient.getTickSummary(ticker);
                if (tickSummary && tickSummary.lastPrice > 0) {
                    if (!state.quotes[ticker]) state.quotes[ticker] = {};
                    state.quotes[ticker].last = tickSummary.lastPrice;
                    state.quotes[ticker].price = tickSummary.lastPrice;
                    state.quotes[ticker].bid = tickSummary.bid || state.quotes[ticker].bid;
                    state.quotes[ticker].ask = tickSummary.ask || state.quotes[ticker].ask;
                    state.quotes[ticker].high = tickSummary.highOfDay || state.quotes[ticker].high;
                    state.quotes[ticker].low = tickSummary.lowOfDay || state.quotes[ticker].low;
                    state.quotes[ticker].vwap = tickSummary.vwap || state.quotes[ticker].vwap;
                    state.quotes[ticker].priceSource = 'polygon-ws';
                    state.quotes[ticker].polygonUpdatedAt = tickSummary.updatedAt;
                    polygonOverrideCount++;
                }
            });

            if (updatedCount > 0) {
                // Re-run gap analysis with fresh prev_close/open data
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
            // Silent — price refresh is best-effort
        }
        schedulePolygonRefresh();
    }

    function schedulePolygonRefresh() {
        var interval = getPolygonRefreshInterval();
        polygonRefreshTimer = setTimeout(polygonTick, interval);
    }

    schedulePolygonRefresh();
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
    startPolygonPriceRefresh();
    startHaltRefresh();
    console.log('📈 Polygon price refresh active — session-aware (' + (getPolygonRefreshInterval() / 1000) + 's current, covers all command centre tickers)');
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
                snapshotData: polygonClient.getSnapshotData(ticker) || null,
                // Phase 2 data
                nope: (function () { var n = state.nope && state.nope[ticker]; return n ? parseFloat(n.nope || n.value || n.nope_value || 0) : null; })(),
                analystRating: (function () { var a = state.analystRatings && state.analystRatings[ticker]; if (!a) return null; var r = Array.isArray(a) ? a[0] : a; return r ? { consensus: r.consensus || r.rating, target: r.price_target || r.avg_price_target } : null; })(),
                institutionFlow: (function () { var i = state.institutionActivity && state.institutionActivity[ticker]; if (!i) return null; var arr = Array.isArray(i) ? i : [i]; var buys = arr.filter(function (x) { return (x.transaction_type || x.type || '').toUpperCase().includes('BUY'); }).length; return { buys: buys, sells: arr.length - buys, direction: buys > arr.length - buys ? 'ACCUMULATING' : 'DISTRIBUTING' }; })(),
                fdaEvents: (state.fdaCalendar || []).filter(function (f) { return (f.ticker || f.symbol || '').toUpperCase() === ticker.toUpperCase(); }).slice(0, 3),
                topStrikeMagnets: (function () { var m = state.flowPerStrikeIntraday && state.flowPerStrikeIntraday[ticker]; if (!m) return null; var arr = Array.isArray(m) ? m : (m.data || []); return arr.slice().sort(function (a, b) { return parseFloat(b.volume || 0) - parseFloat(a.volume || 0); }).slice(0, 3).map(function (s) { return { strike: s.strike, volume: s.volume || s.total_volume }; }); })()
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
