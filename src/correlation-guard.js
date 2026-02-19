// Correlation Guard - Cross-ticker and sector concentration risk
// Flags when portfolio has too many correlated positions

const SECTOR_MAP = {
    // Tech
    AAPL: 'Technology', MSFT: 'Technology', GOOGL: 'Technology', GOOG: 'Technology',
    META: 'Technology', AMZN: 'Technology', NVDA: 'Technology', AMD: 'Technology',
    INTC: 'Technology', CRM: 'Technology', ORCL: 'Technology', ADBE: 'Technology',
    NFLX: 'Technology', TSLA: 'Technology', AVGO: 'Technology', QCOM: 'Technology',
    MU: 'Technology', MRVL: 'Technology', AMAT: 'Technology', LRCX: 'Technology',
    // Financials
    JPM: 'Financials', BAC: 'Financials', GS: 'Financials', MS: 'Financials',
    WFC: 'Financials', C: 'Financials', BLK: 'Financials', SCHW: 'Financials',
    V: 'Financials', MA: 'Financials', AXP: 'Financials', COF: 'Financials',
    // Healthcare
    JNJ: 'Healthcare', UNH: 'Healthcare', PFE: 'Healthcare', ABBV: 'Healthcare',
    MRK: 'Healthcare', LLY: 'Healthcare', BMY: 'Healthcare', AMGN: 'Healthcare',
    GILD: 'Healthcare', MRNA: 'Healthcare', BNTX: 'Healthcare',
    // Energy
    XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy',
    EOG: 'Energy', OXY: 'Energy', MPC: 'Energy', VLO: 'Energy',
    // Consumer
    WMT: 'Consumer', COST: 'Consumer', TGT: 'Consumer', HD: 'Consumer',
    LOW: 'Consumer', NKE: 'Consumer', SBUX: 'Consumer', MCD: 'Consumer',
    KO: 'Consumer', PEP: 'Consumer', PG: 'Consumer', DIS: 'Consumer',
    // Industrial
    BA: 'Industrial', CAT: 'Industrial', DE: 'Industrial', HON: 'Industrial',
    GE: 'Industrial', LMT: 'Industrial', RTX: 'Industrial', UPS: 'Industrial',
    // Real Estate
    SPG: 'Real Estate', AMT: 'Real Estate', PLD: 'Real Estate',
    // ETFs / Indices
    SPY: 'Index', QQQ: 'Index', IWM: 'Index', DIA: 'Index', VIX: 'Volatility'
};

class CorrelationGuard {
    constructor() {
        this.maxSameSector = 3;
        this.maxSectorPct = 60;
    }

    getSector(ticker) {
        return SECTOR_MAP[ticker.toUpperCase()] || 'Other';
    }

    // Check a set of active setups for concentration risk
    checkConcentration(activeSetups) {
        if (!activeSetups || Object.keys(activeSetups).length === 0) {
            return { warnings: [], riskLevel: 'LOW', sectors: {} };
        }

        var self = this;
        var sectorCount = {};
        var sectorDirection = {};
        var totalSetups = 0;
        var warnings = [];

        Object.keys(activeSetups).forEach(function (ticker) {
            var setup = activeSetups[ticker];
            if (!setup) return;
            var sector = self.getSector(ticker);
            totalSetups++;

            if (!sectorCount[sector]) {
                sectorCount[sector] = [];
                sectorDirection[sector] = { long: 0, short: 0 };
            }
            sectorCount[sector].push(ticker);
            if (setup.direction === 'LONG' || setup.direction === 'BULLISH') {
                sectorDirection[sector].long++;
            } else {
                sectorDirection[sector].short++;
            }
        });

        // Check for sector concentration
        Object.keys(sectorCount).forEach(function (sector) {
            var tickers = sectorCount[sector];
            var pct = Math.round(tickers.length / totalSetups * 100);

            // Too many in same sector
            if (tickers.length >= self.maxSameSector) {
                warnings.push({
                    type: 'SECTOR_CONCENTRATION',
                    level: 'HIGH',
                    message: sector + ': ' + tickers.length + ' positions (' + tickers.join(', ') + ') - ' + pct + '% of portfolio',
                    sector: sector,
                    tickers: tickers,
                    pct: pct
                });
            }

            // Same direction in same sector
            var dir = sectorDirection[sector];
            if (dir.long >= 2 && dir.short === 0) {
                warnings.push({
                    type: 'DIRECTIONAL_RISK',
                    level: 'MEDIUM',
                    message: sector + ': ' + dir.long + ' LONG positions - no hedging',
                    sector: sector,
                    direction: 'ALL_LONG'
                });
            } else if (dir.short >= 2 && dir.long === 0) {
                warnings.push({
                    type: 'DIRECTIONAL_RISK',
                    level: 'MEDIUM',
                    message: sector + ': ' + dir.short + ' SHORT positions - no hedging',
                    sector: sector,
                    direction: 'ALL_SHORT'
                });
            }
        });

        // Sector percentage threshold
        Object.keys(sectorCount).forEach(function (sector) {
            var pct = Math.round(sectorCount[sector].length / totalSetups * 100);
            if (pct > self.maxSectorPct) {
                warnings.push({
                    type: 'OVER_CONCENTRATED',
                    level: 'HIGH',
                    message: sector + ' is ' + pct + '% of all setups - over ' + self.maxSectorPct + '% limit',
                    sector: sector,
                    pct: pct
                });
            }
        });

        var riskLevel = 'LOW';
        if (warnings.some(function (w) { return w.level === 'HIGH'; })) riskLevel = 'HIGH';
        else if (warnings.length > 0) riskLevel = 'MEDIUM';

        return {
            warnings: warnings,
            riskLevel: riskLevel,
            sectors: sectorCount,
            totalSetups: totalSetups
        };
    }

    // Check if adding a new ticker would increase risk
    wouldIncrease(ticker, activeSetups) {
        var sector = this.getSector(ticker);
        var count = 0;
        Object.keys(activeSetups || {}).forEach(function (t) {
            if (SECTOR_MAP[t.toUpperCase()] === sector) count++;
        });
        return count >= this.maxSameSector - 1;
    }
}

module.exports = { CorrelationGuard, SECTOR_MAP };
