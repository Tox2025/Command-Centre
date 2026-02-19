document.addEventListener('DOMContentLoaded', () => {
    loadReportList();
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
            // Select most recent by default? No, let user choose.
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

    // Show Total $ P&L
    const paperPnl = perf.paper?.totalPnl || 0;
    updateStat('statEquityPnl', formatMoney(paperPnl), paperPnl >= 0 ? '#4ade80' : '#f87171');
    document.getElementById('statEquityWinRate').innerText = (perf.paper?.winRate || 0) + '% Win Rate (' + (perf.paper?.totalTrades || 0) + ' trades)';

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

    // 2.5 Horizon Breakdown
    if (perf.paper?.byHorizon) {
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
        // Insert after summary section
        const section = document.querySelector('.report-section');
        section.appendChild(hDiv);
    }

    // 3. Signals
    renderSignalTable('bestSignalsBody', signals.bestSignals || []);
    renderSignalTable('worstSignalsBody', signals.worstSignals || []);

    // 4. Raw JSON
    document.getElementById('rawJson').innerText = JSON.stringify(report, null, 2);
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
