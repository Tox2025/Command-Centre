document.addEventListener('DOMContentLoaded', () => {
    loadReportList();
    loadABResults();
});

async function loadReportList() {
    try {
        const res = await fetch('/api/eod-reports');
        const list = await res.json();

        const select = document.getElementById('reportSelect');
        select.innerHTML = '<option value="">Select Date...</option>';

        list.forEach(date => {
            const opt = document.createElement('option');
            opt.value = date;
            opt.text = date;
            select.appendChild(opt);
        });

        if (list.length > 0) {
            select.value = list[0]; // most recent (already sorted desc)
            loadSelectedReport();
        }
    } catch (e) {
        console.error('Failed to load reports:', e);
    }
}

async function loadSelectedReport() {
    const date = document.getElementById('reportSelect').value;
    if (!date) return;

    document.getElementById('loading').style.display = 'block';
    document.getElementById('reportContent').style.display = 'none';
    document.getElementById('emptyState').style.display = 'none';

    try {
        const res = await fetch('/api/eod-report/' + date);
        if (!res.ok) throw new Error('Report not found');
        const report = await res.json();
        renderReport(report);
    } catch (e) {
        alert('Error loading report: ' + e.message);
    } finally {
        document.getElementById('loading').style.display = 'none';
    }
}

async function generateReport() {
    if (!confirm('Generate EOD report for TODAY now?')) return;

    try {
        const res = await fetch('/api/eod-report/generate', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert('Report generated!');
            await loadReportList();
            // Select and load it
            const select = document.getElementById('reportSelect');
            select.value = data.report.date; // or ID
            loadSelectedReport();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

function renderReport(report) {
    document.getElementById('reportContent').style.display = 'block';

    // 1. Stats
    const perf = report.performance || {};
    const signals = report.signalAnalysis || {};
    const regime = report.marketRegime || {};

    updateStat('statAccuracy', signals.accuracy + '%', signals.accuracy >= 50 ? '#4ade80' : '#f87171');
    document.getElementById('statAccuracyBar').style.width = signals.accuracy + '%';

    // Show Total P&L (all-time realized) and today's P&L
    const paperPnl = perf.paper?.totalPnl || 0;
    const todayPnl = perf.paper?.todayPnl || 0;
    const unrealizedPnl = perf.paper?.unrealizedPnl || 0;
    updateStat('statEquityPnl', formatMoney(paperPnl), paperPnl >= 0 ? '#4ade80' : '#f87171');
    var equityDetail = (perf.paper?.winRate || 0) + '% WR | ' + (perf.paper?.totalTrades || 0) + ' closed today';
    if (todayPnl !== 0) equityDetail += ' | Today: ' + formatMoney(todayPnl);
    if (unrealizedPnl !== 0) equityDetail += ' | Open: ' + formatMoney(unrealizedPnl);
    document.getElementById('statEquityWinRate').innerText = equityDetail;

    const optPnl = perf.options?.totalPnl || 0;
    updateStat('statOptionsPnl', formatMoney(optPnl), optPnl >= 0 ? '#4ade80' : '#f87171');
    document.getElementById('statOptionsWinRate').innerText = (perf.options?.winRate || 0) + '% Win Rate';

    updateStat('statRegime', regime.regime || 'UNKNOWN', '#cbd5e1');

    // 2. Recommendations
    const recsDiv = document.getElementById('recommendationsList');
    recsDiv.innerHTML = '';
    if (report.recommendations && report.recommendations.length > 0) {
        report.recommendations.forEach(rec => {
            const div = document.createElement('div');
            div.className = 'rec-item';
            div.innerText = rec;
            recsDiv.appendChild(div);
        });
    } else {
        recsDiv.innerHTML = '<div style="color:#94a3b8;font-style:italic">No recommendations generated.</div>';
    }

    // 2.5 Horizon Breakdown — use dedicated container to prevent duplication
    var horizonContainer = document.getElementById('horizonContainer');
    if (horizonContainer) horizonContainer.innerHTML = '';
    if (perf.paper?.byHorizon && horizonContainer) {
        const hDiv = document.createElement('div');
        hDiv.className = 'report-card';
        hDiv.innerHTML = '<h3>⏳ Performance by Horizon</h3><div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"></div>';
        const grid = hDiv.querySelector('.stat-grid');

        Object.keys(perf.paper.byHorizon).forEach(h => {
            const data = perf.paper.byHorizon[h];
            const box = document.createElement('div');
            box.className = 'stat-box';
            box.innerHTML = `<div class="stat-label">${h}</div><div class="stat-value" style="font-size:1.2em;color:${data.pnl >= 0 ? '#4ade80' : '#f87171'}">${formatMoney(data.pnl)}</div><div class="stat-label">${data.count} trades</div>`;
            grid.appendChild(box);
        });
        horizonContainer.appendChild(hDiv);
    }

    // 3. Signals
    renderSignalTable('bestSignalsBody', signals.bestSignals || []);
    renderSignalTable('worstSignalsBody', signals.worstSignals || []);

    // 3.5 Tech vs ML Comparison
    var existingTvM = document.getElementById('techVsMlCard');
    if (existingTvM) existingTvM.remove();
    if (signals.techVsMl && signals.techVsMl.techAccuracy !== null) {
        var tvm = signals.techVsMl;
        var winnerColor = tvm.winner === 'TECH' ? '#4ade80' : tvm.winner === 'ML' ? '#818cf8' : '#fbbf24';
        var winnerLabel = tvm.winner === 'TECH' ? '🏆 Tech Wins' : tvm.winner === 'ML' ? '🤖 ML Wins' : '🤝 Tie';
        var tvmCard = document.createElement('div');
        tvmCard.id = 'techVsMlCard';
        tvmCard.className = 'report-card';
        tvmCard.innerHTML = '<h3>📊 Tech vs ML Accuracy</h3>' +
            '<div style="display:flex;gap:30px;align-items:center;margin:15px 0">' +
            '<div style="text-align:center;flex:1"><div style="color:var(--text-muted);font-size:12px">TECHNICAL</div><div style="font-size:28px;font-weight:700;color:#4ade80">' + (tvm.techAccuracy || 0) + '%</div><div style="color:var(--text-muted);font-size:11px">' + tvm.techTotal + ' predictions</div></div>' +
            '<div style="text-align:center"><div style="font-size:24px;font-weight:700;color:' + winnerColor + '">' + winnerLabel + '</div></div>' +
            '<div style="text-align:center;flex:1"><div style="color:var(--text-muted);font-size:12px">ML MODEL</div><div style="font-size:28px;font-weight:700;color:#818cf8">' + (tvm.mlAccuracy || 0) + '%</div><div style="color:var(--text-muted);font-size:11px">' + tvm.mlTotal + ' predictions</div></div>' +
            '</div>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
            '<div style="flex:1;background:var(--bg-input);padding:8px 12px;border-radius:6px;text-align:center;border:1px solid var(--border)"><div style="color:#4ade80;font-weight:600">' + tvm.bothAgree + '</div><div style="color:var(--text-muted);font-size:10px">Both Right</div></div>' +
            '<div style="flex:1;background:var(--bg-input);padding:8px 12px;border-radius:6px;text-align:center;border:1px solid var(--border)"><div style="color:#fbbf24;font-weight:600">' + tvm.techOnlyRight + '</div><div style="color:var(--text-muted);font-size:10px">Tech Only</div></div>' +
            '<div style="flex:1;background:var(--bg-input);padding:8px 12px;border-radius:6px;text-align:center;border:1px solid var(--border)"><div style="color:#818cf8;font-weight:600">' + tvm.mlOnlyRight + '</div><div style="color:var(--text-muted);font-size:10px">ML Only</div></div>' +
            '<div style="flex:1;background:var(--bg-input);padding:8px 12px;border-radius:6px;text-align:center;border:1px solid var(--border)"><div style="color:#f87171;font-weight:600">' + tvm.bothWrong + '</div><div style="color:var(--text-muted);font-size:10px">Both Wrong</div></div>' +
            '</div>';
        var sigSection = document.getElementById('signalAnalysisSection');
        if (sigSection) sigSection.appendChild(tvmCard);
    }

    // 4. Trades
    renderTrades(report.trades || {});

    // 5. Raw JSON
    document.getElementById('rawJson').innerText = JSON.stringify(report, null, 2);
}

function renderTrades(trades) {
    var closedBody = document.getElementById('closedTradesBody');
    var openBody = document.getElementById('openTradesBody');
    closedBody.innerHTML = '';
    openBody.innerHTML = '';

    var closed = trades.closed || [];
    var open = trades.open || [];

    document.getElementById('closedTradeCount').textContent = closed.length;
    document.getElementById('openTradeCount').textContent = open.length;
    document.getElementById('noClosedTrades').style.display = closed.length > 0 ? 'none' : 'block';
    document.getElementById('noOpenTrades').style.display = open.length > 0 ? 'none' : 'block';

    closed.forEach(function (t) {
        var pnlColor = t.pnlDollar >= 0 ? '#4ade80' : '#f87171';
        var dirIcon = t.direction === 'LONG' ? '🔼' : '🔽';
        var closedTime = t.closedAt ? new Date(t.closedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--';
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td style="font-weight:600">' + t.ticker + '</td>' +
            '<td>' + dirIcon + ' ' + t.direction + '</td>' +
            '<td style="font-size:11px">' + t.horizon + '</td>' +
            '<td>$' + Number(t.entry).toFixed(2) + '</td>' +
            '<td>$' + Number(t.exit).toFixed(2) + '</td>' +
            '<td>' + t.shares + '</td>' +
            '<td style="color:' + pnlColor + ';font-weight:600">' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%</td>' +
            '<td style="color:' + pnlColor + ';font-weight:600">$' + (t.pnlDollar >= 0 ? '+' : '') + t.pnlDollar.toFixed(2) + '</td>' +
            '<td style="font-size:11px">' + closedTime + '</td>';
        closedBody.appendChild(tr);
    });

    open.forEach(function (t) {
        var pnlColor = t.pnlDollar >= 0 ? '#4ade80' : '#f87171';
        var dirIcon = t.direction === 'LONG' ? '🔼' : '🔽';
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td style="font-weight:600">' + t.ticker + '</td>' +
            '<td>' + dirIcon + ' ' + t.direction + '</td>' +
            '<td style="font-size:11px">' + t.horizon + '</td>' +
            '<td>$' + Number(t.entry).toFixed(2) + '</td>' +
            '<td>$' + (t.current ? Number(t.current).toFixed(2) : '--') + '</td>' +
            '<td>' + t.shares + '</td>' +
            '<td style="color:' + pnlColor + ';font-weight:600">' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%</td>' +
            '<td style="color:' + pnlColor + ';font-weight:600">$' + (t.pnlDollar >= 0 ? '+' : '') + t.pnlDollar.toFixed(2) + '</td>';
        openBody.appendChild(tr);
    });
}

function updateStat(id, value, color) {
    const el = document.getElementById(id);
    el.innerText = value;
    if (color) el.style.color = color;
}

function formatMoney(val) {
    return (val >= 0 ? '+' : '') + parseFloat(val).toFixed(2);
}

function renderSignalTable(bodyId, signals) {
    const tbody = document.getElementById(bodyId);
    tbody.innerHTML = '';

    if (signals.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:#64748b;text-align:center">No data</td></tr>';
        return;
    }

    signals.forEach(s => {
        const tr = document.createElement('tr');
        const accColor = s.accuracy >= 60 ? '#4ade80' : s.accuracy < 40 ? '#f87171' : '#facc15';
        tr.innerHTML = `
            <td>${s.name}</td>
            <td>${s.fires}</td>
            <td style="color:${accColor};font-weight:600">${s.accuracy}%</td>
        `;
        tbody.appendChild(tr);
    });
}

// A/B Version Comparison — loads independently from api/ab-results
async function loadABResults() {
    try {
        var res = await fetch('/api/ab-results');
        var data = await res.json();
        if (!data || data.versionCount < 2) return; // No A/B data

        var section = document.getElementById('abSection');
        if (!section) return;
        section.style.display = 'block';

        var summary = document.getElementById('abSummary');
        summary.textContent = data.versionCount + ' versions running in parallel \u2014 $' + (data.perVersionBudget || 0).toLocaleString() + ' budget per version';

        var body = document.getElementById('abBody');
        body.innerHTML = '';
        var comp = data.comparison || {};
        var versions = Object.keys(comp);

        // Find best WR
        var bestWR = -1;
        var bestVersion = '';
        versions.forEach(function (v) {
            var s = comp[v];
            if ((s.wins + s.losses) >= 5 && s.winRate > bestWR) {
                bestWR = s.winRate;
                bestVersion = v;
            }
        });

        versions.sort().forEach(function (v) {
            var s = comp[v];
            var isBest = (v === bestVersion && bestWR > 0);
            var wrColor = s.winRate >= 55 ? '#4ade80' : s.winRate >= 45 ? '#facc15' : '#f87171';
            var pnlColor = s.avgPnlPct >= 0 ? '#4ade80' : '#f87171';
            var rowBg = isBest ? 'background:rgba(74,222,128,0.08);' : '';
            var trophy = isBest ? ' \ud83c\udfc6' : '';

            var tr = document.createElement('tr');
            tr.setAttribute('style', rowBg);
            tr.innerHTML =
                '<td style="font-weight:600">' + v + trophy + '</td>' +
                '<td>' + s.trades + '</td>' +
                '<td style="color:#4ade80">' + s.wins + '</td>' +
                '<td style="color:#f87171">' + s.losses + '</td>' +
                '<td style="color:#facc15">' + s.pending + '</td>' +
                '<td style="color:' + wrColor + ';font-weight:600">' + s.winRate + '%</td>' +
                '<td style="color:' + pnlColor + ';font-weight:600">' + (s.avgPnlPct >= 0 ? '+' : '') + s.avgPnlPct + '%</td>' +
                '<td style="color:' + pnlColor + ';font-weight:600">$' + s.pnlTotal.toLocaleString() + '</td>';
            body.appendChild(tr);
        });
    } catch (e) {
        console.error('A/B results load error:', e);
    }
}

