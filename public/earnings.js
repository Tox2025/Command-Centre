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

// ── Open Report Page (full page, not modal) ──────────────
function openReport(ticker) {
    window.location.href = '/earnings-report.html?ticker=' + encodeURIComponent(ticker);
}


// ── Helper Functions ──────────────────────────────────────
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

