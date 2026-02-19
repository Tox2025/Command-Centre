// Polygon.io Real-Time Tick Data Client
// Streams trades via WebSocket for buy/sell classification, VWAP, and order flow imbalance
// Uses Polygon Stocks WebSocket: wss://socket.polygon.io/stocks

const WebSocket = require('ws');

class PolygonTickClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.ws = null;
        this.connected = false;
        this.subscribedTickers = [];
        this.reconnectDelay = 5000;
        this.maxReconnectDelay = 60000;
        this.reconnectAttempts = 0;

        // Per-ticker real-time data
        this.tickData = {};   // ticker -> { trades[], vwap, buyVol, sellVol, lastPrice, ... }
        this.windowMs = 300000; // 5-minute rolling window for flow analysis
    }

    // ── Initialize ticker tracking ──────────────────────────
    _initTicker(ticker) {
        if (!this.tickData[ticker]) {
            this.tickData[ticker] = {
                trades: [],           // recent trades within window
                vwap: 0,
                totalVolume: 0,
                totalNotional: 0,
                buyVolume: 0,
                sellVolume: 0,
                buyCount: 0,
                sellCount: 0,
                lastPrice: 0,
                lastBid: 0,
                lastAsk: 0,
                highOfDay: 0,
                lowOfDay: Infinity,
                flowImbalance: 0,     // -1 (all sell) to +1 (all buy)
                largeBlockBuys: 0,    // trades > 10K shares
                largeBlockSells: 0,
                updatedAt: null
            };
        }
    }

    // ── Connect to Polygon WebSocket ────────────────────────
    connect(tickers) {
        var self = this;
        if (!this.apiKey) {
            console.log('⚠️ Polygon: No API key — tick data disabled');
            return;
        }

        this.subscribedTickers = (tickers || []).map(function (t) { return t.toUpperCase(); });

        try {
            this.ws = new WebSocket('wss://socket.polygon.io/stocks');

            this.ws.on('open', function () {
                console.log('🔌 Polygon WebSocket connected');
                self.connected = true;
                self.reconnectAttempts = 0;

                // Authenticate
                self.ws.send(JSON.stringify({ action: 'auth', params: self.apiKey }));
            });

            this.ws.on('message', function (raw) {
                try {
                    var messages = JSON.parse(raw);
                    if (!Array.isArray(messages)) messages = [messages];

                    messages.forEach(function (msg) {
                        if (msg.ev === 'status') {
                            if (msg.status === 'auth_success') {
                                console.log('✅ Polygon authenticated');
                                self._subscribeTickers();
                            } else if (msg.status === 'auth_failed') {
                                console.error('❌ Polygon auth failed:', msg.message);
                            }
                        } else if (msg.ev === 'T') {
                            // Trade event
                            self._handleTrade(msg);
                        } else if (msg.ev === 'Q') {
                            // Quote event (bid/ask update)
                            self._handleQuote(msg);
                        }
                    });
                } catch (e) {
                    // Ignore parse errors
                }
            });

            this.ws.on('close', function () {
                self.connected = false;
                console.log('🔌 Polygon WebSocket closed — reconnecting...');
                self._reconnect();
            });

            this.ws.on('error', function (err) {
                console.error('Polygon WebSocket error:', err.message);
            });

        } catch (e) {
            console.error('Polygon connect error:', e.message);
        }
    }

    // ── Subscribe to trade + quote channels ─────────────────
    _subscribeTickers() {
        if (!this.ws || !this.connected || this.subscribedTickers.length === 0) return;

        // Subscribe to trades (T.*) for all tickers
        var tradeSubs = this.subscribedTickers.map(function (t) { return 'T.' + t; }).join(',');
        this.ws.send(JSON.stringify({ action: 'subscribe', params: tradeSubs }));

        // Subscribe to quotes (Q.*) for bid/ask tracking
        var quoteSubs = this.subscribedTickers.map(function (t) { return 'Q.' + t; }).join(',');
        this.ws.send(JSON.stringify({ action: 'subscribe', params: quoteSubs }));

        console.log('📊 Polygon subscribed: ' + this.subscribedTickers.length + ' tickers (trades + quotes)');
    }

    // ── Handle incoming trade ───────────────────────────────
    _handleTrade(msg) {
        var ticker = msg.sym || msg.T || '';
        if (!ticker) return;

        this._initTicker(ticker);
        var td = this.tickData[ticker];
        var price = msg.p || 0;      // price
        var size = msg.s || 0;       // size (shares)
        var timestamp = msg.t || Date.now(); // timestamp (ms)
        var conditions = msg.c || []; // trade conditions

        // Classify as buy or sell based on trade-at-bid vs trade-at-ask
        var side = 'UNKNOWN';
        if (td.lastBid > 0 && td.lastAsk > 0) {
            var mid = (td.lastBid + td.lastAsk) / 2;
            if (price >= td.lastAsk) side = 'BUY';       // hit the ask = buyer-initiated
            else if (price <= td.lastBid) side = 'SELL';  // hit the bid = seller-initiated
            else if (price > mid) side = 'BUY';           // above mid = likely buyer
            else side = 'SELL';                            // below mid = likely seller
        }

        var trade = {
            price: price,
            size: size,
            side: side,
            timestamp: timestamp,
            notional: price * size
        };

        // Add to rolling window
        td.trades.push(trade);

        // Update running totals
        td.lastPrice = price;
        td.totalVolume += size;
        td.totalNotional += trade.notional;
        td.vwap = td.totalNotional / (td.totalVolume || 1);

        if (price > td.highOfDay) td.highOfDay = price;
        if (price < td.lowOfDay) td.lowOfDay = price;

        if (side === 'BUY') {
            td.buyVolume += size;
            td.buyCount++;
            if (size >= 10000) td.largeBlockBuys++;
        } else if (side === 'SELL') {
            td.sellVolume += size;
            td.sellCount++;
            if (size >= 10000) td.largeBlockSells++;
        }

        // Recalculate flow imbalance: -1 (all sell) to +1 (all buy)
        var totalClassified = td.buyVolume + td.sellVolume;
        td.flowImbalance = totalClassified > 0
            ? (td.buyVolume - td.sellVolume) / totalClassified
            : 0;

        td.updatedAt = new Date().toISOString();

        // Prune old trades outside window
        var cutoff = Date.now() - this.windowMs;
        td.trades = td.trades.filter(function (t) { return t.timestamp >= cutoff; });
    }

    // ── Handle incoming quote (bid/ask) ─────────────────────
    _handleQuote(msg) {
        var ticker = msg.sym || msg.T || '';
        if (!ticker) return;

        this._initTicker(ticker);
        var td = this.tickData[ticker];

        if (msg.bp) td.lastBid = msg.bp; // bid price
        if (msg.ap) td.lastAsk = msg.ap; // ask price
    }

    // ── Reconnect with exponential backoff ──────────────────
    _reconnect() {
        var self = this;
        this.reconnectAttempts++;
        var delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), this.maxReconnectDelay);
        setTimeout(function () {
            console.log('🔄 Polygon reconnect attempt #' + self.reconnectAttempts);
            self.connect(self.subscribedTickers);
        }, delay);
    }

    // ── Update subscriptions (when watchlist changes) ───────
    updateSubscriptions(newTickers) {
        var self = this;
        var newSet = (newTickers || []).map(function (t) { return t.toUpperCase(); });

        if (!this.ws || !this.connected) {
            this.subscribedTickers = newSet;
            return;
        }

        // Unsubscribe removed tickers
        var removed = this.subscribedTickers.filter(function (t) { return newSet.indexOf(t) === -1; });
        if (removed.length > 0) {
            var unsubTrades = removed.map(function (t) { return 'T.' + t; }).join(',');
            var unsubQuotes = removed.map(function (t) { return 'Q.' + t; }).join(',');
            this.ws.send(JSON.stringify({ action: 'unsubscribe', params: unsubTrades + ',' + unsubQuotes }));
        }

        // Subscribe new tickers
        var added = newSet.filter(function (t) { return self.subscribedTickers.indexOf(t) === -1; });
        if (added.length > 0) {
            var subTrades = added.map(function (t) { return 'T.' + t; }).join(',');
            var subQuotes = added.map(function (t) { return 'Q.' + t; }).join(',');
            this.ws.send(JSON.stringify({ action: 'subscribe', params: subTrades + ',' + subQuotes }));
            added.forEach(function (t) { self._initTicker(t); });
        }

        this.subscribedTickers = newSet;
        if (removed.length > 0 || added.length > 0) {
            console.log('📊 Polygon subs updated: +' + added.length + ' -' + removed.length + ' = ' + newSet.length + ' total');
        }
    }

    // ── Get tick summary for a ticker (used by signal engine) ──
    getTickSummary(ticker) {
        var t = (ticker || '').toUpperCase();
        var td = this.tickData[t];
        if (!td || !td.updatedAt) return null;

        // Calculate rolling 5-min metrics from trade window
        var recentBuyVol = 0, recentSellVol = 0;
        var recentBuyCount = 0, recentSellCount = 0;
        td.trades.forEach(function (tr) {
            if (tr.side === 'BUY') { recentBuyVol += tr.size; recentBuyCount++; }
            else if (tr.side === 'SELL') { recentSellVol += tr.size; recentSellCount++; }
        });

        var recentTotal = recentBuyVol + recentSellVol;
        var recentImbalance = recentTotal > 0 ? (recentBuyVol - recentSellVol) / recentTotal : 0;

        return {
            vwap: +td.vwap.toFixed(4),
            lastPrice: td.lastPrice,
            bid: td.lastBid,
            ask: td.lastAsk,
            spread: td.lastAsk > 0 && td.lastBid > 0 ? +(td.lastAsk - td.lastBid).toFixed(4) : 0,
            // Session totals
            totalVolume: td.totalVolume,
            buyVolume: td.buyVolume,
            sellVolume: td.sellVolume,
            buyPct: td.totalVolume > 0 ? Math.round(td.buyVolume / td.totalVolume * 100) : 50,
            sellPct: td.totalVolume > 0 ? Math.round(td.sellVolume / td.totalVolume * 100) : 50,
            flowImbalance: +td.flowImbalance.toFixed(4),
            // Rolling 5-min
            recentBuyVol: recentBuyVol,
            recentSellVol: recentSellVol,
            recentImbalance: +recentImbalance.toFixed(4),
            // Large blocks
            largeBlockBuys: td.largeBlockBuys,
            largeBlockSells: td.largeBlockSells,
            // Price
            highOfDay: td.highOfDay,
            lowOfDay: td.lowOfDay === Infinity ? 0 : td.lowOfDay,
            priceVsVwap: td.vwap > 0 ? +((td.lastPrice - td.vwap) / td.vwap * 100).toFixed(4) : 0,
            updatedAt: td.updatedAt
        };
    }

    // ── Get all tick summaries ───────────────────────────────
    getAllSummaries() {
        var self = this;
        var result = {};
        this.subscribedTickers.forEach(function (t) {
            var summary = self.getTickSummary(t);
            if (summary) result[t] = summary;
        });
        return result;
    }

    // ── Reset daily counters (call at market open) ──────────
    resetDaily() {
        var self = this;
        Object.keys(this.tickData).forEach(function (t) {
            self.tickData[t].totalVolume = 0;
            self.tickData[t].totalNotional = 0;
            self.tickData[t].buyVolume = 0;
            self.tickData[t].sellVolume = 0;
            self.tickData[t].buyCount = 0;
            self.tickData[t].sellCount = 0;
            self.tickData[t].largeBlockBuys = 0;
            self.tickData[t].largeBlockSells = 0;
            self.tickData[t].highOfDay = 0;
            self.tickData[t].lowOfDay = Infinity;
            self.tickData[t].trades = [];
            self.tickData[t].vwap = 0;
            self.tickData[t].flowImbalance = 0;
        });
        console.log('📊 Polygon daily counters reset');
    }

    // ── Disconnect ──────────────────────────────────────────
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    // ── Status ──────────────────────────────────────────────
    isConnected() { return this.connected; }
    getSubscribedCount() { return this.subscribedTickers.length; }
}

module.exports = PolygonTickClient;
