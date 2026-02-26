// Polygon.io Stocks Developer — Full Integration Client
// Features: Trades WS, Minute/Second Aggregates WS, Snapshots REST,
//           Technical Indicators REST, Reference Data REST, Corporate Actions
// Plan: Stocks Developer ($79/mo)

const WebSocket = require('ws');
const https = require('https');

class PolygonTickClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.ws = null;
        this.connected = false;
        this.subscribedTickers = [];
        this.reconnectDelay = 5000;
        this.maxReconnectDelay = 60000;
        this.reconnectAttempts = 0;
        this.baseUrl = 'https://api.polygon.io';

        // Per-ticker real-time data
        this.tickData = {};       // ticker -> trade/volume metrics
        this.minuteBars = {};     // ticker -> array of 1-min candles
        this.secondBars = {};     // ticker -> array of second-level candles
        this.snapshotCache = {};  // ticker -> snapshot data
        this.snapshotAge = 0;    // timestamp of last snapshot fetch
        this.tickerDetails = {};  // ticker -> reference data (sector, market cap, etc)
        this.windowMs = 300000;   // 5-minute rolling window for flow analysis
    }

    // ── Initialize ticker tracking ──────────────────────────
    _initTicker(ticker) {
        if (!this.tickData[ticker]) {
            this.tickData[ticker] = {
                trades: [],
                vwap: 0,
                totalVolume: 0,
                totalNotional: 0,
                buyVolume: 0,
                sellVolume: 0,
                buyCount: 0,
                sellCount: 0,
                lastPrice: 0,
                prevPrice: 0,         // for tick rule
                lastBid: 0,
                lastAsk: 0,
                highOfDay: 0,
                lowOfDay: Infinity,
                flowImbalance: 0,
                largeBlockBuys: 0,
                largeBlockSells: 0,
                updatedAt: null
            };
        }
        if (!this.minuteBars[ticker]) this.minuteBars[ticker] = [];
        if (!this.secondBars[ticker]) this.secondBars[ticker] = [];
    }

    // ══════════════════════════════════════════════════════════
    // ██  WEBSOCKET — Trades + Minute/Second Aggregates     ██
    // ══════════════════════════════════════════════════════════

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
                            self._handleTrade(msg);
                        } else if (msg.ev === 'AM') {
                            self._handleMinuteBar(msg);
                        } else if (msg.ev === 'A') {
                            self._handleSecondBar(msg);
                        }
                    });
                } catch (e) { /* ignore parse errors */ }
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

    _subscribeTickers() {
        if (!this.ws || !this.connected || this.subscribedTickers.length === 0) return;

        // Subscribe to Trades, Minute Aggregates, and Second Aggregates
        var tradeSubs = this.subscribedTickers.map(function (t) { return 'T.' + t; }).join(',');
        var minuteSubs = this.subscribedTickers.map(function (t) { return 'AM.' + t; }).join(',');
        var secondSubs = this.subscribedTickers.map(function (t) { return 'A.' + t; }).join(',');

        this.ws.send(JSON.stringify({ action: 'subscribe', params: tradeSubs + ',' + minuteSubs + ',' + secondSubs }));

        console.log('📊 Polygon subscribed: ' + this.subscribedTickers.length + ' tickers (trades + AM + A)');

        // Initialize tickers
        var self = this;
        this.subscribedTickers.forEach(function (t) { self._initTicker(t); });
    }

    // ── Handle Trade — uses TICK RULE for buy/sell classification ──
    _handleTrade(msg) {
        var ticker = msg.sym || msg.T || '';
        if (!ticker) return;

        this._initTicker(ticker);
        var td = this.tickData[ticker];
        var price = msg.p || 0;
        var size = msg.s || 0;
        var timestamp = msg.t || Date.now();

        // TICK RULE: compare to previous trade price
        // Uptick (price > prev) = buyer initiated
        // Downtick (price < prev) = seller initiated
        // Zero tick: use last known direction
        var side = 'UNKNOWN';
        if (td.prevPrice > 0) {
            if (price > td.prevPrice) side = 'BUY';
            else if (price < td.prevPrice) side = 'SELL';
            else {
                // Zero tick — use bid/ask if available (from snapshot), else last direction
                if (td.lastBid > 0 && td.lastAsk > 0) {
                    var mid = (td.lastBid + td.lastAsk) / 2;
                    side = price >= mid ? 'BUY' : 'SELL';
                } else {
                    side = td.lastSide || 'BUY';
                }
            }
        }
        td.lastSide = side;
        td.prevPrice = price;

        // D3: Filter low-quality trades (odd lots, avg price, contingent, prior ref)
        var conditions = msg.c || msg.conditions || [];
        if (Array.isArray(conditions) && conditions.length > 0) {
            var excludeConditions = [15, 16, 37, 52];
            for (var ci = 0; ci < conditions.length; ci++) {
                if (excludeConditions.indexOf(conditions[ci]) !== -1) return;
            }
        }

        var trade = { price: price, size: size, side: side, timestamp: timestamp, notional: price * size };
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

        // Flow imbalance: -1 to +1
        var totalClassified = td.buyVolume + td.sellVolume;
        td.flowImbalance = totalClassified > 0 ? (td.buyVolume - td.sellVolume) / totalClassified : 0;
        td.updatedAt = new Date().toISOString();

        // Prune old trades
        var cutoff = Date.now() - this.windowMs;
        td.trades = td.trades.filter(function (t) { return t.timestamp >= cutoff; });
    }

    // ── Handle Minute Aggregate Bar ─────────────────────────
    _handleMinuteBar(msg) {
        var ticker = msg.sym || msg.T || '';
        if (!ticker) return;

        this._initTicker(ticker);
        var bar = {
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v || 0,
            vwap: msg.vw || 0,
            trades: msg.n || 0,
            timestamp: msg.s || msg.t || Date.now(),
            date: new Date(msg.s || msg.t || Date.now())
        };
        this.minuteBars[ticker].push(bar);

        // Keep last 390 bars (1 trading day of 1-min candles)
        if (this.minuteBars[ticker].length > 390) {
            this.minuteBars[ticker] = this.minuteBars[ticker].slice(-390);
        }
    }

    // ── Handle Second Aggregate Bar ─────────────────────────
    _handleSecondBar(msg) {
        var ticker = msg.sym || msg.T || '';
        if (!ticker) return;

        this._initTicker(ticker);
        var bar = {
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v || 0,
            vwap: msg.vw || 0,
            timestamp: msg.s || msg.t || Date.now()
        };
        this.secondBars[ticker].push(bar);

        // Keep last 300 (5 minutes of second bars)
        if (this.secondBars[ticker].length > 300) {
            this.secondBars[ticker] = this.secondBars[ticker].slice(-300);
        }
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

    // ── Update subscriptions ────────────────────────────────
    updateSubscriptions(newTickers) {
        var self = this;
        var newSet = (newTickers || []).map(function (t) { return t.toUpperCase(); });

        if (!this.ws || !this.connected) {
            this.subscribedTickers = newSet;
            return;
        }

        var removed = this.subscribedTickers.filter(function (t) { return newSet.indexOf(t) === -1; });
        if (removed.length > 0) {
            var unsub = removed.map(function (t) { return 'T.' + t + ',AM.' + t + ',A.' + t; }).join(',');
            this.ws.send(JSON.stringify({ action: 'unsubscribe', params: unsub }));
        }

        var added = newSet.filter(function (t) { return self.subscribedTickers.indexOf(t) === -1; });
        if (added.length > 0) {
            var sub = added.map(function (t) { return 'T.' + t + ',AM.' + t + ',A.' + t; }).join(',');
            this.ws.send(JSON.stringify({ action: 'subscribe', params: sub }));
            added.forEach(function (t) { self._initTicker(t); });
        }

        this.subscribedTickers = newSet;
        if (removed.length > 0 || added.length > 0) {
            console.log('📊 Polygon subs updated: +' + added.length + ' -' + removed.length + ' = ' + newSet.length + ' total');
        }
    }

    // ══════════════════════════════════════════════════════════
    // ██  REST API — Snapshots, Technical Indicators, Ref    ██
    // ══════════════════════════════════════════════════════════

    _restGet(path) {
        var self = this;
        var separator = path.includes('?') ? '&' : '?';
        var url = this.baseUrl + path + separator + 'apiKey=' + this.apiKey;

        return new Promise(function (resolve, reject) {
            https.get(url, function (res) {
                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('JSON parse error')); }
                });
            }).on('error', function (e) { reject(e); });
        });
    }

    // ── Snapshot: All Tickers ────────────────────────────────
    async getSnapshot() {
        try {
            var result = await this._restGet('/v2/snapshot/locale/us/markets/stocks/tickers');
            if (result && result.tickers) {
                var self = this;
                result.tickers.forEach(function (t) {
                    if (t.ticker) {
                        self.snapshotCache[t.ticker] = {
                            price: (t.lastTrade && t.lastTrade.p > 0) ? t.lastTrade.p : (t.day ? t.day.c : 0),
                            open: t.day ? t.day.o : 0,
                            high: t.day ? t.day.h : 0,
                            low: t.day ? t.day.l : 0,
                            close: t.day ? t.day.c : 0,
                            volume: t.day ? t.day.v : 0,
                            vwap: t.day ? t.day.vw : 0,
                            prevClose: t.prevDay ? t.prevDay.c : 0,
                            changePercent: t.todaysChangePerc || 0,
                            change: t.todaysChange || 0,
                            bid: t.lastQuote ? t.lastQuote.P : 0,
                            ask: t.lastQuote ? t.lastQuote.p : 0,
                            bidSize: t.lastQuote ? t.lastQuote.S : 0,
                            askSize: t.lastQuote ? t.lastQuote.s : 0,
                            lastTradePrice: t.lastTrade ? t.lastTrade.p : 0,
                            lastTradeSize: t.lastTrade ? t.lastTrade.s : 0,
                            minBar: t.min || null,
                            updatedAt: t.updated ? new Date(t.updated / 1e6).toISOString() : null
                        };

                        // Update bid/ask for tick classification
                        if (self.tickData[t.ticker]) {
                            if (t.lastQuote) {
                                self.tickData[t.ticker].lastBid = t.lastQuote.P || 0;
                                self.tickData[t.ticker].lastAsk = t.lastQuote.p || 0;
                            }
                        }
                    }
                });
                this.snapshotAge = Date.now();
                return result.tickers.length;
            }
            return 0;
        } catch (e) {
            console.error('Polygon snapshot error:', e.message);
            return 0;
        }
    }

    // ── Snapshot: Gainers ────────────────────────────────────
    async getGainers() {
        try {
            var result = await this._restGet('/v2/snapshot/locale/us/markets/stocks/gainers');
            return (result && result.tickers) ? result.tickers.map(function (t) {
                return {
                    ticker: t.ticker,
                    price: t.day ? t.day.c : 0,
                    changePercent: t.todaysChangePerc || 0,
                    volume: t.day ? t.day.v : 0,
                    vwap: t.day ? t.day.vw : 0
                };
            }) : [];
        } catch (e) { return []; }
    }

    // ── Snapshot: Losers ────────────────────────────────────
    async getLosers() {
        try {
            var result = await this._restGet('/v2/snapshot/locale/us/markets/stocks/losers');
            return (result && result.tickers) ? result.tickers.map(function (t) {
                return {
                    ticker: t.ticker,
                    price: t.day ? t.day.c : 0,
                    changePercent: t.todaysChangePerc || 0,
                    volume: t.day ? t.day.v : 0,
                    vwap: t.day ? t.day.vw : 0
                };
            }) : [];
        } catch (e) { return []; }
    }

    // ── Snapshot: Single Ticker ──────────────────────────────
    async getTickerSnapshot(ticker) {
        try {
            var result = await this._restGet('/v2/snapshot/locale/us/markets/stocks/tickers/' + ticker.toUpperCase());
            return result && result.ticker ? result.ticker : null;
        } catch (e) { return null; }
    }

    // ── Technical Indicators: RSI ────────────────────────────
    async getRSI(ticker, timespan, window) {
        timespan = timespan || 'day';
        window = window || 14;
        try {
            var result = await this._restGet('/v1/indicators/rsi/' + ticker.toUpperCase() + '?timespan=' + timespan + '&window=' + window + '&limit=50&order=desc');
            if (result && result.results && result.results.values) {
                return result.results.values.map(function (v) {
                    return { timestamp: v.timestamp, value: v.value };
                });
            }
            return [];
        } catch (e) { return []; }
    }

    // ── Technical Indicators: EMA ────────────────────────────
    async getEMA(ticker, timespan, window) {
        timespan = timespan || 'day';
        window = window || 20;
        try {
            var result = await this._restGet('/v1/indicators/ema/' + ticker.toUpperCase() + '?timespan=' + timespan + '&window=' + window + '&limit=50&order=desc');
            if (result && result.results && result.results.values) {
                return result.results.values.map(function (v) {
                    return { timestamp: v.timestamp, value: v.value };
                });
            }
            return [];
        } catch (e) { return []; }
    }

    // ── Technical Indicators: SMA ────────────────────────────
    async getSMA(ticker, timespan, window) {
        timespan = timespan || 'day';
        window = window || 50;
        try {
            var result = await this._restGet('/v1/indicators/sma/' + ticker.toUpperCase() + '?timespan=' + timespan + '&window=' + window + '&limit=50&order=desc');
            if (result && result.results && result.results.values) {
                return result.results.values.map(function (v) {
                    return { timestamp: v.timestamp, value: v.value };
                });
            }
            return [];
        } catch (e) { return []; }
    }

    // ── Technical Indicators: MACD ───────────────────────────
    async getMACD(ticker, timespan, shortWindow, longWindow, signalWindow) {
        timespan = timespan || 'day';
        shortWindow = shortWindow || 12;
        longWindow = longWindow || 26;
        signalWindow = signalWindow || 9;
        try {
            var result = await this._restGet('/v1/indicators/macd/' + ticker.toUpperCase() +
                '?timespan=' + timespan +
                '&short_window=' + shortWindow +
                '&long_window=' + longWindow +
                '&signal_window=' + signalWindow +
                '&limit=50&order=desc');
            if (result && result.results && result.results.values) {
                return result.results.values.map(function (v) {
                    return {
                        timestamp: v.timestamp,
                        value: v.value,
                        signal: v.signal,
                        histogram: v.histogram
                    };
                });
            }
            return [];
        } catch (e) { return []; }
    }

    // ── Get all TA indicators for a ticker (combined call) ──
    async getAllIndicators(ticker) {
        try {
            var results = await Promise.all([
                this.getRSI(ticker, 'day', 14),
                this.getEMA(ticker, 'day', 9),
                this.getEMA(ticker, 'day', 20),
                this.getEMA(ticker, 'day', 50),
                this.getSMA(ticker, 'day', 200),
                this.getMACD(ticker, 'day')
            ]);

            var rsi = results[0];
            var ema9 = results[1];
            var ema20 = results[2];
            var ema50 = results[3];
            var sma200 = results[4];
            var macd = results[5];

            // Determine EMA alignment
            var emaBias = 'NEUTRAL';
            if (ema9.length > 0 && ema20.length > 0 && ema50.length > 0) {
                var e9 = ema9[0].value, e20 = ema20[0].value, e50 = ema50[0].value;
                if (e9 > e20 && e20 > e50) emaBias = 'BULLISH';
                else if (e9 < e20 && e20 < e50) emaBias = 'BEARISH';
            }

            // Determine MACD signal
            var macdSignal = 'NEUTRAL';
            if (macd.length >= 2) {
                if (macd[0].histogram > 0 && macd[1].histogram <= 0) macdSignal = 'BULL_CROSS';
                else if (macd[0].histogram < 0 && macd[1].histogram >= 0) macdSignal = 'BEAR_CROSS';
                else if (macd[0].histogram > 0) macdSignal = 'BULLISH';
                else if (macd[0].histogram < 0) macdSignal = 'BEARISH';
            }

            // Price vs SMA200
            var trend200 = 'UNKNOWN';
            if (sma200.length > 0 && this.tickData[ticker.toUpperCase()] && this.tickData[ticker.toUpperCase()].lastPrice > 0) {
                trend200 = this.tickData[ticker.toUpperCase()].lastPrice > sma200[0].value ? 'ABOVE' : 'BELOW';
            }

            return {
                rsi: rsi.length > 0 ? rsi[0].value : null,
                ema9: ema9.length > 0 ? ema9[0].value : null,
                ema20: ema20.length > 0 ? ema20[0].value : null,
                ema50: ema50.length > 0 ? ema50[0].value : null,
                sma200: sma200.length > 0 ? sma200[0].value : null,
                emaBias: emaBias,
                macd: macd.length > 0 ? { value: macd[0].value, signal: macd[0].signal, histogram: macd[0].histogram } : null,
                macdSignal: macdSignal,
                trend200: trend200,
                updatedAt: new Date().toISOString()
            };
        } catch (e) {
            console.error('Polygon getAllIndicators error for ' + ticker + ':', e.message);
            return null;
        }
    }

    // ── Reference Data: Ticker Details ───────────────────────
    async getTickerDetails(ticker) {
        try {
            var result = await this._restGet('/v3/reference/tickers/' + ticker.toUpperCase());
            if (result && result.results) {
                var r = result.results;
                var details = {
                    ticker: r.ticker,
                    name: r.name,
                    market: r.market,
                    locale: r.locale,
                    type: r.type,
                    currency: r.currency_name,
                    exchange: r.primary_exchange,
                    sic_code: r.sic_code,
                    sic_description: r.sic_description,
                    market_cap: r.market_cap || null,
                    share_class_shares_outstanding: r.share_class_shares_outstanding || null,
                    weighted_shares_outstanding: r.weighted_shares_outstanding || null,
                    homepage_url: r.homepage_url,
                    description: r.description ? r.description.substring(0, 200) : null,
                    branding: r.branding || null,
                    list_date: r.list_date
                };
                this.tickerDetails[ticker.toUpperCase()] = details;
                return details;
            }
            return null;
        } catch (e) { return null; }
    }

    // ── Reference Data: Bulk Ticker Details (for watchlist) ──
    async getWatchlistDetails(tickers) {
        var self = this;
        var results = {};
        var promises = (tickers || []).map(function (t) {
            return self.getTickerDetails(t).then(function (d) {
                if (d) results[t.toUpperCase()] = d;
            }).catch(function () { });
        });
        await Promise.all(promises);
        return results;
    }

    // ── Aggregate Bars (REST) — historical candles ───────────
    async getAggregates(ticker, multiplier, timespan, from, to) {
        // timespan: second, minute, hour, day, week, month, quarter, year
        // from/to: YYYY-MM-DD
        try {
            var result = await this._restGet('/v2/aggs/ticker/' + ticker.toUpperCase() +
                '/range/' + multiplier + '/' + timespan + '/' + from + '/' + to +
                '?adjusted=true&sort=asc&limit=5000');
            if (result && result.results) {
                return result.results.map(function (r) {
                    return {
                        open: r.o,
                        high: r.h,
                        low: r.l,
                        close: r.c,
                        volume: r.v,
                        vwap: r.vw,
                        trades: r.n,
                        timestamp: r.t,
                        date: new Date(r.t)
                    };
                });
            }
            return [];
        } catch (e) { return []; }
    }

    // ══════════════════════════════════════════════════════════
    // ██  DATA ACCESS — for signal engine / server           ██
    // ══════════════════════════════════════════════════════════

    getTickSummary(ticker) {
        var t = (ticker || '').toUpperCase();
        var td = this.tickData[t];
        if (!td || !td.updatedAt) return null;

        // Rolling 5-min metrics
        var recentBuyVol = 0, recentSellVol = 0;
        td.trades.forEach(function (tr) {
            if (tr.side === 'BUY') recentBuyVol += tr.size;
            else if (tr.side === 'SELL') recentSellVol += tr.size;
        });
        var recentTotal = recentBuyVol + recentSellVol;
        var recentImbalance = recentTotal > 0 ? (recentBuyVol - recentSellVol) / recentTotal : 0;

        return {
            vwap: +td.vwap.toFixed(4),
            lastPrice: td.lastPrice,
            bid: td.lastBid,
            ask: td.lastAsk,
            spread: td.lastAsk > 0 && td.lastBid > 0 ? +(td.lastAsk - td.lastBid).toFixed(4) : 0,
            totalVolume: td.totalVolume,
            buyVolume: td.buyVolume,
            sellVolume: td.sellVolume,
            buyPct: td.totalVolume > 0 ? Math.round(td.buyVolume / td.totalVolume * 100) : 50,
            sellPct: td.totalVolume > 0 ? Math.round(td.sellVolume / td.totalVolume * 100) : 50,
            flowImbalance: +td.flowImbalance.toFixed(4),
            recentBuyVol: recentBuyVol,
            recentSellVol: recentSellVol,
            recentImbalance: +recentImbalance.toFixed(4),
            largeBlockBuys: td.largeBlockBuys,
            largeBlockSells: td.largeBlockSells,
            highOfDay: td.highOfDay,
            lowOfDay: td.lowOfDay === Infinity ? 0 : td.lowOfDay,
            priceVsVwap: td.vwap > 0 ? +((td.lastPrice - td.vwap) / td.vwap * 100).toFixed(4) : 0,
            updatedAt: td.updatedAt
        };
    }

    getMinuteBars(ticker) {
        return this.minuteBars[(ticker || '').toUpperCase()] || [];
    }

    getSecondBars(ticker) {
        return this.secondBars[(ticker || '').toUpperCase()] || [];
    }

    getSnapshotData(ticker) {
        return this.snapshotCache[(ticker || '').toUpperCase()] || null;
    }

    getDetails(ticker) {
        return this.tickerDetails[(ticker || '').toUpperCase()] || null;
    }

    getAllSummaries() {
        var self = this;
        var result = {};
        this.subscribedTickers.forEach(function (t) {
            var summary = self.getTickSummary(t);
            if (summary) result[t] = summary;
        });
        return result;
    }

    // ── Reset daily counters ────────────────────────────────
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
            self.tickData[t].prevPrice = 0;
        });
        this.minuteBars = {};
        this.secondBars = {};
        console.log('📊 Polygon daily counters reset');
    }

    disconnect() {
        if (this.ws) { this.ws.close(); this.ws = null; }
        this.connected = false;
    }

    isConnected() { return this.connected; }
    getSubscribedCount() { return this.subscribedTickers.length; }
    // ── Phase C: Financials (quarterly earnings history) ────
    async getFinancials(ticker, limit = 4) {
        try {
            var data = await this._restGet(`/vX/reference/financials?ticker=${ticker}&limit=${limit}&sort=period_of_report_date&order=desc`);
            return data?.results || [];
        } catch (e) { return []; }
    }

    // ── Phase C: Related Companies (sympathy play detection) ──
    async getRelatedCompanies(ticker) {
        try {
            var data = await this._restGet(`/v1/related-companies/${ticker}`);
            return data?.results || [];
        } catch (e) { return []; }
    }

    // ── Phase C: Market Holidays (auto-disable scheduler on closures) ──
    async getMarketHolidays() {
        try {
            var data = await this._restGet('/v1/marketstatus/upcoming');
            return Array.isArray(data) ? data : [];
        } catch (e) { return []; }
    }

    // ── Phase C: Stock Splits (prevent false signals) ─────────
    async getSplits(ticker, limit = 5) {
        try {
            var data = await this._restGet(`/v3/reference/splits?ticker=${ticker}&limit=${limit}&order=desc`);
            return data?.results || [];
        } catch (e) { return []; }
    }

    // ── Phase C: Dividends (prevent false signals) ───────────
    async getDividends(ticker, limit = 5) {
        try {
            var data = await this._restGet(`/v3/reference/dividends?ticker=${ticker}&limit=${limit}&order=desc`);
            return data?.results || [];
        } catch (e) { return []; }
    }

    // ── D3: Trade Condition Codes (filter quality) ───────────
    async getConditions() {
        try {
            var data = await this._restGet('/v3/reference/conditions?asset_class=stocks');
            return data?.results || [];
        } catch (e) { return []; }
    }

    // ── D3: Exchange Metadata ────────────────────────────────
    async getExchanges() {
        try {
            var data = await this._restGet('/v3/reference/exchanges?asset_class=stocks');
            return data?.results || [];
        } catch (e) { return []; }
    }

    // ── D3: Filter trades by quality conditions ──────────────
    // Filters out trades with questionable condition codes (odd lots, average price, etc.)
    filterQualityTrades(trades) {
        if (!trades || !Array.isArray(trades)) return trades;
        // Condition codes to exclude: 15=avg price, 16=odd lot, 37=contingent, 52=prior ref price
        var excludeConditions = [15, 16, 37, 52];
        return trades.filter(function (t) {
            var conds = t.conditions || t.c || [];
            if (!Array.isArray(conds) || conds.length === 0) return true;
            for (var i = 0; i < conds.length; i++) {
                if (excludeConditions.indexOf(conds[i]) !== -1) return false;
            }
            return true;
        });
    }

    // ── Phase H: Options Contracts (live pricing for paper trading) ──
    async getOptionsContracts(ticker, params = {}) {
        try {
            var queryParts = [`underlying_ticker=${ticker.toUpperCase()}`];
            if (params.expiration_date) queryParts.push(`expiration_date=${params.expiration_date}`);
            if (params.strike_price) queryParts.push(`strike_price=${params.strike_price}`);
            if (params.contract_type) queryParts.push(`contract_type=${params.contract_type}`);
            if (params.expired !== undefined) queryParts.push(`expired=${params.expired}`);
            queryParts.push('limit=' + (params.limit || 50));
            queryParts.push('order=asc&sort=strike_price');
            var data = await this._restGet('/v3/reference/options/contracts?' + queryParts.join('&'));
            return data?.results || [];
        } catch (e) { return []; }
    }

    // Phase H: Options Snapshot — live bid/ask/last for all options on a ticker
    async getOptionsSnapshot(ticker, params = {}) {
        try {
            var queryParts = [];
            if (params.strike_price) queryParts.push(`strike_price=${params.strike_price}`);
            if (params.expiration_date) queryParts.push(`expiration_date=${params.expiration_date}`);
            if (params.contract_type) queryParts.push(`contract_type=${params.contract_type}`);
            queryParts.push('limit=' + (params.limit || 50));
            var url = '/v3/snapshot/options/' + ticker.toUpperCase() + (queryParts.length > 0 ? '?' + queryParts.join('&') : '');
            var data = await this._restGet(url);
            return data?.results || [];
        } catch (e) { return []; }
    }
}

module.exports = PolygonTickClient;
