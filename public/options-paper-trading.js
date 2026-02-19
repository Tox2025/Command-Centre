// Options Paper Trading Client JS
var $ = function (id) { return document.getElementById(id); };
var ws = null, state = { tickers: [], quotes: {} };
var ptChart = null;
var sColors = { PRE_MARKET: '#f59e0b', OPEN: '#10b981', MIDDAY: '#3b82f6', POWER_HOUR: '#8b5cf6', POST_MARKET: '#f59e0b', CLOSED: '#64748b', LOADING: '#64748b' };
var sLabels = { PRE_MARKET: 'PRE-MKT', OPEN: 'OPEN', MIDDAY: 'MIDDAY', POWER_HOUR: 'PWR HOUR', POST_MARKET: 'POST-MKT', CLOSED: 'CLOSED', LOADING: 'LOADING' };

function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = function () {
        $('statusDot').className = 'status-dot connected';
        $('lastUpdate').textContent = 'Connected';
    };
    ws.onclose = function () {
        $('statusDot').className = 'status-dot';
        $('lastUpdate').textContent = 'Reconnecting...';
        setTimeout(connect, 3000);
    };
    ws.onmessage = function (e) {
        var msg = JSON.parse(e.data);
        if (msg.type === 'full_state') {
            state = msg.data;
            updateSessionBadge();
            updateTickerSelect();
            refreshTrades();
        }
    };
}

function updateSessionBadge() {
    try {
        $('sessionBadge').textContent = sLabels[state.session] || state.session;
        $('sessionBadge').style.background = sColors[state.session] || '#64748b';
        if (state.lastUpdate) $('lastUpdate').textContent = 'Updated: ' + new Date(state.lastUpdate).toLocaleTimeString();
    } catch (e) { }
    fetch('/api/budget').then(function (r) { return r.json(); }).then(function (b) {
        var pct = b.pct || 0;
        var color = pct < 50 ? '#10b981' : pct < 80 ? '#f59e0b' : '#ef4444';
        $('budgetBadge').innerHTML = '\u26a1 ' + b.used + '/' + b.limit;
        $('budgetBadge').style.color = color;
    }).catch(function () { });
}

function updateTickerSelect() {
    var sel = $('ptChartTicker');
    if (!sel || !state.tickers) return;
    var current = sel.value;
    var opts = '';
    state.tickers.forEach(function (t) {
        opts += '<option value="' + t + '"' + (t === current ? ' selected' : '') + '>' + t + '</option>';
    });
    sel.innerHTML = opts;
}

function loadChart(ticker, interval) {
    var container = $('ptChartArea');
    if (!container) return;
    container.innerHTML = '';
    try {
        ptChart = new TradingView.widget({
            autosize: true,
            symbol: ticker || 'TSLA',
            interval: interval || 'D',
            timezone: 'America/New_York',
            theme: 'dark',
            style: '1',
            locale: 'en',
            toolbar_bg: '#0f172a',
            enable_publishing: false,
            allow_symbol_change: true,
            container_id: 'ptChartArea',
            hide_side_toolbar: false,
            studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies', 'MAExp@tv-basicstudies'],
            withdateranges: true,
            details: true,
            calendar: false
        });
    } catch (e) {
        container.innerHTML = '<div style="padding:20px;color:#94a3b8">Chart loading...</div>';
    }
}

function refreshTrades() {
    fetchStats();
    fetchOpenPositions();
    fetchTradeHistory();
}

// ── Stats ────────────────────────────────────────────
function fetchStats() {
    fetch('/api/options-paper/stats').then(function (r) { return r.json(); }).then(function (s) {
        var acctValue = 100000 + s.totalPnl + s.unrealizedPnl;
        $('statAccount').textContent = '$' + acctValue.toLocaleString('en-US', { minimumFractionDigits: 0 });
        $('statAccount').className = 'stat-value' + (acctValue >= 100000 ? ' positive' : ' negative');

        $('statTotalPnl').textContent = (s.totalPnl >= 0 ? '+' : '') + '$' + s.totalPnl.toFixed(2);
        $('statTotalPnl').className = 'stat-value' + (s.totalPnl >= 0 ? ' positive' : ' negative');

        $('statUnrealizedPnl').textContent = (s.unrealizedPnl >= 0 ? '+' : '') + '$' + s.unrealizedPnl.toFixed(2);
        $('statUnrealizedPnl').className = 'stat-value' + (s.unrealizedPnl >= 0 ? ' positive' : ' negative');

        $('statWinRate').textContent = s.closedTrades > 0 ? s.winRate + '%' : '--';
        $('statOpenTrades').textContent = s.openPositions;
        $('statTotalTrades').textContent = s.totalTrades;

        // ── Today's P&L ──
        if (s.today) {
            var tp = s.today.pnl;
            var tColor = tp >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
            $('todayPnlValue').innerHTML = '<span style="color:' + tColor + '">' + (tp >= 0 ? '+' : '') + '$' + tp.toFixed(2) + '</span>';
            $('todayPnlDetail').textContent = s.today.closed + ' trades | ' + s.today.wins + 'W / ' + s.today.losses + 'L | ' + s.today.winRate + '% WR';
        }

        // ── Call vs Put ──
        if (s.callStats && s.putStats) {
            var cp = s.callStats.pnl;
            var pp = s.putStats.pnl;
            var cCol = cp >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
            var pCol = pp >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
            var h = '';
            h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
            h += '<span style="color:#4ade80;font-weight:600">📈 CALLS</span>';
            h += '<span style="color:' + cCol + ';font-weight:700">' + (cp >= 0 ? '+' : '') + '$' + cp.toFixed(2) + '</span>';
            h += '</div>';
            h += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:10px">' + s.callStats.trades + ' trades | ' + s.callStats.wins + 'W | ' + s.callStats.winRate + '% WR</div>';
            h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
            h += '<span style="color:#f87171;font-weight:600">📉 PUTS</span>';
            h += '<span style="color:' + pCol + ';font-weight:700">' + (pp >= 0 ? '+' : '') + '$' + pp.toFixed(2) + '</span>';
            h += '</div>';
            h += '<div style="font-size:10px;color:var(--text-muted)">' + s.putStats.trades + ' trades | ' + s.putStats.wins + 'W | ' + s.putStats.winRate + '% WR</div>';
            $('callPutBreakdown').innerHTML = h;
        }

        // ── Trade Quality ──
        var q = '';
        q += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Avg Win</span><span style="color:var(--bull, #10b981);font-weight:700">+' + (s.avgWinPct || 0).toFixed(2) + '%</span></div>';
        q += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Avg Loss</span><span style="color:var(--bear, #ef4444);font-weight:700">' + (s.avgLossPct || 0).toFixed(2) + '%</span></div>';
        q += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Avg P&L</span><span style="font-weight:600">' + (s.avgPnl >= 0 ? '+' : '') + (s.avgPnl || 0).toFixed(2) + '%</span></div>';
        if (s.bestTrade) {
            q += '<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:10px"><span>Best</span><span style="color:var(--bull)">' + s.bestTrade.ticker + ' ' + s.bestTrade.optionType.toUpperCase() + ' $' + s.bestTrade.strike + ' +$' + s.bestTrade.pnl.toFixed(2) + '</span></div>';
        }
        if (s.worstTrade) {
            q += '<div style="display:flex;justify-content:space-between;font-size:10px"><span>Worst</span><span style="color:var(--bear)">' + s.worstTrade.ticker + ' ' + s.worstTrade.optionType.toUpperCase() + ' $' + s.worstTrade.strike + ' $' + s.worstTrade.pnl.toFixed(2) + '</span></div>';
        }
        $('tradeQuality').innerHTML = q;

        // ── Per-Ticker Breakdown ──
        if (s.tickerBreakdown && s.tickerBreakdown.length > 0) {
            var maxPnl = Math.max.apply(null, s.tickerBreakdown.map(function (t) { return Math.abs(t.pnl); })) || 1;
            var th = '<table style="width:100%;border-collapse:collapse;font-size:11px">';
            th += '<thead><tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">';
            th += '<th style="text-align:left;padding:4px 6px">Ticker</th>';
            th += '<th style="text-align:center;padding:4px 4px">Trades</th>';
            th += '<th style="text-align:center;padding:4px 4px">W/L</th>';
            th += '<th style="text-align:right;padding:4px 4px">Total P&L</th>';
            th += '<th style="text-align:right;padding:4px 4px">Call P&L</th>';
            th += '<th style="text-align:right;padding:4px 4px">Put P&L</th>';
            th += '<th style="text-align:left;padding:4px 6px;width:100px"></th>';
            th += '</tr></thead><tbody>';
            s.tickerBreakdown.forEach(function (t) {
                var pnlCol = t.pnl >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
                var cCol = t.callPnl >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
                var pCol = t.putPnl >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
                var barW = Math.round(Math.abs(t.pnl) / maxPnl * 80);
                var barCol = t.pnl >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
                th += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">';
                th += '<td style="padding:5px 6px;font-weight:700">' + t.ticker + '</td>';
                th += '<td style="text-align:center;padding:5px 4px">' + t.trades + '</td>';
                th += '<td style="text-align:center;padding:5px 4px"><span style="color:var(--bull)">' + t.wins + '</span>/<span style="color:var(--bear)">' + t.losses + '</span></td>';
                th += '<td style="text-align:right;padding:5px 4px;color:' + pnlCol + ';font-weight:700">' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2) + '</td>';
                th += '<td style="text-align:right;padding:5px 4px;color:' + cCol + ';font-size:10px">' + (t.calls > 0 ? (t.callPnl >= 0 ? '+' : '') + '$' + t.callPnl.toFixed(2) + ' (' + t.calls + ')' : '--') + '</td>';
                th += '<td style="text-align:right;padding:5px 4px;color:' + pCol + ';font-size:10px">' + (t.puts > 0 ? (t.putPnl >= 0 ? '+' : '') + '$' + t.putPnl.toFixed(2) + ' (' + t.puts + ')' : '--') + '</td>';
                th += '<td style="padding:5px 6px"><div style="height:6px;border-radius:3px;background:' + barCol + ';width:' + barW + 'px"></div></td>';
                th += '</tr>';
            });
            th += '</tbody></table>';
            $('tickerBreakdown').innerHTML = th;
        }

        // ── By Strategy ──
        var bsHtml = '';
        for (var key in s.byStrategy) {
            var d = s.byStrategy[key];
            var wr = (d.wins + d.losses) > 0 ? Math.round(d.wins / (d.wins + d.losses) * 100) : 0;
            var pCol = d.pnl >= 0 ? 'var(--bull)' : 'var(--bear)';
            bsHtml += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px">';
            bsHtml += '<span style="color:var(--text-muted)">' + key.replace(/_/g, ' ') + '</span>';
            bsHtml += '<span style="font-weight:600;color:' + pCol + '">' + wr + '% (' + d.wins + 'W/' + d.losses + 'L) $' + d.pnl.toFixed(0) + '</span></div>';
        }
        $('byStrategy').innerHTML = bsHtml || '<div style="color:var(--text-muted);font-size:11px">No data yet</div>';

        // ── By Confidence ──
        var bcHtml = '';
        var brackets = Object.keys(s.byConfidence).sort();
        brackets.forEach(function (key) {
            var d = s.byConfidence[key];
            var wr = (d.wins + d.losses) > 0 ? Math.round(d.wins / (d.wins + d.losses) * 100) : 0;
            var pCol = d.pnl >= 0 ? 'var(--bull)' : 'var(--bear)';
            bcHtml += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px">';
            bcHtml += '<span style="color:var(--text-muted)">' + key + '</span>';
            bcHtml += '<span style="font-weight:600;color:' + pCol + '">' + wr + '% (' + d.wins + 'W/' + d.losses + 'L) $' + d.pnl.toFixed(0) + '</span></div>';
        });
        $('byConfidence').innerHTML = bcHtml || '<div style="color:var(--text-muted);font-size:11px">No data yet</div>';

    }).catch(function (e) { console.error('Stats error:', e); });
}

// ── Open Positions ───────────────────────────────────
function fetchOpenPositions() {
    fetch('/api/options-paper/trades').then(function (r) { return r.json(); }).then(function (trades) {
        var open = trades.filter(function (t) { return t.status === 'OPEN'; });
        $('openCount').textContent = open.length + ' position' + (open.length !== 1 ? 's' : '');

        if (open.length === 0) {
            $('openPositions').innerHTML = '<div class="pt-empty"><div class="pt-empty-icon">📋</div>No open options trades.<br>Use AI Auto-Enter or manual entry above.</div>';
            return;
        }

        var h = '<div class="pt-table-wrap"><table class="pt-table"><thead><tr>';
        h += '<th>Ticker</th><th>Type</th><th>Strike</th><th>DTE</th><th>Entry $</th><th>Current $</th><th>Unrlzd P&L</th><th>%</th><th>Conf</th><th>Direction</th><th>Opened</th><th>Session</th><th>Actions</th>';
        h += '</tr></thead><tbody>';

        open.forEach(function (t) {
            var daysLeft = Math.max(0, Math.ceil((new Date(t.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
            var pnlClass = t.unrealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            var typeClass = t.optionType === 'call' ? 'badge-call' : 'badge-put';
            var openedStr = '--';
            if (t.openTime) {
                var d = new Date(t.openTime);
                openedStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            }

            h += '<tr>';
            h += '<td><strong>' + t.ticker + '</strong></td>';
            h += '<td><span class="' + typeClass + '">' + t.optionType.toUpperCase() + '</span></td>';
            h += '<td>$' + t.strike + '</td>';
            h += '<td>' + daysLeft + 'd</td>';
            h += '<td>$' + t.entryPremium.toFixed(2) + '</td>';
            h += '<td>$' + (t.currentPremium || 0).toFixed(2) + '</td>';
            h += '<td class="' + pnlClass + '" style="font-weight:600">$' + (t.unrealizedPnl || 0).toFixed(2) + '</td>';
            h += '<td class="' + pnlClass + '">' + (t.unrealizedPnlPct >= 0 ? '+' : '') + (t.unrealizedPnlPct || 0).toFixed(1) + '%</td>';
            h += '<td>' + (t.confidence || '--') + '%</td>';
            h += '<td style="font-size:10px">' + (t.direction || '--') + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + openedStr + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + (t.session || '--') + '</td>';
            h += '<td>';
            h += '<button class="btn-chart-trade" onclick="viewOnChart(\'' + t.ticker + '\')">Chart</button>';
            h += '<button class="btn-close-trade" onclick="closeTrade(\'' + t.id + '\')">Close</button>';
            h += '</td>';
            h += '</tr>';
        });

        h += '</tbody></table></div>';
        $('openPositions').innerHTML = h;
    }).catch(function (e) { console.error('Open positions error:', e); });
}

// ── Trade History ────────────────────────────────────
function fetchTradeHistory() {
    fetch('/api/options-paper/trades').then(function (r) { return r.json(); }).then(function (trades) {
        var closed = trades.filter(function (t) { return t.status !== 'OPEN'; });
        $('historyCount').textContent = closed.length + ' trade' + (closed.length !== 1 ? 's' : '');

        if (closed.length === 0) {
            $('tradeHistory').innerHTML = '<div class="pt-empty"><div class="pt-empty-icon">📊</div>No closed options trades yet.<br>Close an open position to see P&L results here.</div>';
            return;
        }

        var h = '<div class="pt-table-wrap"><table class="pt-table"><thead><tr>';
        h += '<th>Ticker</th><th>Type</th><th>Strike</th><th>Entry $</th><th>Exit $</th><th>P&L</th><th>%</th><th>Outcome</th><th>Conf</th><th>Horizon</th><th>Entry Time</th><th>Exit Time</th><th>Duration</th>';
        h += '</tr></thead><tbody>';

        closed.sort(function (a, b) { return new Date(b.closeTime) - new Date(a.closeTime); });

        function fmtTime(iso) {
            if (!iso) return '--';
            var d = new Date(iso);
            var mon = d.getMonth() + 1;
            var day = d.getDate();
            var time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            return mon + '/' + day + ' ' + time;
        }

        closed.forEach(function (t) {
            var pnlClass = t.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            var typeClass = t.optionType === 'call' ? 'badge-call' : 'badge-put';
            var statusColor = t.status === 'WIN' ? 'var(--bull)' : 'var(--bear)';
            var duration = '--';
            if (t.openTime && t.closeTime) {
                var ms = new Date(t.closeTime) - new Date(t.openTime);
                var hours = Math.floor(ms / 3600000);
                var mins = Math.floor((ms % 3600000) / 60000);
                if (hours > 24) duration = Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
                else if (hours > 0) duration = hours + 'h ' + mins + 'm';
                else duration = mins + 'm';
            }

            h += '<tr>';
            h += '<td><strong>' + t.ticker + '</strong></td>';
            h += '<td><span class="' + typeClass + '">' + t.optionType.toUpperCase() + '</span></td>';
            h += '<td>$' + t.strike + '</td>';
            h += '<td>$' + t.entryPremium.toFixed(2) + '</td>';
            h += '<td>$' + (t.exitPremium || 0).toFixed(2) + '</td>';
            h += '<td class="' + pnlClass + '" style="font-weight:600">$' + t.pnl.toFixed(2) + '</td>';
            h += '<td class="' + pnlClass + '">' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(1) + '%</td>';
            h += '<td style="color:' + statusColor + ';font-weight:600;font-size:10px">' + (t.outcome || t.status) + '</td>';
            h += '<td>' + (t.confidence || '--') + '%</td>';
            h += '<td style="font-size:10px">' + (t.horizon || '--') + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + fmtTime(t.openTime) + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + fmtTime(t.closeTime) + '</td>';
            h += '<td style="font-size:10px">' + duration + '</td>';
            h += '</tr>';
        });

        h += '</tbody></table></div>';
        $('tradeHistory').innerHTML = h;
    }).catch(function (e) { console.error('Trade history error:', e); });
}

// ── Actions ──────────────────────────────────────────
function autoEnter(e) {
    var ticker = ($('qeTicker').value || '').toUpperCase().trim();
    if (!ticker) { alert('Enter a ticker'); return; }
    var btn = e && e.target ? e.target : document.querySelector('.btn-auto-enter');
    btn.disabled = true;
    btn.textContent = '⏳ Analyzing...';

    fetch('/api/options-paper/auto-enter/' + ticker, { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            btn.disabled = false;
            btn.textContent = '🤖 AI Auto-Enter';
            if (data.success) {
                var t = data.trade;
                alert('✅ Entered: ' + t.optionType.toUpperCase() + ' ' + t.ticker + ' $' + t.strike + ' @ $' + t.entryPremium);
                refreshTrades();
            } else {
                alert('⚠️ ' + (data.error || 'Could not enter trade'));
            }
        })
        .catch(function (e) {
            btn.disabled = false;
            btn.textContent = '🤖 AI Auto-Enter';
            alert('❌ Error: ' + e.message);
        });
}

function manualEntry() {
    var ticker = ($('qeTicker').value || '').toUpperCase().trim();
    var optionType = $('qeType').value;
    var strike = parseFloat($('qeStrike').value) || 0;
    var premium = parseFloat($('qePremium').value) || 0;
    var dte = parseInt($('qeDTE').value) || 30;
    var contracts = parseInt($('qeContracts').value) || 1;

    if (!ticker || !strike || !premium) {
        alert('Fill in ticker, strike, and premium');
        return;
    }

    fetch('/api/options-paper/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ticker: ticker,
            optionType: optionType,
            strategy: optionType === 'call' ? 'long_call' : 'long_put',
            strike: strike,
            dte: dte,
            premium: premium,
            contracts: contracts,
            stockPrice: 0
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.success) {
                refreshTrades();
            } else {
                alert('⚠️ ' + (data.error || 'Could not enter trade'));
            }
        })
        .catch(function (e) { alert('❌ ' + e.message); });
}

function closeTrade(id) {
    if (!confirm('Close this options trade at current market price?')) return;
    fetch('/api/options-paper/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
    }).then(function (r) { return r.json(); }).then(function (result) {
        if (result.success) {
            refreshTrades();
        } else {
            alert('Error: ' + (result.error || 'Unknown error'));
        }
    }).catch(function (e) { alert('Error closing trade: ' + e.message); });
}

function viewOnChart(ticker) {
    $('ptChartTicker').value = ticker;
    loadChart(ticker, $('ptChartInterval').value);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Init
connect();
loadChart('TSLA', 'D');
refreshTrades();

// Chart controls
$('ptChartTicker').addEventListener('change', function () {
    loadChart(this.value, $('ptChartInterval').value);
});
$('ptChartInterval').addEventListener('change', function () {
    loadChart($('ptChartTicker').value, this.value);
});

// Auto-refresh trades every 15s
setInterval(refreshTrades, 15000);
