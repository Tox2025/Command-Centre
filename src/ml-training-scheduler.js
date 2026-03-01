// ML Training Scheduler — Systematically trains on market-wide tickers during off-hours
// Runs: weekends, overnight (after 8pm ET), holidays
// Processes top tickers by sector, tracks progress, stays within API budget
// Called by server.js during OVERNIGHT session

const PolygonHistorical = require('./polygon-historical');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'ml-training-progress.json');
const CUMUL_FILE = path.join(DATA_DIR, 'ml-training-cumulative.json');

// ── Top tickers by GICS sector (S&P 500 leaders + high-volume mid-caps) ──
const SECTOR_TICKERS = {
    'Technology': [
        'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ADBE', 'CRM', 'AMD', 'INTC', 'ORCL', 'CSCO',
        'NOW', 'INTU', 'MU', 'AMAT', 'LRCX', 'KLAC', 'SNPS', 'CDNS', 'MRVL', 'PANW'
    ],
    'Healthcare': [
        'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'AMGN',
        'BMY', 'GILD', 'ISRG', 'VRTX', 'REGN', 'MDT', 'SYK', 'BSX', 'ELV', 'HCA'
    ],
    'Financials': [
        'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'BLK', 'SCHW', 'AXP',
        'SPGI', 'CB', 'PGR', 'MMC', 'ICE', 'CME', 'AON', 'MET', 'AIG', 'TFC'
    ],
    'Consumer Discretionary': [
        'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
        'ORLY', 'AZO', 'ROST', 'DHI', 'LEN', 'GM', 'F', 'ABNB', 'MAR', 'HLT'
    ],
    'Communication Services': [
        'META', 'GOOGL', 'GOOG', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR',
        'EA', 'ATVI', 'TTWO', 'ZM', 'SNAP', 'PINS', 'MTCH', 'ROKU', 'WBD', 'PARA'
    ],
    'Industrials': [
        'GE', 'CAT', 'HON', 'UNP', 'UPS', 'BA', 'RTX', 'LMT', 'DE', 'MMM',
        'GD', 'NOC', 'FDX', 'WM', 'EMR', 'ITW', 'ETN', 'PH', 'CSX', 'NSC'
    ],
    'Consumer Staples': [
        'PG', 'KO', 'PEP', 'COST', 'WMT', 'PM', 'MO', 'MDLZ', 'CL', 'EL',
        'KMB', 'GIS', 'SJM', 'HSY', 'K', 'STZ', 'TSN', 'KHC', 'KR', 'SYY'
    ],
    'Energy': [
        'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'PXD', 'OXY',
        'HAL', 'HES', 'DVN', 'FANG', 'BKR', 'KMI', 'WMB', 'OKE', 'TRGP', 'ET'
    ],
    'Utilities': [
        'NEE', 'DUK', 'SO', 'D', 'AEP', 'SRE', 'EXC', 'XEL', 'ED', 'WEC',
        'ES', 'AWK', 'PPL', 'PEG', 'EIX', 'DTE', 'FE', 'CMS', 'AES', 'CEG'
    ],
    'Real Estate': [
        'PLD', 'AMT', 'CCI', 'EQIX', 'PSA', 'SPG', 'O', 'WELL', 'DLR', 'AVB',
        'EQR', 'VICI', 'IRM', 'ARE', 'MAA', 'ESS', 'UDR', 'MPW', 'KIM', 'REG'
    ],
    'Materials': [
        'LIN', 'APD', 'SHW', 'FCX', 'NEM', 'ECL', 'DOW', 'NUE', 'VMC', 'MLM',
        'PPG', 'DD', 'EMN', 'CE', 'ALB', 'CF', 'MOS', 'CTVA', 'IFF', 'FMC'
    ]
};

// Total unique tickers
const ALL_TICKERS = [...new Set(Object.values(SECTOR_TICKERS).flat())];

class MLTrainingScheduler {
    constructor(polygonApiKey) {
        this.apiKey = polygonApiKey;
        this.poly = new PolygonHistorical(polygonApiKey);
        this.progress = this._loadProgress();
        this.isRunning = false;
        this.tickersPerCycle = 3; // Process 3 tickers per off-hours cycle (~45 sec each)
        this.yearsOfData = 15;
    }

    _loadProgress() {
        try {
            if (fs.existsSync(PROGRESS_FILE)) {
                return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
            }
        } catch (e) { }
        return {
            completedTickers: [],
            lastRun: null,
            totalSamplesGenerated: 0,
            errors: [],
            startedAt: new Date().toISOString()
        };
    }

    _saveProgress() {
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(PROGRESS_FILE, JSON.stringify(this.progress, null, 2));
        } catch (e) {
            console.error('ML Scheduler: progress save error:', e.message);
        }
    }

    // Get next batch of tickers to process (skip already completed)
    _getNextBatch() {
        var completed = new Set(this.progress.completedTickers);
        var pending = ALL_TICKERS.filter(function (t) { return !completed.has(t); });
        return pending.slice(0, this.tickersPerCycle);
    }

    // Main entry — called from server.js during off-hours
    // Returns number of new samples added
    async runCycle(mlCalibrator, existingWatchlist) {
        if (this.isRunning) return 0;

        var batch = this._getNextBatch();
        if (batch.length === 0) {
            // All tickers processed — reset for next round (data refreshes weekly)
            var daysSinceStart = (Date.now() - new Date(this.progress.startedAt).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceStart > 7) {
                console.log('📊 ML Scheduler: All ' + ALL_TICKERS.length + ' tickers processed — resetting for weekly refresh');
                this.progress.completedTickers = [];
                this.progress.startedAt = new Date().toISOString();
                this._saveProgress();
                batch = this._getNextBatch();
            } else {
                return 0; // All done for this week
            }
        }

        this.isRunning = true;
        var newSamples = 0;
        var self = this;

        try {
            // Skip tickers already on watchlist (they get trained via the normal pipeline)
            var watchlistSet = new Set((existingWatchlist || []).map(function (t) { return t.toUpperCase(); }));
            batch = batch.filter(function (t) { return !watchlistSet.has(t); });
            if (batch.length === 0) {
                // Mark watchlist tickers as done
                (existingWatchlist || []).forEach(function (t) {
                    if (self.progress.completedTickers.indexOf(t.toUpperCase()) === -1) {
                        self.progress.completedTickers.push(t.toUpperCase());
                    }
                });
                this._saveProgress();
                this.isRunning = false;
                return 0;
            }

            console.log('📊 ML Scheduler: Processing batch [' + batch.join(', ') + '] (' +
                this.progress.completedTickers.length + '/' + ALL_TICKERS.length + ' done)');

            for (var i = 0; i < batch.length; i++) {
                var ticker = batch[i];
                try {
                    var result = await this.poly.generateAndConvert([ticker], this.yearsOfData);
                    if (result && result.data && result.data.length > 0) {
                        // Append to cumulative file
                        var cumulative = [];
                        try {
                            if (fs.existsSync(CUMUL_FILE)) {
                                cumulative = JSON.parse(fs.readFileSync(CUMUL_FILE, 'utf8'));
                            }
                        } catch (e) { }

                        cumulative = cumulative.concat(result.data);
                        if (cumulative.length > 50000) cumulative = cumulative.slice(-50000);
                        fs.writeFileSync(CUMUL_FILE, JSON.stringify(cumulative));

                        newSamples += result.mlSamples;
                        console.log('  ✅ ' + ticker + ': +' + result.mlSamples + ' samples (total: ' + cumulative.length + ')');
                    }
                    this.progress.completedTickers.push(ticker);
                } catch (e) {
                    console.error('  ❌ ' + ticker + ': ' + e.message);
                    this.progress.errors.push({ ticker: ticker, error: e.message, at: new Date().toISOString() });
                    this.progress.completedTickers.push(ticker); // Skip it, don't retry forever
                }
            }

            // Retrain models if we added significant data
            if (newSamples > 100 && mlCalibrator) {
                try {
                    var cumulative = JSON.parse(fs.readFileSync(CUMUL_FILE, 'utf8'));
                    var recent = cumulative.slice(Math.floor(cumulative.length * 0.6));
                    mlCalibrator.train(recent, 'dayTrade');
                    mlCalibrator.train(cumulative, 'swing');
                    var st = mlCalibrator.getStatus();
                    console.log('🧠 ML Scheduler retrained: dayTrade=' + st.dayTrade.accuracy + '% (' + recent.length + ') | swing=' + st.swing.accuracy + '% (' + cumulative.length + ')');
                } catch (e) {
                    console.error('ML Scheduler retrain error:', e.message);
                }
            }

            this.progress.totalSamplesGenerated += newSamples;
            this.progress.lastRun = new Date().toISOString();
            this._saveProgress();

        } catch (e) {
            console.error('ML Scheduler cycle error:', e.message);
        }

        this.isRunning = false;
        return newSamples;
    }

    getStatus() {
        var completed = this.progress.completedTickers.length;
        var total = ALL_TICKERS.length;
        return {
            completed: completed,
            total: total,
            pct: Math.round(completed / total * 100),
            remaining: total - completed,
            totalSamples: this.progress.totalSamplesGenerated,
            lastRun: this.progress.lastRun,
            errors: this.progress.errors.length,
            nextBatch: this._getNextBatch()
        };
    }
}

module.exports = { MLTrainingScheduler, SECTOR_TICKERS, ALL_TICKERS };
