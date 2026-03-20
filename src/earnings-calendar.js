// Earnings Calendar — Full data pipeline with 4-step pre-earnings analysis
// Uses UW API for earnings dates, options flow, analyst ratings, insider activity
// Uses Polygon API for financials, ticker details, historical price data
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'earnings-cache.json');
const REPORTS_PATH = path.join(__dirname, '..', 'data', 'earnings-reports.json');
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

class EarningsCalendar {
    constructor(uwClient, polygonClient) {
        this.uw = uwClient;
        this.polygon = polygonClient || null;
        this.cache = {};
        this.reports = {};
        this.monthlyCache = {};
        this._loadCache();
        this._loadReports();
    }

    _loadCache() {
        try {
            if (fs.existsSync(CACHE_PATH)) {
                var data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
                if (data && data.entries) this.cache = data.entries;
                if (data && data.monthly) this.monthlyCache = data.monthly;
            }
        } catch (e) { /* ignore */ }
    }

    _saveCache() {
        try {
            var dir = path.dirname(CACHE_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(CACHE_PATH, JSON.stringify({
                lastUpdated: new Date().toISOString(),
                entries: this.cache,
                monthly: this.monthlyCache
            }, null, 2));
        } catch (e) { /* ignore */ }
    }

    _loadReports() {
        try {
            if (fs.existsSync(REPORTS_PATH)) {
                this.reports = JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf8'));
            }
        } catch (e) { this.reports = {}; }
    }

    _saveReports() {
        try {
            var dir = path.dirname(REPORTS_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(REPORTS_PATH, JSON.stringify(this.reports, null, 2));
        } catch (e) { /* ignore */ }
    }

    // ══════════════════════════════════════════════════════════
    // ██  MONTHLY CALENDAR                                   ██
    // ══════════════════════════════════════════════════════════

    async getMonthlyCalendar(year, month) {
        var cacheKey = year + '-' + String(month).padStart(2, '0');
        var cached = this.monthlyCache[cacheKey];
        if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
            return cached.data;
        }

        // Build date range for the month
        var startDate = new Date(year, month - 1, 1);
        var endDate = new Date(year, month, 0); // last day of month
        var startStr = this._formatDate(startDate);
        var endStr = this._formatDate(endDate);

        // Fetch earnings for this date range
        var calendar = {};
        try {
            // Fetch premarket and afterhours earnings lists
            var premarket = await this.uw._fetch('/earnings/premarket');
            var afterhours = await this.uw._fetch('/earnings/afterhours');

            // Process premarket earnings
            var pmData = this._extractEarningsArray(premarket);
            for (var i = 0; i < pmData.length; i++) {
                var e = pmData[i];
                var dateStr = e.date || e.earnings_date || e.report_date || '';
                if (!dateStr) continue;
                if (!calendar[dateStr]) calendar[dateStr] = [];
                calendar[dateStr].push(this._normalizeEarning(e, 'BMO'));
            }

            // Process afterhours earnings
            var ahData = this._extractEarningsArray(afterhours);
            for (var j = 0; j < ahData.length; j++) {
                var ae = ahData[j];
                var aDateStr = ae.date || ae.earnings_date || ae.report_date || '';
                if (!aDateStr) continue;
                if (!calendar[aDateStr]) calendar[aDateStr] = [];
                calendar[aDateStr].push(this._normalizeEarning(ae, 'AMC'));
            }
        } catch (err) {
            console.error('EarningsCalendar: monthly fetch error:', err.message);
        }

        // Also try the general earnings endpoint for broader coverage
        try {
            // Fetch earnings for tickers in watchlist if available
            var generalData = await this.uw._fetch('/market/earnings-calendar', { from: startStr, to: endStr });
            if (generalData) {
                var genArr = this._extractEarningsArray(generalData);
                for (var k = 0; k < genArr.length; k++) {
                    var ge = genArr[k];
                    var gDateStr = ge.date || ge.earnings_date || ge.report_date || '';
                    if (!gDateStr) continue;
                    if (!calendar[gDateStr]) calendar[gDateStr] = [];
                    // Avoid duplicates
                    var ticker = (ge.ticker || ge.symbol || '').toUpperCase();
                    var exists = calendar[gDateStr].some(function (x) { return x.ticker === ticker; });
                    if (!exists) {
                        calendar[gDateStr].push(this._normalizeEarning(ge, ge.time || ge.when || 'unknown'));
                    }
                }
            }
        } catch (e) { /* general endpoint may not exist */ }

        var result = {
            year: year,
            month: month,
            monthName: startDate.toLocaleDateString('en-US', { month: 'long' }),
            daysInMonth: endDate.getDate(),
            firstDayOfWeek: startDate.getDay(),
            calendar: calendar
        };

        this.monthlyCache[cacheKey] = { data: result, fetchedAt: Date.now() };
        this._saveCache();
        return result;
    }

    // ══════════════════════════════════════════════════════════
    // ██  DAY DRILL-DOWN                                     ██
    // ══════════════════════════════════════════════════════════

    async getDayEarnings(dateStr) {
        // dateStr = 'YYYY-MM-DD'
        var year = parseInt(dateStr.substring(0, 4));
        var month = parseInt(dateStr.substring(5, 7));
        var calData = await this.getMonthlyCalendar(year, month);
        var dayEntries = (calData.calendar && calData.calendar[dateStr]) || [];

        // Enrich each entry with company details if polygon available
        if (this.polygon && dayEntries.length > 0) {
            for (var i = 0; i < Math.min(dayEntries.length, 20); i++) {
                try {
                    if (!dayEntries[i].companyName || dayEntries[i].companyName === dayEntries[i].ticker) {
                        var details = await this.polygon.getTickerDetails(dayEntries[i].ticker);
                        if (details) {
                            dayEntries[i].companyName = details.name || dayEntries[i].ticker;
                            dayEntries[i].description = details.description || '';
                            dayEntries[i].sector = details.sic_description || '';
                            dayEntries[i].marketCap = details.market_cap || null;
                            dayEntries[i].logoUrl = details.branding && details.branding.icon_url
                                ? details.branding.icon_url + '?apiKey=' + this.polygon.apiKey
                                : null;
                        }
                    }
                } catch (e) { /* skip on error */ }
            }
        }

        return {
            date: dateStr,
            dayOfWeek: new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
            totalReporting: dayEntries.length,
            bmo: dayEntries.filter(function (e) { return e.time === 'BMO'; }),
            amc: dayEntries.filter(function (e) { return e.time === 'AMC'; }),
            unknown: dayEntries.filter(function (e) { return e.time !== 'BMO' && e.time !== 'AMC'; }),
            entries: dayEntries
        };
    }

    // ══════════════════════════════════════════════════════════
    // ██  4-STEP PRE-EARNINGS REPORT                         ██
    // ══════════════════════════════════════════════════════════

    async getPreEarningsReport(ticker) {
        ticker = (ticker || '').toUpperCase();
        if (!ticker) return { error: 'No ticker provided' };

        var report = {
            ticker: ticker,
            type: 'PRE_EARNINGS',
            generatedAt: new Date().toISOString(),
            company: {},
            step1_optionsFlow: {},
            step2_chartHistory: {},
            step3_analystCoverage: {},
            step4_insiderActivity: {},
            prediction: {}
        };

        // ── Company Details ──────────────────────────────────
        try {
            if (this.polygon) {
                var details = await this.polygon.getTickerDetails(ticker);
                if (details) {
                    report.company = {
                        name: details.name || ticker,
                        description: details.description || 'No description available.',
                        sector: details.sic_description || 'Unknown',
                        marketCap: details.market_cap || null,
                        marketCapFormatted: details.market_cap ? this._formatMarketCap(details.market_cap) : 'N/A',
                        exchange: details.exchange || '',
                        logoUrl: details.branding && details.branding.icon_url
                            ? details.branding.icon_url + '?apiKey=' + this.polygon.apiKey
                            : null,
                        homepageUrl: details.homepage_url || null
                    };
                }
            }
        } catch (e) { report.company = { name: ticker, description: 'Error fetching details' }; }

        // ── Earnings Date / History ──────────────────────────
        try {
            var earnings = await this.uw._fetch('/earnings/' + ticker);
            var earningsArr = this._extractEarningsArray(earnings);
            report.earningsDate = null;
            report.earningsHistory = [];

            var now = new Date();
            for (var i = 0; i < earningsArr.length; i++) {
                var e = earningsArr[i];
                var d = new Date(e.date || e.earnings_date || e.report_date || '');
                var entry = {
                    date: e.date || e.earnings_date || e.report_date || '',
                    epsEstimate: parseFloat(e.eps_estimate || e.consensus || e.eps_consensus || 0) || null,
                    epsActual: parseFloat(e.eps_actual || e.eps || e.reported_eps || 0) || null,
                    revenueEstimate: parseFloat(e.revenue_estimate || e.rev_consensus || 0) || null,
                    revenueActual: parseFloat(e.revenue_actual || e.revenue || 0) || null,
                    time: e.time || e.when || 'unknown'
                };
                if (entry.epsEstimate && entry.epsActual) {
                    entry.epsSurprise = +(entry.epsActual - entry.epsEstimate).toFixed(4);
                    entry.epsSurprisePct = entry.epsEstimate !== 0
                        ? +((entry.epsSurprise / Math.abs(entry.epsEstimate)) * 100).toFixed(2) : 0;
                    entry.beat = entry.epsActual > entry.epsEstimate;
                }
                if (d > now && !report.earningsDate) {
                    report.earningsDate = entry;
                }
                if (d <= now) {
                    report.earningsHistory.push(entry);
                }
            }
            // Keep last 8 quarters
            report.earningsHistory = report.earningsHistory.slice(0, 8);

            // Historical beat rate
            var beats = report.earningsHistory.filter(function (h) { return h.beat === true; }).length;
            var withData = report.earningsHistory.filter(function (h) { return h.beat !== undefined; }).length;
            report.historicalBeatRate = withData > 0 ? Math.round((beats / withData) * 100) : null;
        } catch (e) { /* continue */ }

        // ── Polygon Financials (quarterly) ───────────────────
        try {
            if (this.polygon) {
                var fin = await this.polygon.getFinancials(ticker, 4);
                if (fin && fin.length > 0) {
                    report.financials = fin.map(function (q) {
                        var income = q.financials && q.financials.income_statement;
                        var eps = q.financials && q.financials.income_statement &&
                            q.financials.income_statement.basic_earnings_per_share;
                        return {
                            period: q.fiscal_period || '',
                            year: q.fiscal_year || '',
                            endDate: q.end_date || q.period_of_report_date || '',
                            revenue: income && income.revenues ? income.revenues.value : null,
                            netIncome: income && income.net_income_loss ? income.net_income_loss.value : null,
                            eps: eps ? eps.value : null
                        };
                    });
                }
            }
        } catch (e) { /* continue */ }

        // ── STEP 1: Options Flow ─────────────────────────────
        var step1Score = 0;
        try {
            var ivData = await this.uw.getIVRank(ticker);
            var ivArr = this._extractEarningsArray(ivData);
            if (ivArr && ivArr.length > 0) {
                var latest = ivArr[0];
                report.step1_optionsFlow.ivRank = parseFloat(latest.iv_rank || latest.ivRank || 0);
                report.step1_optionsFlow.ivPercentile = parseFloat(latest.iv_percentile || latest.ivPercentile || 0);
                report.step1_optionsFlow.impliedMove = parseFloat(latest.implied_move || latest.expected_move || 0);
            }
        } catch (e) { /* continue */ }

        try {
            var flowData = await this.uw.getFlowByTicker(ticker);
            var flows = this._extractEarningsArray(flowData);
            if (flows && flows.length > 0) {
                var totalPrem = 0, callPrem = 0, putPrem = 0;
                var callCount = 0, putCount = 0;
                for (var fi = 0; fi < Math.min(flows.length, 50); fi++) {
                    var f = flows[fi];
                    var prem = parseFloat(f.premium || f.total_premium || f.cost_basis || 0);
                    var pc = (f.put_call || f.option_type || f.type || '').toLowerCase();
                    if (pc.includes('call') || pc === 'c') {
                        callPrem += prem;
                        callCount++;
                    } else if (pc.includes('put') || pc === 'p') {
                        putPrem += prem;
                        putCount++;
                    }
                    totalPrem += prem;
                }
                report.step1_optionsFlow.totalPremium = totalPrem;
                report.step1_optionsFlow.callPremium = callPrem;
                report.step1_optionsFlow.putPremium = putPrem;
                report.step1_optionsFlow.callCount = callCount;
                report.step1_optionsFlow.putCount = putCount;
                report.step1_optionsFlow.putCallRatio = callCount > 0 ? +(putCount / callCount).toFixed(2) : 0;
                report.step1_optionsFlow.premiumBias = callPrem > putPrem ? 'CALLS' : putPrem > callPrem ? 'PUTS' : 'NEUTRAL';

                // Score: bullish flow = +1, bearish = -1
                if (callPrem > putPrem * 1.5) step1Score = 1;
                else if (putPrem > callPrem * 1.5) step1Score = -1;
            }
            report.step1_optionsFlow.verdict = step1Score > 0 ? 'BULLISH' : step1Score < 0 ? 'BEARISH' : 'NEUTRAL';
            report.step1_optionsFlow.score = step1Score;
        } catch (e) { report.step1_optionsFlow.verdict = 'NO DATA'; }

        // ── STEP 2: Chart & Historical Earnings Reaction ─────
        var step2Score = 0;
        try {
            if (this.polygon) {
                var today = new Date();
                var ago30 = new Date(today); ago30.setDate(ago30.getDate() - 30);
                var candles = await this.polygon.getAggregates(
                    ticker, 1, 'day',
                    this._formatDate(ago30),
                    this._formatDate(today)
                );
                if (candles && candles.length >= 2) {
                    // 20-day price move
                    var start20 = candles.length >= 20 ? candles[candles.length - 20] : candles[0];
                    var latest20 = candles[candles.length - 1];
                    var move20d = +((latest20.close - start20.close) / start20.close * 100).toFixed(2);
                    report.step2_chartHistory.move20d = move20d;
                    report.step2_chartHistory.currentPrice = latest20.close;
                    report.step2_chartHistory.price20dAgo = start20.close;

                    // Compare 20d move to anticipated move from IV
                    var anticipatedMove = report.step1_optionsFlow.impliedMove || 5;
                    report.step2_chartHistory.anticipatedMove = anticipatedMove;
                    var alreadyMoved = Math.abs(move20d) > anticipatedMove * 1.5;
                    report.step2_chartHistory.pricedIn = alreadyMoved;
                    report.step2_chartHistory.pricedInVerdict = alreadyMoved
                        ? 'Stock moved ' + Math.abs(move20d).toFixed(1) + '% vs ' + anticipatedMove.toFixed(1) + '% expected — MAY BE PRICED IN'
                        : 'Stock moved ' + Math.abs(move20d).toFixed(1) + '% vs ' + anticipatedMove.toFixed(1) + '% expected — room to move';

                    // Score: priced in = -0.5, not = +0.5
                    step2Score = alreadyMoved ? -0.5 : 0.5;
                    if (move20d > 0) step2Score += 0.25; // momentum positive
                }
            }

            // Historical earnings reactions (from last 4 earnings)
            if (report.earningsHistory && report.earningsHistory.length > 0 && this.polygon) {
                var reactions = [];
                for (var ri = 0; ri < Math.min(report.earningsHistory.length, 4); ri++) {
                    var earningDate = report.earningsHistory[ri].date;
                    if (!earningDate) continue;
                    try {
                        var ed = new Date(earningDate);
                        var before = new Date(ed); before.setDate(before.getDate() - 1);
                        var after = new Date(ed); after.setDate(after.getDate() + 2);
                        var eCandles = await this.polygon.getAggregates(
                            ticker, 1, 'day',
                            this._formatDate(before),
                            this._formatDate(after)
                        );
                        if (eCandles && eCandles.length >= 2) {
                            var preClose = eCandles[0].close;
                            var postClose = eCandles[eCandles.length - 1].close;
                            var reaction = +((postClose - preClose) / preClose * 100).toFixed(2);
                            reactions.push({
                                date: earningDate,
                                beat: report.earningsHistory[ri].beat,
                                reaction: reaction
                            });
                        }
                    } catch (e) { /* skip */ }
                }
                report.step2_chartHistory.pastReactions = reactions;
                if (reactions.length > 0) {
                    var avgReaction = reactions.reduce(function (s, r) { return s + Math.abs(r.reaction); }, 0) / reactions.length;
                    report.step2_chartHistory.avgEarningsMove = +avgReaction.toFixed(2);
                }
            }
            report.step2_chartHistory.score = step2Score;
        } catch (e) { report.step2_chartHistory.verdict = 'NO DATA'; }

        // ── STEP 3: Analyst Upgrades & Price Targets ─────────
        var step3Score = 0;
        try {
            var analystData = await this.uw._fetch('/analyst/' + ticker + '/ratings');
            var analysts = this._extractEarningsArray(analystData);
            if (analysts && analysts.length > 0) {
                var recentUpgrades = [];
                var recentDowngrades = [];
                var targets = [];
                var now10d = new Date(); now10d.setDate(now10d.getDate() - 10);

                for (var ai = 0; ai < analysts.length; ai++) {
                    var a = analysts[ai];
                    var aDate = new Date(a.date || a.rating_date || '');
                    var rating = (a.rating || a.action || a.type || '').toLowerCase();
                    var target = parseFloat(a.price_target || a.target || a.pt || 0);
                    if (target > 0) targets.push(target);

                    // Check if within last 10 days
                    if (aDate >= now10d) {
                        var entry = {
                            date: a.date || a.rating_date || '',
                            firm: a.firm || a.analyst_firm || a.analyst || '',
                            analyst: a.analyst_name || a.analyst || '',
                            rating: a.rating || a.action || '',
                            priceTarget: target,
                            previousTarget: parseFloat(a.previous_target || a.prev_pt || 0) || null,
                            comment: a.comment || a.note || a.summary || ''
                        };
                        if (rating.includes('upgrade') || rating.includes('buy') || rating.includes('outperform') ||
                            rating.includes('overweight') || rating.includes('initiated')) {
                            recentUpgrades.push(entry);
                        } else if (rating.includes('downgrade') || rating.includes('sell') || rating.includes('underperform') ||
                            rating.includes('underweight')) {
                            recentDowngrades.push(entry);
                        } else {
                            recentUpgrades.push(entry); // maintained/reiterated = mild positive
                        }
                    }
                }

                report.step3_analystCoverage.totalAnalysts = analysts.length;
                report.step3_analystCoverage.recentUpgrades = recentUpgrades;
                report.step3_analystCoverage.recentDowngrades = recentDowngrades;
                report.step3_analystCoverage.upgradesLast10d = recentUpgrades.length;
                report.step3_analystCoverage.downgradesLast10d = recentDowngrades.length;

                if (targets.length > 0) {
                    var avgTarget = targets.reduce(function (s, t) { return s + t; }, 0) / targets.length;
                    report.step3_analystCoverage.consensusTarget = +avgTarget.toFixed(2);
                    report.step3_analystCoverage.highTarget = Math.max.apply(null, targets);
                    report.step3_analystCoverage.lowTarget = Math.min.apply(null, targets);

                    if (report.step2_chartHistory.currentPrice) {
                        var upside = ((avgTarget - report.step2_chartHistory.currentPrice) / report.step2_chartHistory.currentPrice) * 100;
                        report.step3_analystCoverage.upsidePercent = +upside.toFixed(2);
                    }
                }

                // Score
                step3Score = (recentUpgrades.length - recentDowngrades.length) * 0.3;
                step3Score = Math.max(-1, Math.min(1, step3Score));

                report.step3_analystCoverage.verdict = step3Score > 0.3 ? 'BULLISH'
                    : step3Score < -0.3 ? 'BEARISH' : 'NEUTRAL';
            } else {
                report.step3_analystCoverage.verdict = 'NO DATA';
            }
            report.step3_analystCoverage.score = step3Score;
        } catch (e) { report.step3_analystCoverage.verdict = 'NO DATA'; }

        // ── STEP 4: Insider Activity ─────────────────────────
        var step4Score = 0;
        try {
            var insiderData = await this.uw._fetch('/insider/' + ticker);
            var insiders = this._extractEarningsArray(insiderData);
            if (insiders && insiders.length > 0) {
                var now30d = new Date(); now30d.setDate(now30d.getDate() - 30);
                var recentSales = [];
                var recentBuys = [];

                for (var ii = 0; ii < insiders.length; ii++) {
                    var ins = insiders[ii];
                    var insDate = new Date(ins.date || ins.filing_date || ins.transaction_date || '');
                    if (insDate < now30d) continue;

                    var txn = {
                        date: ins.date || ins.filing_date || ins.transaction_date || '',
                        name: ins.name || ins.owner_name || ins.insider_name || '',
                        title: ins.title || ins.owner_title || ins.position || '',
                        type: (ins.transaction_type || ins.type || ins.acquisition_or_disposition || '').toUpperCase(),
                        shares: parseInt(ins.shares || ins.share_count || ins.transaction_shares || 0),
                        value: parseFloat(ins.value || ins.total_value || 0)
                    };

                    var isSale = txn.type.includes('SALE') || txn.type.includes('SELL') ||
                        txn.type === 'D' || txn.type === 'S' || txn.type.includes('DISPOSITION');
                    var isBuy = txn.type.includes('BUY') || txn.type.includes('PURCHASE') ||
                        txn.type === 'A' || txn.type === 'P' || txn.type.includes('ACQUISITION');

                    if (isSale) recentSales.push(txn);
                    else if (isBuy) recentBuys.push(txn);
                }

                report.step4_insiderActivity.recentSales = recentSales.slice(0, 10);
                report.step4_insiderActivity.recentBuys = recentBuys.slice(0, 10);
                report.step4_insiderActivity.totalSalesValue = recentSales.reduce(function (s, t) { return s + t.value; }, 0);
                report.step4_insiderActivity.totalBuysValue = recentBuys.reduce(function (s, t) { return s + t.value; }, 0);
                report.step4_insiderActivity.salesCount = recentSales.length;
                report.step4_insiderActivity.buysCount = recentBuys.length;

                // Red flag: C-suite selling large amounts near earnings
                var cSuiteSales = recentSales.filter(function (s) {
                    var t = (s.title || '').toUpperCase();
                    return t.includes('CEO') || t.includes('CFO') || t.includes('COO') ||
                        t.includes('CHIEF') || t.includes('PRESIDENT') || t.includes('DIRECTOR');
                });
                report.step4_insiderActivity.cSuiteSales = cSuiteSales;
                report.step4_insiderActivity.redFlag = cSuiteSales.length > 0 && cSuiteSales.some(function (s) { return s.value > 500000; });

                // Score
                if (report.step4_insiderActivity.redFlag) step4Score = -1;
                else if (recentBuys.length > recentSales.length) step4Score = 0.5;
                else if (recentSales.length > 3) step4Score = -0.5;

                report.step4_insiderActivity.verdict = report.step4_insiderActivity.redFlag ? '🚨 RED FLAG'
                    : step4Score >= 0.5 ? '✅ INSIDER BUYING'
                        : step4Score <= -0.5 ? '⚠️ INSIDER SELLING'
                            : '✅ CLEAN';
            } else {
                report.step4_insiderActivity.verdict = 'NO DATA';
            }
            report.step4_insiderActivity.score = step4Score;
        } catch (e) { report.step4_insiderActivity.verdict = 'NO DATA'; }

        // ── FINAL PREDICTION ─────────────────────────────────
        var totalScore = step1Score + step2Score + step3Score + step4Score;
        var maxPossible = 3.75; // max from all steps
        var confidencePct = Math.min(90, Math.max(30, Math.round(50 + (totalScore / maxPossible) * 40)));

        report.prediction = {
            totalScore: +totalScore.toFixed(2),
            direction: totalScore > 0.5 ? 'BEAT' : totalScore < -0.5 ? 'MISS' : 'NEUTRAL',
            confidence: confidencePct,
            summary: this._buildPredictionSummary(report, totalScore),
            breakdown: {
                step1: { label: 'Options Flow', score: step1Score, verdict: report.step1_optionsFlow.verdict },
                step2: { label: 'Chart/Price Action', score: step2Score, verdict: report.step2_chartHistory.pricedIn ? 'PRICED IN' : 'ROOM TO MOVE' },
                step3: { label: 'Analyst Coverage', score: step3Score, verdict: report.step3_analystCoverage.verdict },
                step4: { label: 'Insider Activity', score: step4Score, verdict: report.step4_insiderActivity.verdict }
            }
        };

        // Save report
        this.reports[ticker] = report;
        this._saveReports();

        return report;
    }

    _buildPredictionSummary(report, totalScore) {
        var parts = [];
        if (report.step1_optionsFlow.verdict === 'BULLISH') parts.push('Options flow favors calls');
        else if (report.step1_optionsFlow.verdict === 'BEARISH') parts.push('Options flow favors puts');

        if (report.step2_chartHistory.pricedIn) parts.push('recent move may have priced in earnings');
        if (report.step3_analystCoverage.upgradesLast10d > 0) parts.push(report.step3_analystCoverage.upgradesLast10d + ' analyst upgrade(s) in last 10 days');
        if (report.step4_insiderActivity.redFlag) parts.push('⚠️ C-suite insider selling detected');
        if (report.historicalBeatRate) parts.push('historical beat rate: ' + report.historicalBeatRate + '%');

        return parts.join('. ') + '.';
    }

    // ══════════════════════════════════════════════════════════
    // ██  POST-EARNINGS REPORT                               ██
    // ══════════════════════════════════════════════════════════

    async getPostEarningsReport(ticker) {
        ticker = (ticker || '').toUpperCase();
        var report = {
            ticker: ticker,
            type: 'POST_EARNINGS',
            generatedAt: new Date().toISOString(),
            company: {},
            results: {},
            guidance: {},
            priceReaction: {}
        };

        // Company details
        try {
            if (this.polygon) {
                var details = await this.polygon.getTickerDetails(ticker);
                if (details) {
                    report.company = {
                        name: details.name || ticker,
                        description: details.description || '',
                        sector: details.sic_description || '',
                        marketCap: details.market_cap || null,
                        marketCapFormatted: details.market_cap ? this._formatMarketCap(details.market_cap) : 'N/A'
                    };
                }
            }
        } catch (e) { /* continue */ }

        // Latest earnings results
        try {
            var earnings = await this.uw._fetch('/earnings/' + ticker);
            var earningsArr = this._extractEarningsArray(earnings);
            if (earningsArr && earningsArr.length > 0) {
                var latest = earningsArr[0]; // most recent
                report.results = {
                    date: latest.date || latest.earnings_date || '',
                    epsEstimate: parseFloat(latest.eps_estimate || latest.consensus || 0) || null,
                    epsActual: parseFloat(latest.eps_actual || latest.eps || latest.reported_eps || 0) || null,
                    revenueEstimate: parseFloat(latest.revenue_estimate || latest.rev_consensus || 0) || null,
                    revenueActual: parseFloat(latest.revenue_actual || latest.revenue || 0) || null
                };
                if (report.results.epsEstimate && report.results.epsActual) {
                    report.results.epsSurprise = +(report.results.epsActual - report.results.epsEstimate).toFixed(4);
                    report.results.epsSurprisePct = report.results.epsEstimate !== 0
                        ? +((report.results.epsSurprise / Math.abs(report.results.epsEstimate)) * 100).toFixed(2) : 0;
                    report.results.beat = report.results.epsActual > report.results.epsEstimate;
                    report.results.verdict = report.results.beat ? 'BEAT' : 'MISS';
                }
                if (report.results.revenueEstimate && report.results.revenueActual) {
                    report.results.revenueSurprise = +(report.results.revenueActual - report.results.revenueEstimate).toFixed(0);
                    report.results.revenueSurprisePct = +((report.results.revenueSurprise / report.results.revenueEstimate) * 100).toFixed(2);
                    report.results.revenueBeat = report.results.revenueActual > report.results.revenueEstimate;
                }

                // Guidance
                report.guidance = {
                    direction: latest.guidance || latest.forward_guidance || null,
                    detail: latest.guidance_detail || latest.guidance_comment || null
                };
            }
        } catch (e) { /* continue */ }

        // Price reaction
        try {
            if (this.polygon && report.results.date) {
                var ed = new Date(report.results.date);
                var before = new Date(ed); before.setDate(before.getDate() - 1);
                var after = new Date(ed); after.setDate(after.getDate() + 2);
                var candles = await this.polygon.getAggregates(
                    ticker, 1, 'day',
                    this._formatDate(before),
                    this._formatDate(after)
                );
                if (candles && candles.length >= 2) {
                    var preClose = candles[0].close;
                    var postClose = candles[candles.length - 1].close;
                    report.priceReaction = {
                        prePrice: preClose,
                        postPrice: postClose,
                        change: +((postClose - preClose).toFixed(2)),
                        changePct: +((postClose - preClose) / preClose * 100).toFixed(2)
                    };
                }
            }
        } catch (e) { /* continue */ }

        return report;
    }

    // ══════════════════════════════════════════════════════════
    // ██  LEGACY — Swing Trade Risk (unchanged)              ██
    // ══════════════════════════════════════════════════════════

    async fetchEarnings(ticker) {
        var cached = this.cache[ticker];
        if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) return cached;

        try {
            var data = await this.uw._fetch('/earnings/' + ticker);
            var earnings = this._extractEarningsArray(data);
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
            return { ticker: ticker, nextEarnings: null, daysUntil: null, fetchedAt: Date.now() };
        }
    }

    async hasEarningsWithin(ticker, days) {
        var info = await this.fetchEarnings(ticker);
        if (!info || info.daysUntil === null) return false;
        return info.daysUntil <= days && info.daysUntil >= 0;
    }

    async getEarningsRisk(ticker, holdDays) {
        var info = await this.fetchEarnings(ticker);
        if (!info || info.daysUntil === null) return { level: 'UNKNOWN', message: 'No earnings data', daysUntil: null };
        if (info.daysUntil <= 0) return { level: 'NONE', message: 'Earnings already passed', daysUntil: info.daysUntil };
        if (info.daysUntil <= holdDays) return { level: 'HIGH', message: 'Earnings in ' + info.daysUntil + 'd - WITHIN hold period', daysUntil: info.daysUntil, date: info.nextEarnings.date, time: info.nextEarnings.time };
        if (info.daysUntil <= holdDays + 3) return { level: 'MEDIUM', message: 'Earnings in ' + info.daysUntil + 'd - close to hold period', daysUntil: info.daysUntil, date: info.nextEarnings.date, time: info.nextEarnings.time };
        return { level: 'LOW', message: 'Earnings in ' + info.daysUntil + 'd - outside hold period', daysUntil: info.daysUntil, date: info.nextEarnings.date };
    }

    async fetchAll(tickers) {
        var results = {};
        for (var i = 0; i < tickers.length; i++) {
            results[tickers[i]] = await this.fetchEarnings(tickers[i]);
        }
        return results;
    }

    // ══════════════════════════════════════════════════════════
    // ██  HELPERS                                            ██
    // ══════════════════════════════════════════════════════════

    _extractEarningsArray(data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.data)) return data.data;
        if (data && Array.isArray(data.results)) return data.results;
        if (data && Array.isArray(data.earnings)) return data.earnings;
        return [];
    }

    _normalizeEarning(e, defaultTime) {
        return {
            ticker: (e.ticker || e.symbol || '').toUpperCase(),
            companyName: e.name || e.company_name || e.company || (e.ticker || e.symbol || '').toUpperCase(),
            time: e.time || e.when || defaultTime || 'unknown',
            date: e.date || e.earnings_date || e.report_date || '',
            epsEstimate: parseFloat(e.eps_estimate || e.consensus || e.eps_consensus || 0) || null,
            epsActual: parseFloat(e.eps_actual || e.eps || e.reported_eps || 0) || null,
            revenueEstimate: parseFloat(e.revenue_estimate || e.rev_consensus || 0) || null,
            revenueActual: parseFloat(e.revenue_actual || e.revenue || 0) || null,
            marketCap: parseFloat(e.market_cap || 0) || null
        };
    }

    _formatDate(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    _formatMarketCap(val) {
        if (!val) return 'N/A';
        if (val >= 1e12) return '$' + (val / 1e12).toFixed(2) + 'T';
        if (val >= 1e9) return '$' + (val / 1e9).toFixed(2) + 'B';
        if (val >= 1e6) return '$' + (val / 1e6).toFixed(0) + 'M';
        return '$' + val.toLocaleString();
    }
}

module.exports = EarningsCalendar;
