// Notifier - Discord/Telegram webhook alerts for high-confidence setups
const https = require('https');

class Notifier {
    constructor(config) {
        config = config || {};
        this.discordUrl = config.discordWebhook || process.env.DISCORD_WEBHOOK_URL || '';
        this.discordBriefUrl = config.discordBriefWebhook || process.env.DISCORD_BRIEF_WEBHOOK_URL || '';
        this.discordPaperUrl = config.discordPaperWebhook || process.env.DISCORD_PAPER_WEBHOOK_URL || '';
        this.telegramToken = config.telegramToken || process.env.TELEGRAM_BOT_TOKEN || '';
        this.telegramChatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '';
        this.minConfidence = config.minConfidence || 65;
        this.cooldown = {};
        this.cooldownMs = config.cooldownMs || 900000; // 15 min per ticker
        this.enabled = !!(this.discordUrl || this.telegramToken);
        this.briefSent = null;

        // Log Telegram status on startup
        if (this.telegramToken && this.telegramChatId) {
            console.log('📱 Telegram notifications ENABLED');
        } else {
            console.log('📱 Telegram notifications disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env)');
        }
    }

    // ── Trade Alert ─────────────────────────────────────────
    async alert(setup, extra) {
        if (!this.enabled) return;
        extra = extra || {};

        // Custom message alerts (e.g. squeeze alerts) bypass confidence threshold
        if (!extra.customMessage && (!setup || (setup.confidence || 0) < this.minConfidence)) return;

        var ticker = setup.ticker || 'UNKNOWN';

        // Cooldown check (skip cooldown for custom alerts — they manage their own)
        if (!extra.customMessage) {
            if (this.cooldown[ticker] && Date.now() - this.cooldown[ticker] < this.cooldownMs) return;
            this.cooldown[ticker] = Date.now();
        }

        var msg = extra.customMessage ? { text: extra.customMessage, setup: setup } : this._formatMessage(setup, extra);

        if (this.discordUrl) {
            await this._sendDiscord(this.discordUrl, msg, setup);
        }
        if (this.telegramToken && this.telegramChatId) {
            await this._sendTelegram(msg.text);
        }
    }

    // ── Morning Brief ──────────────────────────────────────
    async sendBrief(briefData, session, regime) {
        var hasDiscord = !!this.discordBriefUrl;
        var hasTelegram = !!(this.telegramToken && this.telegramChatId);
        if (!hasDiscord && !hasTelegram) return;

        // Only send brief once per day
        var today = new Date().toISOString().slice(0, 10);
        if (this.briefSent === today) return;

        var tickers = Object.keys(briefData || {});
        if (tickers.length === 0) return;

        var now = new Date();
        var est = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

        // Regime info
        var regimeText = regime ? (regime.label || regime.regime || 'Unknown') : 'Unknown';

        // ── Discord embed ──
        if (hasDiscord) {
            var fields = [];
            tickers.forEach(function (t) {
                var d = briefData[t];
                if (!d) return;
                var arrow = d.direction === 'BULLISH' ? '\\u2B06' : d.direction === 'BEARISH' ? '\\u2B07' : '\\u27A1';
                var val = arrow + ' ' + d.direction + ' **' + d.confidence + '%**';
                if (d.setup) {
                    val += '\\nEntry $' + d.setup.entry + ' | T1 $' + d.setup.target1 + ' | Stop $' + d.setup.stop;
                    val += '\\nR:R ' + d.setup.rr;
                }
                var signals = (d.signals || []).slice(0, 5).join(', ');
                if (signals) val += '\\nSignals: ' + signals;
                if (d.earningsRisk && d.earningsRisk.level !== 'NONE') {
                    val += '\\n\\u26A0 Earnings in ' + d.earningsRisk.daysUntil + 'd';
                }
                fields.push({ name: t + ' ($' + (d.price || 0).toFixed ? d.price.toFixed(2) : d.price + ')', value: val, inline: true });
            });

            var payload = JSON.stringify({
                embeds: [{
                    title: '\\uD83C\\uDF05 Morning Brief - ' + est + ' EST',
                    description: '**Session:** ' + (session || 'N/A') + ' | **Regime:** ' + regimeText + ' | **Tickers:** ' + tickers.length,
                    color: 1752220,
                    fields: fields.slice(0, 25),
                    timestamp: now.toISOString(),
                    footer: { text: 'Trading Dashboard - Daily Brief' }
                }]
            });

            await this._postDiscord(this.discordBriefUrl, payload);
        }

        // ── Telegram brief ──
        if (hasTelegram) {
            var tgMsg = '🌅 *Morning Brief* — ' + est + ' EST\n';
            tgMsg += 'Session: ' + (session || 'N/A') + ' | Regime: ' + regimeText + '\n';
            tgMsg += '━━━━━━━━━━━━━━━━━━━━\n';

            tickers.forEach(function (t) {
                var d = briefData[t];
                if (!d) return;
                var arrow = d.direction === 'BULLISH' ? '🟢' : d.direction === 'BEARISH' ? '🔴' : '⚪';
                var price = d.price ? '$' + (typeof d.price === 'number' ? d.price.toFixed(2) : d.price) : '';
                tgMsg += '\n' + arrow + ' *' + t + '* ' + price + '\n';
                tgMsg += d.direction + ' — ' + d.confidence + '% confidence\n';
                if (d.setup) {
                    tgMsg += 'Entry $' + d.setup.entry + ' → T1 $' + d.setup.target1 + '\n';
                    tgMsg += 'Stop $' + d.setup.stop + ' | R:R ' + d.setup.rr + '\n';
                }
                var signals = (d.signals || []).slice(0, 4).join(', ');
                if (signals) tgMsg += 'Signals: ' + signals + '\n';
                if (d.earningsRisk && d.earningsRisk.level !== 'NONE') {
                    tgMsg += '⚠️ Earnings in ' + d.earningsRisk.daysUntil + 'd\n';
                }
            });

            await this._sendTelegram(tgMsg);
        }

        this.briefSent = today;
    }

    // ── Paper Trade Notification ────────────────────────────
    async sendPaperTrade(trade, action) {
        action = action || 'ENTRY';

        var ticker = trade.ticker || 'UNKNOWN';
        var dir = trade.direction || 'N/A';
        var arrow = (dir === 'BULLISH' || dir === 'LONG') ? '\u2B06' : (dir === 'BEARISH' || dir === 'SHORT') ? '\u2B07' : '\u27A1';

        // ── Discord ──
        if (this.discordPaperUrl) {
            var title, description, color;

            if (action === 'ENTRY') {
                color = 3447003; // blue
                title = '\uD83D\uDD77 Paper Trade: ' + ticker + ' ' + dir;
                description = arrow + ' **Entry:** $' + (trade.paperEntry || trade.entry || 0);
                description += '\n**Confidence:** ' + (trade.confidence || 0) + '%';
                var entryPts = (trade.target1 && (trade.paperEntry || trade.entry)) ? Math.abs(trade.target1 - (trade.paperEntry || trade.entry)).toFixed(2) : '?';
                description += '\n**Target:** $' + (trade.target1 || 'N/A') + ' (' + entryPts + ' pts) | **Stop:** $' + (trade.stop || 'N/A');
                if (trade.kellySizing) description += '\n**Kelly Size:** ' + trade.kellySizing.pct + '% ($' + trade.kellySizing.size + ')';
            } else if (action === 'UPDATE') {
                var pnl = trade.unrealizedPnl || 0;
                color = pnl >= 0 ? 3066993 : 15158332;
                title = '\uD83D\uDD77 Paper P&L: ' + ticker + ' ' + (pnl >= 0 ? '+' : '') + pnl + '%';
                description = '**Entry:** $' + (trade.paperEntry || 0);
                description += '\n**Unrealized:** ' + (pnl >= 0 ? '+' : '') + pnl + '%';
                description += '\n**Direction:** ' + dir;
            } else if (action === 'EXIT') {
                var finalPnl = trade.pnlPct || trade.unrealizedPnl || 0;
                var finalPts = trade.pnlPoints || 0;
                color = finalPnl >= 0 ? 3066993 : 15158332;
                title = '\uD83D\uDD77 Paper Exit: ' + ticker + ' ' + (finalPnl >= 0 ? 'WIN' : 'LOSS');
                description = '**Entry:** $' + (trade.paperEntry || 0) + ' \u2192 **Exit:** $' + (trade.exitPrice || trade.outcome || 'N/A');
                description += '\n**P&L:** ' + (finalPnl >= 0 ? '+' : '') + finalPnl + '% (' + (finalPts >= 0 ? '+' : '') + finalPts + ' pts)';
                description += '\n**Status:** ' + (trade.status || 'CLOSED');
            }

            var payload = JSON.stringify({
                embeds: [{
                    title: title,
                    description: description,
                    color: color,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'Spidey - Paper Trading' }
                }]
            });

            await this._postDiscord(this.discordPaperUrl, payload);
        }

        // ── Telegram ──
        if (this.telegramToken && this.telegramChatId) {
            var tgMsg = '';

            if (action === 'ENTRY') {
                tgMsg = '\uD83D\uDD77 *Paper Trade: ' + ticker + '*\n';
                tgMsg += arrow + ' ' + dir + '\n';
                tgMsg += 'Entry: $' + (trade.paperEntry || trade.entry || 0) + '\n';
                tgMsg += 'Confidence: ' + (trade.confidence || 0) + '%\n';
                var tgEntryPts = (trade.target1 && (trade.paperEntry || trade.entry)) ? Math.abs(trade.target1 - (trade.paperEntry || trade.entry)).toFixed(2) : '?';
                tgMsg += 'Target: $' + (trade.target1 || 'N/A') + ' (' + tgEntryPts + ' pts) | Stop: $' + (trade.stop || 'N/A') + '\n';
                if (trade.kellySizing) tgMsg += 'Kelly Size: ' + trade.kellySizing.pct + '% ($' + trade.kellySizing.size + ')';
            } else if (action === 'UPDATE') {
                var tgPnl = trade.unrealizedPnl || 0;
                var pnlEmoji = tgPnl >= 0 ? '📈' : '📉';
                tgMsg = pnlEmoji + ' *Paper P&L: ' + ticker + '*\n';
                tgMsg += 'Unrealized: ' + (tgPnl >= 0 ? '+' : '') + tgPnl + '%\n';
                tgMsg += 'Entry: $' + (trade.paperEntry || 0) + ' | ' + dir;
            } else if (action === 'EXIT') {
                var tgFinalPnl = trade.pnlPct || trade.unrealizedPnl || 0;
                var tgFinalPts = trade.pnlPoints || 0;
                var exitEmoji = tgFinalPnl >= 0 ? '✅' : '❌';
                tgMsg = exitEmoji + ' *Paper Exit: ' + ticker + '*\n';
                tgMsg += 'Entry: $' + (trade.paperEntry || 0) + ' \u2192 Exit: $' + (trade.exitPrice || trade.outcome || 'N/A') + '\n';
                tgMsg += 'P&L: ' + (tgFinalPnl >= 0 ? '+' : '') + tgFinalPnl + '% (' + (tgFinalPts >= 0 ? '+' : '') + tgFinalPts + ' pts)\n';
                tgMsg += 'Result: ' + (tgFinalPnl >= 0 ? 'WIN' : 'LOSS');
            }

            if (tgMsg) await this._sendTelegram(tgMsg);
        }
    }

    // ── Format trade alert message ──────────────────────────
    _formatMessage(setup, extra) {
        var dir = setup.direction || 'N/A';
        var conf = setup.confidence || 0;
        var arrow = (dir === 'BULLISH' || dir === 'LONG') ? '🟢' : (dir === 'BEARISH' || dir === 'SHORT') ? '🔴' : '⚪';
        var regime = extra.regime ? ' | Regime: ' + extra.regime : '';
        var session = extra.session ? ' | ' + extra.session : '';

        var text = arrow + ' *' + setup.ticker + '* ' + dir + ' ' + conf + '%' + session + regime + '\n';
        text += 'Entry: $' + (setup.entry || 0) + ' | T1: $' + (setup.target1 || 0) + ' | Stop: $' + (setup.stop || 0) + '\n';
        text += 'R:R ' + (setup.riskReward || 'N/A') + ' | Signals: ' + ((setup.signals || []).length || 0);
        if (setup.kellySizing) text += ' | Kelly: ' + setup.kellySizing.pct + '%';
        if (extra.earnings) text += '\n⚠️ ' + extra.earnings;

        return { text: text, setup: setup };
    }

    // ── Discord webhook POST ────────────────────────────────
    async _sendDiscord(webhookUrl, msg, setup) {
        if (!webhookUrl) return;
        var dir = setup.direction || '';
        var color = (dir === 'BULLISH' || dir === 'LONG') ? 3066993 : (dir === 'BEARISH' || dir === 'SHORT') ? 15158332 : 3447003;

        var payload = JSON.stringify({
            embeds: [{
                title: setup.ticker + ' - ' + dir + ' Setup (' + (setup.confidence || 0) + '%)',
                description: msg.text,
                color: color,
                timestamp: new Date().toISOString(),
                footer: { text: 'Captain Hook - Trade Alert' }
            }]
        });

        return this._postDiscord(webhookUrl, payload);
    }

    _postDiscord(webhookUrl, payload) {
        return new Promise(function (resolve) {
            try {
                var parsed = new URL(webhookUrl);
                var options = {
                    hostname: parsed.hostname,
                    path: parsed.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                };
                var req = https.request(options, function () { resolve(); });
                req.on('error', function () { resolve(); });
                req.write(payload);
                req.end();
            } catch (e) { resolve(); }
        });
    }

    // ── Telegram Bot API POST ───────────────────────────────
    async _sendTelegram(text) {
        if (!this.telegramToken || !this.telegramChatId) return;

        // Convert Markdown bold (*text*) to HTML bold (<b>text</b>)
        // HTML parse mode is more forgiving with special characters
        var htmlText = text
            .replace(/\*\*/g, '')  // remove Discord-style double bold
            .replace(/\*([^*]+)\*/g, '<b>$1</b>')  // *bold* → <b>bold</b>
            .replace(/&/g, '&amp;')  // must come before other HTML escapes BUT after bold conversion
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');  // escape angle brackets

        // Re-insert the <b> tags (they got escaped above)
        htmlText = htmlText.replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');

        var payload = JSON.stringify({
            chat_id: this.telegramChatId,
            text: htmlText,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });

        return new Promise((resolve) => {
            try {
                var options = {
                    hostname: 'api.telegram.org',
                    path: '/bot' + this.telegramToken + '/sendMessage',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                };
                var req = https.request(options, function (res) {
                    var body = '';
                    res.on('data', function (chunk) { body += chunk; });
                    res.on('end', function () {
                        if (res.statusCode !== 200) {
                            console.error('📱 Telegram error:', res.statusCode, body);
                        }
                        resolve();
                    });
                });
                req.on('error', function (err) {
                    console.error('📱 Telegram request error:', err.message);
                    resolve();
                });
                req.write(payload);
                req.end();
            } catch (e) {
                console.error('📱 Telegram exception:', e.message);
                resolve();
            }
        });
    }

    // ── Status ──────────────────────────────────────────────
    getStatus() {
        return {
            enabled: this.enabled,
            discord: !!this.discordUrl,
            discordBrief: !!this.discordBriefUrl,
            discordPaper: !!this.discordPaperUrl,
            telegram: !!(this.telegramToken && this.telegramChatId),
            cooldownTickers: Object.keys(this.cooldown).length,
            briefSentToday: this.briefSent === new Date().toISOString().slice(0, 10)
        };
    }
}

module.exports = { Notifier };
