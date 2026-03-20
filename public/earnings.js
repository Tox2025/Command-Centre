// Earnings Calendar — Frontend JavaScript
// Calendar rendering, day drill-down, 4-step report modal

var currentYear, currentMonth;
var calendarData = null;
var selectedDate = null;

// ── Initialize ────────────────────────────────────────────
(function init() {
    var now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth() + 1;
    loadCalendar();
})();

// ── Month Navigation ──────────────────────────────────────
function changeMonth(delta) {
    currentMonth += delta;
    if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    if (currentMonth < 1) { currentMonth = 12; currentYear--; }
    loadCalendar();
}

function goToday() {
    var now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth() + 1;
    loadCalendar();
    // Auto-select today
    var todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    setTimeout(function () { selectDay(todayStr); }, 500);
}

// ── Load Calendar Data ────────────────────────────────────
function loadCalendar() {
    var monthStr = currentYear + '-' + String(currentMonth).padStart(2, '0');
    document.getElementById('monthTitle').textContent = new Date(currentYear, currentMonth - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    fetch('/api/earnings/calendar?month=' + monthStr)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            calendarData = data;
            renderCalendar(data);
        })
        .catch(function (err) {
            console.error('Calendar load error:', err);
            renderEmptyCalendar();
        });
}

// ── Render Calendar Grid ──────────────────────────────────
function renderCalendar(data) {
    var grid = document.getElementById('calendarGrid');
    // Keep headers (first 7 children)
    while (grid.children.length > 7) grid.removeChild(grid.lastChild);

    var daysInMonth = data.daysInMonth || new Date(currentYear, currentMonth, 0).getDate();
    var firstDay = data.firstDayOfWeek !== undefined ? data.firstDayOfWeek : new Date(currentYear, currentMonth - 1, 1).getDay();
    var calendar = data.calendar || {};

    var today = new Date();
    var todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

    // Empty cells before first day
    for (var e = 0; e < firstDay; e++) {
        var empty = document.createElement('div');
        empty.className = 'cal-day empty';
        grid.appendChild(empty);
    }

    // Day cells
    for (var d = 1; d <= daysInMonth; d++) {
        var dateStr = currentYear + '-' + String(currentMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        var cell = document.createElement('div');
        cell.className = 'cal-day';
        if (dateStr === todayStr) cell.classList.add('today');
        if (dateStr === selectedDate) cell.classList.add('selected');
        cell.setAttribute('data-date', dateStr);
        cell.onclick = (function (ds) { return function () { selectDay(ds); }; })(dateStr);

        // Day number
        var num = document.createElement('div');
        num.className = 'cal-day-num';
        num.textContent = d;
        cell.appendChild(num);

        // Earnings dots for this day
        var dayEntries = calendar[dateStr] || [];
        if (dayEntries.length > 0) {
            var count = document.createElement('div');
            count.className = 'cal-count';
            count.textContent = dayEntries.length;
            cell.appendChild(count);

            var dotsContainer = document.createElement('div');
            dotsContainer.className = 'cal-earnings-dots';
            // Show up to 8 ticker dots, then "+N more"
            var maxDots = Math.min(dayEntries.length, 8);
            for (var i = 0; i < maxDots; i++) {
                var dot = document.createElement('span');
                dot.className = 'cal-earning-dot';
                var time = (dayEntries[i].time || '').toUpperCase();
                if (time === 'BMO') dot.classList.add('bmo');
                else if (time === 'AMC') dot.classList.add('amc');
                else dot.classList.add('unknown');
                dot.textContent = dayEntries[i].ticker || '?';
                dot.title = (dayEntries[i].companyName || dayEntries[i].ticker) + ' (' + time + ')';
                dotsContainer.appendChild(dot);
            }
            if (dayEntries.length > 8) {
                var more = document.createElement('span');
                more.className = 'cal-earning-dot unknown';
                more.textContent = '+' + (dayEntries.length - 8);
                dotsContainer.appendChild(more);
            }
            cell.appendChild(dotsContainer);
        }

        grid.appendChild(cell);
    }
}

function renderEmptyCalendar() {
    renderCalendar({ daysInMonth: new Date(currentYear, currentMonth, 0).getDate(), firstDayOfWeek: new Date(currentYear, currentMonth - 1, 1).getDay(), calendar: {} });
}

// ── Day Drill-Down ────────────────────────────────────────
function selectDay(dateStr) {
    selectedDate = dateStr;
    // Update visual selection
    document.querySelectorAll('.cal-day').forEach(function (el) {
        el.classList.toggle('selected', el.getAttribute('data-date') === dateStr);
    });

    var drillDown = document.getElementById('drillDown');
    drillDown.style.display = 'block';
    var drillTitle = document.getElementById('drillTitle');
    var drillDate = document.getElementById('drillDate');
    drillTitle.textContent = 'Loading...';
    drillDate.textContent = dateStr;

    fetch('/api/earnings/day?date=' + dateStr)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            renderDrillDown(data);
        })
        .catch(function (err) {
            drillTitle.textContent = 'Error loading data';
            console.error('Drill down error:', err);
        });
}

function renderDrillDown(data) {
    var drillTitle = document.getElementById('drillTitle');
    var dayName = data.dayOfWeek || '';
    drillTitle.textContent = dayName + ' — ' + data.totalReporting + ' Companies Reporting';

    var sections = document.getElementById('drillSections');
    sections.innerHTML = '';

    // BMO Section
    var bmoSection = document.createElement('div');
    bmoSection.className = 'drill-section';
    bmoSection.innerHTML = '<h3>Pre-Market <span class="time-badge bmo">🌅 BMO</span></h3>';
    if (data.bmo && data.bmo.length > 0) {
        bmoSection.appendChild(buildDrillTable(data.bmo));
    } else {
        bmoSection.innerHTML += '<div class="drill-empty">No pre-market earnings</div>';
    }
    sections.appendChild(bmoSection);

    // AMC Section
    var amcSection = document.createElement('div');
    amcSection.className = 'drill-section';
    amcSection.innerHTML = '<h3>After Hours <span class="time-badge amc">🌙 AMC</span></h3>';
    if (data.amc && data.amc.length > 0) {
        amcSection.appendChild(buildDrillTable(data.amc));
    } else {
        amcSection.innerHTML += '<div class="drill-empty">No after-hours earnings</div>';
    }
    sections.appendChild(amcSection);

    // Unknown time
    if (data.unknown && data.unknown.length > 0) {
        var unkSection = document.createElement('div');
        unkSection.className = 'drill-section';
        unkSection.style.gridColumn = 'span 2';
        unkSection.innerHTML = '<h3>Time TBD</h3>';
        unkSection.appendChild(buildDrillTable(data.unknown));
        sections.appendChild(unkSection);
    }
}

function buildDrillTable(entries) {
    var table = document.createElement('table');
    table.className = 'drill-table';
    table.innerHTML = '<thead><tr><th>Ticker</th><th>Company</th><th>EPS Est</th><th>Rev Est</th><th>Market Cap</th><th>Report</th></tr></thead>';
    var tbody = document.createElement('tbody');

    entries.forEach(function (e) {
        var tr = document.createElement('tr');
        tr.onclick = function () { openReport(e.ticker); };
        tr.innerHTML = '<td class="drill-ticker">' + (e.ticker || '?') + '</td>' +
            '<td>' + (e.companyName || e.ticker || '') + '</td>' +
            '<td>' + (e.epsEstimate ? '$' + e.epsEstimate.toFixed(2) : '--') + '</td>' +
            '<td>' + (e.revenueEstimate ? formatRevenue(e.revenueEstimate) : '--') + '</td>' +
            '<td class="drill-cap">' + (e.marketCap ? formatMarketCap(e.marketCap) : '--') + '</td>' +
            '<td><button style="font-size:10px;padding:3px 8px;background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);color:#818cf8;border-radius:4px;cursor:pointer" onclick="event.stopPropagation();openReport(\'' + e.ticker + '\')">📋 View</button></td>';
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    return table;
}

// ── Report Modal ──────────────────────────────────────────
function openReport(ticker) {
    var overlay = document.getElementById('reportOverlay');
    var loading = document.getElementById('reportLoading');
    var content = document.getElementById('reportContent');

    overlay.classList.add('active');
    loading.style.display = 'block';
    content.style.display = 'none';

    fetch('/api/earnings/report/' + ticker)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            loading.style.display = 'none';
            content.style.display = 'block';
            renderReport(data);
        })
        .catch(function (err) {
            loading.innerHTML = '<div style="color:#ef4444">Error loading report: ' + err.message + '</div>';
        });
}

function closeReport() {
    document.getElementById('reportOverlay').classList.remove('active');
}

// Close on overlay click (not content)
document.getElementById('reportOverlay').addEventListener('click', function (e) {
    if (e.target === this) closeReport();
});

// Close on Escape
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeReport();
});

// ── Render Report ─────────────────────────────────────────
function renderReport(report) {
    var content = document.getElementById('reportContent');
    var company = report.company || {};
    var pred = report.prediction || {};
    var step1 = report.step1_optionsFlow || {};
    var step2 = report.step2_chartHistory || {};
    var step3 = report.step3_analystCoverage || {};
    var step4 = report.step4_insiderActivity || {};

    var html = '';

    // ── Header ──
    html += '<div class="report-header">';
    html += '<div class="rh-logo">';
    if (company.logoUrl) {
        html += '<img src="' + company.logoUrl + '" alt="' + report.ticker + '" onerror="this.style.display=\'none\';this.parentElement.textContent=\'' + (report.ticker || '?').substring(0, 2) + '\'">';
    } else {
        html += (report.ticker || '?').substring(0, 2);
    }
    html += '</div>';
    html += '<div class="rh-info">';
    html += '<div class="rh-ticker">$' + report.ticker + '</div>';
    html += '<div class="rh-name">' + (company.name || report.ticker) + '</div>';
    var ed = report.earningsDate;
    if (ed) {
        html += '<div class="rh-date">📅 Earnings: ' + ed.date + ' (' + (ed.time || 'TBD') + ') &nbsp; EPS Est: ' + (ed.epsEstimate ? '$' + ed.epsEstimate.toFixed(2) : 'N/A') + '</div>';
    }
    html += '</div>';
    html += '<button class="rh-close" onclick="closeReport()">✕</button>';
    html += '</div>';

    // ── Prediction Banner ──
    var direction = pred.direction || 'NEUTRAL';
    html += '<div class="prediction-banner">';
    html += '<div>';
    html += '<div class="pred-verdict ' + direction + '">' + (direction === 'BEAT' ? '🟢 PREDICTED: BEAT' : direction === 'MISS' ? '🔴 PREDICTED: MISS' : '🟡 NEUTRAL') + '</div>';
    html += '<div class="pred-summary">' + (pred.summary || '') + '</div>';
    html += '</div>';
    html += '<div class="pred-confidence">';
    html += '<strong class="' + direction + '">' + (pred.confidence || '--') + '%</strong>';
    html += '<div style="font-size:11px;color:#64748b">Confidence</div>';
    html += '</div>';
    html += '</div>';

    // ── Company Overview ──
    html += '<div class="company-overview">';
    html += '<div class="co-desc">' + (company.description || 'No description available.') + '</div>';
    html += '<div class="co-stats">';
    html += '<div><div class="co-stat-label">Sector</div><div class="co-stat-value">' + (company.sector || 'N/A') + '</div></div>';
    html += '<div><div class="co-stat-label">Market Cap</div><div class="co-stat-value">' + (company.marketCapFormatted || 'N/A') + '</div></div>';
    html += '<div><div class="co-stat-label">Beat Rate</div><div class="co-stat-value">' + (report.historicalBeatRate !== null ? report.historicalBeatRate + '%' : 'N/A') + '</div></div>';
    html += '<div><div class="co-stat-label">Exchange</div><div class="co-stat-value">' + (company.exchange || 'N/A') + '</div></div>';
    html += '</div>';
    html += '</div>';

    // ── Report Body ──
    html += '<div class="report-body">';

    // ── STEP 1: Options Flow ──
    html += '<div class="step-card">';
    html += '<div class="step-card-header">';
    html += '<div class="step-num">Step 1 — Options Flow</div>';
    html += '<div class="step-verdict ' + verdictClass(step1.verdict) + '">' + (step1.verdict || 'NO DATA') + '</div>';
    html += '</div>';
    html += '<div class="step-data-grid">';
    html += metricBox('Put/Call Ratio', step1.putCallRatio !== undefined ? step1.putCallRatio.toFixed(2) : '--');
    html += metricBox('Call Premium', step1.callPremium ? formatPremium(step1.callPremium) : '--');
    html += metricBox('Put Premium', step1.putPremium ? formatPremium(step1.putPremium) : '--');
    html += metricBox('Premium Bias', step1.premiumBias || '--');
    html += metricBox('IV Rank', step1.ivRank !== undefined ? step1.ivRank.toFixed(1) + '%' : '--');
    html += metricBox('Implied Move', step1.impliedMove ? step1.impliedMove.toFixed(1) + '%' : '--');
    html += '</div>';
    html += '</div>';

    // ── STEP 2: Chart & Price Action ──
    html += '<div class="step-card">';
    html += '<div class="step-card-header">';
    html += '<div class="step-num">Step 2 — Chart & Price Action</div>';
    html += '<div class="step-verdict ' + (step2.pricedIn ? 'negative' : 'positive') + '">' + (step2.pricedIn ? '⚠️ MAY BE PRICED IN' : '✅ ROOM TO MOVE') + '</div>';
    html += '</div>';
    html += '<div class="step-data-grid">';
    html += metricBox('20-Day Move', step2.move20d !== undefined ? (step2.move20d > 0 ? '+' : '') + step2.move20d.toFixed(1) + '%' : '--');
    html += metricBox('Current Price', step2.currentPrice ? '$' + step2.currentPrice.toFixed(2) : '--');
    html += metricBox('Anticipated Move', step2.anticipatedMove ? step2.anticipatedMove.toFixed(1) + '%' : '--');
    html += metricBox('Avg Earnings Move', step2.avgEarningsMove ? step2.avgEarningsMove.toFixed(1) + '%' : '--');
    html += '</div>';
    // Past reactions
    if (step2.pastReactions && step2.pastReactions.length > 0) {
        html += '<div style="margin-top:12px"><div class="step-metric-label">Last ' + step2.pastReactions.length + ' Earnings Reactions</div>';
        html += '<div class="earnings-history-chart">';
        step2.pastReactions.forEach(function (r) {
            var h = Math.min(70, Math.abs(r.reaction) * 5);
            html += '<div class="eh-bar ' + (r.reaction >= 0 ? 'beat' : 'miss') + '" style="height:' + Math.max(8, h) + 'px">';
            html += '<div class="eh-bar-value">' + (r.reaction > 0 ? '+' : '') + r.reaction + '%</div>';
            html += '<div class="eh-bar-label">' + (r.date || '').substring(5) + '</div>';
            html += '</div>';
        });
        html += '</div></div>';
    }
    html += '</div>';

    // ── STEP 3: Analyst Coverage ──
    html += '<div class="step-card">';
    html += '<div class="step-card-header">';
    html += '<div class="step-num">Step 3 — Analyst Coverage & Upgrades</div>';
    html += '<div class="step-verdict ' + verdictClass(step3.verdict) + '">' + (step3.verdict || 'NO DATA') + '</div>';
    html += '</div>';
    html += '<div class="step-data-grid">';
    html += metricBox('Consensus Target', step3.consensusTarget ? '$' + step3.consensusTarget.toFixed(2) : '--');
    html += metricBox('Target Range', step3.lowTarget && step3.highTarget ? '$' + step3.lowTarget + ' - $' + step3.highTarget : '--');
    html += metricBox('Upside/Downside', step3.upsidePercent !== undefined ? (step3.upsidePercent > 0 ? '+' : '') + step3.upsidePercent.toFixed(1) + '%' : '--');
    html += metricBox('Upgrades (10d)', step3.upgradesLast10d !== undefined ? step3.upgradesLast10d : '--');
    html += metricBox('Downgrades (10d)', step3.downgradesLast10d !== undefined ? step3.downgradesLast10d : '--');
    html += metricBox('Total Analysts', step3.totalAnalysts || '--');
    html += '</div>';
    // Recent upgrades table
    if (step3.recentUpgrades && step3.recentUpgrades.length > 0) {
        html += '<table class="analyst-table"><thead><tr><th>Date</th><th>Firm</th><th>Rating</th><th>Price Target</th></tr></thead><tbody>';
        step3.recentUpgrades.slice(0, 5).forEach(function (u) {
            html += '<tr><td>' + (u.date || '').substring(0, 10) + '</td><td>' + (u.firm || '--') + '</td><td>' + (u.rating || '--') + '</td><td>' + (u.priceTarget ? '$' + u.priceTarget.toFixed(2) : '--') + '</td></tr>';
        });
        html += '</tbody></table>';
    }
    html += '</div>';

    // ── STEP 4: Insider Activity ──
    html += '<div class="step-card">';
    html += '<div class="step-card-header">';
    html += '<div class="step-num">Step 4 — Insider Activity</div>';
    var insVerdict = step4.verdict || 'NO DATA';
    html += '<div class="step-verdict ' + (insVerdict.includes('RED') ? 'negative' : insVerdict.includes('BUYING') ? 'positive' : insVerdict.includes('SELLING') ? 'negative' : 'mixed') + '">' + insVerdict + '</div>';
    html += '</div>';
    html += '<div class="step-data-grid">';
    html += metricBox('Recent Sales', step4.salesCount !== undefined ? step4.salesCount : '--');
    html += metricBox('Recent Buys', step4.buysCount !== undefined ? step4.buysCount : '--');
    html += metricBox('Total Sales Value', step4.totalSalesValue ? formatPremium(step4.totalSalesValue) : '--');
    html += metricBox('Total Buys Value', step4.totalBuysValue ? formatPremium(step4.totalBuysValue) : '--');
    html += '</div>';
    // C-suite sales warning
    if (step4.cSuiteSales && step4.cSuiteSales.length > 0) {
        html += '<div style="margin-top:10px;padding:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px">';
        html += '<div style="color:#ef4444;font-weight:700;font-size:12px;margin-bottom:6px">🚨 C-Suite / Director Sales Detected</div>';
        html += '<table class="insider-table"><thead><tr><th>Name</th><th>Title</th><th>Shares</th><th>Value</th><th>Date</th></tr></thead><tbody>';
        step4.cSuiteSales.forEach(function (s) {
            html += '<tr class="insider-sale"><td>' + (s.name || '--') + '</td><td>' + (s.title || '--') + '</td><td>' + (s.shares ? s.shares.toLocaleString() : '--') + '</td><td>' + (s.value ? formatPremium(s.value) : '--') + '</td><td>' + (s.date || '').substring(0, 10) + '</td></tr>';
        });
        html += '</tbody></table>';
        html += '</div>';
    }
    // Recent insider transactions
    if (step4.recentSales && step4.recentSales.length > 0) {
        html += '<div style="margin-top:8px"><div class="step-metric-label">All Recent Sales (30d)</div>';
        html += '<table class="insider-table"><thead><tr><th>Name</th><th>Title</th><th>Shares</th><th>Value</th><th>Date</th></tr></thead><tbody>';
        step4.recentSales.slice(0, 8).forEach(function (s) {
            html += '<tr><td>' + (s.name || '--') + '</td><td>' + (s.title || '--') + '</td><td>' + (s.shares ? s.shares.toLocaleString() : '--') + '</td><td>' + (s.value ? formatPremium(s.value) : '--') + '</td><td>' + (s.date || '').substring(0, 10) + '</td></tr>';
        });
        html += '</tbody></table></div>';
    }
    if (step4.recentBuys && step4.recentBuys.length > 0) {
        html += '<div style="margin-top:8px"><div class="step-metric-label">All Recent Buys (30d)</div>';
        html += '<table class="insider-table"><thead><tr><th>Name</th><th>Title</th><th>Shares</th><th>Value</th><th>Date</th></tr></thead><tbody>';
        step4.recentBuys.slice(0, 8).forEach(function (s) {
            html += '<tr class="insider-buy"><td>' + (s.name || '--') + '</td><td>' + (s.title || '--') + '</td><td>' + (s.shares ? s.shares.toLocaleString() : '--') + '</td><td>' + (s.value ? formatPremium(s.value) : '--') + '</td><td>' + (s.date || '').substring(0, 10) + '</td></tr>';
        });
        html += '</tbody></table></div>';
    }
    html += '</div>';

    // ── Prediction Breakdown ──
    if (pred.breakdown) {
        html += '<div class="step-card" style="border-color:rgba(99,102,241,0.4);background:rgba(99,102,241,0.05)">';
        html += '<div class="step-card-header"><div class="step-num" style="color:#34d399">📊 Prediction Breakdown</div></div>';
        html += '<div class="step-data-grid">';
        var bd = pred.breakdown;
        for (var key in bd) {
            if (bd.hasOwnProperty(key)) {
                var s = bd[key];
                html += '<div class="step-metric">';
                html += '<div class="step-metric-label">' + s.label + '</div>';
                html += '<div class="step-metric-value">' + (s.score > 0 ? '+' : '') + s.score.toFixed(2) + ' <span style="font-size:10px;color:#64748b">' + s.verdict + '</span></div>';
                html += '</div>';
            }
        }
        html += '<div class="step-metric"><div class="step-metric-label">Total Score</div><div class="step-metric-value" style="color:' + (pred.totalScore > 0 ? '#34d399' : pred.totalScore < 0 ? '#ef4444' : '#f59e0b') + '">' + (pred.totalScore > 0 ? '+' : '') + pred.totalScore.toFixed(2) + '</div></div>';
        html += '</div>';
        html += '</div>';
    }

    // ── Financials (if available) ──
    if (report.financials && report.financials.length > 0) {
        html += '<div class="step-card">';
        html += '<div class="step-card-header"><div class="step-num">📈 Quarterly Financials</div></div>';
        html += '<table class="analyst-table"><thead><tr><th>Period</th><th>Revenue</th><th>Net Income</th><th>EPS</th></tr></thead><tbody>';
        report.financials.forEach(function (q) {
            html += '<tr><td>' + (q.period || '') + ' ' + (q.year || '') + '</td><td>' + (q.revenue ? formatRevenue(q.revenue) : '--') + '</td><td>' + (q.netIncome ? formatRevenue(q.netIncome) : '--') + '</td><td>' + (q.eps !== null ? '$' + q.eps.toFixed(2) : '--') + '</td></tr>';
        });
        html += '</tbody></table>';
        html += '</div>';
    }

    html += '</div>'; // end report-body

    content.innerHTML = html;
}

// ── Helper Functions ──────────────────────────────────────
function metricBox(label, value) {
    return '<div class="step-metric"><div class="step-metric-label">' + label + '</div><div class="step-metric-value">' + value + '</div></div>';
}

function verdictClass(v) {
    if (!v) return 'mixed';
    if (v === 'BULLISH' || v === 'CLEAN' || v.includes('BUYING')) return 'BULLISH';
    if (v === 'BEARISH' || v.includes('RED') || v.includes('SELLING')) return 'BEARISH';
    return 'NEUTRAL';
}

function formatMarketCap(val) {
    if (!val) return 'N/A';
    if (val >= 1e12) return '$' + (val / 1e12).toFixed(2) + 'T';
    if (val >= 1e9) return '$' + (val / 1e9).toFixed(1) + 'B';
    if (val >= 1e6) return '$' + (val / 1e6).toFixed(0) + 'M';
    return '$' + val.toLocaleString();
}

function formatRevenue(val) {
    if (!val) return '--';
    var abs = Math.abs(val);
    var sign = val < 0 ? '-' : '';
    if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(0) + 'K';
    return sign + '$' + abs.toFixed(2);
}

function formatPremium(val) {
    if (!val) return '--';
    var abs = Math.abs(val);
    if (abs >= 1e6) return '$' + (val / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (val / 1e3).toFixed(0) + 'K';
    return '$' + val.toFixed(0);
}
