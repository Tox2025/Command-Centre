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

    async getMonthlyCalendar(year, month, earningsToday) {
        var cacheKey = year + '-' + String(month).padStart(2, '0');
        var cached = this.monthlyCache[cacheKey];
        if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
            return cached.data;
        }

        var startDate = new Date(year, month - 1, 1);
        var endDate = new Date(year, month, 0);
        var todayStr = this._formatDate(new Date());
        var calendar = {};

        // === Source 1: Use server-side state.earningsToday (already fetched) ===
        if (earningsToday) {
            var pmList = earningsToday.premarket || [];
            var ahList = earningsToday.afterhours || [];
            var enriched = earningsToday.enriched || {};

            for (var i = 0; i < pmList.length; i++) {
                var e = pmList[i];
                var dateStr = e.date || e.earnings_date || e.report_date || todayStr;
                if (!calendar[dateStr]) calendar[dateStr] = [];
                var norm = this._normalizeEarning(e, 'BMO');
                // Merge enriched data if available
                if (enriched[norm.ticker]) {
                    var enr = enriched[norm.ticker];
                    if (enr.eps_estimate) norm.epsEstimate = parseFloat(enr.eps_estimate);
                    if (enr.eps_actual) norm.epsActual = parseFloat(enr.eps_actual);
                    if (enr.revenue_estimate) norm.revenueEstimate = parseFloat(enr.revenue_estimate);
                    if (enr.revenue_actual) norm.revenueActual = parseFloat(enr.revenue_actual);
                    if (enr.beat) norm.beatMiss = enr.beat;
                    if (enr.surprise_pct) norm.surprisePct = enr.surprise_pct;
                }
                calendar[dateStr].push(norm);
            }

            for (var j = 0; j < ahList.length; j++) {
                var ae = ahList[j];
                var aDateStr = ae.date || ae.earnings_date || ae.report_date || todayStr;
                if (!calendar[aDateStr]) calendar[aDateStr] = [];
                var aNorm = this._normalizeEarning(ae, 'AMC');
                if (enriched[aNorm.ticker]) {
                    var aEnr = enriched[aNorm.ticker];
                    if (aEnr.eps_estimate) aNorm.epsEstimate = parseFloat(aEnr.eps_estimate);
                    if (aEnr.eps_actual) aNorm.epsActual = parseFloat(aEnr.eps_actual);
                    if (aEnr.revenue_estimate) aNorm.revenueEstimate = parseFloat(aEnr.revenue_estimate);
                    if (aEnr.revenue_actual) aNorm.revenueActual = parseFloat(aEnr.revenue_actual);
                    if (aEnr.beat) aNorm.beatMiss = aEnr.beat;
                    if (aEnr.surprise_pct) aNorm.surprisePct = aEnr.surprise_pct;
                }
                calendar[aDateStr].push(aNorm);
            }

            // === Source 1b: Enriched data has 200+ tickers with report_date — full month coverage ===
            var reactions = earningsToday.reactions || {};
            var monthPrefix = year + '-' + String(month).padStart(2, '0');
            var enrichedTickers = Object.keys(enriched);
            for (var ei = 0; ei < enrichedTickers.length; ei++) {
                var eTicker = enrichedTickers[ei];
                var eData = enriched[eTicker];
                var eDate = eData.report_date;
                if (!eDate) continue;
                // Only include dates in the requested month
                if (!eDate.startsWith(monthPrefix)) continue;
                // Skip if already added from premarket/afterhours
                if (calendar[eDate] && calendar[eDate].some(function(x) { return x.ticker === eTicker; })) continue;
                if (!calendar[eDate]) calendar[eDate] = [];
                var eNorm = {
                    ticker: eTicker,
                    companyName: eTicker,
                    time: 'unknown',
                    epsEstimate: eData.eps_estimate ? parseFloat(eData.eps_estimate) : null,
                    epsActual: eData.eps_actual ? parseFloat(eData.eps_actual) : null,
                    revenueEstimate: eData.revenue_estimate ? parseFloat(eData.revenue_estimate) : null,
                    revenueActual: eData.revenue_actual ? parseFloat(eData.revenue_actual) : null,
                    beatMiss: eData.beat || null,
                    surprisePct: eData.surprise_pct || null,
                    marketCap: null
                };
                // Merge reaction data (price, change) if available
                if (reactions[eTicker]) {
                    eNorm.price = reactions[eTicker].price;
                    eNorm.changePct = reactions[eTicker].change_pct;
                }
                calendar[eDate].push(eNorm);
            }

            var totalEntries = 0;
            for (var dk in calendar) { totalEntries += calendar[dk].length; }
            console.log('EarningsCalendar: loaded ' + totalEntries + ' total entries (' + pmList.length + ' BMO + ' + ahList.length + ' AMC + enriched) for month ' + monthPrefix);
        }

        // === Source 2: If no server data or looking at a different month, try UW API directly ===
        if (Object.keys(calendar).length === 0) {
            try {
                var premarket = await this.uw._fetch('/earnings/premarket');
                var pmData = this._extractEarningsArray(premarket);
                for (var pi = 0; pi < pmData.length; pi++) {
                    var pe = pmData[pi];
                    var pDate = pe.date || pe.earnings_date || pe.report_date || todayStr;
                    if (!calendar[pDate]) calendar[pDate] = [];
                    calendar[pDate].push(this._normalizeEarning(pe, 'BMO'));
                }
            } catch (err) {
                console.error('EarningsCalendar: premarket fetch error:', err.message);
            }

            try {
                var afterhours = await this.uw._fetch('/earnings/afterhours');
                var ahData = this._extractEarningsArray(afterhours);
                for (var ai = 0; ai < ahData.length; ai++) {
                    var ahe = ahData[ai];
                    var ahDate = ahe.date || ahe.earnings_date || ahe.report_date || todayStr;
                    if (!calendar[ahDate]) calendar[ahDate] = [];
                    calendar[ahDate].push(this._normalizeEarning(ahe, 'AMC'));
                }
            } catch (err) {
                console.error('EarningsCalendar: afterhours fetch error:', err.message);
            }
        }

        var result = {
            year: year,
            month: month,
            monthName: startDate.toLocaleDateString('en-US', { month: 'long' }),
            daysInMonth: endDate.getDate(),
            firstDayOfWeek: startDate.getDay(),
            calendar: calendar
        };

        // Only cache if we have actual data — don't cache empty results
        if (Object.keys(calendar).length > 0) {
            this.monthlyCache[cacheKey] = { data: result, fetchedAt: Date.now() };
            this._saveCache();
        }
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

        // ── Cache check: return cached report if less than 1 hour old ──
        var cached = this.reports[ticker];
        if (cached && cached.generatedAt) {
            var age = Date.now() - new Date(cached.generatedAt).getTime();
            if (age < 3600000) {
                console.log('EarningsReport: Returning cached report for ' + ticker + ' (age: ' + Math.round(age / 60000) + 'min)');
                return cached;
            }
        }

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
        } catch (e) { console.error('EarningsReport: Company details error for ' + ticker + ':', e.message); report.company = { name: ticker, description: 'Error fetching details' }; }

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
        } catch (e) { console.error('EarningsReport: Earnings history error for ' + ticker + ':', e.message); }

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
        } catch (e) { console.error('EarningsReport: Polygon financials error for ' + ticker + ':', e.message); }

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
        } catch (e) { console.error('EarningsReport: Step1 IV rank error for ' + ticker + ':', e.message); }

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
        } catch (e) { console.error('EarningsReport: Step1 options flow error for ' + ticker + ':', e.message); report.step1_optionsFlow.verdict = 'NO DATA'; }

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
        } catch (e) { console.error('EarningsReport: Step2 chart history error for ' + ticker + ':', e.message); report.step2_chartHistory.verdict = 'NO DATA'; }

        // ── STEP 3: Analyst / News Context (uses Polygon news) ─
        var step3Score = 0;
        try {
            // Use Polygon news to extract recent analyst mentions and sentiment
            if (this.polygon) {
                var newsData = await this.polygon._restGet('/v2/reference/news?ticker=' + ticker + '&limit=10&order=desc');
                var newsArticles = (newsData && newsData.results) ? newsData.results : [];
                var bullishMentions = 0, bearishMentions = 0;
                var recentNews = [];

                for (var ni = 0; ni < newsArticles.length; ni++) {
                    var article = newsArticles[ni];
                    var title = (article.title || '').toLowerCase();
                    var desc = (article.description || '').toLowerCase();
                    var combined = title + ' ' + desc;

                    var newsEntry = {
                        date: article.published_utc || '',
                        title: article.title || '',
                        source: article.publisher ? article.publisher.name : '',
                        url: article.article_url || ''
                    };
                    recentNews.push(newsEntry);

                    // Simple sentiment from keywords
                    if (combined.match(/upgrade|outperform|buy|bullish|beat|strong|raises|positive|overweight/)) {
                        bullishMentions++;
                        newsEntry.sentiment = 'BULLISH';
                    } else if (combined.match(/downgrade|underperform|sell|bearish|miss|weak|cuts|negative|underweight/)) {
                        bearishMentions++;
                        newsEntry.sentiment = 'BEARISH';
                    } else {
                        newsEntry.sentiment = 'NEUTRAL';
                    }
                }

                report.step3_analystCoverage.recentNews = recentNews.slice(0, 5);
                report.step3_analystCoverage.totalArticles = newsArticles.length;
                report.step3_analystCoverage.bullishMentions = bullishMentions;
                report.step3_analystCoverage.bearishMentions = bearishMentions;

                // Price target from snapshot if available
                if (report.step2_chartHistory.currentPrice && report.company.marketCap) {
                    // Use financials EPS to derive a basic P/E implied target
                    if (report.financials && report.financials.length > 0) {
                        var ttmEps = null;
                        for (var fi2 = 0; fi2 < report.financials.length; fi2++) {
                            if (report.financials[fi2].period === 'TTM' && report.financials[fi2].eps) {
                                ttmEps = report.financials[fi2].eps;
                                break;
                            }
                        }
                        if (ttmEps && ttmEps > 0) {
                            var currentPE = report.step2_chartHistory.currentPrice / ttmEps;
                            report.step3_analystCoverage.currentPE = +currentPE.toFixed(1);
                            report.step3_analystCoverage.ttmEPS = +ttmEps.toFixed(2);
                        }
                    }
                }

                step3Score = (bullishMentions - bearishMentions) * 0.2;
                step3Score = Math.max(-1, Math.min(1, step3Score));

                report.step3_analystCoverage.verdict = newsArticles.length === 0 ? 'NO DATA'
                    : step3Score > 0.3 ? 'BULLISH SENTIMENT'
                    : step3Score < -0.3 ? 'BEARISH SENTIMENT' : 'NEUTRAL';
            } else {
                report.step3_analystCoverage.verdict = 'NO DATA';
            }
            report.step3_analystCoverage.score = step3Score;
        } catch (e) { console.error('EarningsReport: Step3 news/analyst error for ' + ticker + ':', e.message); report.step3_analystCoverage.verdict = 'NO DATA'; report.step3_analystCoverage.score = 0; }

        // ── STEP 4: Financial Health & Insider Signals ────────
        var step4Score = 0;
        try {
            // Use financials data to assess company health heading into earnings
            if (report.financials && report.financials.length >= 2) {
                var quarters = report.financials.filter(function (q) { return q.period !== 'TTM' && q.period !== 'FY'; });
                if (quarters.length >= 2) {
                    var latest = quarters[0];
                    var previous = quarters[1];

                    report.step4_insiderActivity.latestRevenue = latest.revenue;
                    report.step4_insiderActivity.previousRevenue = previous.revenue;
                    report.step4_insiderActivity.latestEPS = latest.eps;
                    report.step4_insiderActivity.previousEPS = previous.eps;
                    report.step4_insiderActivity.latestNetIncome = latest.netIncome;

                    // Revenue growth
                    if (latest.revenue && previous.revenue && previous.revenue > 0) {
                        var revGrowth = ((latest.revenue - previous.revenue) / Math.abs(previous.revenue)) * 100;
                        report.step4_insiderActivity.revenueGrowthQoQ = +revGrowth.toFixed(1);
                    }
                    // EPS growth
                    if (latest.eps !== null && previous.eps !== null && previous.eps !== 0) {
                        var epsGrowth = ((latest.eps - previous.eps) / Math.abs(previous.eps)) * 100;
                        report.step4_insiderActivity.epsGrowthQoQ = +epsGrowth.toFixed(1);
                    }
                    // Profit margin
                    if (latest.revenue && latest.netIncome) {
                        var margin = (latest.netIncome / latest.revenue) * 100;
                        report.step4_insiderActivity.profitMargin = +margin.toFixed(1);
                    }

                    // Score: growing revenue & EPS = positive signal
                    if (report.step4_insiderActivity.revenueGrowthQoQ > 5) step4Score += 0.3;
                    if (report.step4_insiderActivity.revenueGrowthQoQ < -5) step4Score -= 0.3;
                    if (report.step4_insiderActivity.epsGrowthQoQ > 10) step4Score += 0.3;
                    if (report.step4_insiderActivity.epsGrowthQoQ < -10) step4Score -= 0.3;
                    if (report.step4_insiderActivity.profitMargin > 15) step4Score += 0.2;
                    if (report.step4_insiderActivity.profitMargin < 0) step4Score -= 0.3;
                    step4Score = Math.max(-1, Math.min(1, step4Score));

                    report.step4_insiderActivity.verdict = step4Score > 0.3 ? '📈 STRONG FUNDAMENTALS'
                        : step4Score < -0.3 ? '📉 WEAK FUNDAMENTALS'
                        : '📊 STABLE FUNDAMENTALS';
                } else {
                    report.step4_insiderActivity.verdict = 'LIMITED DATA';
                }
            } else {
                report.step4_insiderActivity.verdict = 'NO DATA';
            }
            report.step4_insiderActivity.score = step4Score;
        } catch (e) { console.error('EarningsReport: Step4 fundamentals error for ' + ticker + ':', e.message); report.step4_insiderActivity.verdict = 'NO DATA'; report.step4_insiderActivity.score = 0; }

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
        if (report.step3_analystCoverage.bullishMentions > 0) parts.push(report.step3_analystCoverage.bullishMentions + ' bullish news mention(s)');
        if (report.step3_analystCoverage.bearishMentions > 0) parts.push(report.step3_analystCoverage.bearishMentions + ' bearish news mention(s)');
        if (report.step4_insiderActivity.revenueGrowthQoQ > 5) parts.push('revenue growing ' + report.step4_insiderActivity.revenueGrowthQoQ + '% QoQ');
        else if (report.step4_insiderActivity.revenueGrowthQoQ < -5) parts.push('revenue declining ' + report.step4_insiderActivity.revenueGrowthQoQ + '% QoQ');
        if (report.historicalBeatRate) parts.push('historical beat rate: ' + report.historicalBeatRate + '%');

        return parts.length > 0 ? parts.join('. ') + '.' : 'Insufficient data for detailed summary.';
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
