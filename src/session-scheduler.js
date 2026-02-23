// Session Scheduler — Dynamic refresh intervals and data tiering
// Manages market session detection, interval calculation, and API call budgeting

const fs = require('fs');
const path = require('path');

// Session definitions (all times in EST minutes from midnight)
const SESSIONS = [
    { name: 'OVERNIGHT', start: 1021, end: 509, intervalMs: 3600000 }, // 5:01 PM – 8:29 AM, 60 min
    { name: 'PRE_MARKET', start: 510, end: 540, intervalMs: 600000 }, // 8:30 – 9:00 AM, 10 min
    { name: 'OPEN_RUSH', start: 541, end: 560, intervalMs: 300000 }, // 9:01 – 9:20 AM, 5 min
    { name: 'POWER_OPEN', start: 561, end: 600, intervalMs: 60000 }, // 9:21 – 10:00 AM, 1 min
    { name: 'MIDDAY', start: 601, end: 900, intervalMs: 600000 }, // 10:01 AM – 3:00 PM, 10 min
    { name: 'POWER_HOUR', start: 901, end: 975, intervalMs: 300000 }, // 3:01 – 4:15 PM, 5 min
    { name: 'AFTER_HOURS', start: 976, end: 1020, intervalMs: 600000 }, // 4:16 – 5:00 PM, 10 min
];

// Data tier definitions
// HOT:  fetched every cycle
// WARM: fetched every Nth cycle
// COLD: fetched every Mth cycle
const DATA_TIERS = {
    ticker: {
        HOT: ['getStockQuote', 'getFlowByTicker', 'getDarkPoolLevels', 'getGEXByStrike', 'getHistoricalPrice', 'getOptionVolumeLevels'],
        WARM: ['getIVRank', 'getMaxPain', 'getOIChange', 'getGreeks'],
        COLD: ['getShortInterest', 'getStockState', 'getInsiderByTicker', 'getEarnings']
    },
    market: {
        HOT: ['getMarketTide', 'getFlowAlerts', 'getDarkPoolRecent', 'getNewsHeadlines', 'getMarketSpike', 'getTopNetImpact'],
        WARM: ['getTotalOptionsVolume', 'getMarketOIChange', 'getInsiderBuySells'],
        COLD: ['getCongressTrades', 'getCongressTrader', 'getCongressLateReports', 'getInsiderTransactions', 'getEarningsPremarket', 'getEarningsAfterhours']
    }
};

const WARM_EVERY = 5;  // fetch WARM data every 5th cycle
const COLD_EVERY = 15; // fetch COLD data every 15th cycle

class SessionScheduler {
    constructor(config) {
        config = config || {};
        this.cycleCount = 0;
        this.dailyCallCount = 0;
        this.dailyLimit = config.dailyLimit || 15000;
        this.safetyMargin = config.safetyMargin || 0.90; // pause at 90%
        this.lastResetDate = this._getESTDate();
        this.callLog = [];
        this.stateFilePath = config.stateFilePath || path.join(__dirname, '..', 'data', 'state-cache.json');
    }

    // ── Session Detection ─────────────────────────────────
    getESTMinutes() {
        var now = new Date();
        var estStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
        var est = new Date(estStr);
        return est.getHours() * 60 + est.getMinutes();
    }

    _getESTDate() {
        return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    }

    getCurrentSession() {
        var mins = this.getESTMinutes();
        for (var i = 0; i < SESSIONS.length; i++) {
            var s = SESSIONS[i];
            if (s.name === 'OVERNIGHT') {
                // Overnight wraps around midnight
                if (mins >= s.start || mins < s.end) return s;
            } else {
                if (mins >= s.start && mins <= s.end) return s;
            }
        }
        // Default to overnight
        return SESSIONS[0];
    }

    getSessionInterval() {
        return this.getCurrentSession().intervalMs;
    }

    getSessionName() {
        return this.getCurrentSession().name;
    }

    // Check if today is a market day (Mon-Fri, not a holiday)
    isMarketDay() {
        var now = new Date();
        var estStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
        var est = new Date(estStr);
        var day = est.getDay(); // 0=Sun, 6=Sat
        return day >= 1 && day <= 5;
    }

    // Check if market is open for trading (not overnight/weekend)
    isTradingSession() {
        if (!this.isMarketDay()) return false;
        var session = this.getSessionName();
        // Only trade during active sessions, NOT overnight
        return ['PRE_MARKET', 'OPEN_RUSH', 'POWER_OPEN', 'MIDDAY', 'POWER_HOUR', 'AFTER_HOURS'].indexOf(session) >= 0;
    }

    // ── Data Tiering ──────────────────────────────────────
    getDataTier() {
        this.cycleCount++;
        var isCold = (this.cycleCount % COLD_EVERY === 0);
        var isWarm = (this.cycleCount % WARM_EVERY === 0);

        if (isCold) return 'COLD'; // COLD includes WARM + HOT
        if (isWarm) return 'WARM'; // WARM includes HOT
        return 'HOT';
    }

    shouldFetchTicker(endpoint, tier) {
        if (DATA_TIERS.ticker.HOT.indexOf(endpoint) >= 0) return true;
        if (tier === 'HOT') return false;
        if (DATA_TIERS.ticker.WARM.indexOf(endpoint) >= 0) return true;
        if (tier === 'WARM') return false;
        if (DATA_TIERS.ticker.COLD.indexOf(endpoint) >= 0) return true;
        return false;
    }

    shouldFetchMarket(endpoint, tier) {
        if (DATA_TIERS.market.HOT.indexOf(endpoint) >= 0) return true;
        if (tier === 'HOT') return false;
        if (DATA_TIERS.market.WARM.indexOf(endpoint) >= 0) return true;
        if (tier === 'WARM') return false;
        if (DATA_TIERS.market.COLD.indexOf(endpoint) >= 0) return true;
        return false;
    }

    // ── API Call Budget ───────────────────────────────────
    trackCall(endpoint) {
        // Reset counter at 8 PM EST (UW resets daily)
        var today = this._getESTDate();
        if (today !== this.lastResetDate) {
            console.log('📊 API budget reset — yesterday used: ' + this.dailyCallCount + ' calls');
            this.dailyCallCount = 0;
            this.lastResetDate = today;
        }
        this.dailyCallCount++;
    }

    trackCalls(count) {
        var today = this._getESTDate();
        if (today !== this.lastResetDate) {
            console.log('📊 API budget reset — yesterday used: ' + this.dailyCallCount + ' calls');
            this.dailyCallCount = 0;
            this.lastResetDate = today;
        }
        this.dailyCallCount += count;
    }

    isWithinBudget() {
        return this.dailyCallCount < (this.dailyLimit * this.safetyMargin);
    }

    getBudget() {
        var used = this.dailyCallCount;
        var limit = this.dailyLimit;
        var remaining = limit - used;
        var pct = Math.round(used / limit * 100);
        return {
            used: used,
            limit: limit,
            remaining: remaining,
            pct: pct,
            safe: this.isWithinBudget(),
            session: this.getSessionName(),
            interval: this.getSessionInterval() / 1000,
            cycle: this.cycleCount,
            tier: this.cycleCount % COLD_EVERY === 0 ? 'COLD' :
                this.cycleCount % WARM_EVERY === 0 ? 'WARM' : 'HOT'
        };
    }

    // ── State Persistence ─────────────────────────────────
    saveState(state) {
        try {
            var dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            var saveData = {
                savedAt: new Date().toISOString(),
                dailyCallCount: this.dailyCallCount,
                cycleCount: this.cycleCount,
                state: state
            };
            fs.writeFileSync(this.stateFilePath, JSON.stringify(saveData), 'utf8');
        } catch (e) {
            console.error('State save error:', e.message);
        }
    }

    loadState() {
        try {
            if (!fs.existsSync(this.stateFilePath)) return null;
            var raw = fs.readFileSync(this.stateFilePath, 'utf8');
            var data = JSON.parse(raw);

            // Restore call counter if same day
            if (data.savedAt) {
                var savedDate = new Date(data.savedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
                if (savedDate === this._getESTDate()) {
                    this.dailyCallCount = data.dailyCallCount || 0;
                    this.cycleCount = data.cycleCount || 0;
                    console.log('📂 Restored state — ' + this.dailyCallCount + ' API calls used today, cycle #' + this.cycleCount);
                } else {
                    console.log('📂 Loaded cached state (new day, counter reset)');
                }
            }
            return data.state || null;
        } catch (e) {
            console.error('State load error:', e.message);
            return null;
        }
    }

    // ── Logging ───────────────────────────────────────────
    logCycle(tier, tickerCount, callCount) {
        var session = this.getSessionName();
        var interval = this.getSessionInterval() / 1000;
        var budget = this.getBudget();
        console.log(
            '📊 Cycle #' + this.cycleCount +
            ' | ' + session +
            ' | Tier: ' + tier +
            ' | ' + callCount + ' calls (' + budget.pct + '% of daily limit)' +
            ' | Next in ' + interval + 's'
        );
    }
}

module.exports = { SessionScheduler, DATA_TIERS, SESSIONS, WARM_EVERY, COLD_EVERY };
