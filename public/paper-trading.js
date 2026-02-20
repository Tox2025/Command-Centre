// Paper Trading Client JS
var $ = function (id) { return document.getElementById(id); };
var ws = null, state = { tickers: [], quotes: {} };
var _closedTrades = []; // global ref for trade history click handlers
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
    // Budget
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

function fetchStats() {
    fetch('/api/paper-trades/stats').then(function (r) { return r.json(); }).then(function (s) {
        var acctValue = s.accountSize + (s.totalPnlDollar || 0) + (s.unrealizedPnlDollar || 0);
        $('statAccount').textContent = '$' + acctValue.toLocaleString('en-US', { minimumFractionDigits: 0 });
        $('statAccount').className = 'stat-value' + (acctValue >= s.accountSize ? ' positive' : ' negative');

        $('statTotalPnl').textContent = (s.totalPnlDollar >= 0 ? '+' : '') + '$' + (s.totalPnlDollar || 0).toFixed(2);
        $('statTotalPnl').className = 'stat-value' + (s.totalPnlDollar >= 0 ? ' positive' : ' negative');

        $('statUnrealizedPnl').textContent = (s.unrealizedPnl >= 0 ? '+' : '') + s.unrealizedPnl.toFixed(2) + '% ($' + ((s.unrealizedPnlTotal || s.unrealizedPnlDollar || 0) >= 0 ? '+' : '') + (s.unrealizedPnlTotal || s.unrealizedPnlDollar || 0).toFixed(2) + ')';
        $('statUnrealizedPnl').className = 'stat-value' + (s.unrealizedPnl >= 0 ? ' positive' : ' negative');

        $('statWinRate').textContent = s.closedTrades > 0 ? s.winRate + '%' : '--';
        $('statOpenTrades').textContent = s.openTrades;
        $('statTotalTrades').textContent = s.totalTrades;

        // ── Today's P&L ──
        if (s.today) {
            var tp = s.today.pnl;
            var tColor = tp >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
            var tpd = s.today.pnlDollar || 0;
            $('todayPnlValue').innerHTML = '<span style="color:' + tColor + '">' + (tp >= 0 ? '+' : '') + tp.toFixed(2) + '% <span style="font-size:14px">($' + (tpd >= 0 ? '+' : '') + tpd.toFixed(2) + ')</span></span>';
            $('todayPnlDetail').textContent = s.today.closed + ' trades | ' + s.today.wins + 'W / ' + s.today.losses + 'L | ' + s.today.winRate + '% WR';
        }

        // ── Long vs Short ──
        if (s.longStats && s.shortStats) {
            var lp = s.longStats.pnl;
            var sp = s.shortStats.pnl;
            var lCol = lp >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
            var sCol = sp >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
            var h = '';
            h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
            h += '<span style="color:#3b82f6;font-weight:600">🔼 LONG</span>';
            var lpd = s.longStats.pnlDollar || 0;
            h += '<span style="color:' + lCol + ';font-weight:700">' + (lp >= 0 ? '+' : '') + lp.toFixed(2) + '% ($' + (lpd >= 0 ? '+' : '') + lpd.toFixed(2) + ')</span>';
            h += '</div>';
            h += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:10px">' + s.longStats.trades + ' trades | ' + s.longStats.wins + 'W | ' + s.longStats.winRate + '% WR</div>';
            h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
            h += '<span style="color:#f59e0b;font-weight:600">🔽 SHORT</span>';
            var spd = s.shortStats.pnlDollar || 0;
            h += '<span style="color:' + sCol + ';font-weight:700">' + (sp >= 0 ? '+' : '') + sp.toFixed(2) + '% ($' + (spd >= 0 ? '+' : '') + spd.toFixed(2) + ')</span>';
            h += '</div>';
            h += '<div style="font-size:10px;color:var(--text-muted)">' + s.shortStats.trades + ' trades | ' + s.shortStats.wins + 'W | ' + s.shortStats.winRate + '% WR</div>';
            $('longShortBreakdown').innerHTML = h;
        }

        // ── Trade Quality ──
        var q = '';
        q += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Avg Win</span><span style="color:var(--bull, #10b981);font-weight:700">+' + (s.avgWin || 0).toFixed(2) + '% ($' + (s.avgWinDollar >= 0 ? '+' : '') + (s.avgWinDollar || 0).toFixed(2) + ')</span></div>';
        q += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Avg Loss</span><span style="color:var(--bear, #ef4444);font-weight:700">' + (s.avgLoss || 0).toFixed(2) + '% ($' + (s.avgLossDollar || 0).toFixed(2) + ')</span></div>';
        q += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Avg P&L</span><span style="font-weight:600">' + (s.avgPnl >= 0 ? '+' : '') + (s.avgPnl || 0).toFixed(2) + '%</span></div>';
        if (s.bestTrade) {
            q += '<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:10px"><span>Best</span><span style="color:var(--bull)">' + s.bestTrade.ticker + ' ' + s.bestTrade.direction + ' +' + s.bestTrade.pnl.toFixed(2) + '% ($' + (s.bestTrade.pnlPoints >= 0 ? '+' : '') + s.bestTrade.pnlPoints.toFixed(2) + ')</span></div>';
        }
        if (s.worstTrade) {
            q += '<div style="display:flex;justify-content:space-between;font-size:10px"><span>Worst</span><span style="color:var(--bear)">' + s.worstTrade.ticker + ' ' + s.worstTrade.direction + ' ' + s.worstTrade.pnl.toFixed(2) + '% ($' + (s.worstTrade.pnlPoints >= 0 ? '+' : '') + s.worstTrade.pnlPoints.toFixed(2) + ')</span></div>';
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
            th += '<th style="text-align:right;padding:4px 4px">Long P&L</th>';
            th += '<th style="text-align:right;padding:4px 4px">Short P&L</th>';
            th += '<th style="text-align:left;padding:4px 6px;width:100px"></th>';
            th += '</tr></thead><tbody>';
            s.tickerBreakdown.forEach(function (t) {
                var pnlCol = t.pnl >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
                var lCol = t.longPnl >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
                var sCol = t.shortPnl >= 0 ? 'var(--bull, #10b981)' : 'var(--bear, #ef4444)';
                var barW = Math.round(Math.abs(t.pnl) / maxPnl * 80);
                var barCol = t.pnl >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
                th += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">';
                th += '<td style="padding:5px 6px;font-weight:700">' + t.ticker + '</td>';
                th += '<td style="text-align:center;padding:5px 4px">' + t.trades + '</td>';
                th += '<td style="text-align:center;padding:5px 4px"><span style="color:var(--bull)">' + t.wins + '</span>/<span style="color:var(--bear)">' + t.losses + '</span></td>';
                // Total P&L calculation
                var totalPnl = t.pnlTotal || (t.pnlDollar * (t.avgShares || 10)); // approximate if missing
                th += '<td style="text-align:right;padding:5px 4px;color:' + pnlCol + ';font-weight:700">' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) + '% ($' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + ')</td>';
                th += '<td style="text-align:right;padding:5px 4px;color:' + lCol + ';font-size:10px">' + (t.longs > 0 ? (t.longPnl >= 0 ? '+' : '') + t.longPnl.toFixed(2) + '% (' + t.longs + ')' : '--') + '</td>';
                th += '<td style="text-align:right;padding:5px 4px;color:' + sCol + ';font-size:10px">' + (t.shorts > 0 ? (t.shortPnl >= 0 ? '+' : '') + t.shortPnl.toFixed(2) + '% (' + t.shorts + ')' : '--') + '</td>';
                th += '<td style="padding:5px 6px"><div style="height:6px;border-radius:3px;background:' + barCol + ';width:' + barW + 'px"></div></td>';
                th += '</tr>';
            });
            th += '</tbody></table>';
            $('tickerBreakdown').innerHTML = th;
        }
    }).catch(function (e) { console.error('Stats error:', e); });
}

function fetchOpenPositions() {
    fetch('/api/paper-trades').then(function (r) { return r.json(); }).then(function (trades) {
        var open = trades.filter(function (t) { return t.status === 'PENDING'; });
        $('openCount').textContent = open.length + ' position' + (open.length !== 1 ? 's' : '');

        if (open.length === 0) {
            $('openPositions').innerHTML = '<div class="pt-empty"><div class="pt-empty-icon">📋</div>No open paper trades.<br>Click "Paper Trade" on a Trade Setup from the Dashboard to start.</div>';
            return;
        }

        var h = '<div class="pt-table-wrap"><table class="pt-table"><thead><tr>';
        h += '<th>Ticker</th><th>Direction</th><th>Shares</th><th>Entry</th><th>Current</th><th>P&L</th><th>Target 1</th><th>Stop</th><th>Conf</th><th>Horizon</th><th>Opened</th><th>Session</th><th>Actions</th>';
        h += '</tr></thead><tbody>';

        open.forEach(function (t) {
            var ticker = t.ticker;
            // Prefer backend-stored currentPrice, fallback to WS quotes
            var q = (state.quotes || {})[ticker] || {};
            var current = t.currentPrice || parseFloat(q.last || q.price || t.paperEntry || 0);
            var pnl = t.unrealizedPnl || 0;
            var pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            var dirClass = t.direction === 'LONG' ? 'trade-dir-long' : 'trade-dir-short';
            var openedStr = '--';
            if (t.openTime || t.entryTime) {
                var d = new Date(t.openTime || t.entryTime);
                openedStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            }
            // Show last price update time
            var updatedStr = '';
            if (t.lastPriceUpdate) {
                var u = new Date(t.lastPriceUpdate);
                updatedStr = '<br><span style="font-size:9px;color:var(--text-muted)">📡 ' + u.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + '</span>';
            }

            var entryP = Number(t.paperEntry || t.entry || 0);
            var stopP = Number(t.stop || 0);
            var shares = t.shares || (stopP > 0 && entryP > 0 ? Math.floor(2000 / Math.abs(entryP - stopP)) : '--');

            h += '<tr>';
            h += '<td><strong>' + ticker + '</strong></td>';
            h += '<td class="' + dirClass + '">' + t.direction + '</td>';
            h += '<td>' + shares + '</td>';
            h += '<td>$' + entryP.toFixed(2) + '</td>';
            h += '<td>$' + current.toFixed(2) + updatedStr + '</td>';
            var pnlDollar = t.unrealizedPnlTotal || (t.unrealizedPnlDollar * (typeof shares === 'number' ? shares : 1));
            h += '<td class="' + pnlClass + '">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%<br><span style="font-size:10px">($' + (pnlDollar >= 0 ? '+' : '') + Number(pnlDollar).toFixed(2) + ')</span></td>';
            h += '<td style="color:var(--bull)">$' + Number(t.target1 || 0).toFixed(2) + '</td>';
            h += '<td style="color:var(--bear)">$' + Number(t.stop || 0).toFixed(2) + '</td>';
            h += '<td style="color:var(--bear)">$' + Number(t.stop || 0).toFixed(2) + '</td>';
            h += '<td>' + (t.confidence || '--') + '%</td>';
            h += '<td style="font-size:10px">' + (t.horizon || 'Swing') + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + openedStr + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + (t.session || '--') + '</td>';
            h += '<td>';
            h += '<button class="btn-chart-trade" onclick="viewOnChart(\'' + ticker + '\')">Chart</button>';
            h += '<button class="btn-close-trade" onclick="closeTrade(\'' + t.id + '\')">Close</button>';
            h += '</td>';
            h += '</tr>';
        });

        h += '</tbody></table></div>';
        $('openPositions').innerHTML = h;
    }).catch(function (e) { console.error('Open positions error:', e); });
}

function fetchTradeHistory() {
    fetch('/api/paper-trades').then(function (r) { return r.json(); }).then(function (trades) {
        var closed = trades.filter(function (t) { return t.status !== 'PENDING'; });
        $('historyCount').textContent = closed.length + ' trade' + (closed.length !== 1 ? 's' : '');

        if (closed.length === 0) {
            $('tradeHistory').innerHTML = '<div class="pt-empty"><div class="pt-empty-icon">📊</div>No closed trades yet.<br>Close an open position to see P&L results here.</div>';
            return;
        }

        var h = '<div class="pt-table-wrap"><table class="pt-table"><thead><tr>';
        h += '<th>Ticker</th><th>Direction</th><th>Shares</th><th>Entry $</th><th>Exit $</th><th>P&L</th><th>Status</th><th>Conf</th><th>Horizon</th><th>Entry Time</th><th>Exit Time</th><th>Duration</th>';
        h += '</tr></thead><tbody>';

        closed.sort(function (a, b) { return new Date(b.closedAt || b.entryTime) - new Date(a.closedAt || a.entryTime); });
        _closedTrades = closed; // store for click handler

        function fmtTime(iso) {
            if (!iso) return '--';
            var d = new Date(iso);
            var mon = d.getMonth() + 1;
            var day = d.getDate();
            var time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            return mon + '/' + day + ' ' + time;
        }

        closed.forEach(function (t) {
            var pnl = t.pnl || t.pnlPct || 0;
            var pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            var dirClass = t.direction === 'LONG' ? 'trade-dir-long' : 'trade-dir-short';
            var statusColor = t.status.includes('WIN') ? 'var(--bull)' : t.status.includes('LOSS') ? 'var(--bear)' : 'var(--text-muted)';
            var duration = '--';
            if ((t.entryTime || t.openTime) && t.closedAt) {
                var ms = new Date(t.closedAt) - new Date(t.entryTime || t.openTime);
                var hours = Math.floor(ms / 3600000);
                var mins = Math.floor((ms % 3600000) / 60000);
                if (hours > 24) duration = Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
                else if (hours > 0) duration = hours + 'h ' + mins + 'm';
                else duration = mins + 'm';
            }

            var entryP = Number(t.paperEntry || t.entry || 0);
            var stopP = Number(t.stop || 0);
            var exitP = Number(t.exitPrice || t.outcome || 0);
            var shares = t.shares || (stopP > 0 && entryP > 0 ? Math.floor(2000 / Math.abs(entryP - stopP)) : '--');

            h += '<tr>';
            h += '<td><strong class="ticker-link" onclick="showTradeOnChart(_closedTrades[' + closed.indexOf(t) + '])">' + t.ticker + '</strong></td>';
            h += '<td class="' + dirClass + '">' + t.direction + '</td>';
            h += '<td>' + shares + '</td>';
            h += '<td>$' + entryP.toFixed(2) + '</td>';
            h += '<td>$' + exitP.toFixed(2) + '</td>';
            var pnlPts = t.pnlPoints || 0;
            var pnlTotal = t.pnlTotal || (pnlPts * (typeof shares === 'number' ? shares : 1));
            h += '<td class="' + pnlClass + '">' + (pnl >= 0 ? '+' : '') + Number(pnl).toFixed(2) + '%<br><span style="font-size:10px">($' + (pnlTotal >= 0 ? '+' : '') + Number(pnlTotal).toFixed(2) + ')</span></td>';
            h += '<td style="color:' + statusColor + ';font-weight:600;font-size:10px">' + t.status + '</td>';
            h += '<td>' + (t.confidence || '--') + '%</td>';
            h += '<td style="font-size:10px">' + (t.horizon || '--') + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + fmtTime(t.entryTime || t.openTime) + '</td>';
            h += '<td style="font-size:10px;color:var(--text-muted)">' + fmtTime(t.closedAt) + '</td>';
            h += '<td style="font-size:10px">' + duration + '</td>';
            h += '</tr>';
        });

        h += '</tbody></table></div>';
        $('tradeHistory').innerHTML = h;
    }).catch(function (e) { console.error('Trade history error:', e); });
}

function closeTrade(id) {
    // console.log('Closing trade ' + id);
    // Removed confirm dialog to debug blocking issues
    fetch('/api/paper-trades/close', {
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

function showTradeOnChart(trade) {
    // Switch chart to this ticker
    var ticker = trade.ticker;
    $('ptChartTicker').value = ticker;
    loadChart(ticker, $('ptChartInterval').value);

    // Compute shares
    var entryP = Number(trade.paperEntry || trade.entry || 0);
    var stopP = Number(trade.stop || 0);
    var exitP = Number(trade.exitPrice || trade.outcome || 0);
    var shares = trade.shares || (stopP > 0 && entryP > 0 ? Math.floor(2000 / Math.abs(entryP - stopP)) : '--');
    var pnl = trade.pnl || trade.pnlPct || 0;
    var pnlPts = trade.pnlPoints || 0;
    var totalDollar = typeof shares === 'number' ? (pnlPts * shares).toFixed(2) : pnlPts.toFixed(2);
    var pnlColor = pnl >= 0 ? '#10b981' : '#ef4444';

    // Duration
    var duration = '--';
    if ((trade.entryTime || trade.openTime) && trade.closedAt) {
        var ms = new Date(trade.closedAt) - new Date(trade.entryTime || trade.openTime);
        var hours = Math.floor(ms / 3600000);
        var mins = Math.floor((ms % 3600000) / 60000);
        if (hours > 24) duration = Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
        else if (hours > 0) duration = hours + 'h ' + mins + 'm';
        else duration = mins + 'm';
    }

    // Build info panel
    var dirIcon = trade.direction === 'LONG' ? '🔼' : '🔽';
    var items = [
        { label: 'Direction', value: dirIcon + ' ' + trade.direction },
        { label: 'Shares', value: shares },
        { label: 'Entry', value: '$' + entryP.toFixed(2) },
        { label: 'Exit', value: '$' + exitP.toFixed(2) },
        { label: 'P&L %', value: '<span style="color:' + pnlColor + '">' + (pnl >= 0 ? '+' : '') + Number(pnl).toFixed(2) + '%</span>' },
        { label: 'P&L Total', value: '<span style="color:' + pnlColor + '">$' + (pnlPts >= 0 ? '+' : '') + (trade.pnlTotal || totalDollar) + '</span>' },
        { label: 'P&L Points', value: '$' + pnlPts.toFixed(2) },
        { label: 'Stop', value: '$' + stopP.toFixed(2) },
        { label: 'Status', value: trade.status },
        { label: 'Duration', value: duration }
    ];

    var gh = '';
    items.forEach(function (item) {
        gh += '<div class="trade-info-item">';
        gh += '<div class="trade-info-label">' + item.label + '</div>';
        gh += '<div class="trade-info-value">' + item.value + '</div>';
        gh += '</div>';
    });

    $('tradeInfoGrid').innerHTML = gh;
    $('tradeInfoTitle').textContent = '📊 ' + ticker + ' — ' + trade.direction + ' Trade Details';
    $('tradeInfoPanel').classList.add('active');

    // Scroll to chart
    window.scrollTo({ top: $('ptChartArea').offsetTop - 80, behavior: 'smooth' });
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
