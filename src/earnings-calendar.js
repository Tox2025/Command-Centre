// Earnings Calendar - Filter swing trades around earnings dates
// Uses UW API to check upcoming earnings for risk flagging
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'earnings-cache.json');
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

class EarningsCalendar {
    constructor(uwClient) {
        this.uw = uwClient;
        this.cache = {};
        this._loadCache();
    }

    _loadCache() {
        try {
            if (fs.existsSync(CACHE_PATH)) {
                var data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
                if (data && data.entries) this.cache = data.entries;
            }
        } catch (e) { /* ignore */ }
    }

    _saveCache() {
        try {
            var dir = path.dirname(CACHE_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(CACHE_PATH, JSON.stringify({
                lastUpdated: new Date().toISOString(),
                entries: this.cache
            }, null, 2));
        } catch (e) { /* ignore */ }
    }

    // Fetch earnings date for a ticker (with caching)
    async fetchEarnings(ticker) {
        var cached = this.cache[ticker];
        if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
            return cached;
        }

        try {
            // Try UW API endpoint for earnings
            var data = await this.uw._fetch('/earnings/' + ticker);
            var earnings = Array.isArray(data) ? data : (data && data.data ? data.data : []);

            var now = new Date();
            var upcoming = null;

            for (var i = 0; i < earnings.length; i++) {
                var e = earnings[i];
                var dateStr = e.date || e.earnings_date || e.report_date || '';
                if (!dateStr) continue;
                var d = new Date(dateStr);
                if (d > now) {
                    if (!upcoming || d < new Date(upcoming.date)) {
                        upcoming = {
                            date: dateStr,
                            time: e.time || e.when || 'unknown',
                            estimate: e.eps_estimate || e.consensus || null
                        };
                    }
                }
            }

            var result = {
                ticker: ticker,
                nextEarnings: upcoming,
                daysUntil: upcoming ? Math.ceil((new Date(upcoming.date) - now) / (1000 * 60 * 60 * 24)) : null,
                fetchedAt: Date.now()
            };

            this.cache[ticker] = result;
            this._saveCache();
            return result;
        } catch (e) {
            // If API fails, return null (no earnings data available)
            return { ticker: ticker, nextEarnings: null, daysUntil: null, fetchedAt: Date.now() };
        }
    }

    // Check if a ticker has earnings within N days (for swing trade filtering)
    async hasEarningsWithin(ticker, days) {
        var info = await this.fetchEarnings(ticker);
        if (!info || info.daysUntil === null) return false;
        return info.daysUntil <= days && info.daysUntil >= 0;
    }

    // Get earnings risk level for swing trades
    async getEarningsRisk(ticker, holdDays) {
        var info = await this.fetchEarnings(ticker);
        if (!info || info.daysUntil === null) {
            return { level: 'UNKNOWN', message: 'No earnings data', daysUntil: null };
        }

        if (info.daysUntil <= 0) {
            return { level: 'NONE', message: 'Earnings already passed', daysUntil: info.daysUntil };
        }

        if (info.daysUntil <= holdDays) {
            return {
                level: 'HIGH',
                message: 'Earnings in ' + info.daysUntil + 'd - WITHIN hold period',
                daysUntil: info.daysUntil,
                date: info.nextEarnings.date,
                time: info.nextEarnings.time
            };
        }

        if (info.daysUntil <= holdDays + 3) {
            return {
                level: 'MEDIUM',
                message: 'Earnings in ' + info.daysUntil + 'd - close to hold period',
                daysUntil: info.daysUntil,
                date: info.nextEarnings.date,
                time: info.nextEarnings.time
            };
        }

        return {
            level: 'LOW',
            message: 'Earnings in ' + info.daysUntil + 'd - outside hold period',
            daysUntil: info.daysUntil,
            date: info.nextEarnings.date
        };
    }

    // Bulk fetch for all tickers
    async fetchAll(tickers) {
        var results = {};
        for (var i = 0; i < tickers.length; i++) {
            results[tickers[i]] = await this.fetchEarnings(tickers[i]);
        }
        return results;
    }
}

module.exports = EarningsCalendar;
