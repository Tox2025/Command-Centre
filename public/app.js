// Trading Dashboard V2 Client
var state = { tickers: [], quotes: {}, technicals: {}, optionsFlow: [], darkPool: {}, gex: {}, marketTide: null, congressTrades: [], tradeSetups: {}, alerts: [], morningBrief: {}, lastUpdate: null, session: 'LOADING', nope: {}, flowPerStrikeIntraday: {}, analystRatings: {}, institutionActivity: {}, fdaCalendar: [] };
var ws = null, activeFilter = 'all', tvWidget = null;
var $ = function (id) { return document.getElementById(id); };
function fmt(n) { return n == null ? '--' : Number(n).toFixed(2); }
function fmtK(n) { return n == null ? '--' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n); }
function timeAgo(iso) { if (!iso) return ''; return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }
var sColors = { PRE_MARKET: '#f59e0b', OPEN: '#10b981', MIDDAY: '#3b82f6', POWER_HOUR: '#8b5cf6', POST_MARKET: '#f59e0b', CLOSED: '#64748b', LOADING: '#64748b' };
// Compute squeeze score for a ticker from state data (0-6)
function getSqueezeScore(ticker) {
    var score = 0;
    var svRaw = state.shortVolume && state.shortVolume[ticker];
    var svArr = Array.isArray(svRaw) ? svRaw : [];
    var lastSV = svArr.length > 0 ? svArr[svArr.length - 1] : null;
    if (lastSV) { var r = parseFloat(lastSV.short_volume_ratio || lastSV.short_ratio || 0); if (r > 0.5) score += 2; else if (r > 0.4) score += 1; }
    var ftdRaw = state.failsToDeliver && state.failsToDeliver[ticker];
    var ftdArr = Array.isArray(ftdRaw) ? ftdRaw : [];
    var lastFTD = ftdArr.length > 0 ? ftdArr[ftdArr.length - 1] : null;
    if (lastFTD) { var q = parseFloat(lastFTD.quantity || lastFTD.fails || 0); if (q > 1000000) score += 2; else if (q > 500000) score += 1; }
    var siRaw = state.shortInterest && state.shortInterest[ticker];
    var siObj = Array.isArray(siRaw) ? siRaw[0] : siRaw;
    if (siObj) {
        // UW doesn't return utilization — use SI% of float as proxy
        var siPct = parseFloat(siObj.percent_returned || siObj.si_pct_float || siObj.short_interest_pct || siObj.percent_of_float || 0);
        if (siPct > 100) siPct = 0; // bad data guard
        if (siPct > 20) score += 2; else if (siPct > 10) score += 1;
    }
    return score;
}
function squeezeBadge(ticker) {
    var sq = getSqueezeScore(ticker);
    if (sq >= 4) return ' <span class="badge" style="background:#ef4444;font-size:0.6rem;animation:pulse 2s infinite">SQUEEZE ' + sq + '/6</span>';
    if (sq >= 2) return ' <span class="badge" style="background:#f59e0b;font-size:0.6rem">SQUEEZE ' + sq + '/6</span>';
    return '';
}
function renderSqueeze() {
    var tb = $('squeezeBody');
    if (!tb) return;
    // Collect all tickers: watchlist + discoveries
    var allTickers = (state.tickers || []).slice();
    (state.liveDiscoveries || []).forEach(function (d) {
        if (d.ticker && allTickers.indexOf(d.ticker) < 0) allTickers.push(d.ticker);
    });
    // Build squeeze data for each ticker
    var rows = [];
    allTickers.forEach(function (t) {
        var sq = getSqueezeScore(t);
        // Get SI data
        var siRaw = state.shortInterest && state.shortInterest[t];
        var siObj = Array.isArray(siRaw) ? siRaw[0] : siRaw;
        var siPct = siObj ? parseFloat(siObj.short_interest || siObj.si_pct_float || siObj.short_percent_of_float || 0) : 0;
        var utilization = siObj ? parseFloat(siObj.utilization || siObj.borrow_utilization || 0) : 0;
        var dtc = siObj ? parseFloat(siObj.days_to_cover || siObj.dtc || 0) : 0;
        // Short volume ratio
        var svRaw = state.shortVolume && state.shortVolume[t];
        var svArr = Array.isArray(svRaw) ? svRaw : [];
        var lastSV = svArr.length > 0 ? svArr[svArr.length - 1] : null;
        var svRatio = lastSV ? parseFloat(lastSV.short_volume_ratio || lastSV.short_ratio || 0) : 0;
        // FTDs
        var ftdRaw = state.failsToDeliver && state.failsToDeliver[t];
        var ftdArr = Array.isArray(ftdRaw) ? ftdRaw : [];
        var lastFTD = ftdArr.length > 0 ? ftdArr[ftdArr.length - 1] : null;
        var ftdQty = lastFTD ? parseFloat(lastFTD.quantity || lastFTD.fails || 0) : 0;
        // Price
        var q = state.quotes[t] || {};
        var price = q.last || q.price || q.close || 0;
        var chg = q.changePercent || q.change_percent || 0;
        rows.push({ ticker: t, score: sq, siPct: siPct, svRatio: svRatio, ftdQty: ftdQty, utilization: utilization, dtc: dtc, price: price, chg: chg });
    });
    // Sort: highest squeeze score first, then by SI%
    rows.sort(function (a, b) { return b.score - a.score || b.siPct - a.siPct; });
    // Also merge shortScreener auto-discovered tickers
    if (state.shortScreener && Array.isArray(state.shortScreener)) {
        state.shortScreener.forEach(function (ss) {
            var t = ss.ticker || ss.symbol;
            if (!t) return;
            var exists = rows.find(function (r) { return r.ticker === t; });
            if (!exists) {
                rows.push({ ticker: t, score: 3, siPct: parseFloat(ss.short_interest || 0), svRatio: parseFloat(ss.short_volume_ratio || 0), ftdQty: 0, utilization: parseFloat(ss.utilization || 0), dtc: parseFloat(ss.days_to_cover || 0), price: parseFloat(ss.price || 0), chg: parseFloat(ss.change_percent || 0), discovered: true });
            }
        });
        rows.sort(function (a, b) { return b.score - a.score || b.siPct - a.siPct; });
    }
    // Only show tickers with score >= 1 (skip totally clean tickers)
    var filtered = rows.filter(function (r) { return r.score >= 1 || r.siPct > 5; });
    var countEl = $('squeezeCount');
    var hotCount = rows.filter(function (r) { return r.score >= 4; }).length;
    if (countEl) countEl.textContent = hotCount;
    var h = '';
    filtered.forEach(function (r) {
        var scoreColor = r.score >= 5 ? '#ef4444' : r.score >= 4 ? '#f97316' : r.score >= 3 ? '#f59e0b' : r.score >= 2 ? '#eab308' : '#64748b';
        var scoreLabel = r.score >= 5 ? 'EXTREME' : r.score >= 4 ? 'HIGH' : r.score >= 3 ? 'ELEVATED' : r.score >= 2 ? 'MODERATE' : 'LOW';
        var chgClass = r.chg >= 0 ? 'text-bull' : 'text-bear';
        var pulseStyle = r.score >= 4 ? 'animation:pulse 2s infinite;' : '';
        h += '<tr onclick="openTickerView(\'' + r.ticker + '\')" style="cursor:pointer">';
        h += '<td><strong>' + r.ticker + '</strong></td>';
        h += '<td><span class="badge" style="background:' + scoreColor + ';' + pulseStyle + '">' + r.score + '/6 ' + scoreLabel + '</span></td>';
        h += '<td' + (r.siPct > 15 ? ' style="color:#ef4444;font-weight:600"' : '') + '>' + (r.siPct > 0 ? r.siPct.toFixed(1) + '%' : '--') + '</td>';
        h += '<td' + (r.svRatio > 0.5 ? ' style="color:#f59e0b;font-weight:600"' : '') + '>' + (r.svRatio > 0 ? (r.svRatio * 100).toFixed(0) + '%' : '--') + '</td>';
        h += '<td>' + (r.ftdQty > 0 ? fmtK(r.ftdQty) : '--') + '</td>';
        h += '<td' + (r.utilization > 90 ? ' style="color:#ef4444;font-weight:600"' : r.utilization > 70 ? ' style="color:#f59e0b"' : '') + '>' + (r.utilization > 0 ? r.utilization.toFixed(0) + '%' : '--') + '</td>';
        h += '<td' + (r.dtc > 5 ? ' style="color:#f59e0b;font-weight:600"' : '') + '>' + (r.dtc > 0 ? r.dtc.toFixed(1) + 'd' : '--') + '</td>';
        h += '<td>$' + fmt(r.price) + '</td>';
        h += '<td class="' + chgClass + '">' + (r.chg >= 0 ? '+' : '') + fmt(r.chg) + '%</td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="9" class="empty">No squeeze candidates detected</td></tr>';
}
function renderEcon() {
    var tb = $('econBody'); if (!tb) return;
    var data = state.economicCalendar || [];
    var cnt = $('econCount'); if (cnt) cnt.textContent = data.length;
    var h = '';
    data.forEach(function (e) {
        var impact = (e.impact || e.importance || '').toUpperCase();
        var impColor = impact === 'HIGH' ? '#ef4444' : impact === 'MEDIUM' ? '#f59e0b' : '#64748b';
        h += '<tr>';
        h += '<td>' + (e.date || e.event_date || '--') + '</td>';
        h += '<td><strong>' + (e.name || e.event || e.title || '--') + '</strong></td>';
        h += '<td><span class="badge" style="background:' + impColor + '">' + (impact || 'LOW') + '</span></td>';
        h += '<td>' + (e.previous || e.prior || '--') + '</td>';
        h += '<td>' + (e.forecast || e.consensus || '--') + '</td>';
        h += '<td>' + (e.actual || '--') + '</td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="6" class="empty">No upcoming events</td></tr>';
}
function renderImpact() {
    var tb = $('impactBody'); if (!tb) return;
    var data = state.topNetImpact || [];
    var items = Array.isArray(data) ? data : [];
    var cnt = $('impactCount'); if (cnt) cnt.textContent = items.length;
    var h = '';
    items.forEach(function (e) {
        // UW top-net-impact returns various field names for bull/bear premium
        var bullPrem = parseFloat(e.net_bullish_premium || e.bullish_premium || e.call_premium || e.calls_premium || 0);
        var bearPrem = parseFloat(e.net_bearish_premium || e.bearish_premium || e.put_premium || e.puts_premium || 0);
        var net = bullPrem - Math.abs(bearPrem);
        // Fallback to generic premium field
        if (bullPrem === 0 && bearPrem === 0) net = parseFloat(e.net_premium || e.premium || e.total_premium || 0);
        var cls = net >= 0 ? 'text-bull' : 'text-bear';
        var side = net >= 0 ? 'BULLISH' : 'BEARISH';
        var sideColor = net >= 0 ? '#22c55e' : '#ef4444';
        h += '<tr onclick="openTickerView(\'' + (e.ticker || e.symbol || '') + '\')" style="cursor:pointer">';
        h += '<td><strong>' + (e.ticker || e.symbol || '--') + '</strong></td>';
        h += '<td class="text-bull">$' + fmtK(Math.abs(bullPrem)) + '</td>';
        h += '<td class="text-bear">$' + fmtK(Math.abs(bearPrem)) + '</td>';
        h += '<td class="' + cls + '">$' + fmtK(Math.abs(net)) + '</td>';
        h += '<td><span class="badge" style="background:' + sideColor + '">' + side + '</span></td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="5" class="empty">Top net impact loads on WARM cycle</td></tr>';
}
function renderSectorTide() {
    var el = $('sectorTideContent'); if (!el) return;
    var data = state.sectorTide || {};
    var sectors = Object.keys(data);
    if (sectors.length === 0) { el.innerHTML = '<span style="color:#64748b;font-size:11px">Sector data loads on WARM cycle (~3 refreshes)</span>'; return; }
    var h = '';
    sectors.forEach(function (s) {
        var d = data[s];
        var sentiment = 0;
        if (d) {
            // Handle array of readings (take latest)
            var entry = Array.isArray(d) ? d[d.length - 1] : d;
            if (entry) {
                // UW sector-tide returns net_call_premium / net_put_premium
                var callP = parseFloat(entry.net_call_premium || entry.call_premium || entry.calls || 0);
                var putP = parseFloat(entry.net_put_premium || entry.put_premium || entry.puts || 0);
                var netVol = parseFloat(entry.net_volume || 0);
                if (callP !== 0 || putP !== 0) {
                    var total = Math.abs(callP) + Math.abs(putP);
                    sentiment = total > 0 ? (callP - Math.abs(putP)) / total : 0;
                } else if (entry.sentiment !== undefined) {
                    sentiment = parseFloat(entry.sentiment);
                } else if (netVol !== 0) {
                    sentiment = netVol > 0 ? 0.3 : -0.3;
                }
            }
        }
        var bg = sentiment > 0.1 ? '#22c55e' : sentiment < -0.1 ? '#ef4444' : '#64748b';
        var pct = (sentiment * 100).toFixed(0);
        h += '<div style="background:' + bg + '22;border:1px solid ' + bg + ';border-radius:8px;padding:8px 12px;min-width:100px;text-align:center">';
        h += '<div style="font-size:11px;font-weight:600;color:#e2e8f0">' + s + '</div>';
        h += '<div style="font-size:16px;font-weight:700;color:' + bg + '">' + (sentiment >= 0 ? '+' : '') + pct + '%</div>';
        h += '</div>';
    });
    el.innerHTML = h;
}
function renderETFFlows() {
    var tb = $('etfFlowBody'); if (!tb) return;
    var data = state.etfFlows || {};
    var etfs = Object.keys(data);
    var h = '';
    etfs.forEach(function (e) {
        var d = data[e];
        if (!d) return;
        // Handle array (take latest entry)
        var entry = Array.isArray(d) ? d[d.length - 1] : d;
        if (!entry) return;
        // UW ETF in-outflow uses inflow/outflow/net_flow fields
        var inflow = parseFloat(entry.inflow || entry.in_flow || 0);
        var outflow = parseFloat(entry.outflow || entry.out_flow || 0);
        var flow = parseFloat(entry.net_flow || entry.flow || (inflow - outflow) || 0);
        var cls = flow >= 0 ? 'text-bull' : 'text-bear';
        h += '<tr>';
        h += '<td><strong>' + e + '</strong></td>';
        h += '<td class="' + cls + '">$' + fmtK(flow) + '</td>';
        h += '<td>' + (entry.one_week_change ? fmt(entry.one_week_change) + '%' : entry.change_1w ? fmt(entry.change_1w) + '%' : '--') + '</td>';
        h += '<td>' + (entry.total_assets ? '$' + fmtK(entry.total_assets) : entry.aum ? '$' + fmtK(entry.aum) : '--') + '</td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="4" class="empty">ETF flows load on COLD cycle (~15 min)</td></tr>';
}
function renderFDA() {
    var tb = $('fdaBody'); if (!tb) return;
    var data = state.fdaCalendar || [];
    var cnt = $('fdaCount'); if (cnt) cnt.textContent = data.length;
    var h = '';
    data.forEach(function (e) {
        h += '<tr>';
        h += '<td>' + (e.date || e.pdufa_date || '--') + '</td>';
        h += '<td><strong>' + (e.company || e.ticker || '--') + '</strong></td>';
        h += '<td>' + (e.drug || e.drug_name || e.catalyst || '--') + '</td>';
        h += '<td>' + (e.action_type || e.type || '--') + '</td>';
        h += '<td>' + (e.status || '--') + '</td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="5" class="empty">No upcoming FDA events</td></tr>';
}
var sLabels = { PRE_MARKET: 'PRE-MKT', OPEN: 'OPEN', MIDDAY: 'MIDDAY', POWER_HOUR: 'PWR HOUR', POST_MARKET: 'POST-MKT', CLOSED: 'CLOSED', LOADING: 'LOADING' };

function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = function () { $('statusDot').className = 'status-dot connected'; $('lastUpdate').textContent = 'Connected'; };
    ws.onclose = function () { $('statusDot').className = 'status-dot'; $('lastUpdate').textContent = 'Reconnecting...'; setTimeout(connect, 3000); };
    ws.onmessage = function (e) {
        var msg = JSON.parse(e.data);
        if (msg.type === 'full_state') { state = msg.data; renderAll(); }
        else if (msg.type === 'alert') { state.alerts.unshift(msg.data); renderAlerts(); try { $('alertSound').play(); } catch (x) { } }
    };
}

function addTicker() {
    var inp = $('tickerInput'), t = inp.value.trim().toUpperCase();
    if (!t) return;
    if (!/^[A-Z]{1,5}$/.test(t)) {
        inp.style.borderColor = '#ef4444';
        setTimeout(function () { inp.style.borderColor = ''; }, 2000);
        return;
    }
    // Check if already in watchlist
    if (state.tickers && state.tickers.indexOf(t) >= 0) {
        inp.value = '';
        inp.placeholder = t + ' already added';
        setTimeout(function () { inp.placeholder = 'Add ticker…'; }, 2000);
        return;
    }
    inp.disabled = true;
    inp.value = 'Loading ' + t + '...';
    fetch('/api/tickers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: t, action: 'add' }) })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            inp.disabled = false;
            inp.value = '';
            inp.placeholder = '✓ ' + t + ' added';
            setTimeout(function () { inp.placeholder = 'Add ticker…'; }, 2000);
        })
        .catch(function (err) {
            inp.disabled = false;
            inp.value = '';
            inp.placeholder = '✗ Failed: ' + t;
            setTimeout(function () { inp.placeholder = 'Add ticker…'; }, 2000);
        });
}
function removeTicker(t) {
    // Optimistic UI: remove immediately from local state for instant feedback
    state.tickers = state.tickers.filter(function (x) { return x !== t; });
    renderWatchlist();
    renderBrief();
    fetch('/api/tickers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: t, action: 'remove' }) })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.tickers) state.tickers = data.tickers;
            renderWatchlist();
        })
        .catch(function (err) {
            // Restore ticker on failure
            if (state.tickers.indexOf(t) < 0) state.tickers.push(t);
            renderWatchlist();
            console.error('Failed to remove ' + t + ':', err);
        });
}
$('addTickerBtn').addEventListener('click', addTicker);
$('tickerInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTicker(); });
// Part 2: Render functions - Morning Brief, Watchlist, Alerts, Setups
function renderAll() {
    try { $('sessionBadge').textContent = sLabels[state.session] || state.session; } catch (e) { console.error('session', e); }
    try { $('sessionBadge').style.background = sColors[state.session] || '#64748b'; } catch (e) { }
    try { if (state.lastUpdate) $('lastUpdate').textContent = 'Updated: ' + timeAgo(state.lastUpdate); } catch (e) { }
    try { populateSelects(); } catch (e) { console.error('populateSelects', e); }
    try { renderBrief(); } catch (e) { console.error('renderBrief', e); }
    try { renderWatchlist(); } catch (e) { console.error('renderWatchlist', e); }
    try { renderScanner(); } catch (e) { console.error('renderScanner', e); }
    try { renderDiscoveries(); } catch (e) { console.error('renderDiscoveries', e); }
    try { renderSetups(); } catch (e) { console.error('renderSetups', e); }
    try { renderXAlerts(); } catch (e) { console.error('renderXAlerts', e); }
    try { renderTide(); } catch (e) { console.error('renderTide', e); }
    try { renderGaps(); } catch (e) { console.error('renderGaps', e); }
    try { renderHalts(); } catch (e) { console.error('renderHalts', e); }
    try { renderSqueeze(); } catch (e) { console.error('renderSqueeze', e); }
    try { renderEcon(); } catch (e) { console.error('renderEcon', e); }
    try { renderImpact(); } catch (e) { console.error('renderImpact', e); }
    try { renderSectorTide(); } catch (e) { console.error('renderSectorTide', e); }
    try { renderETFFlows(); } catch (e) { console.error('renderETFFlows', e); }
    try { renderFDA(); } catch (e) { console.error('renderFDA', e); }
    try { renderNews(); } catch (e) { console.error('renderNews', e); }
    try { renderCongress(); } catch (e) { console.error('renderCongress', e); }
    try { renderInsider(); } catch (e) { console.error('renderInsider', e); }
    try { renderAlerts(); } catch (e) { console.error('renderAlerts', e); }
    try { renderBudget(); } catch (e) { console.error('renderBudget', e); }
    console.log('renderAll complete — ' + state.tickers.length + ' tickers, ' + (state.alerts || []).length + ' alerts');
}

function populateSelects() {
    var sels = ['gexTickerSelect', 'dpTickerSelect', 'taTickerSelect'];
    sels.forEach(function (id) {
        var el = $(id); if (!el) return;
        var cur = el.value;
        el.innerHTML = '';
        state.tickers.forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = t; el.appendChild(o); });
        if (cur && state.tickers.indexOf(cur) >= 0) el.value = cur;
    });
}

function renderBrief() {
    var b = state.morningBrief || {}, el = $('briefContent');
    if (!el) return;
    var h = '';
    Object.keys(b).forEach(function (t) {
        var d = b[t];
        var dirClass = d.direction === 'BULLISH' ? 'brief-bull' : d.direction === 'BEARISH' ? 'brief-bear' : 'brief-neutral';
        var icon = d.direction === 'BULLISH' ? '&#9650;' : d.direction === 'BEARISH' ? '&#9660;' : '&#9654;';
        h += '<div class="brief-card ' + dirClass + '" onclick="openTickerView(\'' + t + '\')">';
        // Top row: ticker + price
        h += '<div class="brief-top"><span class="brief-ticker">' + t + '</span><span class="brief-price">$' + fmt(d.price) + '</span></div>';
        // Direction + Signal/ML confidence row
        var sigPct = d.confidence || 0;
        var mlPct = (d.ensemble && d.ensemble.confidence != null) ? d.ensemble.confidence : null;
        h += '<div class="brief-dir">' + icon + ' ' + d.direction + '</div>';
        h += '<div class="brief-confidence-row">';
        h += '<span class="brief-conf-item" title="Signal Engine Prediction"><span class="conf-label">Sig</span> <span class="conf-value ' + (sigPct >= 65 ? 'text-bull' : sigPct >= 50 ? '' : 'text-bear') + '">' + sigPct + '%</span></span>';
        if (mlPct !== null) {
            h += '<span class="brief-conf-item" title="ML Model Prediction"><span class="conf-label">ML</span> <span class="conf-value ' + (mlPct >= 60 ? 'text-bull' : mlPct >= 45 ? '' : 'text-bear') + '">' + mlPct + '%</span></span>';
        }
        // Blended confidence (if ensemble)
        if (d.ensemble && d.ensemble.blended != null) {
            h += '<span class="brief-conf-item" title="Blended (Signal + ML)"><span class="conf-label">Mix</span> <span class="conf-value" style="color:#a78bfa">' + d.ensemble.blended + '%</span></span>';
        }
        h += '</div>';
        // Bull/Bear score bar
        if (d.bull !== undefined && d.bear !== undefined) {
            var total = (d.bull + d.bear) || 1;
            var bullPct = Math.round(d.bull / total * 100);
            h += '<div class="score-bar"><div class="score-bull" style="width:' + bullPct + '%"></div><div class="score-bear" style="width:' + (100 - bullPct) + '%"></div></div>';
            h += '<div class="score-labels"><span>B ' + d.bull.toFixed(1) + '</span><span>S ' + d.bear.toFixed(1) + '</span></div>';
        }
        // Compact badges row
        var badges = '';
        if (d.ensemble && d.ensemble.source === 'ensemble') {
            var tfLabel = d.ensemble.timeframe === 'swing' ? 'SW' : 'DT';
            badges += '<span class="badge" style="background:#6366f1;font-size:0.55rem;padding:1px 3px">' + tfLabel + '</span> ';
        }
        var regime = state.marketRegime;
        if (regime && regime.regime !== 'UNKNOWN') {
            var rColor = regime.regime === 'TRENDING_UP' ? '#22c55e' : regime.regime === 'TRENDING_DOWN' ? '#ef4444' : regime.regime === 'VOLATILE' ? '#f59e0b' : '#6366f1';
            badges += '<span class="badge" style="background:' + rColor + ';font-size:0.55rem;padding:1px 3px">' + (regime.label || regime.regime).substring(0, 5) + '</span> ';
        }
        var kelly = (state.kellySizing || {})[t];
        if (kelly) {
            badges += '<span class="badge" style="background:#7c3aed;font-size:0.55rem;padding:1px 3px">' + kelly.pct + '%</span> ';
        }
        var sent = (state.sentiment || {})[t];
        if (sent && sent.label !== 'NEUTRAL') {
            var sentColor = sent.label === 'BULLISH' ? '#22c55e' : '#ef4444';
            badges += '<span class="badge" style="background:' + sentColor + ';font-size:0.55rem;padding:1px 3px">' + sent.label.substring(0, 4) + '</span>';
        }
        if (badges) h += '<div style="margin:2px 0">' + badges + '</div>';
        // Polygon tick data (buy/sell flow)
        if (d.tickData && d.tickData.totalVolume > 0) {
            var buyPct = d.tickData.buyPct || 0;
            var flowColor = buyPct > 55 ? '#00dc82' : buyPct < 45 ? '#ff3b5c' : '#f59e0b';
            h += '<div class="brief-flow">';
            h += '<span style="color:' + flowColor + ';font-weight:600">' + buyPct + '% buy</span>';
            if (d.tickData.vwap > 0) h += '<span style="color:var(--text-muted)">VWAP $' + fmt(d.tickData.vwap) + '</span>';
            if (d.tickData.largeBlockBuys > 0 || d.tickData.largeBlockSells > 0) {
                h += '<span style="font-size:9px;color:var(--text-muted)">Blocks ' + (d.tickData.largeBlockBuys || 0) + 'B/' + (d.tickData.largeBlockSells || 0) + 'S</span>';
            }
            h += '</div>';
        }
        // Signals (max 3)
        var sigs = (d.signals || []).slice(0, 3);
        if (sigs.length > 0) {
            h += '<div class="brief-signals">';
            sigs.forEach(function (s) { h += '<span class="brief-signal">' + s + '</span>'; });
            h += '</div>';
        }
        // Setup prices with clear labels
        if (d.setup) {
            h += '<div class="brief-setup-grid">';
            h += '<div class="setup-level"><span class="setup-label">Entry</span><span class="setup-price">$' + fmt(d.setup.entry) + '</span></div>';
            h += '<div class="setup-level"><span class="setup-label" style="color:var(--bull)">Target</span><span class="setup-price" style="color:var(--bull)">$' + fmt(d.setup.target1) + '</span></div>';
            h += '<div class="setup-level"><span class="setup-label" style="color:var(--bear)">Stop</span><span class="setup-price" style="color:var(--bear)">$' + fmt(d.setup.stop) + '</span></div>';
            if (d.setup.rr) h += '<div class="setup-level"><span class="setup-label">R:R</span><span class="setup-price" style="color:var(--accent-blue)">' + d.setup.rr + '</span></div>';
            h += '</div>';
        }
        h += '</div>';
    });
    el.innerHTML = h || '<div class="empty">Generating brief...</div>';
    var sess = $('briefSession');
    if (sess) sess.textContent = sLabels[state.session] || '--';
}

function renderWatchlist() {
    var tb = $('watchlistBody'), h = '';
    state.tickers.forEach(function (t) {
        var q = state.quotes[t] || {}, ta = state.technicals[t] || {}, s = state.tradeSetups[t];
        var price = q.last || q.price || q.close || ta.price || 0;
        var chg = q.changePercent || q.change_percent || ta.changePercent || 0;
        var chgPts = q.change || q.change_amount || 0;
        if (!chgPts && price && chg) chgPts = (price * chg / 100);
        var chgClass = chg >= 0 ? 'text-bull' : 'text-bear';
        h += '<tr onclick="openTickerView(\'' + t + '\')" style="cursor:pointer">';
        h += '<td><strong>' + t + '</strong></td>';
        h += '<td>$' + fmt(price) + '</td>';
        h += '<td class="' + chgClass + '">' + (chgPts >= 0 ? '+' : '') + fmt(chgPts) + ' pts (' + (chg >= 0 ? '+' : '') + fmt(chg) + '%)</td>';
        var vol = q.volume || ta.volume || 0;
        h += '<td>' + (vol > 0 ? fmtK(vol) : '--') + '</td>';
        h += '<td>' + (ta.rsi ? ta.rsi.toFixed(0) : '--') + '</td>';
        h += '<td><span class="badge ' + (ta.bias === 'BULLISH' ? 'badge-bull' : ta.bias === 'BEARISH' ? 'badge-bear' : 'badge-neutral') + '">' + (ta.bias || '--') + '</span></td>';
        h += '<td>' + (s ? '<span class="badge ' + (s.direction === 'LONG' ? 'badge-bull' : 'badge-bear') + '">' + s.direction + '</span>' : '--') + '</td>';
        h += '<td><button class="btn-remove" onclick="event.stopPropagation();removeTicker(\'' + t + '\')">x</button></td>';
        h += '</tr>';
    });
    tb.innerHTML = h;
    $('tickerCount').textContent = state.tickers.length;
}

function renderAlerts() {
    var feed = $('alertFeed'), h = '';
    var arr = state.alerts || [];
    arr = arr.filter(function (a) {
        if (activeFilter === 'all') return true;
        if (activeFilter === 'HIGH') return a.severity === 'HIGH';
        if (activeFilter === 'BULLISH') return a.direction === 'BULLISH';
        if (activeFilter === 'BEARISH') return a.direction === 'BEARISH';
        if (activeFilter === 'GAP') return (a.type || '').indexOf('GAP') >= 0 || (a.message || '').indexOf('gap') >= 0 || (a.message || '').indexOf('Gap') >= 0;
        if (activeFilter === 'DARK_POOL') return (a.type || '').indexOf('DARK') >= 0 || (a.type || '').indexOf('DP') >= 0;
        if (activeFilter === 'FLOW') return (a.type || '').indexOf('FLOW') >= 0 || (a.type || '').indexOf('SWEEP') >= 0 || (a.type || '').indexOf('UNUSUAL') >= 0 || (a.type || '').indexOf('VOLUME') >= 0;
        return true;
    }).slice(0, 50);
    arr.forEach(function (a) {
        var dc = a.direction === 'BULLISH' ? 'alert-bull' : a.direction === 'BEARISH' ? 'alert-bear' : 'alert-neutral';
        var q = state.quotes[a.ticker] || {};
        var price = q.last || q.price || q.close || 0;
        var chgPct = q.changePercent || q.change_percent || 0;
        var chgPts = q.change || q.change_amount || 0;
        if (!chgPts && price && chgPct) chgPts = (price * chgPct / 100);
        var priceInfo = price > 0 ? ' $' + fmt(price) + ' (' + (chgPts >= 0 ? '+' : '') + fmt(chgPts) + ' pts, ' + (chgPct >= 0 ? '+' : '') + fmt(chgPct) + '%)' : '';
        // Enrich alert message with type-specific details
        var enrichedMsg = a.message || '';
        var typeTag = '';
        var aType = (a.type || '').toUpperCase();
        // Dark Pool: add direction inference
        if (aType.indexOf('DARK') >= 0 || aType.indexOf('DP') >= 0) {
            typeTag = '<span class="badge" style="background:#6366f1;font-size:9px;margin-right:4px">DP</span>';
            if (price > 0) {
                // Parse dark pool price from message if available
                var dpMatch = (a.message || '').match(/\$([0-9,.]+)/);
                if (dpMatch) {
                    var dpPrice = parseFloat(dpMatch[1].replace(/,/g, ''));
                    if (dpPrice > price * 1.001) enrichedMsg += ' <span class="text-bull">[ABOVE ASK - LONG bias]</span>';
                    else if (dpPrice < price * 0.999) enrichedMsg += ' <span class="text-bear">[BELOW BID - SHORT bias]</span>';
                    else enrichedMsg += ' <span style="color:#f59e0b">[AT MID]</span>';
                }
            }
        }
        // Gap: add $ value alongside %
        if (aType.indexOf('GAP') >= 0 || enrichedMsg.toLowerCase().indexOf('gap') >= 0) {
            typeTag = '<span class="badge" style="background:#8b5cf6;font-size:9px;margin-right:4px">GAP</span>';
            var gapMatch = enrichedMsg.match(/([+-]?\d+\.?\d*)%/);
            if (gapMatch && price > 0) {
                var gapPct = parseFloat(gapMatch[1]);
                var gapDollar = (price * gapPct / 100).toFixed(2);
                enrichedMsg = enrichedMsg.replace(gapMatch[0], (gapPct >= 0 ? '+' : '') + '$' + gapDollar + ' (' + gapMatch[0] + ')');
            }
        }
        // Volume/Flow: add type tag
        if (aType.indexOf('VOLUME') >= 0 || aType.indexOf('UNUSUAL') >= 0) {
            typeTag = '<span class="badge" style="background:#0ea5e9;font-size:9px;margin-right:4px">VOL</span>';
        }
        if (aType.indexOf('FLOW') >= 0 || aType.indexOf('SWEEP') >= 0) {
            typeTag = '<span class="badge" style="background:#14b8a6;font-size:9px;margin-right:4px">FLOW</span>';
        }
        // Direction badge
        var dirBadge = '';
        if (a.direction === 'BULLISH') dirBadge = '<span class="badge badge-bull" style="font-size:9px;margin-right:4px">BULL</span>';
        else if (a.direction === 'BEARISH') dirBadge = '<span class="badge badge-bear" style="font-size:9px;margin-right:4px">BEAR</span>';
        h += '<div class="alert-item ' + dc + '" onclick="openTickerView(\'' + a.ticker + '\')" style="cursor:pointer">';
        h += '<span class="alert-time">' + timeAgo(a.time) + '</span>';
        h += '<span class="alert-ticker">' + a.ticker + '</span>';
        h += '<span class="alert-price">' + priceInfo + '</span>';
        if (a.severity === 'HIGH') h += '<span class="badge badge-hot">HIGH</span>';
        h += dirBadge + typeTag;
        h += '<span class="alert-msg">' + enrichedMsg + '</span>';
        h += '</div>';
    });
    feed.innerHTML = h || '<div class="empty">No alerts yet</div>';
}

document.querySelectorAll('.filter-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeFilter = btn.getAttribute('data-filter');
        renderAlerts();
    });
});

var activeSetupTab = 'all';
function switchSetupTab(tab) {
    activeSetupTab = tab;
    document.querySelectorAll('.setup-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    renderSetups();
}

function renderSetups() {
    var tb = $('setupsBody'), h = '';
    // Color map for server-side horizons
    var horizonColors = {
        'Scalp / Day Trade': '#00d4ff', 'Day Trade': '#3b82f6', 'Day Trade (volatile)': '#3b82f6',
        'Intraday': '#8b5cf6', 'Extended Hours': '#b45309',
        'Day / Swing (1-2d)': '#b45309', 'Swing (2-5d)': '#059669', 'Swing': '#059669'
    };
    var allSetups = Object.keys(state.tradeSetups || {}).map(function (t) {
        var s = state.tradeSetups[t];
        if (!s) return null;
        // Classify: day trade vs swing based on server horizon
        var horizon = s.horizon || 'Swing';
        var isDay = horizon.indexOf('Day') !== -1 || horizon.indexOf('Scalp') !== -1 || horizon.indexOf('Intraday') !== -1;
        s._ticker = t;
        s._isDay = isDay;
        s._horizon = horizon;
        return s;
    }).filter(Boolean);

    // Count day vs swing
    var dayCount = allSetups.filter(function (s) { return s._isDay; }).length;
    var swingCount = allSetups.length - dayCount;
    var cAll = $('setupCountAll'), cDay = $('setupCountDay'), cSwing = $('setupCountSwing');
    if (cAll) cAll.textContent = allSetups.length;
    if (cDay) cDay.textContent = dayCount;
    if (cSwing) cSwing.textContent = swingCount;

    // Filter by active tab
    var filtered = allSetups;
    if (activeSetupTab === 'day') filtered = allSetups.filter(function (s) { return s._isDay; });
    else if (activeSetupTab === 'swing') filtered = allSetups.filter(function (s) { return !s._isDay; });

    filtered.forEach(function (s) {
        var t = s._ticker;
        var dc = s.direction === 'LONG' ? 'text-bull' : 'text-bear';
        var hColor = horizonColors[s._horizon] || '#64748b';
        var sigCount = (s.signals || []).length;
        h += '<tr onclick="openTickerView(\'' + t + '\')" style="cursor:pointer">';
        h += '<td><strong>' + t + '</strong>' + squeezeBadge(t) + '</td>';
        h += '<td class="' + dc + '">' + s.direction + '</td>';
        h += '<td>$' + fmt(s.entry) + '</td>';
        h += '<td>$' + fmt(s.target1) + '</td>';
        h += '<td>$' + fmt(s.target2) + '</td>';
        h += '<td>$' + fmt(s.stop) + '</td>';
        h += '<td>' + s.riskReward + '</td>';
        // Earnings risk badge
        var earningsRisk = (state.earningsRisk || {})[t];
        var earningsHtml = '';
        if (earningsRisk && earningsRisk.level === 'HIGH') {
            earningsHtml = ' <span class="badge" style="background:#ef4444;font-size:0.65rem">EARN ' + earningsRisk.daysUntil + 'd</span>';
        } else if (earningsRisk && earningsRisk.level === 'MEDIUM') {
            earningsHtml = ' <span class="badge" style="background:#f59e0b;font-size:0.65rem">EARN ' + earningsRisk.daysUntil + 'd</span>';
        }
        // ML model indicator
        var sigScore = (state.signalScores || {})[t];
        var mlTF = (sigScore && sigScore.ensemble && sigScore.ensemble.timeframe) ? sigScore.ensemble.timeframe : '';
        var mlBadge = mlTF ? ' <span class="badge" style="background:#00d4ff;color:#050810;font-size:0.6rem">' + (mlTF === 'swing' ? 'SW' : 'DT') + '</span>' : '';
        // Kelly sizing badge
        var kelly = (state.kellySizing || {})[t];
        var kellyBadge = kelly ? ' <span class="badge" style="background:#7c3aed;font-size:0.6rem">' + kelly.pct + '%</span>' : '';
        h += '<td>' + s.confidence + '% <small>(' + sigCount + ' sig)</small>' + kellyBadge + '</td>';
        // ML confidence column
        var mlConf = s.mlConfidence;
        var mlCell = mlConf !== null && mlConf !== undefined ? '<span style="color:' + (mlConf >= 60 ? '#4ade80' : mlConf >= 45 ? '#fbbf24' : '#f87171') + '">' + mlConf + '%</span>' + mlBadge : '<span style="color:#64748b">--</span>';
        h += '<td>' + mlCell + '</td>';
        h += '<td><span class="badge" style="background:' + hColor + '">' + s._horizon + '</span>' + earningsHtml + '</td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="10" class="empty">No ' + (activeSetupTab === 'all' ? '' : activeSetupTab + ' trade ') + 'setups</td></tr>';
    // Render journal stats if available
    renderJournalStats();
}

function renderJournalStats() {
    var el = $('journalStats');
    if (!el) return;
    var js = state.journalStats || {};
    var ml = state.mlStatus || {};
    var dt = ml.dayTrade || {};
    var sw = ml.swing || {};
    var h = '<div class="journal-row">';
    h += '<div class="journal-stat"><span class="journal-label">Trades</span><span class="journal-val">' + (js.totalTrades || 0) + '</span></div>';
    h += '<div class="journal-stat"><span class="journal-label">Win Rate</span><span class="journal-val ' + ((js.winRate || 0) >= 55 ? 'text-bull' : 'text-bear') + '">' + (js.winRate || 0) + '%</span></div>';
    h += '<div class="journal-stat"><span class="journal-label">Avg PnL</span><span class="journal-val ' + ((js.avgPnl || 0) >= 0 ? 'text-bull' : 'text-bear') + '">' + (js.avgPnl || 0) + '%</span></div>';
    h += '<div class="journal-stat"><span class="journal-label">DT ML</span><span class="journal-val">' + (dt.trained ? dt.accuracy + '%' : (dt.mlRampPct || 0) + '% ramp') + '</span></div>';
    h += '<div class="journal-stat"><span class="journal-label">Swing ML</span><span class="journal-val">' + (sw.trained ? sw.accuracy + '%' : (sw.mlRampPct || 0) + '% ramp') + '</span></div>';
    h += '</div>';
    // Regime + Correlation row
    var regime = state.marketRegime;
    var corr = state.correlationRisk || {};
    if (regime || (corr.warnings && corr.warnings.length > 0)) {
        h += '<div class="journal-row" style="margin-top:4px">';
        if (regime && regime.regime !== 'UNKNOWN') {
            var rColor = regime.regime === 'TRENDING_UP' ? '#22c55e' : regime.regime === 'TRENDING_DOWN' ? '#ef4444' : regime.regime === 'VOLATILE' ? '#f59e0b' : '#6366f1';
            h += '<div class="journal-stat"><span class="journal-label">Regime</span><span class="journal-val" style="color:' + rColor + '">' + (regime.label || regime.regime) + '</span></div>';
        }
        if (corr.riskLevel && corr.riskLevel !== 'LOW') {
            var corrColor = corr.riskLevel === 'HIGH' ? '#ef4444' : '#f59e0b';
            h += '<div class="journal-stat"><span class="journal-label">Correlation</span><span class="journal-val" style="color:' + corrColor + '">' + corr.riskLevel + ' (' + (corr.warnings || []).length + ' warn)</span></div>';
        }
        h += '</div>';
    }
    el.innerHTML = h;
}
// Part 3: Options Flow (enhanced with sentiment + summary), Dark Pool, GEX
function renderFlow() {
    var tb = $('flowBody'), d = state.optionsFlow || [];
    var summary = $('flowSummary');
    // Build per-ticker call/put summary
    var tickerStats = {};
    d.forEach(function (f) {
        var t = f.ticker || f.symbol || '??';
        if (!tickerStats[t]) tickerStats[t] = { calls: 0, puts: 0, callPrem: 0, putPrem: 0 };
        var pc = (f.put_call || f.option_type || '').toUpperCase();
        var prem = parseFloat(f.premium || f.cost_basis || 0);
        if (pc.indexOf('CALL') >= 0) { tickerStats[t].calls++; tickerStats[t].callPrem += prem; }
        else { tickerStats[t].puts++; tickerStats[t].putPrem += prem; }
    });
    if (summary) {
        var sh = '';
        Object.keys(tickerStats).forEach(function (t) {
            var s = tickerStats[t], total = s.calls + s.puts;
            if (total < 2) return;
            var pct = Math.round(s.calls / total * 100);
            var sent = pct > 60 ? 'BULLISH' : pct < 40 ? 'BEARISH' : 'NEUTRAL';
            var sentClass = sent === 'BULLISH' ? 'text-bull' : sent === 'BEARISH' ? 'text-bear' : '';
            sh += '<div class="flow-stat" onclick="openTickerView(\'' + t + '\')" style="cursor:pointer">';
            sh += '<strong>' + t + '</strong> ';
            sh += '<span class="' + sentClass + '">' + s.calls + 'C/' + s.puts + 'P</span> ';
            sh += '<span style="font-size:11px;color:var(--text-muted)">C$' + fmtK(s.callPrem) + ' P$' + fmtK(s.putPrem) + '</span> ';
            sh += '<span class="badge ' + (sent === 'BULLISH' ? 'badge-bull' : sent === 'BEARISH' ? 'badge-bear' : 'badge-neutral') + '">' + sent + '</span>';
            sh += '</div>';
        });
        summary.innerHTML = sh;
    }
    // Flow table
    var h = '';
    $('flowCount').textContent = d.length;
    d.slice(0, 50).forEach(function (f) {
        var pc = (f.put_call || f.option_type || '--').toUpperCase();
        var isCall = pc.indexOf('CALL') >= 0;
        var type = f.trade_type || f.type || f.aggressor_ind || '--';
        var sentiment = f.sentiment || (isCall ? (type === 'SWEEP' || type === 'BLOCK' ? 'BULLISH' : 'neutral') : (type === 'SWEEP' || type === 'BLOCK' ? 'BEARISH' : 'neutral'));
        var sentClass = sentiment === 'BULLISH' ? 'text-bull' : sentiment === 'BEARISH' ? 'text-bear' : '';
        h += '<tr onclick="openTickerView(\'' + (f.ticker || f.symbol) + '\')" style="cursor:pointer">';
        h += '<td>' + timeAgo(f.created_at || f.executed_at || f.date) + '</td>';
        h += '<td><strong>' + (f.ticker || f.symbol || '--') + '</strong></td>';
        h += '<td class="' + (isCall ? 'text-bull' : 'text-bear') + '">' + pc + '</td>';
        h += '<td>' + (f.strike || '--') + '</td>';
        h += '<td>' + (f.expires || f.expiry || f.expiration_date || '--') + '</td>';
        h += '<td>$' + fmtK(parseFloat(f.premium || f.cost_basis || 0)) + '</td>';
        h += '<td>' + type + '</td>';
        h += '<td class="' + sentClass + '">' + sentiment + '</td>';
        h += '</tr>';
    });
    tb.innerHTML = h || '<tr><td colspan="8" class="empty">No flow data</td></tr>';
}

function renderDarkPool() {
    var sel = $('dpTickerSelect'), t = sel ? sel.value : state.tickers[0];
    var d = state.darkPool[t], el = $('darkPoolContent');
    if (!d || !Array.isArray(d) || d.length === 0) { el.innerHTML = '<div class="empty">No dark pool data for ' + t + '</div>'; return; }
    var h = '';
    d.slice(0, 15).forEach(function (lv) {
        var vol = parseFloat(lv.volume || lv.size || 0);
        var prem = parseFloat(lv.premium || 0);
        var price = parseFloat(lv.price || lv.avg_price || 0);
        var dpDate = lv.tracking_timestamp || lv.date || lv.executed_at || lv.timestamp || '';
        if (dpDate) dpDate = dpDate.substring(0, 10); // show YYYY-MM-DD
        // Infer direction: compare dark pool price to current price
        var curPrice = 0;
        var q = state.quotes[t];
        if (q) curPrice = parseFloat(q.last || q.price || q.close || 0);
        var direction = '--';
        if (curPrice > 0 && price > 0) {
            if (price >= curPrice * 1.001) direction = '<span class="text-bull">ABOVE ASK (Bullish)</span>';
            else if (price <= curPrice * 0.999) direction = '<span class="text-bear">BELOW BID (Bearish)</span>';
            else direction = '<span style="color:#f59e0b">AT MID</span>';
        }
        h += '<div class="dp-level" onclick="openTickerView(\'' + t + '\')" style="cursor:pointer">';
        if (dpDate) h += '<span class="dp-date">' + dpDate + '</span> ';
        h += '<span class="dp-price">$' + fmt(price) + '</span>';
        h += '<span class="dp-vol">' + fmtK(vol) + ' shares | $' + fmtK(prem) + '</span>';
        h += '<span class="dp-dir">' + direction + '</span>';
        h += '</div>';
    });
    el.innerHTML = h;
}

function renderGEX() {
    var cv = $('gexChart'); if (!cv) return;
    var sel = $('gexTickerSelect'), t = sel ? sel.value : state.tickers[0];
    var d = state.gex[t], ctx = cv.getContext('2d');
    // Make canvas taller for vertical layout
    cv.width = cv.parentElement ? cv.parentElement.offsetWidth - 20 : 500;
    cv.height = 500;
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
    if (!d || !Array.isArray(d) || d.length === 0) { ctx.fillStyle = '#64748b'; ctx.font = '14px Inter'; ctx.fillText('No GEX data for ' + t, W / 2 - 60, H / 2); return; }
    var arr = d.map(function (x) { return { strike: parseFloat(x.strike), gex: parseFloat(x.call_gex || 0) + parseFloat(x.put_gex || 0), callGex: parseFloat(x.call_gex || 0), putGex: parseFloat(x.put_gex || 0) }; });
    arr.sort(function (a, b) { return Math.abs(b.gex) - Math.abs(a.gex); });
    arr = arr.slice(0, 35);
    arr.sort(function (a, b) { return a.strike - b.strike; });
    var max = 0; arr.forEach(function (a) { var v = Math.abs(a.gex); if (v > max) max = v; });
    if (max === 0) return;
    // Vertical layout: strikes on Y, GEX bars horizontal
    var leftPad = 65, rightPad = 15, topPad = 30, botPad = 20;
    var chartW = W - leftPad - rightPad;
    var chartH = H - topPad - botPad;
    var barH = Math.max(3, chartH / arr.length - 2);
    var midX = leftPad + chartW / 2;
    // Draw bars
    arr.forEach(function (a, i) {
        var y = topPad + i * (barH + 2);
        var pct = a.gex / max;
        var bW = Math.abs(pct) * (chartW / 2);
        var x = pct >= 0 ? midX : midX - bW;
        ctx.fillStyle = pct >= 0 ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.8)';
        ctx.fillRect(x, y, bW, barH);
        // Strike label on left
        ctx.fillStyle = '#94a3b8'; ctx.font = '9px JetBrains Mono';
        ctx.textAlign = 'right';
        ctx.fillText('$' + a.strike, leftPad - 4, y + barH / 2 + 3);
        // GEX value on bar end
        if (Math.abs(pct) > 0.15) {
            ctx.fillStyle = '#e2e8f0'; ctx.font = '8px JetBrains Mono';
            ctx.textAlign = pct >= 0 ? 'left' : 'right';
            ctx.fillText(fmtK(Math.abs(a.gex)), pct >= 0 ? midX + bW + 3 : midX - bW - 3, y + barH / 2 + 3);
        }
    });
    ctx.textAlign = 'left';
    // Center vertical line (zero)
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(midX, topPad); ctx.lineTo(midX, topPad + chartH); ctx.stroke();
    // Current price horizontal line
    var curPrice = 0;
    var q = state.quotes[t];
    if (q) curPrice = parseFloat(q.last || q.price || q.close || 0);
    if (curPrice > 0) {
        var minS = arr[0].strike, maxS = arr[arr.length - 1].strike;
        if (curPrice >= minS && curPrice <= maxS) {
            var py = topPad + (curPrice - minS) / (maxS - minS) * chartH;
            ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
            ctx.beginPath(); ctx.moveTo(leftPad, py); ctx.lineTo(W - rightPad, py); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#f59e0b'; ctx.font = '10px Inter, sans-serif';
            ctx.fillText('Spot $' + fmt(curPrice), midX + 5, py - 5);
        }
    }
    // Find key levels
    var sorted = arr.slice().sort(function (a, b) { return b.gex - a.gex; });
    var topPos = sorted.filter(function (a) { return a.gex > 0; }).slice(0, 2);
    var topNeg = sorted.filter(function (a) { return a.gex < 0; }).slice(-2);
    // Label key support (positive GEX)
    topPos.forEach(function (lv) {
        var idx = arr.indexOf(lv);
        if (idx >= 0) {
            var y = topPad + idx * (barH + 2) + barH / 2;
            ctx.fillStyle = '#10b981'; ctx.font = 'bold 8px Inter';
            ctx.fillText('SUPPORT', leftPad + 2, y - 2);
        }
    });
    // Label key magnets (negative GEX)
    topNeg.forEach(function (lv) {
        var idx = arr.indexOf(lv);
        if (idx >= 0) {
            var y = topPad + idx * (barH + 2) + barH / 2;
            ctx.fillStyle = '#ef4444'; ctx.font = 'bold 8px Inter';
            ctx.fillText('MAGNET', leftPad + 2, y - 2);
        }
    });
    // Legend
    ctx.fillStyle = '#e2e8f0'; ctx.font = '11px Inter'; ctx.fillText(t + ' Gamma Exposure (GEX)', leftPad, 16);
    ctx.fillStyle = '#10b981'; ctx.fillRect(W - 160, 5, 8, 8); ctx.fillStyle = '#94a3b8'; ctx.font = '9px Inter'; ctx.fillText('Positive (Support)', W - 148, 13);
    ctx.fillStyle = '#ef4444'; ctx.fillRect(W - 160, 17, 8, 8); ctx.fillStyle = '#94a3b8'; ctx.fillText('Negative (Magnet)', W - 148, 25);
    // Axis labels
    ctx.fillStyle = '#64748b'; ctx.font = '9px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('< Negative GEX', leftPad + chartW * 0.25, H - 5);
    ctx.fillText('Positive GEX >', leftPad + chartW * 0.75, H - 5);
    ctx.textAlign = 'left';
}
// Part 4: Market Tide, Technicals (with timeframe), Congress (with committee data)
function renderTide() {
    var d = state.marketTide, fill = $('tideFill'), det = $('tideDetails');
    var pct = 50;
    if (Array.isArray(d) && d.length > 0) {
        var last = d[d.length - 1];
        var callP = Math.abs(parseFloat(last.net_call_premium || 0));
        var putP = Math.abs(parseFloat(last.net_put_premium || 0));
        var total = callP + putP;
        pct = total > 0 ? Math.round(callP / total * 100) : 50;
        var tideIcon = pct > 55 ? 'Calls dominating - BULLISH tilt' : pct < 45 ? 'Puts dominating - BEARISH tilt' : 'Balanced flow - NEUTRAL';
        det.innerHTML = '<div style="font-size:10px;color:#64748b;margin-bottom:4px">Aggregated SPY + major indices net option premium flow</div>' +
            'Call premium: <strong>$' + fmtK(callP) + '</strong> vs Put premium: <strong>$' + fmtK(putP) + '</strong><br>' + tideIcon;
    } else if (d && typeof d === 'object' && !Array.isArray(d)) {
        if (typeof d.score === 'number') pct = Math.max(0, Math.min(100, (d.score + 1) * 50));
        else if (typeof d.bullish_pct === 'number') pct = d.bullish_pct;
        det.innerHTML = '<div style="font-size:10px;color:#64748b;margin-bottom:4px">Aggregated SPY + major indices net option premium flow</div>Score: ' + pct + '%';
    }
    fill.style.width = pct + '%';
    fill.style.background = pct > 55 ? 'linear-gradient(90deg,#10b981,#34d399)' : pct < 45 ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#f59e0b,#fbbf24)';
    renderSectorTide();
}

// P7: Sector Tide Breakdown
function renderSectorTide() {
    var el = $('sectorTide');
    if (!el) return;
    // Build sector map from tickers
    var sectors = {};
    state.tickers.forEach(function (t) {
        var info = state.quotes && state.quotes[t];
        var sector = (info && (info.sector || info.industry_group || info.industry)) || 'Other';
        if (!sectors[sector]) sectors[sector] = { tickers: [], callPrem: 0, putPrem: 0 };
        sectors[sector].tickers.push(t);
        // Aggregate flow data per sector
        var flow = (state.optionsFlow || []).filter(function (f) { return f.ticker === t || f.symbol === t; });
        flow.forEach(function (f) {
            var prem = parseFloat(f.premium || f.total_premium || 0);
            var isCall = (f.option_type || f.put_call || '').toUpperCase().indexOf('C') >= 0;
            if (isCall) sectors[sector].callPrem += prem;
            else sectors[sector].putPrem += prem;
        });
    });
    var keys = Object.keys(sectors).filter(function (k) { return k !== 'Other' && k !== 'Unknown'; });
    if (keys.length === 0) { el.innerHTML = ''; return; }
    var h = '<div style="font-size:10px;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Sector Breakdown</div>';
    keys.sort().forEach(function (sec) {
        var s = sectors[sec];
        var tot = s.callPrem + s.putPrem;
        var pct = tot > 0 ? Math.round(s.callPrem / tot * 100) : 50;
        var barColor = pct > 55 ? '#10b981' : pct < 45 ? '#ef4444' : '#f59e0b';
        h += '<div class="sector-row">';
        h += '<span class="sector-name">' + sec + '</span>';
        h += '<div class="sector-bar-bg"><div class="sector-bar-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>';
        h += '<span class="sector-pct" style="color:' + barColor + '">' + pct + '%</span>';
        h += '</div>';
    });
    el.innerHTML = h;
}

function renderTech() {
    var sel = $('taTickerSelect'), t = sel ? sel.value : state.tickers[0];
    var tfSel = $('taTimeframe'), tf = tfSel ? tfSel.value : '1d';
    var ta = state.technicals[t] || {};
    var el = $('techContent');
    var tfLabel = { '1m': '1 Min', '5m': '5 Min', '15m': '15 Min', '1h': '1 Hour', '4h': '4 Hour', '1d': 'Daily' };
    var h = '<div class="tech-tf-label">Timeframe: <strong>' + (tfLabel[tf] || tf) + '</strong></div>';
    h += '<div class="tech-grid">';
    h += '<div class="tech-item"><span class="tech-label">RSI (14)</span><span class="tech-value ' + (ta.rsi < 30 ? 'text-bull' : ta.rsi > 70 ? 'text-bear' : '') + '">' + (ta.rsi ? ta.rsi.toFixed(1) : '--') + '</span></div>';
    h += '<div class="tech-item"><span class="tech-label">MACD</span><span class="tech-value">' + (ta.macd ? ta.macd.macd.toFixed(2) : '--') + '</span></div>';
    h += '<div class="tech-item"><span class="tech-label">Signal</span><span class="tech-value">' + (ta.macd ? ta.macd.signal.toFixed(2) : '--') + '</span></div>';
    h += '<div class="tech-item"><span class="tech-label">Histogram</span><span class="tech-value ' + (ta.macd && ta.macd.histogram > 0 ? 'text-bull' : 'text-bear') + '">' + (ta.macd ? ta.macd.histogram.toFixed(2) : '--') + '</span></div>';
    if (ta.ema) {
        h += '<div class="tech-item"><span class="tech-label">EMA 9</span><span class="tech-value">$' + fmt(ta.ema.ema9) + '</span></div>';
        h += '<div class="tech-item"><span class="tech-label">EMA 20</span><span class="tech-value">$' + fmt(ta.ema.ema20) + '</span></div>';
        h += '<div class="tech-item"><span class="tech-label">EMA Bias</span><span class="tech-value ' + (ta.ema.ema9 > ta.ema.ema20 ? 'text-bull' : 'text-bear') + '">' + (ta.ema.ema9 > ta.ema.ema20 ? 'BULLISH' : 'BEARISH') + '</span></div>';
    }
    if (ta.pivots) {
        h += '<div class="tech-item"><span class="tech-label">Pivot</span><span class="tech-value">$' + fmt(ta.pivots.pivot) + '</span></div>';
        h += '<div class="tech-item"><span class="tech-label">R1 / R2</span><span class="tech-value text-bull">$' + fmt(ta.pivots.r1) + ' / $' + fmt(ta.pivots.r2) + '</span></div>';
        h += '<div class="tech-item"><span class="tech-label">S1 / S2</span><span class="tech-value text-bear">$' + fmt(ta.pivots.s1) + ' / $' + fmt(ta.pivots.s2) + '</span></div>';
    }
    h += '<div class="tech-item"><span class="tech-label">Overall Bias</span><span class="tech-value badge ' + (ta.bias === 'BULLISH' ? 'badge-bull' : ta.bias === 'BEARISH' ? 'badge-bear' : 'badge-neutral') + '">' + (ta.bias || '--') + '</span></div>';
    h += '</div>';
    el.innerHTML = h;
}

// Timeframe change handler - fetch from server
var tfFetchTimeout = null;
function onTimeframeChange() {
    var sel = $('taTickerSelect'), t = sel ? sel.value : state.tickers[0];
    var tfSel = $('taTimeframe'), tf = tfSel ? tfSel.value : '1d';
    if (tf === '1d') { renderTech(); return; }
    clearTimeout(tfFetchTimeout);
    tfFetchTimeout = setTimeout(function () {
        fetch('/api/technicals/' + t + '/' + tf)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && !data.error) {
                    state.technicals[t] = data;
                    renderTech();
                }
            })
            .catch(function () { });
    }, 300);
}
if ($('taTimeframe')) $('taTimeframe').addEventListener('change', onTimeframeChange);
if ($('taTickerSelect')) $('taTickerSelect').addEventListener('change', function () { $('taTimeframe').value = '1d'; renderTech(); });

function renderCongress() {
    var d = state.congressTrades || [], el = $('congressContent');
    var filterEl = $('congressFilter');
    var profileEl = $('congressProfile');
    if (!d.length) { el.innerHTML = '<div class="empty">No congressional trades</div>'; return; }
    // Populate politician filter dropdown
    if (filterEl) {
        var curVal = filterEl.value || 'all';
        var names = {};
        d.forEach(function (t) { var n = t.name || t.reporter || t.representative || ''; if (n) names[n] = (names[n] || 0) + 1; });
        var sorted = Object.keys(names).sort(function (a, b) { return names[b] - names[a]; });
        var opts = '<option value="all">All Politicians (' + d.length + ')</option>';
        sorted.forEach(function (n) { opts += '<option value="' + n + '">' + n + ' (' + names[n] + ')</option>'; });
        filterEl.innerHTML = opts;
        if (curVal !== 'all' && names[curVal]) filterEl.value = curVal;
    }
    // Filter by politician
    var selectedPol = filterEl ? filterEl.value : 'all';
    var filtered = selectedPol === 'all' ? d : d.filter(function (t) { return (t.name || t.reporter || t.representative) === selectedPol; });
    // Show profile if politician selected
    if (profileEl) {
        if (selectedPol !== 'all' && filtered.length > 0) {
            var p = filtered[0];
            var buys = 0, sells = 0, tickers = {};
            filtered.forEach(function (t) {
                var typ = (t.txn_type || '').toUpperCase();
                if (typ.indexOf('BUY') >= 0 || typ.indexOf('PUR') >= 0) buys++; else sells++;
                if (t.ticker) tickers[t.ticker] = (tickers[t.ticker] || 0) + 1;
            });
            var topTickers = Object.keys(tickers).sort(function (a, b) { return tickers[b] - tickers[a]; }).slice(0, 8);
            var ph = '<div class="congress-profile-card">';
            ph += '<div class="profile-name">' + selectedPol + '</div>';
            if (p._party || p._state) ph += '<div class="profile-meta">Party: <strong>' + (p._party || '?') + '</strong> | State: <strong>' + (p._state || '?') + '</strong> | Chamber: <strong>' + (p._chamber || '?') + '</strong></div>';
            if (p._committees && p._committees.length > 0) {
                ph += '<div class="profile-committees">Committees: ';
                p._committees.forEach(function (c) { ph += '<span class="committee-tag">' + c + '</span> '; });
                ph += '</div>';
            }
            ph += '<div class="profile-stats">';
            ph += '<span class="text-bull">' + buys + ' Buys</span> | <span class="text-bear">' + sells + ' Sells</span> | ' + filtered.length + ' total trades';
            ph += '</div>';
            ph += '<div class="profile-tickers">Top tickers: ' + topTickers.map(function (t) { return '<span class="congress-ticker" onclick="openTickerView(\'' + t + '\')" style="cursor:pointer">' + t + ' (' + tickers[t] + ')</span>'; }).join(' ') + '</div>';
            ph += '</div>';
            profileEl.innerHTML = ph;
            profileEl.style.display = 'block';
        } else {
            profileEl.style.display = 'none';
        }
    }
    var h = '';
    filtered.forEach(function (t) {
        var name = t.name || t.reporter || t.representative || '--';
        var typ = (t.txn_type || t.transaction_type || '--').toUpperCase();
        var isBuy = typ.indexOf('BUY') >= 0 || typ.indexOf('PUR') >= 0;
        var insiderClass = t._insiderFlag ? 'congress-flagged' : '';
        var severityClass = t._insiderSeverity === 'HIGH' ? 'insider-high' : t._insiderSeverity === 'MEDIUM' ? 'insider-med' : '';

        h += '<div class="congress-item ' + insiderClass + '" onclick="openTickerView(\'' + (t.ticker || '') + '\')" style="cursor:pointer">';
        h += '<div class="congress-top">';
        h += '<span class="congress-name">' + name + '</span>';
        if (t._party || t._state) {
            h += ' <span class="congress-party congress-party-' + (t._party || '').toLowerCase() + '">(' + (t._party || '?') + '-' + (t._state || '?') + ')</span>';
        }
        h += ' <span class="congress-chamber">' + (t._chamber || t.member_type || '') + '</span>';
        h += '</div>';
        if (t._committees && t._committees.length > 0) {
            h += '<div class="congress-committees">';
            t._committees.forEach(function (c) { h += '<span class="committee-tag">' + c + '</span>'; });
            h += '</div>';
        }
        h += '<div class="congress-trade">';
        h += '<span class="congress-ticker">' + (t.ticker || '--') + '</span>';
        h += '<span class="congress-type badge ' + (isBuy ? 'badge-bull' : 'badge-bear') + '">' + typ + '</span>';
        h += '<span class="congress-amount">' + (t.amounts || '') + '</span>';
        h += '</div>';
        h += '<div class="congress-meta">';
        h += '<span>Trade: ' + (t.transaction_date || '--') + '</span>';
        h += '<span>Filed: ' + (t.filed_at_date || '--') + '</span>';
        if (t._filingDelay > 0) {
            h += '<span class="filing-delay ' + (t._filingDelay > 30 ? 'delay-late' : '') + '">' + t._filingDelay + ' day delay</span>';
        }
        h += '</div>';
        if (t._insiderFlag) {
            h += '<div class="insider-flag ' + severityClass + '">';
            h += '<span class="flag-icon">&#9888;</span> ';
            h += '<span>' + (t._insiderReason || 'Potential insider insight') + '</span>';
            h += '</div>';
        }
        if (t._politicianNotes) {
            h += '<div class="congress-notes">' + t._politicianNotes + '</div>';
        }
        h += '</div>';
    });
    el.innerHTML = h;
}

// Select change listeners for GEX, Dark Pool, and Congress
if ($('gexTickerSelect')) $('gexTickerSelect').addEventListener('change', renderGEX);
if ($('dpTickerSelect')) $('dpTickerSelect').addEventListener('change', renderDarkPool);
if ($('congressFilter')) $('congressFilter').addEventListener('change', renderCongress);

// Phase 1: News Headlines renderer
function renderNews() {
    var el = $('newsContent');
    var nb = $('newsCount');
    if (!el) return;
    var items = state.news || [];
    if (nb) nb.textContent = items.length;
    if (!items.length) { el.innerHTML = '<div class="empty">No news headlines</div>'; return; }
    var h = '';
    items.slice(0, 20).forEach(function (n) {
        var t = n.published_at || n.created_at || n.date || '';
        // Convert UTC timestamp to local timezone
        var timeStr = '';
        if (t) {
            try {
                var dt = new Date(t);
                timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            } catch (e) { timeStr = t.substring(11, 16); }
        }
        var tickers = n.tickers || n.symbols || [];
        if (typeof tickers === 'string') tickers = tickers.split(',');
        var title = n.title || n.headline || '';
        var sent = (n.sentiment || '').toLowerCase();
        var sentClass = sent === 'bullish' ? 'bull' : sent === 'bearish' ? 'bear' : '';
        h += '<div class="news-item">';
        if (timeStr) h += '<span class="news-time">' + timeStr + '</span> ';
        if (tickers.length > 0) h += '<span class="news-tickers">' + tickers.join(', ') + '</span> ';
        h += '<span class="news-title ' + sentClass + '">' + title + '</span>';
        if (sent) h += ' <span class="news-sentiment ' + sentClass + '">' + sent.toUpperCase() + '</span>';
        h += '</div>';
    });
    el.innerHTML = h;
}

// Phase 4: Insider Transactions — Smart Filtering with Position & Relevance
function renderInsider() {
    var el = $('insiderContent');
    if (!el) return;
    var items = state.insiderTransactions || [];
    if (!items.length) { el.innerHTML = '<div class="empty">No insider transactions</div>'; return; }

    // C-suite titles to prioritize
    var csuiteTitles = ['CEO', 'CFO', 'COO', 'CTO', 'CMO', 'PRESIDENT', 'CHAIRMAN', 'VICE CHAIRMAN', 'CHIEF'];
    var directorTitles = ['DIRECTOR', '10% OWNER', 'BENEFICIAL OWNER'];

    // Smart filter: only show relevant transactions
    var filtered = items.filter(function (tx) {
        var isBuy = (tx.acquisition_or_disposition || tx.transaction_type || '').toUpperCase().indexOf('A') >= 0 ||
            (tx.transaction_type || '').toUpperCase().indexOf('BUY') >= 0 ||
            (tx.transaction_type || '').toUpperCase().indexOf('PURCHASE') >= 0;
        var title = (tx.officer_title || tx.title || tx.relationship || '').toUpperCase();
        var shares = parseFloat(tx.shares || tx.amount || tx.number_of_shares || 0);
        var price = parseFloat(tx.price_per_share || tx.price || 0);
        var value = parseFloat(tx.total_value || tx.value || 0) || (shares * price);

        // Always show C-suite transactions
        var isCsuite = csuiteTitles.some(function (t) { return title.indexOf(t) >= 0; });
        if (isCsuite) return true;

        // Show large buys from anyone (> $100K)
        if (isBuy && value > 100000) return true;

        // Show director/10% owner buys
        var isDirector = directorTitles.some(function (t) { return title.indexOf(t) >= 0; });
        if (isDirector && isBuy) return true;

        // Show very large sells (> $500K)
        if (!isBuy && value > 500000 && isDirector) return true;

        // Filter out routine small transactions
        return false;
    });

    if (!filtered.length) {
        el.innerHTML = '<div class="empty">No significant insider activity</div>';
        return;
    }

    var h = '<table class="insider-table"><thead><tr><th>Date</th><th>Ticker</th><th>Name</th><th>Position</th><th>Type</th><th>Shares</th><th>Value</th><th>Signal</th></tr></thead><tbody>';
    filtered.slice(0, 15).forEach(function (tx) {
        var isBuy = (tx.acquisition_or_disposition || tx.transaction_type || '').toUpperCase().indexOf('A') >= 0 ||
            (tx.transaction_type || '').toUpperCase().indexOf('BUY') >= 0 ||
            (tx.transaction_type || '').toUpperCase().indexOf('PURCHASE') >= 0;
        var dc = isBuy ? 'text-bull' : 'text-bear';
        var typ = isBuy ? 'BUY' : 'SELL';
        var title = tx.officer_title || tx.title || tx.relationship || '--';
        var shares = parseFloat(tx.shares || tx.amount || tx.number_of_shares || 0);
        var price = parseFloat(tx.price_per_share || tx.price || 0);
        var value = parseFloat(tx.total_value || tx.value || 0) || (shares * price);
        var date = tx.filing_date || tx.transaction_date || tx.date || '--';
        if (date.length > 10) date = date.substring(0, 10);

        // Relevance badges
        var badges = '';
        var titleUp = title.toUpperCase();
        var isCsuite = csuiteTitles.some(function (t) { return titleUp.indexOf(t) >= 0; });
        if (isCsuite) badges += '<span class="badge" style="background:#ef4444;font-size:0.6rem">C-SUITE</span> ';
        if (value > 1000000) badges += '<span class="badge" style="background:#f59e0b;font-size:0.6rem">$' + fmtK(value) + '</span> ';
        else if (value > 100000 && isBuy) badges += '<span class="badge" style="background:#10b981;font-size:0.6rem">LARGE BUY</span> ';

        // Check for near-earnings
        var ticker = tx.ticker || tx.symbol || '';
        var earningsRisk = (state.earningsRisk || {})[ticker];
        if (earningsRisk && earningsRisk.daysUntil <= 14) {
            badges += '<span class="badge" style="background:#8b5cf6;font-size:0.6rem">EARN ' + earningsRisk.daysUntil + 'd</span> ';
        }

        // Cluster detection: count same-ticker transactions
        var sameTickerCount = filtered.filter(function (t2) { return (t2.ticker || t2.symbol) === ticker; }).length;
        if (sameTickerCount >= 3) {
            badges += '<span class="badge" style="background:#06b6d4;font-size:0.6rem">CLUSTER×' + sameTickerCount + '</span> ';
        }

        h += '<tr>';
        h += '<td>' + date + '</td>';
        h += '<td><strong style="cursor:pointer;color:#38bdf8" onclick="openTickerView(\'' + ticker + '\')">' + (ticker || '--') + '</strong></td>';
        h += '<td>' + (tx.owner_name || tx.insider_name || tx.name || '--') + '</td>';
        h += '<td><small>' + title + '</small></td>';
        h += '<td class="' + dc + '">' + typ + '</td>';
        h += '<td>' + fmtK(shares) + '</td>';
        h += '<td>$' + fmtK(value) + '</td>';
        h += '<td>' + badges + '</td>';
        h += '</tr>';
    });
    h += '</tbody></table>';
    el.innerHTML = h;
}

// Market Scanner renderer
function renderScanner() {
    var el = $('scannerBody'), statusEl = $('scannerStatus'), countEl = $('scannerCount');
    if (!el) return;
    var data = state.scannerResults || {};
    var results = data.results || [];
    if (countEl) countEl.textContent = results.length;
    if (statusEl) {
        if (results.length > 0) {
            statusEl.innerHTML = '<span style="color:#10b981">\u2713</span> ' + results.length + ' discoveries | Last scan: ' + timeAgo(data.lastScan);
        } else {
            statusEl.innerHTML = '<span class="scanner-spinner">\u27F3</span> Scanning market-wide feeds...';
        }
    }
    var h = '';
    results.forEach(function (r) {
        var confClass = r.confidence >= 80 ? 'conf-high' : r.confidence >= 70 ? 'conf-med' : 'conf-low';
        var sourcePills = r.sources.map(function (s) {
            var sColor = {
                FLOW: '#14b8a6', DARKPOOL: '#6366f1', NET_IMPACT: '#f59e0b',
                INSIDER: '#22c55e', NEWS: '#3b82f6'
            };
            return '<span class="source-pill" style="background:' + (sColor[s] || '#64748b') + '">' + s + '</span>';
        }).join(' ');
        var signalNames = (r.signals || []).map(function (s) { return s.name; }).slice(0, 3).join(', ');
        h += '<tr class="scanner-row" onclick="openTickerView(\'' + r.ticker + '\')" style="cursor:pointer">';
        h += '<td><strong class="scanner-ticker">' + r.ticker + '</strong>' + squeezeBadge(r.ticker) + '</td>';
        h += '<td><span class="badge ' + (r.direction === 'BULLISH' ? 'badge-bull' : r.direction === 'BEARISH' ? 'badge-bear' : 'badge-neutral') + '">' + r.direction + '</span></td>';
        h += '<td><div class="conf-bar-wrap"><div class="conf-bar ' + confClass + '" style="width:' + r.confidence + '%"></div><span class="conf-text">' + r.confidence + '%</span></div></td>';
        h += '<td>$' + fmt(r.price) + '</td>';
        h += '<td>' + sourcePills + '</td>';
        h += '<td class="scanner-signals">' + signalNames + '</td>';
        h += '<td><button class="btn-add-scanner" onclick="event.stopPropagation();addScannerTicker(\'' + r.ticker + '\',this)">+ Add</button></td>';
        h += '</tr>';
    });
    el.innerHTML = h || '<tr><td colspan="7" class="empty">Scanning for opportunities...</td></tr>';
}

// Add scanner discovery to watchlist
function addScannerTicker(ticker, btn) {
    fetch('/api/tickers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: ticker, action: 'add' }) })
        .then(function () {
            if (btn) { btn.textContent = '\u2713 Added'; btn.disabled = true; btn.style.background = '#10b981'; }
        });
}

// Live Discoveries renderer (runners + halt resumes)
function renderDiscoveries() {
    var cardsEl = $('discoveryCards'), statusEl = $('discoveryStatus'), countEl = $('discoveryCount');
    if (!cardsEl) return;

    // Collect discoveries from state
    var discoveries = (state.liveDiscoveries || []);
    if (countEl) countEl.textContent = discoveries.length;

    if (statusEl) {
        if (discoveries.length > 0) {
            statusEl.innerHTML = '<span style="color:#10b981">\u2713</span> ' + discoveries.length + ' active discoveries';
        } else {
            statusEl.innerHTML = '<span class="scanner-spinner">\u27F3</span> Monitoring for runners & halt resumes...';
        }
    }

    if (discoveries.length === 0) {
        cardsEl.innerHTML = '<div class="discovery-empty">No active discoveries yet. Runners and halt resumes will appear here during market hours.</div>';
        return;
    }

    var h = '';
    discoveries.forEach(function (d) {
        var sourceClass = d.source === 'VolatilityRunner' ? 'runner' : d.source === 'HaltResume' ? 'halt' : 'scanner';
        var sourceLabel = d.source === 'VolatilityRunner' ? '\uD83D\uDE80 RUNNER' : d.source === 'HaltResume' ? '\uD83D\uDD13 HALT' : '\uD83D\uDD0D SCANNER';
        var dirClass = d.direction === 'BULLISH' ? 'bull' : d.direction === 'BEARISH' ? 'bear' : 'neutral';

        h += '<div class="discovery-card" onclick="openTickerView(\'' + d.ticker + '\')"> ';
        h += '<div class="discovery-card-header">';
        h += '<span class="discovery-ticker">' + d.ticker + '</span>' + squeezeBadge(d.ticker);
        h += '<span class="discovery-source-badge discovery-source-' + sourceClass + '">' + sourceLabel + '</span>';
        h += '</div>';

        h += '<div class="discovery-stats">';
        if (d.price) h += '<div>Price: <span>$' + fmt(d.price) + '</span></div>';
        if (d.gapPct) h += '<div>Gap: <span>' + d.gapPct.toFixed(1) + '%</span></div>';
        if (d.volume) h += '<div>Vol: <span>' + fmtK(d.volume) + '</span></div>';
        if (d.rVol) h += '<div>RVol: <span>' + d.rVol.toFixed(1) + 'x</span></div>';
        if (d.haltReason) h += '<div>Reason: <span>' + d.haltReason + '</span></div>';
        if (d.age) h += '<div>Age: <span>' + d.age + '</span></div>';
        h += '</div>';

        if (d.direction) {
            h += '<div class="discovery-signal-row">';
            h += '<span class="discovery-signal-dir ' + dirClass + '">' + d.direction + '</span>';
            h += '<span class="discovery-conf" style="color:' + (d.confidence >= 70 ? 'var(--bull)' : d.confidence >= 55 ? 'var(--accent-amber)' : 'var(--text-secondary)') + '">' + (d.confidence || 0) + '%</span>';
            if (d.mlConfidence) h += '<span style="font-size:11px;color:var(--text-muted)">ML: ' + d.mlConfidence + '%</span>';
            h += '</div>';
            if (d.topSignals && d.topSignals.length > 0) {
                h += '<div class="discovery-signals-list">' + d.topSignals.slice(0, 4).join(' \u2022 ') + '</div>';
            }
        }

        h += '</div>';
    });
    cardsEl.innerHTML = h;
}

// API Budget renderer
function renderBudget() {
    var budgetEl = $('budgetBadge'), intervalEl = $('sessionInterval');
    if (!budgetEl) return;
    fetch('/api/budget').then(function (r) { return r.json(); }).then(function (b) {
        var pct = b.pct || 0;
        var color = pct < 50 ? '#10b981' : pct < 80 ? '#f59e0b' : '#ef4444';
        budgetEl.innerHTML = '\u26a1 ' + b.used + '/' + b.limit;
        budgetEl.style.color = color;
        budgetEl.title = 'API: ' + b.used + '/' + b.limit + ' (' + pct + '%) | Tier: ' + b.tier + ' | Cycle #' + b.cycle;
        if (intervalEl) {
            var intLabel = b.interval >= 60 ? Math.round(b.interval / 60) + 'm' : b.interval + 's';
            intervalEl.innerHTML = '\u23f1 ' + b.session + ' ' + intLabel;
        }
    }).catch(function () { });
}

// Gap Scanner renderer
function renderGaps() {
    var gaps = state.gapAnalysis || [];
    var body = $('gapBody');
    var countEl = $('gapCount');
    if (!body) return;
    if (countEl) countEl.textContent = gaps.length;

    if (gaps.length === 0) {
        body.innerHTML = '<tr><td colspan="9" style="text-align:center;opacity:0.5;padding:20px">No gaps detected — waiting for market data refresh</td></tr>';
        return;
    }

    // Helper to format gap timestamp
    function gapTime(ts) {
        if (!ts) return '--';
        var d = new Date(ts);
        var now = new Date();
        var isToday = d.toDateString() === now.toDateString();
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        var timeStr = h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
        return isToday ? 'Today ' + timeStr : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + timeStr;
    }

    body.innerHTML = gaps.map(function (g) {
        var gapColor = g.gapDir === 'UP' ? '#10b981' : '#ef4444';
        var gapIcon = g.gapDir === 'UP' ? '\u2B06' : '\u2B07';

        // Bias colors
        var biasDir = g.bias.direction || 'NEUTRAL';
        var biasColor = '#94a3b8';
        var biasIcon = '\u26aa';
        if (biasDir === 'CONTINUE_UP' || biasDir === 'BOUNCE_UP') {
            biasColor = '#10b981'; biasIcon = '\ud83d\udfe2';
        } else if (biasDir === 'FADE_DOWN' || biasDir === 'CONTINUE_DOWN') {
            biasColor = '#ef4444'; biasIcon = '\ud83d\udd34';
        }

        // Strategy color
        var stratColor = '#94a3b8';
        if (g.signal.strategy.indexOf('LONG') >= 0 || g.signal.strategy.indexOf('DIP') >= 0 || g.signal.strategy.indexOf('GO') >= 0) stratColor = '#10b981';
        else if (g.signal.strategy.indexOf('SHORT') >= 0 || g.signal.strategy.indexOf('FADE') >= 0) stratColor = '#ef4444';

        // Type badge color
        var typeColors = {
            'EARNINGS': '#f59e0b', 'FDA/CATALYST': '#ef4444', 'ANALYST': '#3b82f6',
            'M&A': '#8b5cf6', 'SHORT SQUEEZE': '#ec4899', 'GUIDANCE': '#06b6d4',
            'MOMENTUM': '#f97316', 'TECHNICAL': '#64748b'
        };
        var typeColor = typeColors[g.gapType] || '#64748b';

        var causation = g.causation.reason || 'Unknown';
        if (causation.length > 50) causation = causation.substring(0, 47) + '...';

        var personality = g.personality.typicalPattern || '--';
        var fillRate = g.personality.fillRate !== null ? ' (' + g.personality.fillRate + '% fill)' : '';

        // PrevClose display for verification
        var prevCloseLabel = g.prevClose ? '$' + parseFloat(g.prevClose).toFixed(2) : '--';
        var openLabel = g.open ? '$' + parseFloat(g.open).toFixed(2) : '--';

        return '<tr class="gap-row" onclick="openTickerView(\'' + g.ticker + '\')" style="cursor:pointer">' +
            '<td><strong>' + g.ticker + '</strong>' + (g.isWatchlist ? ' <small style="color:#f59e0b">\u2605</small>' : '') + '<br><small>$' + g.price.toFixed(2) + '</small>' +
            '<br><small style="opacity:0.5">' + gapTime(g.timestamp) + '</small></td>' +
            '<td><span style="color:' + gapColor + ';font-weight:700;font-size:14px">' + gapIcon + ' ' + (g.gapPct > 0 ? '+' : '') + g.gapPct + '%</span>' +
            '<br><small style="opacity:0.6">Prev: ' + prevCloseLabel + '</small>' +
            '<br><small style="opacity:0.6">Open: ' + openLabel + '</small></td>' +
            '<td><span class="badge" style="background:' + typeColor + '">' + g.gapType + '</span></td>' +
            '<td><small>' + causation + '</small>' + (g.causation.marketContext ? '<br><small style="opacity:0.6">' + g.causation.marketContext + '</small>' : '') + '</td>' +
            '<td><small>' + personality + fillRate + '</small><br><small style="opacity:0.5">' + (g.personality.description || '').substring(0, 60) + '</small></td>' +
            '<td><span style="color:' + biasColor + ';font-weight:600">' + biasIcon + ' ' + g.bias.label + '</span><br><small>Score: ' + g.bias.score + '</small></td>' +
            '<td><span style="color:' + stratColor + ';font-weight:700;font-size:12px">' + g.signal.strategy + '</span></td>' +
            '<td><small>E: $' + g.signal.entry.toFixed(2) + '</small><br><small class="text-bull">T: $' + g.signal.target1 + '</small><br><small class="text-bear">SL: $' + g.signal.stop + '</small></td>' +
            '</tr>';
    }).join('');
}

function renderHalts() {
    var halts = state.halts || [];
    var body = $('haltBody');
    var countEl = $('haltCount');
    if (!body) return;
    if (countEl) countEl.textContent = halts.length;

    if (halts.length === 0) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;opacity:0.5;padding:20px">No trading halts detected today</td></tr>';
        return;
    }

    body.innerHTML = halts.slice(0, 30).map(function (h) {
        var isHalted = h.status === 'HALTED';
        var statusColor = isHalted ? '#ef4444' : '#10b981';
        var statusIcon = isHalted ? '🛑' : '✅';
        var statusBg = isHalted ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.1)';
        var watchBg = h.isWatchlist ? 'border-left:3px solid #f59e0b;' : '';
        var changePct = h.changePct || 0;
        var changeColor = changePct > 0 ? '#10b981' : changePct < 0 ? '#ef4444' : '#94a3b8';
        var changeSign = changePct > 0 ? '+' : '';
        var timeStr = h.haltTime || '';
        if (h.resumeTime) timeStr += ' → ' + h.resumeTime;
        // Check if this ticker has an active setup
        var hasSetup = (state.tradeSetups || {})[h.ticker];
        var setupBadge = hasSetup ? ' <span class="badge" style="background:#3b82f6;font-size:0.55rem;margin-left:4px">' + hasSetup.direction + '</span>' : '';

        return '<tr style="background:' + statusBg + ';' + watchBg + '" onclick="openTickerView(\'' + h.ticker + '\')" style="cursor:pointer">' +
            '<td><strong style="cursor:pointer;text-decoration:underline dotted' + (h.isWatchlist ? ';color:#f59e0b' : '') + '">' + h.ticker + '</strong>' + setupBadge +
            (h.name ? '<br><small style="opacity:0.5">' + h.name.substring(0, 30) + '</small>' : '') + '</td>' +
            '<td><span style="color:' + statusColor + ';font-weight:700">' + statusIcon + ' ' + h.status + '</span></td>' +
            '<td><small>' + timeStr + '</small></td>' +
            '<td>' + (h.price ? '$' + h.price.toFixed(2) : '-') + '</td>' +
            '<td style="color:' + changeColor + ';font-weight:600">' + (changePct ? changeSign + changePct.toFixed(2) + '%' : '-') + '</td>' +
            '<td><small>' + (h.reason || '-') + '</small></td>' +
            '<td><small>' + (h.market || '-') + '</small></td>' +
            '</tr>';
    }).join('');
}

// X Alert Validator
function validateXTicker() {
    var tickerEl = $('xAlertTicker'), sourceEl = $('xAlertSource'), statusEl = $('xAlertStatus');
    var ticker = tickerEl.value.trim().toUpperCase();
    if (!ticker) return;
    var source = sourceEl.value.trim() || 'Manual';
    statusEl.innerHTML = '<span class="xalert-loading">Validating ' + ticker + '...</span>';
    $('validateBtn').disabled = true;

    fetch('/api/validate-ticker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker, source: source })
    }).then(function (r) { return r.json(); }).then(function (result) {
        tickerEl.value = '';
        $('validateBtn').disabled = false;
        if (result.status === 'COOLDOWN') {
            statusEl.innerHTML = '<span class="xalert-cooldown">' + result.ticker + ' recently validated (30min cooldown)</span>';
        } else if (result.status === 'VALIDATED') {
            statusEl.innerHTML = '<span class="xalert-validated">\u2705 ' + result.ticker + ' VALIDATED — Score: ' + result.score + '% | Range: ' + result.predictedRange.min + '-' + result.predictedRange.max + '%</span>';
        } else if (result.status === 'WEAK') {
            statusEl.innerHTML = '<span class="xalert-weak">\u26a0\ufe0f ' + result.ticker + ' WEAK — Score: ' + result.score + '%</span>';
        } else {
            statusEl.innerHTML = '<span class="xalert-rejected">\u274c ' + result.ticker + ' REJECTED — Score: ' + result.score + '%</span>';
        }
    }).catch(function (e) {
        $('validateBtn').disabled = false;
        statusEl.innerHTML = '<span class="xalert-error">Error: ' + e.message + '</span>';
    });
}

if ($('validateBtn')) {
    $('validateBtn').addEventListener('click', validateXTicker);
    $('xAlertTicker').addEventListener('keydown', function (e) { if (e.key === 'Enter') validateXTicker(); });
}

// Scan Market handler
function scanLowFloat() {
    var statusEl = $('xAlertStatus');
    var btn = $('scanMarketBtn');
    if (!statusEl || !btn) return;
    btn.disabled = true;
    btn.textContent = '🔎 Scanning...';
    statusEl.innerHTML = '<span class="xalert-loading">Scanning flow + dark pool for low-float candidates...</span>';
    fetch('/api/scan-low-float', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (result) {
            btn.disabled = false;
            btn.textContent = '🔎 Scan Market';
            if (result.scanned === 0) {
                statusEl.innerHTML = '<span class="xalert-weak">No new low-float candidates found in current flow data</span>';
            } else {
                statusEl.innerHTML = '<span class="xalert-validated">✅ Found ' + result.scanned + ' candidates — ' + result.validated + ' validated, ' + result.weak + ' weak</span>';
            }
        })
        .catch(function (e) {
            btn.disabled = false;
            btn.textContent = '🔎 Scan Market';
            statusEl.innerHTML = '<span class="xalert-error">Scan error: ' + e.message + '</span>';
        });
}
if ($('scanMarketBtn')) $('scanMarketBtn').addEventListener('click', scanLowFloat);

function renderXAlerts() {
    var alerts = state.xAlerts || [];
    var body = $('xAlertBody');
    var countEl = $('xAlertCount');
    if (!body) return;
    if (countEl) countEl.textContent = alerts.length;

    if (alerts.length === 0) {
        body.innerHTML = '<tr><td colspan="11" style="text-align:center;opacity:0.5;padding:20px">Enter a ticker above to validate a low float alert</td></tr>';
        return;
    }

    function fmtNum(n) {
        if (!n || n === 0) return '--';
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
        return n.toString();
    }

    body.innerHTML = alerts.map(function (a) {
        var scoreColor = a.score >= 60 ? '#f59e0b' : a.score >= 40 ? '#94a3b8' : '#ef4444';
        var statusIcon = a.status === 'VALIDATED' ? '\u2705' : a.status === 'WEAK' ? '\u26a0\ufe0f' : '\u274c';
        var dirIcon = a.direction === 'BULLISH' ? '\ud83d\udfe2' : a.direction === 'BEARISH' ? '\ud83d\udd34' : '\u26aa';
        var priceLabel = a.price > 0 ? '$' + a.price.toFixed(2) : '--';
        var sharesLabel = fmtNum(a.sharesOutstanding);
        var floatLabel = a.floatShares > 0 ? fmtNum(a.floatShares) : '--';
        var siLabel = a.shortInterest > 0 ? a.shortInterest.toFixed(1) + '%' : '--';
        var rvLabel = a.relativeVolume > 0 ? a.relativeVolume.toFixed(1) + 'x' : '--';
        var rangeLabel = a.predictedRange ? a.predictedRange.min + '-' + a.predictedRange.max + '%' : '--';
        var dataIcon = a.dataCompleteness >= 80 ? '' : a.dataCompleteness >= 60 ? ' <small title="Partial data (' + a.dataCompleteness + '%)" style="opacity:0.6">⚠️</small>' : ' <small title="Sparse data (' + (a.dataCompleteness || 0) + '%)" style="opacity:0.6">⚠️</small>';
        var momLabel = a.intradayMomentum > 0 ? '<br><small style="color:#10b981">+' + a.intradayMomentum.toFixed(1) + '% today</small>' : '';
        var targetsHtml = '';
        if (a.targets && a.price > 0) {
            targetsHtml = '<div class="xalert-targets">' +
                '<span class="xt-cons" title="Conservative">C: $' + a.targets.conservative.price + ' (+' + a.targets.conservative.pct + '%)</span>' +
                '<span class="xt-mod" title="Moderate">M: $' + a.targets.moderate.price + ' (+' + a.targets.moderate.pct + '%)</span>' +
                '<span class="xt-agg" title="Aggressive">A: $' + a.targets.aggressive.price + ' (+' + a.targets.aggressive.pct + '%)</span>' +
                '<span class="xt-stop" title="Stop Loss">SL: $' + a.targets.stopLoss.price + '</span>' +
                '</div>';
        }
        return '<tr class="xalert-row xalert-' + a.status.toLowerCase() + '">' +
            '<td class="ticker-link" onclick="openTickerView(\'' + a.ticker + '\')">' + statusIcon + ' <b>' + a.ticker + '</b>' + dataIcon + '</td>' +
            '<td><span style="color:' + scoreColor + ';font-weight:700;font-size:16px">' + a.score + '%</span><br><small>' + dirIcon + ' ' + a.direction + '</small>' + momLabel + '</td>' +
            '<td><b>' + priceLabel + '</b></td>' +
            '<td>' + sharesLabel + '</td>' +
            '<td><b>' + floatLabel + '</b><br><small class="xalert-float-label">' + (a.floatLabel || '') + '</small></td>' +
            '<td>' + siLabel + '</td>' +
            '<td>' + rvLabel + '</td>' +
            '<td><b style="color:#f59e0b">' + rangeLabel + '</b></td>' +
            '<td>' + targetsHtml + '</td>' +
            '<td><small>' + (a.source || '') + '</small><br><small style="opacity:0.5">' + timeAgo(a.validatedAt) + '</small></td>' +
            '<td><button class="btn-delete-xalert" onclick="deleteXAlert(\'' + a.ticker + '\')" title="Remove">✕</button></td>' +
            '</tr>';
    }).join('');
}

function deleteXAlert(ticker) {
    fetch('/api/x-alerts/' + ticker, { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function () {
            state.xAlerts = (state.xAlerts || []).filter(function (a) { return a.ticker !== ticker; });
            renderXAlerts();
        })
        .catch(function (e) { console.error('Delete X alert error:', e); });
}

// Part 5: Ticker Deep-Dive Modal with TradingView
function openTickerView(ticker) {
    if (!ticker || ticker === 'undefined' || ticker === '--') return;
    var modal = $('tickerModal');
    modal.style.display = 'flex';
    $('modalTicker').textContent = ticker;

    // TradingView Widget
    var container = $('tvChartContainer');
    container.innerHTML = '';
    try {
        tvWidget = new TradingView.widget({
            autosize: true,
            symbol: ticker,
            interval: 'D',
            timezone: 'America/New_York',
            theme: 'dark',
            style: '1',
            locale: 'en',
            toolbar_bg: '#0f172a',
            enable_publishing: false,
            allow_symbol_change: true,
            container_id: 'tvChartContainer',
            hide_side_toolbar: false,
            studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies', 'MAExp@tv-basicstudies'],
            withdateranges: true,
            details: true,
            calendar: false
        });
    } catch (e) {
        container.innerHTML = '<div style="padding:20px;color:#94a3b8">TradingView chart loading... If it does not appear, check your internet connection.</div>';
    }

    // P6: Trade Setup Price Ladder Overlay
    var sOverlay = $('setupOverlay');
    var setupData = state.tradeSetups[ticker];
    if (sOverlay && setupData && setupData.entry) {
        var levels = [];
        if (setupData.target2) levels.push({ price: setupData.target2, label: 'T2', color: '#10b981', type: 'target' });
        if (setupData.target1) levels.push({ price: setupData.target1, label: 'T1', color: '#34d399', type: 'target' });
        levels.push({ price: setupData.entry, label: 'ENTRY', color: '#3b82f6', type: 'entry' });
        if (setupData.stop) levels.push({ price: setupData.stop, label: 'STOP', color: '#ef4444', type: 'stop' });
        // Sort by price descending
        levels.sort(function (a, b) { return b.price - a.price; });
        var oh = '<div class="price-ladder">';
        oh += '<div class="ladder-title">' + (setupData.direction || '') + ' Setup</div>';
        levels.forEach(function (lv) {
            var bgOpacity = lv.type === 'entry' ? '0.2' : lv.type === 'stop' ? '0.15' : '0.12';
            oh += '<div class="ladder-level" style="border-left:3px solid ' + lv.color + ';background:rgba(' +
                (lv.type === 'stop' ? '239,68,68' : lv.type === 'entry' ? '59,130,246' : '16,185,129') + ',' + bgOpacity + ')">';
            oh += '<span class="ladder-label" style="color:' + lv.color + '">' + lv.label + '</span>';
            oh += '<span class="ladder-price">$' + fmt(lv.price) + '</span>';
            oh += '</div>';
        });
        // R:R summary
        if (setupData.riskReward) {
            oh += '<div class="ladder-rr">R:R <strong>' + setupData.riskReward + '</strong></div>';
        }
        if (setupData.confidence) {
            oh += '<div class="ladder-conf">' + setupData.confidence + '% confidence</div>';
        }
        oh += '</div>';
        sOverlay.innerHTML = oh;
    } else if (sOverlay) {
        sOverlay.innerHTML = '<div class="empty">No setup for ' + ticker + '</div>';
    }

    // Trade Setup panel (left box)
    var s = state.tradeSetups[ticker];
    var setupEl = $('modalSetup');
    if (s) {
        var dc = s.direction === 'LONG' ? 'text-bull' : 'text-bear';
        // Use server-sent horizon if available, else compute from % move
        var horizonS = s.horizon || 'Swing';
        if (!s.horizon) {
            var entryP = s.entry || 0, t1P = s.target1 || 0;
            var movePctS = entryP > 0 ? Math.abs(t1P - entryP) / entryP * 100 : 0;
            horizonS = 'Scalp/Open';
            if (movePctS > 5) horizonS = 'Swing (3-5d)';
            else if (movePctS > 2) horizonS = 'Swing (1-3d)';
            else if (movePctS > 0.8) horizonS = 'Day Trade';
        }
        var horizonColors = {
            'Scalp / Day Trade': '#00d4ff', 'Scalp/Open': '#00d4ff',
            'Day Trade': '#3b82f6', 'Intraday': '#3b82f6',
            'Day / Swing (1-2d)': '#b45309', 'Swing (1-3d)': '#b45309',
            'Swing (2-5d)': '#059669', 'Swing (3-5d)': '#059669', 'Swing': '#059669'
        };
        var mlConfDisp = s.mlConfidence !== null && s.mlConfidence !== undefined ? s.mlConfidence + '%' : '--';
        var mlConfColor = s.mlConfidence >= 60 ? '#4ade80' : s.mlConfidence >= 45 ? '#fbbf24' : '#f87171';
        setupEl.innerHTML = '<div class="modal-setup-card">' +
            '<div class="' + dc + '" style="font-size:16px;font-weight:700">' + s.direction + '</div>' +
            '<div style="display:flex;gap:16px;margin:6px 0">' +
            '<div style="text-align:center"><div style="color:#94a3b8;font-size:9px">TECH</div><div style="font-size:18px;font-weight:700">' + s.confidence + '%</div></div>' +
            '<div style="text-align:center"><div style="color:#94a3b8;font-size:9px">ML</div><div style="font-size:18px;font-weight:700;color:' + mlConfColor + '">' + mlConfDisp + '</div></div>' +
            '</div>' +
            '<div style="font-size:11px;color:#94a3b8;margin:2px 0">Horizon: <span class="badge" style="background:' + (horizonColors[horizonS] || '#64748b') + '">' + horizonS + '</span></div>' +
            '<div>Entry: <strong>$' + fmt(s.entry) + '</strong></div>' +
            '<div class="text-bull">T1: $' + fmt(s.target1) + ' | T2: $' + fmt(s.target2) + '</div>' +
            '<div class="text-bear">Stop: $' + fmt(s.stop) + '</div>' +
            '<div>R:R ' + s.riskReward + '</div>' +
            '<button class="btn-paper-trade" onclick="paperTrade(\'' + ticker + '\')" title="Open a simulated trade at current price with these levels">&#128196; Paper Trade This</button>' +
            '</div>';
    } else {
        setupEl.innerHTML = '<div class="empty">No setup for ' + ticker + '</div>';
    }

    // Morning Brief panel (right box)
    var briefEl = $('modalBrief');
    var brief = (state.morningBrief || {})[ticker];
    if (briefEl && brief) {
        var bIcon = brief.direction === 'BULLISH' ? '&#9650;' : brief.direction === 'BEARISH' ? '&#9660;' : '&#9654;';
        var bClass = brief.direction === 'BULLISH' ? 'text-bull' : brief.direction === 'BEARISH' ? 'text-bear' : '';
        var bh = '<div style="background:var(--bg-input);border-radius:8px;padding:10px;border-left:3px solid ' + (brief.direction === 'BULLISH' ? '#10b981' : brief.direction === 'BEARISH' ? '#ef4444' : '#64748b') + '">';
        bh += '<div style="font-size:14px;font-weight:700;margin-bottom:6px" class="' + bClass + '">' + bIcon + ' ' + brief.direction + ' <span style="color:#94a3b8;font-weight:400">' + brief.confidence + '%</span></div>';
        // Score bar
        if (brief.bull !== undefined && brief.bear !== undefined) {
            var total = (brief.bull + brief.bear) || 1;
            var bullPct = Math.round(brief.bull / total * 100);
            bh += '<div class="score-bar"><div class="score-bull" style="width:' + bullPct + '%"></div><div class="score-bear" style="width:' + (100 - bullPct) + '%"></div></div>';
            bh += '<div class="score-labels"><span>Bull ' + brief.bull.toFixed(1) + '</span><span>Bear ' + brief.bear.toFixed(1) + '</span></div>';
        }
        // Badges
        var bb = '';
        if (brief.ensemble && brief.ensemble.source === 'ensemble') {
            bb += '<span class="badge" style="background:#6366f1;font-size:0.6rem">' + (brief.ensemble.timeframe === 'swing' ? 'Swing ML' : 'DayTrade ML') + '</span> ';
        }
        var regime = state.marketRegime;
        if (regime && regime.regime !== 'UNKNOWN') {
            var rColor = regime.regime === 'TRENDING_UP' ? '#22c55e' : regime.regime === 'TRENDING_DOWN' ? '#ef4444' : regime.regime === 'VOLATILE' ? '#f59e0b' : '#6366f1';
            bb += '<span class="badge" style="background:' + rColor + ';font-size:0.6rem">' + (regime.label || regime.regime) + '</span> ';
        }
        var sent = (state.sentiment || {})[ticker];
        if (sent && sent.label !== 'NEUTRAL') {
            bb += '<span class="badge" style="background:' + (sent.label === 'BULLISH' ? '#22c55e' : '#ef4444') + ';font-size:0.6rem">Sent: ' + sent.label + '</span> ';
        }
        var kelly = (state.kellySizing || {})[ticker];
        if (kelly) {
            bb += '<span class="badge" style="background:#7c3aed;font-size:0.6rem">Size ' + kelly.pct + '%</span>';
        }
        if (bb) bh += '<div style="margin-top:6px">' + bb + '</div>';
        // Signals
        if (brief.signals && brief.signals.length) {
            bh += '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:3px">';
            brief.signals.forEach(function (sig) {
                bh += '<span class="brief-signal">' + sig + '</span>';
            });
            bh += '</div>';
        }
        // Setup entry line within brief
        if (brief.setup) {
            bh += '<div style="margin-top:6px;font-size:11px;font-family:var(--font-mono);color:var(--text-secondary)">Entry $' + fmt(brief.setup.entry) + ' | T1 $' + fmt(brief.setup.target1) + ' | Stop $' + fmt(brief.setup.stop) + ' | ' + brief.setup.rr + ' R:R</div>';
        }
        bh += '</div>';
        briefEl.innerHTML = bh;
    } else if (briefEl) {
        briefEl.innerHTML = '<div class="empty">No brief for ' + ticker + '</div>';
    }

    // Technicals
    var ta = state.technicals[ticker] || {};
    var techEl = $('modalTech');
    var th = '';
    th += '<div>RSI: <strong>' + (ta.rsi ? ta.rsi.toFixed(1) : '--') + '</strong></div>';
    if (ta.macd) th += '<div>MACD: <strong>' + ta.macd.macd.toFixed(2) + '</strong> Signal: ' + ta.macd.signal.toFixed(2) + '</div>';
    if (ta.ema) th += '<div>EMA 9: $' + fmt(ta.ema.ema9) + ' | EMA 20: $' + fmt(ta.ema.ema20) + '</div>';
    th += '<div>Bias: <span class="badge ' + (ta.bias === 'BULLISH' ? 'badge-bull' : ta.bias === 'BEARISH' ? 'badge-bear' : 'badge-neutral') + '">' + (ta.bias || '--') + '</span></div>';
    if (techEl) techEl.innerHTML = th;

    // Options flow for this ticker
    try {
        var flowEl = $('modalFlow');
        if (flowEl) {
            var flows = (state.optionsFlow || []).filter(function (f) { return (f.ticker || f.symbol) === ticker; });
            var calls = 0, puts = 0, callPrem = 0, putPrem = 0;
            flows.forEach(function (f) {
                var pc = (f.put_call || f.option_type || f.type || '').toUpperCase();
                var prem = parseFloat(f.premium || f.total_premium || f.cost_basis || 0);
                if (pc.indexOf('CALL') >= 0) { calls++; callPrem += prem; } else { puts++; putPrem += prem; }
            });
            var tot = calls + puts;
            var fh = '';
            if (tot > 0) {
                var cpPct = Math.round(calls / tot * 100);
                var sent = cpPct > 60 ? 'BULLISH' : cpPct < 40 ? 'BEARISH' : 'NEUTRAL';
                fh += '<div style="margin-bottom:8px"><strong>Sentiment: <span class="' + (sent === 'BULLISH' ? 'text-bull' : sent === 'BEARISH' ? 'text-bear' : '') + '">' + sent + '</span></strong></div>';
                fh += '<div>' + calls + ' Calls ($' + fmtK(callPrem) + ') / ' + puts + ' Puts ($' + fmtK(putPrem) + ')</div>';
                fh += '<div style="margin-top:8px">';
                flows.slice(0, 10).forEach(function (f) {
                    var pc = (f.put_call || f.option_type || f.type || '--').toUpperCase();
                    var isCall = pc.indexOf('CALL') >= 0;
                    fh += '<div style="font-size:11px;padding:2px 0;border-bottom:1px solid #1e293b">';
                    fh += '<span class="' + (isCall ? 'text-bull' : 'text-bear') + '">' + pc + '</span> ';
                    fh += '$' + (f.strike || '--') + ' ' + (f.expires || f.expiry || '') + ' ';
                    fh += '$' + fmtK(parseFloat(f.premium || f.total_premium || 0)) + ' ';
                    fh += (f.trade_type || f.type || '--');
                    fh += '</div>';
                });
                fh += '</div>';
            } else {
                // Show top market-wide flow since no ticker-specific flow
                var allFlow = (state.optionsFlow || []).slice(0, 8);
                if (allFlow.length > 0) {
                    fh = '<div style="font-size:10px;color:#64748b;margin-bottom:4px">No ' + ticker + ' flow — showing top market activity:</div>';
                    allFlow.forEach(function (f) {
                        var pc = (f.put_call || f.option_type || f.type || '--').toUpperCase();
                        var isCall = pc.indexOf('CALL') >= 0;
                        fh += '<div style="font-size:11px;padding:2px 0;border-bottom:1px solid #1e293b">';
                        fh += '<strong>' + (f.ticker || f.symbol || '--') + '</strong> ';
                        fh += '<span class="' + (isCall ? 'text-bull' : 'text-bear') + '">' + pc + '</span> ';
                        fh += '$' + (f.strike || '--') + ' $' + fmtK(parseFloat(f.premium || f.total_premium || 0));
                        fh += '</div>';
                    });
                } else {
                    fh = '<div class="empty">No flow data available</div>';
                }
            }
            flowEl.innerHTML = fh;
        }
    } catch (e) { console.error('Modal Options Flow error:', e); if ($('modalFlow')) $('modalFlow').innerHTML = '<div class="empty">Error loading flow: ' + e.message + '</div>'; }

    // GEX in modal — with labels and summary
    try {
        var gexData = state.gex[ticker];
        var cv = $('modalGexChart');
        var gexSummaryEl = $('modalGexSummary');
        if (cv && gexData && Array.isArray(gexData) && gexData.length > 0) {
            var ctx = cv.getContext('2d');
            var W = cv.width, H = cv.height;
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
            var arr = gexData.map(function (x) { return { strike: parseFloat(x.strike), gex: parseFloat(x.call_gex || 0) + parseFloat(x.put_gex || 0) }; });
            arr.sort(function (a, b) { return Math.abs(b.gex) - Math.abs(a.gex); }); arr = arr.slice(0, 20);
            arr.sort(function (a, b) { return a.strike - b.strike; });
            var max = 0; arr.forEach(function (a) { if (Math.abs(a.gex) > max) max = Math.abs(a.gex); });

            // Summary stats
            var maxGammaStrike = arr.reduce(function (best, a) { return Math.abs(a.gex) > Math.abs(best.gex) ? a : best; }, arr[0]);
            var netGex = arr.reduce(function (sum, a) { return sum + a.gex; }, 0);
            var callWall = arr.filter(function (a) { return a.gex > 0; }).sort(function (a, b) { return b.gex - a.gex; })[0];
            var putWall = arr.filter(function (a) { return a.gex < 0; }).sort(function (a, b) { return a.gex - b.gex; })[0];

            if (gexSummaryEl) {
                var gs = '<strong>Max Gamma:</strong> $' + maxGammaStrike.strike + ' ';
                gs += '| <strong>Net GEX:</strong> <span class="' + (netGex >= 0 ? 'text-bull' : 'text-bear') + '">' + (netGex >= 0 ? 'POSITIVE' : 'NEGATIVE') + '</span> ';
                if (callWall) gs += '| <strong>Call Wall:</strong> $' + callWall.strike + ' ';
                if (putWall) gs += '| <strong>Put Wall:</strong> $' + putWall.strike;
                gexSummaryEl.innerHTML = gs;
            }

            if (max > 0) {
                var barW = Math.max(8, (W - 60) / arr.length - 3);
                var labelH = 20; // space for labels
                var chartH = H - labelH;
                arr.forEach(function (a, i) {
                    var pct = a.gex / max;
                    var bH = Math.abs(pct) * (chartH / 2 - 10);
                    var x = 30 + i * (barW + 3);
                    var y = pct >= 0 ? chartH / 2 - bH : chartH / 2;
                    ctx.fillStyle = pct >= 0 ? '#10b981' : '#ef4444';
                    ctx.fillRect(x, y, barW, bH);
                    // Strike labels
                    ctx.save();
                    ctx.fillStyle = '#94a3b8';
                    ctx.font = '9px Inter, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('$' + a.strike, x + barW / 2, H - 3);
                    ctx.restore();
                });
                ctx.strokeStyle = '#334155'; ctx.beginPath(); ctx.moveTo(0, chartH / 2); ctx.lineTo(W, chartH / 2); ctx.stroke();
            }
        } else if (gexSummaryEl) {
            gexSummaryEl.innerHTML = '';
        }
    } catch (e) { console.error('Modal GEX error:', e); }

    // Dark Pool in modal — with directional bias
    try {
        var dpEl = $('modalDarkPool');
        var dpData = state.darkPool[ticker];
        if (dpData && Array.isArray(dpData) && dpData.length > 0) {
            var curPrice = 0;
            var q = state.quotes[ticker];
            if (q) curPrice = parseFloat(q.last || q.price || q.close || 0);
            var bullCount = 0, bearCount = 0, neutralCount = 0;
            var dh = '';
            dpData.slice(0, 8).forEach(function (lv) {
                var dpPrice = parseFloat(lv.price || lv.avg_price || 0);
                var vol = parseFloat(lv.volume || lv.size || 0);
                var prem = parseFloat(lv.premium || 0);
                var dpDate = lv.tracking_timestamp || lv.date || lv.executed_at || '';
                if (dpDate) dpDate = dpDate.substring(0, 10);
                // Direction
                var direction = '--';
                if (curPrice > 0 && dpPrice > 0) {
                    if (dpPrice >= curPrice * 1.001) { direction = '<span class="text-bull">ABOVE ASK \u2191</span>'; bullCount++; }
                    else if (dpPrice <= curPrice * 0.999) { direction = '<span class="text-bear">BELOW BID \u2193</span>'; bearCount++; }
                    else { direction = '<span style="color:#f59e0b">AT MID</span>'; neutralCount++; }
                }
                dh += '<div style="font-size:11px;padding:3px 0;border-bottom:1px solid #1e293b">';
                if (dpDate) dh += '<span style="opacity:0.5">' + dpDate + '</span> ';
                dh += '$' + fmt(dpPrice) + ' — ' + fmtK(vol) + ' shares | $' + fmtK(prem) + ' ';
                dh += direction;
                dh += '</div>';
            });
            // Net bias summary
            var netBias = 'NEUTRAL';
            var netColor = '#f59e0b';
            if (bullCount > bearCount + 1) { netBias = 'BULLISH'; netColor = '#10b981'; }
            else if (bearCount > bullCount + 1) { netBias = 'BEARISH'; netColor = '#ef4444'; }
            dh = '<div style="margin-bottom:6px;font-weight:700">Net Bias: <span style="color:' + netColor + '">' + netBias + '</span> <small>(' + bullCount + ' above / ' + bearCount + ' below / ' + neutralCount + ' mid)</small></div>' + dh;
            dpEl.innerHTML = dh;
        } else {
            dpEl.innerHTML = '<div class="empty">No DP data</div>';
        }
    } catch (e) { console.error('Modal DP error:', e); if ($('modalDarkPool')) $('modalDarkPool').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Congress in modal
    try {
        var congEl = $('modalCongress');
        var congData = (state.congressTrades || []).filter(function (c) { return c.ticker === ticker; });
        if (congEl) {
            var ch = '';
            if (congData.length > 0) {
                congData.forEach(function (c) {
                    var isBuy = (c.txn_type || '').toUpperCase().indexOf('BUY') >= 0;
                    ch += '<div style="font-size:11px;padding:3px 0;border-bottom:1px solid #1e293b">';
                    ch += '<strong>' + (c.name || '--') + '</strong> ';
                    if (c._party) ch += '(' + c._party + ') ';
                    ch += '<span class="' + (isBuy ? 'text-bull' : 'text-bear') + '">' + (c.txn_type || '--') + '</span> ';
                    ch += (c.amounts || '') + ' ' + (c.transaction_date || '');
                    if (c._insiderFlag) ch += ' <span style="color:#f59e0b">!! ' + c._insiderReason + '</span>';
                    ch += '</div>';
                });
            } else {
                // Show recent overall congressional trades
                var allCong = (state.congressTrades || []).slice(0, 5);
                if (allCong.length > 0) {
                    ch = '<div style="font-size:10px;color:#64748b;margin-bottom:4px">No ' + ticker + ' trades — recent congressional activity:</div>';
                    allCong.forEach(function (c) {
                        var isBuy = (c.txn_type || '').toUpperCase().indexOf('BUY') >= 0;
                        ch += '<div style="font-size:11px;padding:3px 0;border-bottom:1px solid #1e293b">';
                        ch += '<strong>' + (c.ticker || '--') + '</strong> ';
                        ch += '<strong>' + (c.name || '--') + '</strong> ';
                        if (c._party) ch += '(' + c._party + ') ';
                        ch += '<span class="' + (isBuy ? 'text-bull' : 'text-bear') + '">' + (c.txn_type || '--') + '</span> ';
                        ch += (c.amounts || '') + ' ' + (c.transaction_date || '');
                        ch += '</div>';
                    });
                } else {
                    ch = '<div class="empty">No congressional trade data</div>';
                }
            }
            congEl.innerHTML = ch;
        }
    } catch (e) { console.error('Modal Congress error:', e); if ($('modalCongress')) $('modalCongress').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 1: IV Rank + Max Pain modal panel
    try {
        var ivmpEl = $('modalIVMaxPain');
        if (ivmpEl) {
            var ivArr = state.ivRank && state.ivRank[ticker];
            var mpArr = state.maxPain && state.maxPain[ticker];
            var ih = '';
            if (ivArr && Array.isArray(ivArr) && ivArr.length > 0) {
                var ivd = ivArr[ivArr.length - 1]; // latest entry
                var rank = parseFloat(ivd.iv_rank_1y || ivd.iv_rank || 0);
                var vol = parseFloat(ivd.volatility || ivd.iv || 0);
                var ivClose = parseFloat(ivd.close || 0);
                ih += '<div class="modal-metric"><span>IV Rank (1Y):</span> <strong class="' + (rank > 50 ? 'text-bear' : 'text-bull') + '">' + fmt(rank) + '%</strong></div>';
                ih += '<div class="modal-metric"><span>Implied Volatility:</span> <strong>' + (vol * 100).toFixed(1) + '%</strong></div>';
                if (ivClose) ih += '<div class="modal-metric"><span>Close:</span> <strong>$' + fmt(ivClose) + '</strong></div>';
            } else if (ivArr && !Array.isArray(ivArr)) {
                var rank = parseFloat(ivArr.iv_rank || ivArr.iv_rank_1y || 0);
                ih += '<div class="modal-metric"><span>IV Rank:</span> <strong>' + fmt(rank) + '%</strong></div>';
            }
            if (mpArr && Array.isArray(mpArr) && mpArr.length > 0) {
                ih += '<div style="margin-top:6px;font-size:10px;color:#64748b;text-transform:uppercase">Max Pain by Expiry</div>';
                mpArr.slice(0, 5).forEach(function (mp) {
                    var pain = parseFloat(mp.max_pain || 0);
                    var expiry = mp.expiry || mp.expiration_date || '--';
                    var close = parseFloat(mp.close || 0);
                    var diff = close > 0 && pain > 0 ? ((close - pain) / pain * 100).toFixed(1) : null;
                    ih += '<div class="modal-metric"><span>' + expiry + ':</span> <strong>$' + fmt(pain) + '</strong>';
                    if (diff !== null) ih += ' <span class="' + (parseFloat(diff) > 0 ? 'text-bull' : 'text-bear') + '" style="font-size:10px">(' + (parseFloat(diff) > 0 ? '+' : '') + diff + '% from pain)</span>';
                    ih += '</div>';
                });
            } else if (mpArr && !Array.isArray(mpArr)) {
                ih += '<div class="modal-metric"><span>Max Pain:</span> <strong>$' + fmt(mpArr.max_pain || mpArr.price || 0) + '</strong></div>';
            }
            ivmpEl.innerHTML = ih || '<div class="empty">No IV/max pain data</div>';
        }
    } catch (e) { console.error('Modal IV/MP error:', e); if ($('modalIVMaxPain')) $('modalIVMaxPain').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 1: Short Interest modal panel
    try {
        var siEl = $('modalShorts');
        if (siEl) {
            var siRaw = state.shortInterest && state.shortInterest[ticker];
            var sid = null;
            if (Array.isArray(siRaw) && siRaw.length > 0) sid = siRaw[siRaw.length - 1];
            else if (siRaw && !Array.isArray(siRaw)) sid = siRaw;
            if (sid) {
                var sh = '';
                var sif = sid.si_float_returned || sid.short_interest || sid.shares_short || 0;
                var sifPct = parseFloat(sid.percent_returned || sid.short_interest_pct || sid.si_pct_float || sid.percent_of_float || 0);
                // UW returns percent_returned as raw percentage e.g. 10.3 = 10.3%
                // But if value > 100, it's likely shares count being misread — cap and recalc
                if (sifPct > 100) {
                    var totalFloat = parseFloat(sid.total_float_returned || sid.total_float || 0);
                    if (totalFloat > 0 && sif > 0) {
                        sifPct = (parseFloat(sif) / totalFloat * 100);
                    } else {
                        sifPct = 0; // can't calculate, don't show garbage
                    }
                }
                var dvr = parseFloat(sid.days_to_cover_returned || sid.days_to_cover || sid.short_ratio || 0);
                var totalFloat = sid.total_float_returned || sid.total_float || 0;
                var mktDate = sid.market_date || sid.date || '';
                if (mktDate) sh += '<div class="modal-metric"><span>Date:</span> <strong>' + mktDate + '</strong></div>';
                sh += '<div class="modal-metric"><span>Short Interest:</span> <strong>' + fmtK(sif) + '</strong></div>';
                if (sifPct > 0) sh += '<div class="modal-metric"><span>SI % of Float:</span> <strong class="' + (sifPct > 15 ? 'text-bear' : '') + '">' + fmt(sifPct) + '%</strong></div>';
                if (dvr) sh += '<div class="modal-metric"><span>Days to Cover:</span> <strong>' + fmt(dvr) + '</strong></div>';
                if (totalFloat) sh += '<div class="modal-metric"><span>Total Float:</span> <strong>' + fmtK(totalFloat) + '</strong></div>';
                siEl.innerHTML = sh;
            } else {
                siEl.innerHTML = '<div class="empty">Short interest loads on COLD cycle — may take ~15 min after restart</div>';
            }
        }
    } catch (e) { console.error('Modal SI error:', e); if ($('modalShorts')) $('modalShorts').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 1: Earnings modal panel
    try {
        var earnEl = $('modalEarnings');
        if (earnEl) {
            var ed = state.earnings && state.earnings[ticker];
            if (ed) {
                var eh = '';
                var items = Array.isArray(ed) ? ed : [ed];
                items.slice(0, 4).forEach(function (e) {
                    var date = e.report_date || e.date || '--';
                    var time = e.report_time || e.time || '';
                    var est = e.street_mean_est || e.eps_estimate || null;
                    var actual = e.actual_eps || e.eps_actual || null;
                    var move = e.expected_move || null;
                    var postMove = e.post_earnings_move_1d || null;
                    eh += '<div class="modal-metric" style="flex-direction:column;align-items:flex-start">';
                    eh += '<div><strong>' + date + '</strong>';
                    if (time && time !== 'unknown') eh += ' <span style="color:#94a3b8">(' + time + ')</span>';
                    eh += '</div>';
                    eh += '<div style="font-size:11px">';
                    if (est) eh += 'EPS Est: <strong>$' + fmt(parseFloat(est)) + '</strong> ';
                    if (actual) eh += 'Actual: <strong class="' + (parseFloat(actual) >= parseFloat(est || 0) ? 'text-bull' : 'text-bear') + '">$' + fmt(parseFloat(actual)) + '</strong> ';
                    if (move) eh += 'Exp Move: ' + fmt(parseFloat(move)) + '% ';
                    if (postMove) eh += 'Post-ER: <span class="' + (parseFloat(postMove) >= 0 ? 'text-bull' : 'text-bear') + '">' + (parseFloat(postMove) >= 0 ? '+' : '') + fmt(parseFloat(postMove)) + '%</span>';
                    eh += '</div>';
                    eh += '</div>';
                });
                earnEl.innerHTML = eh || '<div class="empty">No earnings data</div>';
            } else {
                earnEl.innerHTML = '<div class="empty">No earnings data</div>';
            }
        }
    } catch (e) { console.error('Modal Earnings error:', e); if ($('modalEarnings')) $('modalEarnings').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Signal Summary Pie Chart
    try {
        var pieCanvas = $('signalPieChart');
        var sigDet = $('signalDetails');
        if (pieCanvas && sigDet) {
            var signals = [];
            // Technical bias signal
            var ta = state.technicals[ticker] || {};
            if (ta.bias === 'BULLISH') signals.push({ name: 'Technicals: Bullish bias', weight: 2, bull: true });
            else if (ta.bias === 'BEARISH') signals.push({ name: 'Technicals: Bearish bias', weight: 2, bull: false });
            if (ta.rsi && ta.rsi < 30) signals.push({ name: 'Technicals: RSI oversold (' + ta.rsi.toFixed(0) + ')', weight: 1.5, bull: true });
            if (ta.rsi && ta.rsi > 70) signals.push({ name: 'Technicals: RSI overbought (' + ta.rsi.toFixed(0) + ')', weight: 1.5, bull: false });
            if (ta.ema && ta.ema.ema9 > ta.ema.ema20) signals.push({ name: 'EMA 9 > EMA 20 (bullish cross)', weight: 1, bull: true });
            else if (ta.ema && ta.ema.ema9 < ta.ema.ema20) signals.push({ name: 'EMA 9 < EMA 20 (bearish cross)', weight: 1, bull: false });
            // Options flow signal
            var flows = (state.optionsFlow || []).filter(function (f) { return (f.ticker || f.symbol) === ticker; });
            var fCalls = 0, fPuts = 0;
            flows.forEach(function (f) { var pc = (f.put_call || f.type || '').toUpperCase(); if (pc.indexOf('CALL') >= 0) fCalls++; else fPuts++; });
            if (fCalls + fPuts > 0) {
                var cpRatio = fCalls / (fCalls + fPuts);
                if (cpRatio > 0.6) signals.push({ name: 'Options flow: ' + fCalls + 'C/' + fPuts + 'P (bullish)', weight: 1.5, bull: true });
                else if (cpRatio < 0.4) signals.push({ name: 'Options flow: ' + fCalls + 'C/' + fPuts + 'P (bearish)', weight: 1.5, bull: false });
                else signals.push({ name: 'Options flow: ' + fCalls + 'C/' + fPuts + 'P (neutral)', weight: 0.5, bull: true });
            }
            // Dark pool signal
            var dpData = state.darkPool[ticker];
            if (dpData && Array.isArray(dpData) && dpData.length > 0) {
                var dpAbove = 0, dpBelow = 0;
                var curP = parseFloat((state.quotes[ticker] || {}).last || (state.quotes[ticker] || {}).price || 0);
                dpData.forEach(function (dp) { var p = parseFloat(dp.price || 0); if (p > curP * 1.001) dpAbove++; else if (p < curP * 0.999) dpBelow++; });
                if (dpAbove > dpBelow) signals.push({ name: 'Dark pool: ' + dpAbove + ' above ask (accumulation)', weight: 1.5, bull: true });
                else if (dpBelow > dpAbove) signals.push({ name: 'Dark pool: ' + dpBelow + ' below bid (distribution)', weight: 1.5, bull: false });
            }
            // Congressional signal
            var congVotes = (state.congressTrades || []).filter(function (c) { return c.ticker === ticker; });
            var congBuy = 0, congSell = 0;
            congVotes.forEach(function (c) { if ((c.txn_type || '').toUpperCase().indexOf('BUY') >= 0 || (c.txn_type || '').toUpperCase().indexOf('PURCHASE') >= 0) congBuy++; else congSell++; });
            if (congBuy > 0) signals.push({ name: 'Congressional: ' + congBuy + ' buy(s)', weight: 2, bull: true });
            if (congSell > 0) signals.push({ name: 'Congressional: ' + congSell + ' sell(s)', weight: 2, bull: false });
            // Insider signal
            var insiders = (state.insiderTransactions || []).filter(function (tx) { return (tx.ticker || tx.symbol) === ticker; });
            var insBuy = 0, insSell = 0;
            insiders.forEach(function (tx) {
                var isBuy = (tx.acquisition_or_disposition || tx.transaction_type || '').toUpperCase().indexOf('A') >= 0 ||
                    (tx.transaction_type || '').toUpperCase().indexOf('BUY') >= 0;
                if (isBuy) insBuy++; else insSell++;
            });
            if (insBuy > 0) signals.push({ name: 'Insider: ' + insBuy + ' buy transaction(s)', weight: 2.5, bull: true });
            if (insSell > 0) signals.push({ name: 'Insider: ' + insSell + ' sell transaction(s)', weight: 2.5, bull: false });
            // Setup signal
            var setup = state.tradeSetups[ticker];
            if (setup) {
                signals.push({ name: 'Setup: ' + setup.direction + ' ' + setup.confidence + '% conf', weight: setup.confidence / 40, bull: setup.direction === 'LONG' });
            }
            // Ticker alerts signal
            var tickerAlerts = (state.alerts || []).filter(function (a) { return a.ticker === ticker; });
            tickerAlerts.forEach(function (a) {
                if (a.direction === 'BULLISH') signals.push({ name: 'Alert: ' + (a.message || '').substring(0, 50), weight: 1, bull: true });
                else if (a.direction === 'BEARISH') signals.push({ name: 'Alert: ' + (a.message || '').substring(0, 50), weight: 1, bull: false });
            });
            // Calculate totals
            var bullW = 0, bearW = 0;
            signals.forEach(function (s) { if (s.bull) bullW += s.weight; else bearW += s.weight; });
            var total = bullW + bearW;
            // Draw pie chart
            var pCtx = pieCanvas.getContext('2d');
            var pw = pieCanvas.width, ph = pieCanvas.height;
            pCtx.clearRect(0, 0, pw, ph);
            var cx = pw / 2, cy = ph / 2, radius = Math.min(pw, ph) / 2 - 10;
            if (total > 0) {
                var bullAngle = (bullW / total) * Math.PI * 2;
                // Bull segment
                pCtx.beginPath(); pCtx.moveTo(cx, cy);
                pCtx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + bullAngle);
                pCtx.closePath();
                pCtx.fillStyle = '#10b981'; pCtx.fill();
                pCtx.strokeStyle = '#0f172a'; pCtx.lineWidth = 2; pCtx.stroke();
                // Bear segment
                pCtx.beginPath(); pCtx.moveTo(cx, cy);
                pCtx.arc(cx, cy, radius, -Math.PI / 2 + bullAngle, -Math.PI / 2 + Math.PI * 2);
                pCtx.closePath();
                pCtx.fillStyle = '#ef4444'; pCtx.fill();
                pCtx.strokeStyle = '#0f172a'; pCtx.lineWidth = 2; pCtx.stroke();
                // Center label
                var bullPct = Math.round(bullW / total * 100);
                var verdict = bullPct > 65 ? 'BULLISH' : bullPct < 35 ? 'BEARISH' : 'MIXED';
                pCtx.fillStyle = '#0f172a'; pCtx.beginPath(); pCtx.arc(cx, cy, radius * 0.45, 0, Math.PI * 2); pCtx.fill();
                pCtx.fillStyle = verdict === 'BULLISH' ? '#10b981' : verdict === 'BEARISH' ? '#ef4444' : '#f59e0b';
                pCtx.font = 'bold 14px Inter'; pCtx.textAlign = 'center'; pCtx.fillText(verdict, cx, cy - 2);
                pCtx.fillStyle = '#e2e8f0'; pCtx.font = '11px Inter'; pCtx.fillText(bullPct + '% Bull', cx, cy + 14);
                pCtx.textAlign = 'left';
            } else {
                pCtx.fillStyle = '#1e293b'; pCtx.beginPath(); pCtx.arc(cx, cy, radius, 0, Math.PI * 2); pCtx.fill();
                pCtx.fillStyle = '#64748b'; pCtx.font = '12px Inter'; pCtx.textAlign = 'center'; pCtx.fillText('No signals', cx, cy + 4); pCtx.textAlign = 'left';
            }
            // Signal details list
            var sd = '<div style="margin-bottom:4px"><strong>' + signals.length + ' signals detected</strong></div>';
            signals.forEach(function (s) {
                sd += '<div style="padding:2px 0;border-bottom:1px solid #1e293b">';
                sd += '<span class="' + (s.bull ? 'text-bull' : 'text-bear') + '">' + (s.bull ? '&#9650;' : '&#9660;') + '</span> ';
                sd += s.name;
                sd += ' <span style="color:#64748b;font-size:9px">(wt:' + s.weight.toFixed(1) + ')</span>';
                sd += '</div>';
            });
            sigDet.innerHTML = sd;
        }
    } catch (e) { console.error('Modal Signal Summary error:', e); if ($('signalDetails')) $('signalDetails').innerHTML = '<div class="empty">Error computing signals: ' + e.message + '</div>'; }

    // Modal Alerts for this ticker
    try {
        var modalAlertsEl = $('modalAlerts');
        if (modalAlertsEl) {
            var tickerAlts = (state.alerts || []).filter(function (a) { return a.ticker === ticker; });
            if (tickerAlts.length > 0) {
                var ah = '';
                tickerAlts.forEach(function (a) {
                    var dc = a.direction === 'BULLISH' ? 'text-bull' : a.direction === 'BEARISH' ? 'text-bear' : '';
                    ah += '<div style="padding:3px 0;border-bottom:1px solid #1e293b;font-size:11px">';
                    ah += '<span class="' + dc + '">' + (a.direction || '--') + '</span> ';
                    if (a.severity === 'HIGH') ah += '<span class="badge badge-hot" style="font-size:9px">HIGH</span> ';
                    ah += '<span>' + (a.message || '') + '</span>';
                    ah += ' <span style="color:#64748b">' + timeAgo(a.time) + '</span>';
                    ah += '</div>';
                });
                modalAlertsEl.innerHTML = ah;
            } else {
                modalAlertsEl.innerHTML = '<div class="empty">No alerts for ' + ticker + '</div>';
            }
        }
    } catch (e) { console.error('Modal Alerts error:', e); if ($('modalAlerts')) $('modalAlerts').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Modal News & Insider for this ticker
    try {
        var niEl = $('modalNewsInsider');
        if (niEl) {
            var nih = '';
            // News filtered by ticker
            var tickerNews = (state.news || []).filter(function (n) {
                var tickers = n.tickers || n.symbols || n.related_tickers || [];
                if (typeof tickers === 'string') tickers = tickers.split(',');
                // Also check if ticker appears in headline
                var inTitle = (n.title || n.headline || '').toUpperCase().indexOf(ticker) >= 0;
                return tickers.indexOf(ticker) >= 0 || inTitle;
            });
            if (tickerNews.length > 0) {
                nih += '<div style="font-size:10px;color:#64748b;text-transform:uppercase;margin-bottom:4px">News</div>';
                tickerNews.slice(0, 5).forEach(function (n) {
                    var sent = (n.sentiment || '').toLowerCase();
                    nih += '<div style="padding:2px 0;border-bottom:1px solid #1e293b;font-size:11px">';
                    nih += '<span class="' + (sent === 'bullish' ? 'text-bull' : sent === 'bearish' ? 'text-bear' : '') + '">' + (n.title || n.headline || '') + '</span>';
                    nih += '</div>';
                });
            }
            // Insider filtered by ticker
            var tickerInsider = (state.insiderTransactions || []).filter(function (tx) { return (tx.ticker || tx.symbol) === ticker; });
            if (tickerInsider.length > 0) {
                nih += '<div style="font-size:10px;color:#64748b;text-transform:uppercase;margin:6px 0 4px">Insider Transactions</div>';
                tickerInsider.slice(0, 5).forEach(function (tx) {
                    var isBuy = (tx.acquisition_or_disposition || tx.transaction_type || '').toUpperCase().indexOf('A') >= 0;
                    nih += '<div style="padding:2px 0;border-bottom:1px solid #1e293b;font-size:11px">';
                    nih += '<span class="' + (isBuy ? 'text-bull' : 'text-bear') + '">' + (isBuy ? 'BUY' : 'SELL') + '</span> ';
                    nih += '<strong>' + (tx.owner_name || tx.insider_name || '--') + '</strong> ';
                    nih += fmtK(tx.shares || tx.amount || 0) + ' @ $' + fmt(parseFloat(tx.price_per_share || tx.price || 0));
                    nih += '</div>';
                });
            }
            niEl.innerHTML = nih || '<div class="empty">News/insider data loads on COLD cycle — may take ~15 min after restart</div>';
        }
    } catch (e) { console.error('Modal News/Insider error:', e); if ($('modalNewsInsider')) $('modalNewsInsider').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 2: NOPE Gauge
    try {
        var nopeEl = $('modalNOPE');
        if (nopeEl) {
            var nopeRaw = state.nope && state.nope[ticker];
            // Handle array response (UW may return array of intraday readings)
            var nopeData = Array.isArray(nopeRaw) ? nopeRaw[nopeRaw.length - 1] : nopeRaw;
            if (nopeData) {
                var nVal = parseFloat(nopeData.nope || nopeData.value || nopeData.nope_value || 0);
                var nColor = nVal > 5 ? '#10b981' : nVal < -5 ? '#ef4444' : '#f59e0b';
                var nDir = nVal > 5 ? 'BULLISH' : nVal < -5 ? 'BEARISH' : 'NEUTRAL';
                var nArrow = nVal > 5 ? '&#9650;' : nVal < -5 ? '&#9660;' : '&#9654;';
                var nh = '<div style="text-align:center;padding:12px 0">';
                nh += '<div style="font-size:32px;font-weight:800;color:' + nColor + '">' + nVal.toFixed(2) + '</div>';
                nh += '<div style="font-size:14px;color:' + nColor + ';margin:4px 0">' + nArrow + ' ' + nDir + '</div>';
                // gauge bar
                var barPct = Math.min(100, Math.max(0, (nVal + 20) / 40 * 100));
                nh += '<div style="width:100%;height:8px;background:#1e293b;border-radius:4px;margin-top:8px;position:relative">';
                nh += '<div style="position:absolute;left:50%;top:-2px;width:2px;height:12px;background:#64748b"></div>';
                nh += '<div style="width:' + barPct + '%;height:100%;border-radius:4px;background:linear-gradient(90deg,#ef4444,#f59e0b,#10b981)"></div>';
                nh += '</div>';
                nh += '<div style="display:flex;justify-content:space-between;font-size:9px;color:#64748b;margin-top:2px"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>';
                // After-hours note if NOPE is 0
                var sess = state.session || '';
                if (nVal === 0 && (sess === 'CLOSED' || sess === 'POST_MARKET' || sess === 'AFTER_HOURS')) {
                    nh += '<div style="font-size:10px;color:#64748b;margin-top:8px;font-style:italic">NOPE is an intraday metric — neutral after market close</div>';
                }
                nh += '</div>';
                nopeEl.innerHTML = nh;
            } else {
                nopeEl.innerHTML = '<div class="empty">No NOPE data — ' + ticker + ' may have low options activity</div>';
            }
        }
    } catch (e) { console.error('Modal NOPE error:', e); if ($('modalNOPE')) $('modalNOPE').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 2: Analyst Consensus
    try {
        var analystEl = $('modalAnalyst');
        if (analystEl) {
            var arData = state.analystRatings && state.analystRatings[ticker];
            if (arData) {
                var items = Array.isArray(arData) ? arData : (arData.data || [arData]);
                var ah = '';
                if (items.length > 0) {
                    var latest = items[0];
                    var rating = (latest.consensus || latest.rating || latest.recommendation || '--').toUpperCase();
                    var target = parseFloat(latest.price_target || latest.target_price || latest.avg_price_target || 0);
                    var curPrice = parseFloat((state.quotes[ticker] || {}).last || (state.quotes[ticker] || {}).price || 0);
                    var rColor = rating.includes('BUY') || rating.includes('OUTPERFORM') ? '#10b981' : rating.includes('SELL') || rating.includes('UNDERPERFORM') ? '#ef4444' : '#f59e0b';
                    ah += '<div style="text-align:center;padding:8px 0">';
                    ah += '<span class="badge" style="background:' + rColor + ';font-size:14px;padding:4px 12px">' + rating + '</span>';
                    ah += '</div>';
                    if (target > 0) {
                        var upside = curPrice > 0 ? ((target - curPrice) / curPrice * 100).toFixed(1) : null;
                        ah += '<div class="modal-metric"><span>Target Price:</span> <strong>$' + fmt(target) + '</strong></div>';
                        if (upside !== null) {
                            var upColor = parseFloat(upside) >= 0 ? '#10b981' : '#ef4444';
                            ah += '<div class="modal-metric"><span>Upside/Downside:</span> <strong style="color:' + upColor + '">' + (parseFloat(upside) >= 0 ? '+' : '') + upside + '%</strong></div>';
                        }
                    }
                    var numAnalysts = latest.analyst_count || latest.num_analysts || items.length;
                    if (numAnalysts) ah += '<div class="modal-metric"><span>Analysts:</span> <strong>' + numAnalysts + '</strong></div>';
                    // Show recent individual ratings if available
                    if (items.length > 1) {
                        ah += '<div style="margin-top:8px;font-size:10px;color:#64748b;text-transform:uppercase">Recent Ratings</div>';
                        items.slice(0, 5).forEach(function (r) {
                            var rr = (r.rating || r.recommendation || '--').toUpperCase();
                            var rc = rr.includes('BUY') ? 'text-bull' : rr.includes('SELL') ? 'text-bear' : '';
                            ah += '<div style="font-size:11px;padding:2px 0;border-bottom:1px solid #1e293b">';
                            ah += '<strong>' + (r.analyst || r.firm || '--') + '</strong> ';
                            ah += '<span class="' + rc + '">' + rr + '</span> ';
                            if (r.price_target) ah += '$' + fmt(parseFloat(r.price_target));
                            ah += '</div>';
                        });
                    }
                }
                analystEl.innerHTML = ah || '<div class="empty">No analyst data</div>';
            } else {
                analystEl.innerHTML = '<div class="empty">No analyst data for ' + ticker + '</div>';
            }
        }
    } catch (e) { console.error('Modal Analyst error:', e); if ($('modalAnalyst')) $('modalAnalyst').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 2: Institutional Flow
    try {
        var instEl = $('modalInstitution');
        if (instEl) {
            var instData = state.institutionActivity && state.institutionActivity[ticker];
            if (instData) {
                var items = Array.isArray(instData) ? instData : (instData.data || [instData]);
                var buys = 0, sells = 0, ih = '';
                if (items.length > 0) {
                    items.slice(0, 8).forEach(function (tx) {
                        var txType = (tx.transaction_type || tx.type || tx.action || '').toUpperCase();
                        var isBuy = txType.includes('BUY') || txType.includes('ACQUIRE') || txType.includes('PURCHASE');
                        if (isBuy) buys++; else sells++;
                        ih += '<div style="font-size:11px;padding:3px 0;border-bottom:1px solid #1e293b">';
                        ih += '<span class="' + (isBuy ? 'text-bull' : 'text-bear') + '">' + (isBuy ? 'BUY' : 'SELL') + '</span> ';
                        ih += '<strong>' + (tx.institution || tx.name || tx.investor || '--') + '</strong> ';
                        if (tx.shares || tx.amount) ih += fmtK(parseFloat(tx.shares || tx.amount || 0)) + ' shares ';
                        if (tx.value || tx.total_value) ih += '($' + fmtK(parseFloat(tx.value || tx.total_value || 0)) + ') ';
                        if (tx.date || tx.filing_date) ih += '<span style="color:#64748b">' + (tx.date || tx.filing_date) + '</span>';
                        ih += '</div>';
                    });
                    var netDir = buys > sells ? 'ACCUMULATING' : sells > buys ? 'DISTRIBUTING' : 'BALANCED';
                    var netColor = buys > sells ? '#10b981' : sells > buys ? '#ef4444' : '#f59e0b';
                    ih = '<div style="margin-bottom:6px;font-weight:700">Net: <span style="color:' + netColor + '">' + netDir + '</span> <small>(' + buys + ' buys / ' + sells + ' sells)</small></div>' + ih;
                }
                instEl.innerHTML = ih || '<div class="empty">No institutional data</div>';
            } else {
                instEl.innerHTML = '<div class="empty">No institutional data for ' + ticker + '</div>';
            }
        }
    } catch (e) { console.error('Modal Institution error:', e); if ($('modalInstitution')) $('modalInstitution').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 2: FDA Calendar
    try {
        var fdaEl = $('modalFDA');
        if (fdaEl) {
            var fdaAll = state.fdaCalendar || [];
            var fdaTicker = fdaAll.filter(function (f) { return (f.ticker || f.symbol || '').toUpperCase() === ticker.toUpperCase(); });
            if (fdaTicker.length > 0) {
                var fh = '';
                fdaTicker.forEach(function (f) {
                    var evDate = f.event_date || f.date || f.catalyst_date || '--';
                    var evType = f.event_type || f.type || f.catalyst_type || 'FDA Event';
                    var drug = f.drug || f.drug_name || f.product || '';
                    var daysUntil = null;
                    if (evDate && evDate !== '--') {
                        var d = new Date(evDate);
                        daysUntil = Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
                    }
                    var urgColor = daysUntil !== null && daysUntil <= 7 ? '#ef4444' : daysUntil !== null && daysUntil <= 30 ? '#f59e0b' : '#64748b';
                    fh += '<div style="padding:4px 0;border-bottom:1px solid #1e293b;border-left:3px solid ' + urgColor + ';padding-left:8px;margin:2px 0">';
                    fh += '<div><strong>' + evType + '</strong>';
                    if (drug) fh += ' — ' + drug;
                    fh += '</div>';
                    fh += '<div style="font-size:11px">';
                    fh += '<span style="color:' + urgColor + '">' + evDate + '</span>';
                    if (daysUntil !== null) {
                        if (daysUntil <= 0) fh += ' <span class="badge badge-hot" style="font-size:9px">PAST DUE</span>';
                        else if (daysUntil <= 7) fh += ' <span class="badge badge-hot" style="font-size:9px">&#9888; ' + daysUntil + ' DAYS</span>';
                        else fh += ' (' + daysUntil + ' days)';
                    }
                    fh += '</div></div>';
                });
                fdaEl.innerHTML = fh;
            } else {
                fdaEl.innerHTML = '<div class="empty">No FDA events for ' + ticker + '</div>';
            }
        }
    } catch (e) { console.error('Modal FDA error:', e); if ($('modalFDA')) $('modalFDA').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // Phase 2: Intraday Strike Magnets
    try {
        var magEl = $('modalStrikeMagnets');
        if (magEl) {
            var magData = state.flowPerStrikeIntraday && state.flowPerStrikeIntraday[ticker];
            if (magData) {
                var strikes = Array.isArray(magData) ? magData : (magData.data || []);
                var curPrice = parseFloat((state.quotes[ticker] || {}).last || (state.quotes[ticker] || {}).price || 0);
                if (strikes.length > 0) {
                    // Sort by volume/premium descending to find top magnets
                    var sorted = strikes.slice().sort(function (a, b) {
                        return (parseFloat(b.volume || b.total_volume || b.premium || 0)) - (parseFloat(a.volume || a.total_volume || a.premium || 0));
                    });
                    var top = sorted.slice(0, 10);
                    top.sort(function (a, b) { return parseFloat(a.strike || 0) - parseFloat(b.strike || 0); });
                    var mh = '';
                    var maxVol = parseFloat(top[0] ? (top[0].volume || top[0].total_volume || top[0].premium || 1) : 1);
                    // Re-sort for maxVol
                    sorted.slice(0, 10).forEach(function (s) { var v = parseFloat(s.volume || s.total_volume || s.premium || 0); if (v > maxVol) maxVol = v; });
                    top.forEach(function (s) {
                        var strike = parseFloat(s.strike || 0);
                        var vol = parseFloat(s.volume || s.total_volume || s.premium || 0);
                        var isAbove = curPrice > 0 && strike >= curPrice;
                        var barW = maxVol > 0 ? Math.round(vol / maxVol * 100) : 0;
                        var barColor = isAbove ? '#10b981' : '#ef4444';
                        mh += '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:11px">';
                        mh += '<span style="min-width:60px;text-align:right;font-weight:600;color:' + barColor + '">$' + strike + '</span>';
                        mh += '<div style="flex:1;height:6px;background:#1e293b;border-radius:3px"><div style="width:' + barW + '%;height:100%;background:' + barColor + ';border-radius:3px"></div></div>';
                        mh += '<span style="min-width:45px;color:#94a3b8">' + fmtK(vol) + '</span>';
                        mh += '</div>';
                    });
                    if (curPrice > 0) {
                        var aboveStrikes = top.filter(function (s) { return parseFloat(s.strike || 0) >= curPrice; });
                        var belowStrikes = top.filter(function (s) { return parseFloat(s.strike || 0) < curPrice; });
                        var nearAbove = aboveStrikes.length > 0 ? aboveStrikes[0] : null;
                        var nearBelow = belowStrikes.length > 0 ? belowStrikes[belowStrikes.length - 1] : null;
                        mh += '<div style="margin-top:6px;font-size:10px;color:#94a3b8">';
                        if (nearAbove) mh += 'Resistance Magnet: <strong class="text-bull">$' + parseFloat(nearAbove.strike).toFixed(0) + '</strong> ';
                        if (nearBelow) mh += 'Support Magnet: <strong class="text-bear">$' + parseFloat(nearBelow.strike).toFixed(0) + '</strong>';
                        mh += '</div>';
                    }
                    magEl.innerHTML = mh;
                } else {
                    magEl.innerHTML = '<div class="empty">No intraday strike data</div>';
                }
            } else {
                magEl.innerHTML = '<div class="empty">No intraday strike data for ' + ticker + '</div>';
            }
        }
    } catch (e) { console.error('Modal Strike Magnets error:', e); if ($('modalStrikeMagnets')) $('modalStrikeMagnets').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }

    // ── Short Squeeze Composite Panel ──
    try {
        var sqEl = $('modalSqueeze');
        if (sqEl) {
            var svRaw = state.shortVolume && state.shortVolume[ticker];
            var ftdRaw = state.failsToDeliver && state.failsToDeliver[ticker];
            var siRaw = state.shortInterest && state.shortInterest[ticker];
            var sqScore = 0;
            var sqComponents = [];

            // Component 1: Short Volume Ratio
            var svArr = Array.isArray(svRaw) ? svRaw : [];
            var lastSV = svArr.length > 0 ? svArr[svArr.length - 1] : null;
            var svRatio = lastSV ? parseFloat(lastSV.short_volume_ratio || lastSV.short_ratio || 0) : 0;
            var svPts = svRatio > 0.5 ? 2 : svRatio > 0.4 ? 1 : 0;
            sqScore += svPts;
            sqComponents.push({ label: 'Short Volume', value: svRatio > 0 ? (svRatio * 100).toFixed(1) + '%' : 'N/A', pts: svPts, max: 2, threshold: '>50%=2pts, >40%=1pt', icon: svPts >= 2 ? '✅' : svPts >= 1 ? '⚠️' : '❌' });

            // Component 2: Fails to Deliver
            var ftdArr = Array.isArray(ftdRaw) ? ftdRaw : [];
            var lastFTD = ftdArr.length > 0 ? ftdArr[ftdArr.length - 1] : null;
            var ftdQty = lastFTD ? parseFloat(lastFTD.quantity || lastFTD.fails || 0) : 0;
            var ftdPts = ftdQty > 1000000 ? 2 : ftdQty > 500000 ? 1 : 0;
            sqScore += ftdPts;
            var ftdDisplay = ftdQty > 1000000 ? (ftdQty / 1e6).toFixed(1) + 'M' : ftdQty > 0 ? (ftdQty / 1e3).toFixed(0) + 'K' : 'N/A';
            sqComponents.push({ label: 'Fails to Deliver', value: ftdDisplay + ' shares', pts: ftdPts, max: 2, threshold: '>1M=2pts, >500K=1pt', icon: ftdPts >= 2 ? '✅' : ftdPts >= 1 ? '⚠️' : '❌' });

            // Component 3: SI % of Float (high SI = squeeze fuel)
            var siObj = Array.isArray(siRaw) ? siRaw[0] : siRaw;
            var siPct = siObj ? parseFloat(siObj.percent_returned || siObj.si_pct_float || siObj.short_interest_pct || siObj.percent_of_float || 0) : 0;
            if (siPct > 100) siPct = 0; // bad data guard
            var siPts = siPct > 20 ? 2 : siPct > 10 ? 1 : 0;
            sqScore += siPts;
            sqComponents.push({ label: 'SI % of Float', value: siPct > 0 ? siPct.toFixed(1) + '%' : 'N/A', pts: siPts, max: 2, threshold: '>20%=2pts, >10%=1pt', icon: siPts >= 2 ? '✅' : siPts >= 1 ? '⚠️' : '❌' });

            // Build HTML
            var sqColor = sqScore >= 4 ? '#ef4444' : sqScore >= 2 ? '#f59e0b' : '#64748b';
            var sqLabel = sqScore >= 5 ? 'EXTREME' : sqScore >= 4 ? 'HIGH' : sqScore >= 2 ? 'MODERATE' : 'LOW';
            var html = '';

            // Score gauge
            html += '<div style="text-align:center;margin-bottom:10px">';
            html += '<div style="font-size:28px;font-weight:800;color:' + sqColor + '">' + sqScore + '<span style="font-size:14px;color:#64748b">/6</span></div>';
            html += '<div style="font-size:11px;color:' + sqColor + ';font-weight:600">' + sqLabel + ' SQUEEZE PROBABILITY</div>';
            // Progress bar
            html += '<div style="height:6px;background:#1e293b;border-radius:3px;margin-top:6px">';
            html += '<div style="width:' + Math.round(sqScore / 6 * 100) + '%;height:100%;background:' + sqColor + ';border-radius:3px;transition:width 0.3s"></div>';
            html += '</div></div>';

            // Component rows
            sqComponents.forEach(function (c) {
                html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.05)">';
                html += '<span style="color:#94a3b8">' + c.icon + ' ' + c.label + '</span>';
                html += '<span style="font-weight:600;color:' + (c.pts >= 2 ? '#ef4444' : c.pts >= 1 ? '#f59e0b' : '#64748b') + '">' + c.value + '</span>';
                html += '<span style="font-size:9px;color:#475569">' + c.pts + '/' + c.max + '</span>';
                html += '</div>';
            });

            // Threshold guide
            html += '<div style="margin-top:6px;font-size:9px;color:#475569;text-align:center">✅ Threshold met  ⚠️ Partial  ❌ Below threshold</div>';

            sqEl.innerHTML = html;
        }
    } catch (e) { console.error('Modal Squeeze error:', e); if ($('modalSqueeze')) $('modalSqueeze').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

// Paper Trade from setup panel
function paperTrade(ticker) {
    if (!confirm('Open a paper trade for ' + ticker + ' at current price?')) return;
    fetch('/api/paper-trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker })
    }).then(function (r) { return r.json(); }).then(function (result) {
        if (result.success) {
            var btn = document.querySelector('.btn-paper-trade');
            if (btn) { btn.textContent = '\u2705 Trade Opened!'; btn.style.background = '#10b981'; btn.style.color = '#fff'; btn.disabled = true; }
        } else {
            alert('Error: ' + (result.error || 'Could not open trade'));
        }
    }).catch(function (e) { alert('Paper trade error: ' + e.message); });
}

// Modal close
$('modalClose').addEventListener('click', function () { $('tickerModal').style.display = 'none'; });
$('tickerModal').addEventListener('click', function (e) { if (e.target === $('tickerModal')) $('tickerModal').style.display = 'none'; });

// Modal timeframe change
if ($('modalTimeframe')) {
    $('modalTimeframe').addEventListener('change', function () {
        var tf = this.value;
        var ticker = $('modalTicker').textContent;
        // Update TradingView chart resolution
        if (tvWidget && tvWidget.activeChart) {
            try {
                var intervals = { '1d': 'D', '4h': '240', '1h': '60', '15m': '15', '5m': '5' };
                tvWidget.activeChart().setResolution(intervals[tf] || 'D');
            } catch (e) { }
        }
        // Fetch and update technicals for the selected timeframe
        if (ticker && ticker !== '--') {
            var url = tf === '1d' ? '/api/technicals/' + ticker : '/api/technicals/' + ticker + '/' + tf;
            fetch(url)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data && !data.error) {
                        var techEl = $('modalTech');
                        var ta = data;
                        var tfLabel = { '1m': '1 Min', '5m': '5 Min', '15m': '15 Min', '1h': '1 Hour', '4h': '4 Hour', '1d': 'Daily' };
                        var th = '<div style="font-size:10px;color:#64748b;margin-bottom:4px">Timeframe: ' + (tfLabel[tf] || tf) + '</div>';
                        th += '<div>RSI: <strong>' + (ta.rsi ? ta.rsi.toFixed(1) : '--') + '</strong></div>';
                        if (ta.macd) th += '<div>MACD: <strong>' + ta.macd.macd.toFixed(2) + '</strong> Signal: ' + ta.macd.signal.toFixed(2) + '</div>';
                        if (ta.ema) th += '<div>EMA 9: $' + fmt(ta.ema.ema9) + ' | EMA 20: $' + fmt(ta.ema.ema20) + '</div>';
                        if (ta.pivots) {
                            th += '<div>Pivot: $' + fmt(ta.pivots.pivot) + '</div>';
                            th += '<div class="text-bull">R1: $' + fmt(ta.pivots.r1) + ' R2: $' + fmt(ta.pivots.r2) + '</div>';
                            th += '<div class="text-bear">S1: $' + fmt(ta.pivots.s1) + ' S2: $' + fmt(ta.pivots.s2) + '</div>';
                        }
                        th += '<div>Bias: <span class="badge ' + (ta.bias === 'BULLISH' ? 'badge-bull' : ta.bias === 'BEARISH' ? 'badge-bear' : 'badge-neutral') + '">' + (ta.bias || '--') + '</span></div>';
                        techEl.innerHTML = th;
                    }
                })
                .catch(function () { });
        }
    });
}

// Init
connect();

// ── Options Profit Calculator ──────────────────────────
(function () {
    var stratEl = $('calcStrategy');
    if (!stratEl) return;
    stratEl.addEventListener('change', function () {
        var v = stratEl.value;
        var s2 = $('calcStrike2Wrap'), s34 = $('calcStrike34Wrap'), p2 = $('calcPremium2Wrap');
        // Show/hide fields based on strategy
        if (v === 'long_call' || v === 'long_put') {
            s2.style.display = 'none'; s34.style.display = 'none'; p2.style.display = 'none';
        } else if (v === 'bull_call_spread' || v === 'bear_put_spread' || v === 'straddle' || v === 'strangle') {
            s2.style.display = ''; s34.style.display = 'none'; p2.style.display = '';
        } else if (v === 'iron_condor') {
            s2.style.display = ''; s34.style.display = ''; p2.style.display = '';
        }
    });
    stratEl.dispatchEvent(new Event('change'));

    // Auto-fill price from watchlist ticker
    var tickerInput = $('calcTicker');
    if (tickerInput) {
        tickerInput.addEventListener('blur', function () {
            var t = tickerInput.value.toUpperCase().trim();
            if (t && state.quotes[t]) {
                $('calcPrice').value = state.quotes[t].price || '';
            }
        });
    }
})();

// ── AI Options Recommendation ──────────────────────────
function getAIRecommendation() {
    var ticker = ($('calcTicker').value || '').toUpperCase().trim();
    if (!ticker) {
        // Try to use selected ticker from watchlist
        var selected = document.querySelector('.watchlist-item.selected');
        if (selected) ticker = selected.dataset.ticker || '';
        if (!ticker && state.tickers && state.tickers.length) ticker = state.tickers[0];
    }
    if (!ticker) {
        alert('Enter a ticker symbol first');
        return;
    }

    var recDiv = $('aiRecommendation');
    recDiv.style.display = 'block';
    recDiv.innerHTML = '<div style="color:var(--text-muted);text-align:center">🤖 Analyzing ' + ticker + '...</div>';

    fetch('/api/options-recommend/' + ticker)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.error) {
                recDiv.innerHTML = '<div style="color:#f87171">❌ ' + data.error + '</div>';
                return;
            }

            var rec = data.recommendation;
            var analysis = data.analysis;

            // Pre-populate the calculator fields
            $('calcTicker').value = data.ticker;
            $('calcPrice').value = data.price;
            $('calcStrategy').value = rec.strategy;
            $('calcStrategy').dispatchEvent(new Event('change'));
            $('calcStrike1').value = rec.strike;
            $('calcPremium').value = rec.estimatedPremium;
            $('calcContracts').value = rec.contracts;
            $('calcDTE').value = rec.dte;

            // For straddle, set premium2 same as premium1
            if (rec.strategy === 'straddle') {
                $('calcStrike2').value = rec.strike;
                $('calcPremium2').value = rec.estimatedPremium;
            }

            // Auto-calculate P/L
            setTimeout(function () { calculateOptions(); }, 100);

            // Build recommendation display
            var riskColor = rec.riskLevel === 'LOW' ? '#4ade80' : rec.riskLevel === 'HIGH' ? '#f87171' : '#fbbf24';
            var dirColor = rec.optionType === 'call' ? '#4ade80' : '#f87171';
            var dirIcon = rec.optionType === 'call' ? '📈' : '📉';
            var horizonLabel = rec.horizon === 'day_trade' ? '⚡ Day Trade' : '📊 Swing';

            var h = '';
            h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
            h += '<div style="font-size:14px;font-weight:700;color:var(--text-primary)">' + dirIcon + ' ' + data.ticker + ' ' + rec.optionType.toUpperCase() + ' $' + rec.strike + '</div>';
            h += '<div style="display:flex;gap:6px">';
            h += '<span style="padding:2px 8px;border-radius:4px;background:rgba(99,102,241,0.2);color:#a5b4fc;font-size:10px;font-weight:600">' + horizonLabel + '</span>';
            h += '<span style="padding:2px 8px;border-radius:4px;background:' + (rec.riskLevel === 'LOW' ? 'rgba(74,222,128,0.15)' : rec.riskLevel === 'HIGH' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)') + ';color:' + riskColor + ';font-size:10px;font-weight:600">' + rec.riskLevel + ' RISK</span>';
            h += '</div></div>';

            // Key metrics row
            h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">Confidence</div><div style="font-weight:700;color:' + (rec.confidence >= 65 ? '#4ade80' : rec.confidence >= 55 ? '#fbbf24' : '#f87171') + '">' + rec.confidence + '%</div></div>';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">Est. Premium</div><div style="font-weight:700;color:var(--text-primary)">$' + rec.estimatedPremium + '</div></div>';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">Exp. Move</div><div style="font-weight:700;color:#60a5fa">$' + rec.expectedMove + '</div></div>';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">DTE</div><div style="font-weight:700;color:var(--text-primary)">' + rec.dte + '</div></div>';
            h += '</div>';

            // Analysis metrics
            h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;padding:8px;background:rgba(15,23,42,0.4);border-radius:6px">';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">IV Rank</div><div style="font-size:11px;font-weight:600;color:' + (analysis.ivRank > 60 ? '#f87171' : analysis.ivRank < 30 ? '#4ade80' : '#fbbf24') + '">' + analysis.ivRank + '%</div></div>';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">ATR</div><div style="font-size:11px;font-weight:600;color:var(--text-primary)">$' + analysis.atr + '</div></div>';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">RSI</div><div style="font-size:11px;font-weight:600;color:' + (analysis.rsi < 30 ? '#4ade80' : analysis.rsi > 70 ? '#f87171' : 'var(--text-primary)') + '">' + (analysis.rsi || '--') + '</div></div>';
            h += '<div style="text-align:center"><div style="color:var(--text-muted);font-size:9px">EMA Bias</div><div style="font-size:11px;font-weight:600;color:' + (analysis.emaBias === 'BULLISH' ? '#4ade80' : analysis.emaBias === 'BEARISH' ? '#f87171' : 'var(--text-muted)') + '">' + analysis.emaBias + '</div></div>';
            h += '</div>';

            // Reasoning
            h += '<div style="margin-bottom:6px">';
            h += '<div style="color:var(--text-muted);font-size:9px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">AI Reasoning</div>';
            data.reasoning.forEach(function (r) {
                h += '<div style="color:var(--text-secondary);font-size:11px;padding:2px 0">• ' + r + '</div>';
            });
            h += '</div>';

            // Top signals
            if (data.topSignals && data.topSignals.length > 0) {
                h += '<div style="color:var(--text-muted);font-size:9px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Supporting Signals</div>';
                h += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
                data.topSignals.forEach(function (s) {
                    h += '<span style="padding:2px 6px;border-radius:3px;background:rgba(74,222,128,0.1);color:#86efac;font-size:10px">' + s + '</span>';
                });
                h += '</div>';
            }

            // IV Warning
            if (data.ivWarning) {
                h += '<div style="margin-top:8px;padding:6px 8px;border-radius:4px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;font-size:11px">' + data.ivWarning + '</div>';
            }

            recDiv.innerHTML = h;
        })
        .catch(function (e) {
            recDiv.innerHTML = '<div style="color:#f87171">❌ Failed to get recommendation: ' + e.message + '</div>';
        });
}

function calculateOptions() {
    var strat = $('calcStrategy').value;
    var price = parseFloat($('calcPrice').value) || 0;
    var s1 = parseFloat($('calcStrike1').value) || 0;
    var s2 = parseFloat($('calcStrike2').value) || 0;
    var s3 = parseFloat($('calcStrike3').value) || 0;
    var s4 = parseFloat($('calcStrike4').value) || 0;
    var prem = parseFloat($('calcPremium').value) || 0;
    var prem2 = parseFloat($('calcPremium2').value) || 0;
    var contracts = parseInt($('calcContracts').value) || 1;
    var multiplier = contracts * 100;

    if (!price || !s1 || !prem) return;

    // Calculate P/L at each price point
    var minP = Math.max(0, price * 0.7);
    var maxP = price * 1.3;
    var points = [];
    var maxProfit = -Infinity, maxLoss = Infinity;
    var breakEvens = [];

    for (var p = minP; p <= maxP; p += (maxP - minP) / 200) {
        var pl = 0;
        switch (strat) {
            case 'long_call':
                pl = (Math.max(0, p - s1) - prem) * multiplier;
                break;
            case 'long_put':
                pl = (Math.max(0, s1 - p) - prem) * multiplier;
                break;
            case 'bull_call_spread':
                pl = (Math.max(0, p - s1) - Math.max(0, p - s2) - (prem - prem2)) * multiplier;
                break;
            case 'bear_put_spread':
                pl = (Math.max(0, s2 - p) - Math.max(0, s1 - p) - (prem - prem2)) * multiplier;
                break;
            case 'straddle':
                pl = (Math.max(0, p - s1) + Math.max(0, s1 - p) - prem - prem2) * multiplier;
                break;
            case 'strangle':
                pl = (Math.max(0, p - s2) + Math.max(0, s1 - p) - prem - prem2) * multiplier;
                break;
            case 'iron_condor':
                // Sell s2 put, buy s1 put, sell s3 call, buy s4 call
                var putSpread = Math.max(0, s2 - p) - Math.max(0, s1 - p);
                var callSpread = Math.max(0, p - s3) - Math.max(0, p - s4);
                pl = (prem + prem2 - putSpread - callSpread) * multiplier;
                break;
        }
        points.push({ price: p, pl: pl });
        if (pl > maxProfit) maxProfit = pl;
        if (pl < maxLoss) maxLoss = pl;
    }

    // Find break-even(s)
    for (var i = 1; i < points.length; i++) {
        if ((points[i - 1].pl < 0 && points[i].pl >= 0) || (points[i - 1].pl >= 0 && points[i].pl < 0)) {
            breakEvens.push(points[i].price);
        }
    }

    // Display metrics
    $('calcMaxProfit').textContent = maxProfit === Infinity || maxProfit > 999999 ? 'Unlimited' : '$' + maxProfit.toFixed(0);
    $('calcMaxLoss').textContent = '$' + Math.abs(maxLoss).toFixed(0);
    var beText = breakEvens.length ? breakEvens.map(function (b) { return '$' + b.toFixed(2); }).join(' / ') : '--';
    $('calcBreakEven').textContent = beText;
    var reqMove = breakEvens.length ? ((breakEvens[0] - price) / price * 100).toFixed(1) + '%' : '--';
    $('calcReqMove').textContent = reqMove;

    // Draw chart
    drawPLChart(points, price, breakEvens);
}

function drawPLChart(points, currentPrice, breakEvens) {
    var canvas = $('calcChart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = 280 * dpr;
    W = canvas.width; H = canvas.height;
    ctx.scale(dpr, dpr);
    var w = canvas.offsetWidth, h = 280;
    ctx.clearRect(0, 0, w, h);

    var pad = { top: 20, right: 20, bottom: 35, left: 60 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    // Data ranges
    var minPrice = points[0].price, maxPrice = points[points.length - 1].price;
    var plVals = points.map(function (p) { return p.pl; });
    var minPL = Math.min.apply(null, plVals);
    var maxPL = Math.max.apply(null, plVals);
    var plRange = (maxPL - minPL) || 1;
    minPL -= plRange * 0.1; maxPL += plRange * 0.1;
    plRange = maxPL - minPL;

    function xOf(price) { return pad.left + (price - minPrice) / (maxPrice - minPrice) * cw; }
    function yOf(pl) { return pad.top + (1 - (pl - minPL) / plRange) * ch; }

    // Grid
    ctx.strokeStyle = 'rgba(100,116,139,0.15)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 5; i++) {
        var gy = pad.top + ch * i / 4;
        ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    }

    // Zero line
    if (minPL < 0 && maxPL > 0) {
        var zeroY = yOf(0);
        ctx.strokeStyle = 'rgba(148,163,184,0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(w - pad.right, zeroY); ctx.stroke();
        ctx.setLineDash([]);
    }

    // P/L line with gradient fill
    ctx.beginPath();
    points.forEach(function (pt, idx) {
        var x = xOf(pt.price), y = yOf(pt.pl);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill area
    var grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    grad.addColorStop(0, 'rgba(16,185,129,0.2)');
    grad.addColorStop(0.5, 'rgba(99,102,241,0.05)');
    grad.addColorStop(1, 'rgba(239,68,68,0.2)');
    ctx.lineTo(xOf(maxPrice), yOf(0));
    ctx.lineTo(xOf(minPrice), yOf(0));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Current price vertical
    var cpx = xOf(currentPrice);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cpx, pad.top); ctx.lineTo(cpx, h - pad.bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f59e0b';
    ctx.font = '10px sans-serif';
    ctx.fillText('Current $' + currentPrice.toFixed(2), cpx + 4, pad.top + 12);

    // Break-even dots
    ctx.fillStyle = '#e2e8f0';
    breakEvens.forEach(function (be) {
        var bx = xOf(be), by = yOf(0);
        ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillText('BE $' + be.toFixed(2), bx + 6, by - 6);
    });

    // Axes labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (var i = 0; i < 5; i++) {
        var val = maxPL - plRange * i / 4;
        ctx.fillText('$' + val.toFixed(0), pad.left - 6, pad.top + ch * i / 4 + 4);
    }
    ctx.textAlign = 'center';
    for (var i = 0; i <= 4; i++) {
        var pv = minPrice + (maxPrice - minPrice) * i / 4;
        ctx.fillText('$' + pv.toFixed(0), pad.left + cw * i / 4, h - pad.bottom + 16);
    }

    // Axis labels
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Stock Price at Expiry', w / 2, h - 4);
    ctx.save();
    ctx.translate(14, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Profit / Loss', 0, 0);
    ctx.restore();
}

// ── AI Chatbot ────────────────────────────────────────────
function toggleChat() {
    var panel = $('chatPanel');
    panel.classList.toggle('open');
}

function sendChat() {
    var input = $('chatInput');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    // Add user message
    var msgs = $('chatMessages');
    var userDiv = document.createElement('div');
    userDiv.className = 'chat-msg user';
    userDiv.textContent = msg;
    msgs.appendChild(userDiv);
    msgs.scrollTop = msgs.scrollHeight;

    // Add typing indicator
    var typingDiv = document.createElement('div');
    typingDiv.className = 'chat-msg bot chat-typing';
    typingDiv.textContent = 'Thinking...';
    msgs.appendChild(typingDiv);
    msgs.scrollTop = msgs.scrollHeight;

    // Detect ticker in message
    var tickerMatch = msg.match(/\b([A-Z]{1,5})\b/);
    var ticker = tickerMatch ? tickerMatch[1] : null;
    // Only use it if it's a known ticker
    if (ticker && !state.quotes[ticker]) ticker = null;

    // 60s timeout for Gemini thinking time
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 60000);

    fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, ticker: ticker }),
        signal: controller.signal
    })
        .then(function (r) { clearTimeout(timeout); return r.json(); })
        .then(function (data) {
            msgs.removeChild(typingDiv);
            var botDiv = document.createElement('div');
            botDiv.className = 'chat-msg bot';
            botDiv.innerHTML = (data.reply || data.error || 'No response').replace(/\n/g, '<br>');
            msgs.appendChild(botDiv);
            msgs.scrollTop = msgs.scrollHeight;
        })
        .catch(function (e) {
            clearTimeout(timeout);
            msgs.removeChild(typingDiv);
            var errDiv = document.createElement('div');
            errDiv.className = 'chat-msg bot';
            var errMsg = e.name === 'AbortError' ? 'Request timed out. Try a simpler question.'
                : 'Error: ' + e.message + '. Try again in a moment.';
            errDiv.textContent = errMsg;
            msgs.appendChild(errDiv);
            msgs.scrollTop = msgs.scrollHeight;
        });
}
