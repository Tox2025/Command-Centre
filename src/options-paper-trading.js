// Options Paper Trading â€” real options contract trades via IBKR
// Tracks entries, premium P&L, theta decay, expirations, and feeds ML
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'options-paper-trades.json');

class OptionsPaperTrading {
    constructor() {
        this.trades = [];
        this.pendingOrders = new Map(); // orderId → { params, timestamp } — awaiting IBKR fill
        this.brokerClient = null;       // Injected from server.js
        this.polygonClient = null;      // Injected from server.js for real option chain data
        this.uwClient = null;           // Injected from server.js
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(DATA_PATH)) {
                var raw = fs.readFileSync(DATA_PATH, 'utf8');
                var data = JSON.parse(raw);
                this.trades = data.trades || [];
            }
        } catch (e) {
            this.trades = [];
        }
    }

    _save() {
        try {
            var dir = path.dirname(DATA_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(DATA_PATH, JSON.stringify({ trades: this.trades }, null, 2));
        } catch (e) {
            // silent
        }
    }

    // ── Open a new options trade — IBKR-first flow ────────────────────
    // Step 1: Validate + send to IBKR → store as PENDING
    // Step 2: handleFill() creates actual trade when IBKR confirms
    openTrade(params) {
        if (!params || !params.ticker) return null;

        // Block options trades outside market hours (9:30 AM - 4:00 PM ET)
        var now = new Date();
        var etTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
        var parts = etTime.split(':');
        var etHour = parseInt(parts[0]);
        var etMin = parseInt(parts[1]);
        var etMinutes = etHour * 60 + etMin;
        if (etMinutes < 570 || etMinutes >= 960) { // 570 = 9:30, 960 = 16:00
            console.log('[Options] BLOCKED ' + params.ticker + ' — outside market hours (' + etHour + ':' + (etMin < 10 ? '0' : '') + etMin + ' ET)');
            return null;
        }

        // Check for duplicate open trade (same ticker + type + strike)
        var dup = this.trades.find(function (t) {
            return t.status === 'OPEN'
                && t.ticker === params.ticker
                && t.optionType === params.optionType
                && t.strike === params.strike;
        });
        if (dup) return null;

        // Check for duplicate pending order
        var self = this;
        var pendingDup = false;
        this.pendingOrders.forEach(function(pending) {
            if (pending.params.ticker === params.ticker
                && pending.params.optionType === params.optionType
                && pending.params.strike === params.strike) {
                pendingDup = true;
            }
        });
        if (pendingDup) return null;

        // IBKR-FIRST: Send order to broker BEFORE creating any trade record
        if (this.brokerClient && this.brokerClient.isConnected && process.env.BROKER_EXECUTION === 'true') {
            console.log('[Options] Submitting to IBKR: ' + params.optionType.toUpperCase() + ' ' + params.ticker + ' $' + params.strike + ' x' + (params.contracts || 1));
            var orderParams = {
                ticker: params.ticker,
                optionType: params.optionType,
                strike: params.strike,
                premium: params.premium || 0,
                quantity: params.contracts || 1,
                action: 'BUY',
                expirationDate: params.expirationDate || this._calcExpiry(params.dte || 30)
            };

            this.brokerClient.placeOptionOrder(orderParams).then(function(brokerResult) {
                if (brokerResult.status === 'FAILED') {
                    console.error('[Options] IBKR BLOCKED: ' + params.ticker + ' — ' + (brokerResult.reason || 'disconnected'));
                    return;
                }

                // Store as PENDING — trade will be created in handleFill()
                self.pendingOrders.set(brokerResult.orderId, {
                    params: params,
                    orderParams: orderParams,
                    orderId: brokerResult.orderId,
                    timestamp: Date.now(),
                    status: 'SUBMITTED'
                });
                console.log('[Options] PENDING order ' + brokerResult.orderId + ': ' + params.ticker + ' ' + params.optionType + ' $' + params.strike);
            }).catch(function(e) {
                console.error('[Options] IBKR order failed: ' + e.message);
            });

            // Return a placeholder — actual trade created on fill
            return { pending: true, ticker: params.ticker, strike: params.strike };
        }

        // FALLBACK: No broker connected — create trade directly (simulated only)
        console.log('[Options] No broker — simulated trade: ' + params.ticker + ' ' + params.optionType + ' $' + params.strike);
        var trade = this._createTradeRecord(params, null);
        this.trades.push(trade);
        this._save();
        return trade;
    }

    // ── Calculate expiration date ──────────────────────────
    _calcExpiry(dte) {
        var d = new Date();
        d.setDate(d.getDate() + dte);
        return d.toISOString().split('T')[0]; // YYYY-MM-DD
    }

    // — Parse OCC option symbol (e.g. "APP260821C00520000") —
    _parseOptionSymbol(sym) {
        // OCC format: TICKER + YYMMDD + C/P + 8-digit strike (last 3 are decimal)
        var match = sym.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!match) return null;
        var y = parseInt('20' + match[2].substring(0, 2));
        var m = parseInt(match[2].substring(2, 4)) - 1;
        var d = parseInt(match[2].substring(4, 6));
        return {
            ticker: match[1],
            expiration_date: y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
            optionType: match[3] === 'C' ? 'call' : 'put',
            strike: parseInt(match[4]) / 1000
        };
    }

    // — Find real option contract (UW primary, Polygon fallback) —
    async _findRealContract(ticker, optionType, targetStrike, targetDTE) {
        // Try UW first
        if (this.uwClient) {
            try {
                var result = await this.uwClient.getOptionChain(ticker);
                var contracts = (result && result.data) ? result.data : [];
                if (contracts.length > 0) {
                    var self = this;
                    var today = new Date();
                    var targetDate = new Date();
                    targetDate.setDate(today.getDate() + targetDTE);
                    var typeChar = optionType === 'call' ? 'C' : 'P';

                    // Parse and filter by type
                    var parsed = contracts.map(function(c) {
                        var p = self._parseOptionSymbol(c.option_symbol || '');
                        if (!p) return null;
                        p.raw = c;
                        return p;
                    }).filter(function(p) {
                        return p && p.optionType === optionType;
                    });

                    if (parsed.length === 0) return null;

                    // Filter contracts with expiry >= target DTE
                    var valid = parsed.filter(function(p) {
                        return new Date(p.expiration_date) >= targetDate;
                    });
                    if (valid.length === 0) valid = parsed;

                    // Sort by closest expiry to target
                    valid.sort(function(a, b) {
                        var da = Math.abs(new Date(a.expiration_date) - targetDate);
                        var db = Math.abs(new Date(b.expiration_date) - targetDate);
                        return da - db;
                    });

                    // Pick contracts with the best expiry
                    var bestExpiry = valid[0].expiration_date;
                    var sameExpiry = valid.filter(function(p) { return p.expiration_date === bestExpiry; });

                    // Find closest strike to target
                    sameExpiry.sort(function(a, b) {
                        return Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike);
                    });

                    var best = sameExpiry[0];
                    console.log('[Options] UW contract found: ' + best.raw.option_symbol + ' strike=$' + best.strike + ' exp=' + best.expiration_date);
                    return {
                        strike: best.strike,
                        expirationDate: best.expiration_date,
                        contractSymbol: best.raw.option_symbol,
                        _uwData: best.raw  // carry full UW data for premium lookup
                    };
                }
            } catch (e) {
                console.error('[Options] UW contract lookup error:', e.message);
            }
        }

        // Fallback to Polygon
        if (!this.polygonClient) return null;
        try {
            var contracts = await this.polygonClient.getOptionsContracts(ticker, {
                contract_type: optionType,
                expired: false,
                limit: 100
            });
            if (!contracts || contracts.length === 0) return null;

            var today = new Date();
            var targetDate = new Date();
            targetDate.setDate(today.getDate() + targetDTE);

            var valid = contracts.filter(function(c) {
                var exp = new Date(c.expiration_date);
                return exp >= targetDate;
            });
            if (valid.length === 0) valid = contracts;

            valid.sort(function(a, b) {
                var da = Math.abs(new Date(a.expiration_date) - targetDate);
                var db = Math.abs(new Date(b.expiration_date) - targetDate);
                return da - db;
            });

            var bestExpiry = valid[0].expiration_date;
            var sameExpiry = valid.filter(function(c) { return c.expiration_date === bestExpiry; });

            sameExpiry.sort(function(a, b) {
                return Math.abs(a.strike_price - targetStrike) - Math.abs(b.strike_price - targetStrike);
            });

            var best = sameExpiry[0];
            return {
                strike: best.strike_price,
                expirationDate: best.expiration_date,
                contractSymbol: best.ticker
            };
        } catch (e) {
            console.error('[Options] Polygon contract lookup error:', e.message);
            return null;
        }
    }

    // — Get real option premium (UW primary, Polygon fallback) —
    async _getRealPremium(ticker, strike, expiry, optionType, uwData) {
        // If we already have UW data from _findRealContract, use it directly
        if (uwData) {
            var bid = parseFloat(uwData.nbbo_bid) || 0;
            var ask = parseFloat(uwData.nbbo_ask) || 0;
            var last = parseFloat(uwData.last_price) || 0;
            var mid = (bid && ask) ? +((bid + ask) / 2).toFixed(2) : last;
            if (mid > 0 || last > 0) {
                console.log('[Options] UW premium: bid=$' + bid + ' ask=$' + ask + ' mid=$' + mid + ' IV=' + (parseFloat(uwData.implied_volatility) || 0).toFixed(2));
                return {
                    bid: bid,
                    ask: ask,
                    last: last,
                    mid: mid,
                    volume: uwData.volume || 0,
                    openInterest: uwData.open_interest || 0,
                    iv: parseFloat(uwData.implied_volatility) || 0
                };
            }
        }

        // Try UW option chain lookup if no cached data
        if (this.uwClient && !uwData) {
            try {
                var result = await this.uwClient.getOptionChain(ticker, expiry);
                var contracts = (result && result.data) ? result.data : [];
                var self = this;
                var matching = contracts.filter(function(c) {
                    var p = self._parseOptionSymbol(c.option_symbol || '');
                    return p && Math.abs(p.strike - strike) < 0.01 && p.optionType === optionType;
                });
                if (matching.length > 0) {
                    var c = matching[0];
                    var bid = parseFloat(c.nbbo_bid) || 0;
                    var ask = parseFloat(c.nbbo_ask) || 0;
                    var last = parseFloat(c.last_price) || 0;
                    var mid = (bid && ask) ? +((bid + ask) / 2).toFixed(2) : last;
                    if (mid > 0 || last > 0) {
                        return { bid: bid, ask: ask, last: last, mid: mid, volume: c.volume || 0, openInterest: c.open_interest || 0, iv: parseFloat(c.implied_volatility) || 0 };
                    }
                }
            } catch (e) {
                console.error('[Options] UW premium lookup error:', e.message);
            }
        }

        // Fallback to Polygon
        if (!this.polygonClient) return null;
        try {
            var snapshots = await this.polygonClient.getOptionsSnapshot(ticker, {
                strike_price: strike,
                expiration_date: expiry,
                contract_type: optionType
            });
            if (!snapshots || snapshots.length === 0) return null;

            var snap = snapshots[0];
            var day = snap.day || {};
            var lastQuote = snap.last_quote || {};
            var lastTrade = snap.last_trade || {};
            return {
                bid: lastQuote.bid || 0,
                ask: lastQuote.ask || 0,
                last: lastTrade.price || day.close || 0,
                mid: (lastQuote.bid && lastQuote.ask) ? +((lastQuote.bid + lastQuote.ask) / 2).toFixed(2) : 0,
                volume: day.volume || 0,
                openInterest: snap.open_interest || 0,
                iv: snap.implied_volatility || 0
            };
        } catch (e) {
            console.error('[Options] Polygon premium lookup error:', e.message);
            return null;
        }
    }

    // ── Create trade record (used by handleFill and simulated fallback) ──
    _createTradeRecord(params, fillData) {
        var now = Date.now();
        var fillPrice = fillData ? fillData.filledPrice : (params.premium || 0);
        var trade = {
            id: 'OPT-' + now + '-' + Math.random().toString(36).substr(2, 5),
            ticker: params.ticker,
            optionType: params.optionType || 'call',
            strategy: params.strategy || 'long_call',
            strike: params.strike,
            dte: params.dte || 30,
            expirationDate: params.expirationDate || this._calcExpiry(params.dte || 30),
            entryPremium: fillPrice,           // IBKR fill price (not estimated)
            currentPremium: fillPrice,
            contracts: params.contracts || 1,
            entryPrice: params.stockPrice || 0,
            currentPrice: params.stockPrice || 0,
            confidence: params.confidence || 0,
            direction: params.direction || 'NEUTRAL',
            signals: params.signals || [],
            reasoning: params.reasoning || [],
            ivRankAtEntry: params.ivRank || 0,
            horizon: params.horizon || 'swing',
            session: params.session || 'UNKNOWN',
            pnl: 0,
            pnlPct: 0,
            unrealizedPnl: 0,
            unrealizedPnlPct: 0,
            openTime: new Date().toISOString(),
            closeTime: null,
            status: 'OPEN',
            outcome: null,
            autoEntry: params.autoEntry || false,
            signalVersion: params.signalVersion || 'v1.0',
            features: params.features || {},
            contractSymbol: params.contractSymbol || null,
            usedRealData: params.usedRealData || false,
            // IBKR data — source of truth
            brokerFilled: fillData ? true : false,
            brokerOrderId: fillData ? fillData.orderId : null,
            brokerFillPrice: fillData ? fillData.filledPrice : null,
            brokerStatus: fillData ? 'FILLED' : 'SIMULATED',
            commission: 0
        };
        return trade;
    }

    // ── Handle IBKR order status — creates trade on FILL ──────────
    handleBrokerUpdate(orderId, status, fillPrice, filledQty) {
        if (!orderId) return;
        var orderIdStr = orderId.toString();

        // Check if this is a PENDING entry order
        var pending = this.pendingOrders.get(orderIdStr);
        if (pending) {
            if (status === 'FILLED' && fillPrice > 0) {
                // CREATE the trade — IBKR confirmed the fill
                var trade = this._createTradeRecord(pending.params, {
                    orderId: orderIdStr,
                    filledPrice: fillPrice,
                    filledQty: filledQty || pending.params.contracts || 1
                });
                this.trades.push(trade);
                this.pendingOrders.delete(orderIdStr);
                this._save();
                console.log('[Options] ✅ FILLED → Trade created: ' + trade.ticker + ' ' + trade.optionType + ' $' + trade.strike + ' @ $' + fillPrice + ' (IBKR confirmed)');
            } else if (status === 'REJECTED' || status === 'CANCELLED') {
                console.error('[Options] ❌ ' + status + ': ' + pending.params.ticker + ' $' + pending.params.strike + ' — no trade created');
                this.pendingOrders.delete(orderIdStr);
            }
            return;
        }

        // Check if this is an existing trade (close order fill)
        var self = this;
        var closeTrade = this.trades.find(function(t) {
            return t.closeOrderId === orderIdStr;
        });
        if (closeTrade && status === 'FILLED') {
            var exitPrice = fillPrice > 0 ? fillPrice : closeTrade.currentPremium;
            closeTrade.brokerClosePrice = exitPrice;
            closeTrade.brokerCloseStatus = 'FILLED';
            this._finalizeClose(closeTrade, exitPrice);
            console.log('[Options] ✅ CLOSE FILLED: ' + closeTrade.ticker + ' ' + closeTrade.optionType + ' $' + closeTrade.strike + ' exit @ $' + exitPrice);
            return;
        }

        // Legacy: check for old-style trades with brokerOrderId
        var legacyTrade = this.trades.find(function(t) {
            return t.brokerOrderId === orderIdStr && t.status === 'OPEN';
        });
        if (legacyTrade) {
            if (status === 'FILLED' && fillPrice > 0) {
                legacyTrade.brokerFillPrice = fillPrice;
                legacyTrade.entryPremium = fillPrice;
                legacyTrade.currentPremium = fillPrice;
                legacyTrade.brokerFilled = true;
                legacyTrade.brokerStatus = 'FILLED';
                console.log('[Options] ✅ Legacy FILL: ' + legacyTrade.ticker + ' @ $' + fillPrice);
            } else if (status === 'REJECTED' || status === 'CANCELLED') {
                legacyTrade.status = 'REJECTED';
                legacyTrade.closeTime = new Date().toISOString();
            }
            this._save();
        }
    }

    // ── Handle execution details (timestamp + exchange) ──────────
    handleExecDetails(execData) {
        if (!execData || !execData.orderId) return;
        var orderIdStr = execData.orderId.toString();
        var trade = this.trades.find(function(t) {
            return t.brokerOrderId === orderIdStr;
        });
        if (trade) {
            if (execData.time) trade.execTime = execData.time;
            if (execData.exchange) trade.execExchange = execData.exchange;
            if (execData.execId) trade.execId = execData.execId;
            this._save();
        }
    }

    // ── Handle commission report ──────────────────────────────
    handleCommission(commData) {
        if (!commData || !commData.execId) return;
        var trade = this.trades.find(function(t) {
            return t.execId === commData.execId;
        });
        if (trade) {
            trade.commission = (trade.commission || 0) + commData.commission;
            console.log('[Options] Commission: ' + trade.ticker + ' $' + commData.commission);
            this._save();
        }
    }

    // ── Update all open trades with current prices ───────
    updatePrices(quotes) {
        var updated = 0;
        var now = new Date();
        var self = this;

        this.trades.forEach(function (trade) {
            if (trade.status !== 'OPEN') return;
            var q = quotes[trade.ticker];
            if (!q) return;

            var currentPrice = parseFloat(q.last || q.price || q.close || 0);
            if (currentPrice === 0) return;

            trade.currentPrice = currentPrice;

            // Sync entry premium with broker fill price if available (fixes race condition)
            if (trade.brokerFillPrice && trade.brokerFillPrice > 0 && trade.entryPremium !== trade.brokerFillPrice) {
                console.log('[Options] Correcting ' + trade.ticker + ' entryPremium: $' + trade.entryPremium + ' → $' + trade.brokerFillPrice + ' (broker fill)');
                trade.entryPremium = trade.brokerFillPrice;
            }

            // Estimate current premium using simplified model
            var newPremium = self._estimatePremium(trade, currentPrice, now);
            trade.currentPremium = newPremium;

            // Calculate unrealized P&L
            var direction = (trade.strategy === 'long_call' || trade.strategy === 'long_put') ? 1 : -1;
            var entryPrem = trade.brokerFillPrice || trade.entryPremium;
            trade.unrealizedPnl = +((newPremium - entryPrem) * direction * trade.contracts * 100).toFixed(2);
            trade.unrealizedPnlPct = entryPrem > 0
                ? +((newPremium - entryPrem) / entryPrem * 100 * direction).toFixed(2)
                : 0;

            updated++;
        });

        // Check for expirations and auto-outcomes
        this._checkOutcomes(now);

        if (updated > 0) this._save();
        return updated;
    }

    // â”€â”€ Estimate current premium (simplified Black-Scholes proxy) â”€â”€
    _estimatePremium(trade, currentPrice, now) {
        var strike = trade.strike;
        var entryPremium = trade.entryPremium;
        var entryPrice = trade.entryPrice;
        if (entryPrice === 0 || entryPremium === 0) return entryPremium;

        // Days remaining
        var expiry = new Date(trade.expirationDate);
        var msRemaining = expiry.getTime() - now.getTime();
        var daysRemaining = Math.max(0, msRemaining / (1000 * 60 * 60 * 24));
        var originalDTE = trade.dte || 30;

        // Time decay factor (theta): sqrt curve — faster near expiry
        // MUST cap at 1.0 — options cannot gain time value
        var timeFactor = originalDTE > 0 ? Math.min(1.0, Math.sqrt(daysRemaining / originalDTE)) : 0;

        // Intrinsic value
        var intrinsic = 0;
        if (trade.optionType === 'call') {
            intrinsic = Math.max(0, currentPrice - strike);
        } else {
            intrinsic = Math.max(0, strike - currentPrice);
        }

        // Extrinsic at entry (time value)
        var entryIntrinsic = 0;
        if (trade.optionType === 'call') {
            entryIntrinsic = Math.max(0, entryPrice - strike);
        } else {
            entryIntrinsic = Math.max(0, strike - entryPrice);
        }
        var entryExtrinsic = Math.max(0, entryPremium - entryIntrinsic);

        // Delta effect: how much premium changes per $ of underlying move
        var moneyness = (currentPrice - strike) / strike;
        var delta = 0.5; // ATM default
        if (trade.optionType === 'call') {
            if (moneyness > 0.05) delta = 0.7;      // ITM
            else if (moneyness > 0) delta = 0.55;    // slightly ITM
            else if (moneyness > -0.05) delta = 0.4; // slightly OTM
            else delta = 0.2;                         // deep OTM
        } else {
            moneyness = -moneyness; // flip for puts
            if (moneyness > 0.05) delta = 0.7;
            else if (moneyness > 0) delta = 0.55;
            else if (moneyness > -0.05) delta = 0.4;
            else delta = 0.2;
        }

        // OTM extrinsic decay: as option moves further OTM, extrinsic collapses
        // Use delta as a proxy for how much extrinsic to retain
        var otmDecay = delta / 0.5; // 1.0 at ATM, 0.4 at deep OTM
        otmDecay = Math.min(1.0, otmDecay);

        // Current extrinsic = entry extrinsic × time decay × OTM decay
        var currentExtrinsic = entryExtrinsic * timeFactor * otmDecay;

        // Total estimated premium
        var estimated = intrinsic + currentExtrinsic;
        estimated = Math.max(0.01, estimated); // minimum $0.01

        return Math.round(estimated * 100) / 100;
    }

    // ── Check for outcomes (expiration, profit targets, stop losses) ──
    _checkOutcomes(now) {
        var self = this;
        this.trades.forEach(function (trade) {
            if (trade.status !== 'OPEN') return;
            if (trade.closeOrderPending) return; // Already waiting for IBKR close

            // Check expiration
            var expiry = new Date(trade.expirationDate + 'T16:00:00');
            if (now >= expiry) {
                var intrinsic = 0;
                if (trade.optionType === 'call') {
                    intrinsic = Math.max(0, trade.currentPrice - trade.strike);
                } else {
                    intrinsic = Math.max(0, trade.strike - trade.currentPrice);
                }
                self._closeTrade(trade, intrinsic > 0 ? 'EXPIRED_ITM' : 'EXPIRED_OTM', intrinsic);
                return;
            }

            // Auto-close rules — only for broker-filled trades with confirmed P&L
            if (!trade.brokerFilled) return; // Don't auto-close trades without IBKR data

            if (trade.unrealizedPnlPct >= 100) {
                self._closeTrade(trade, 'WIN_100PCT', trade.currentPremium);
            } else if (trade.unrealizedPnlPct >= 50 && trade.dte <= 2) {
                self._closeTrade(trade, 'WIN_50PCT', trade.currentPremium);
            } else if (trade.unrealizedPnlPct <= -50) {
                self._closeTrade(trade, 'LOSS_50PCT', trade.currentPremium);
            }
        });
    }

    // ── Close a trade — IBKR-first flow ──────────────────────
    _closeTrade(trade, outcome, estimatedExitPremium) {
        // IBKR-FIRST: Send close order, wait for fill confirmation
        if (this.brokerClient && this.brokerClient.isConnected && process.env.BROKER_EXECUTION === 'true' && trade.brokerFilled) {
            console.log('[Options] Sending CLOSE to IBKR: ' + trade.ticker + ' ' + trade.optionType + ' $' + trade.strike + ' (' + outcome + ')');
            trade.closeOrderPending = true;
            trade.pendingOutcome = outcome;
            var self = this;

            this.brokerClient.closeOptionPosition(trade).then(function(result) {
                if (result.status === 'FAILED') {
                    console.error('[Options] IBKR close FAILED: ' + trade.ticker + ' — position still open');
                    trade.closeOrderPending = false;
                } else {
                    trade.closeOrderId = result.orderId;
                    console.log('[Options] Close order submitted: ' + trade.ticker + ' orderId=' + result.orderId);
                }
                self._save();
            }).catch(function(e) {
                console.error('[Options] Close order error: ' + e.message);
                trade.closeOrderPending = false;
                self._save();
            });
            return;
        }

        // Non-broker trade — close immediately (simulated)
        this._finalizeClose(trade, estimatedExitPremium);
    }

    // ── Finalize close — called after IBKR confirms sell fill ──────
    _finalizeClose(trade, exitPremium) {
        var outcome = trade.pendingOutcome || 'CLOSED';
        trade.status = outcome.startsWith('WIN') || outcome === 'EXPIRED_ITM' ? 'WIN' : 'LOSS';
        trade.outcome = outcome;
        trade.closeTime = new Date().toISOString();
        trade.exitPremium = exitPremium;
        trade.closeOrderPending = false;
        trade.pendingOutcome = null;

        var direction = (trade.strategy === 'long_call' || trade.strategy === 'long_put') ? 1 : -1;
        trade.pnl = +((exitPremium - trade.entryPremium) * direction * trade.contracts * 100).toFixed(2);
        trade.pnlPct = trade.entryPremium > 0
            ? +((exitPremium - trade.entryPremium) / trade.entryPremium * 100 * direction).toFixed(2)
            : 0;
        trade.unrealizedPnl = 0;
        trade.unrealizedPnlPct = 0;

        console.log('[Options] CLOSED: ' + trade.ticker + ' ' + trade.optionType + ' $' + trade.strike + ' | ' + outcome + ' | P&L: $' + trade.pnl + ' (' + trade.pnlPct + '%)');
        this._save();
    }

    // ── Manual close ─────────────────────────────────────────
    closeTrade(id) {
        var trade = this.trades.find(function (t) { return t.id === id && t.status === 'OPEN'; });
        if (!trade) return null;
        this._closeTrade(trade, 'CLOSED', trade.currentPremium);
        return trade;
    }

    // â”€â”€ Get trades â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    getTrades(version) {
        if (!version || version === 'all') return this.trades;
        return this.trades.filter(function (t) { return t.signalVersion === version; });
    }

    getOpenTrades(version) {
        var open = this.trades.filter(function (t) { return t.status === 'OPEN'; });
        if (!version || version === 'all') return open;
        return open.filter(function (t) { return t.signalVersion === version; });
    }

    getClosedTrades(version) {
        var closed = this.trades.filter(function (t) { return t.status !== 'OPEN'; });
        if (!version || version === 'all') return closed;
        return closed.filter(function (t) { return t.signalVersion === version; });
    }

    // â”€â”€ Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    getStatsByVersion(days) {
        var byVersion = {};
        var cutoff = days ? Date.now() - (days * 24 * 60 * 60 * 1000) : 0;

        this.trades.forEach(function (t) {
            if (cutoff > 0) {
                var tradeTime = new Date(t.closeTime || t.openTime).getTime();
                if (tradeTime < cutoff) return;
            }

            var v = t.signalVersion || 'unknown';
            if (byVersion[v] === undefined) {
                byVersion[v] = { version: v, trades: 0, wins: 0, losses: 0, expired: 0, pending: 0, pnlSum: 0, pnlTotal: 0 };
            }
            byVersion[v].trades++;
            if (t.status === 'OPEN') byVersion[v].pending++;
            else if (t.status === 'WIN') { byVersion[v].wins++; byVersion[v].pnlSum += (t.pnlPct || 0); byVersion[v].pnlTotal += (t.pnl || 0); }
            else if (t.status === 'LOSS') { byVersion[v].losses++; byVersion[v].pnlSum += (t.pnlPct || 0); byVersion[v].pnlTotal += (t.pnl || 0); }
            else if (t.outcome && t.outcome.startsWith('EXPIRED')) { byVersion[v].expired++; byVersion[v].pnlSum += (t.pnlPct || 0); byVersion[v].pnlTotal += (t.pnl || 0); }
        });

        // Compute derived stats
        Object.keys(byVersion).forEach(function (v) {
            var s = byVersion[v];
            var decided = s.wins + s.losses;
            s.winRate = decided > 0 ? +(s.wins / decided * 100).toFixed(1) : 0;
            s.avgPnlPct = (decided + s.expired) > 0 ? +(s.pnlSum / (decided + s.expired)).toFixed(2) : 0;
            s.pnlTotal = +s.pnlTotal.toFixed(2);
        });
        return byVersion;
    }

    getStats(version) {
        var open = this.getOpenTrades(version);
        var closed = this.getClosedTrades(version);

        var wins = closed.filter(function (t) { return t.status === 'WIN'; });
        var losses = closed.filter(function (t) { return t.status === 'LOSS'; });

        var totalPnl = closed.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var unrealizedPnl = open.reduce(function (s, t) { return s + (t.unrealizedPnl || 0); }, 0);
        var winRate = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
        var avgWin = wins.length > 0 ? +(wins.reduce(function (s, t) { return s + t.pnlPct; }, 0) / wins.length).toFixed(2) : 0;
        var avgLoss = losses.length > 0 ? +(losses.reduce(function (s, t) { return s + t.pnlPct; }, 0) / losses.length).toFixed(2) : 0;
        var avgPnl = closed.length > 0 ? +(closed.reduce(function (s, t) { return s + t.pnlPct; }, 0) / closed.length).toFixed(2) : 0;

        // Today's stats
        var now = new Date();
        var todayStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
        var todayClosed = closed.filter(function (t) {
            if (!t.closeTime) return false;
            return new Date(t.closeTime).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === todayStr;
        });
        var todayPnl = todayClosed.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var todayWins = todayClosed.filter(function (t) { return t.pnl > 0; }).length;
        var todayLosses = todayClosed.filter(function (t) { return t.pnl <= 0; }).length;
        var todayWinRate = todayClosed.length > 0 ? Math.round(todayWins / todayClosed.length * 100) : 0;

        // Call vs Put breakdown
        var calls = closed.filter(function (t) { return t.optionType === 'call'; });
        var puts = closed.filter(function (t) { return t.optionType === 'put'; });
        var callWins = calls.filter(function (t) { return t.pnl > 0; }).length;
        var putWins = puts.filter(function (t) { return t.pnl > 0; }).length;
        var callPnl = calls.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
        var putPnl = puts.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);

        // Best / Worst trade
        var sortedByPnl = closed.slice().sort(function (a, b) { return b.pnl - a.pnl; });
        var bestTrade = sortedByPnl[0] || null;
        var worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;

        // By strategy
        var byStrategy = {};
        closed.forEach(function (t) {
            var s = t.strategy || 'unknown';
            if (!byStrategy[s]) byStrategy[s] = { wins: 0, losses: 0, pnl: 0 };
            if (t.status === 'WIN') byStrategy[s].wins++;
            else byStrategy[s].losses++;
            byStrategy[s].pnl += t.pnl || 0;
        });

        // By confidence bracket
        var byConfidence = {};
        closed.forEach(function (t) {
            var bracket = Math.floor((t.confidence || 0) / 10) * 10;
            var key = bracket + '-' + (bracket + 9) + '%';
            if (!byConfidence[key]) byConfidence[key] = { wins: 0, losses: 0, pnl: 0 };
            if (t.status === 'WIN') byConfidence[key].wins++;
            else byConfidence[key].losses++;
            byConfidence[key].pnl += t.pnl || 0;
        });

        // Per-ticker breakdown
        var byTicker = {};
        closed.forEach(function (t) {
            if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, trades: 0, wins: 0, losses: 0, pnl: 0, calls: 0, puts: 0, callPnl: 0, putPnl: 0 };
            var bt = byTicker[t.ticker];
            bt.trades++;
            if (t.pnl > 0) bt.wins++; else bt.losses++;
            bt.pnl += (t.pnl || 0);
            if (t.optionType === 'call') { bt.calls++; bt.callPnl += (t.pnl || 0); }
            else { bt.puts++; bt.putPnl += (t.pnl || 0); }
        });
        var tickerBreakdown = Object.values(byTicker).sort(function (a, b) { return b.pnl - a.pnl; });

        return {
            totalTrades: open.length + closed.length,
            openPositions: open.length,
            closedTrades: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: winRate,
            totalPnl: +totalPnl.toFixed(2),
            unrealizedPnl: +unrealizedPnl.toFixed(2),
            avgWinPct: avgWin,
            avgLossPct: avgLoss,
            avgPnl: avgPnl,
            todayPnl: +todayPnl.toFixed(2),
            todayTrades: todayClosed.length,
            today: { closed: todayClosed.length, pnl: +todayPnl.toFixed(2), wins: todayWins, losses: todayLosses, winRate: todayWinRate },
            callStats: { trades: calls.length, wins: callWins, pnl: +callPnl.toFixed(2), winRate: calls.length > 0 ? Math.round(callWins / calls.length * 100) : 0 },
            putStats: { trades: puts.length, wins: putWins, pnl: +putPnl.toFixed(2), winRate: puts.length > 0 ? Math.round(putWins / puts.length * 100) : 0 },
            bestTrade: bestTrade ? { ticker: bestTrade.ticker, pnl: +bestTrade.pnl.toFixed(2), optionType: bestTrade.optionType, strike: bestTrade.strike } : null,
            worstTrade: worstTrade ? { ticker: worstTrade.ticker, pnl: +worstTrade.pnl.toFixed(2), optionType: worstTrade.optionType, strike: worstTrade.strike } : null,
            byStrategy: byStrategy,
            byConfidence: byConfidence,
            tickerBreakdown: tickerBreakdown
        };
    }

    // â”€â”€ ML Training Data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    getTrainingData() {
        return this.getClosedTrades().map(function (t) {
            return {
                ticker: t.ticker,
                optionType: t.optionType,
                strategy: t.strategy,
                strike: t.strike,
                dte: t.dte,
                entryPremium: t.entryPremium,
                confidence: t.confidence,
                direction: t.direction,
                ivRankAtEntry: t.ivRankAtEntry,
                horizon: t.horizon,
                outcome: t.outcome,
                pnlPct: t.pnlPct,
                pnl: t.pnl,
                win: t.status === 'WIN' ? 1 : 0,
                features: t.features
            };
        });
    }

    // â”€â”€ Auto-enter from signal engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Called automatically when A/B paper trades are created
    // Now async: fetches real option contracts from Polygon
    async autoEnterFromSignal(ticker, signalResult, stockPrice, quote, explicitVersion) {
        if (!ticker || !signalResult || !stockPrice || stockPrice <= 0) return null;
        if (!signalResult.direction || signalResult.direction === 'NEUTRAL') return null;
        if ((signalResult.confidence || 0) < 51) return null; // Trade signals 51%+

        var version = explicitVersion || 'v1.0';
        // Allow any version that matches our naming patterns (vX.X or vML)
        if (!version.startsWith('v')) return null;

        // Cooldown: max 1 options trade per ticker per version per 2 hours
        var now = Date.now();
        var recent = this.trades.find(function (t) {
            return t.ticker === ticker && t.status === 'OPEN' && t.signalVersion === version
                && (now - new Date(t.openTime).getTime()) < 2 * 60 * 60 * 1000;
        });
        if (recent) return null;

        var isBullish = signalResult.direction === 'BULLISH';
        var optionType = isBullish ? 'call' : 'put';

        // Guard: Block new positions when deployed capital exceeds account balance
        var accountBalance = 25000;
        var deployedCapital = this.trades.filter(function (t) { return t.status === 'OPEN'; })
            .reduce(function (sum, t) { return sum + ((t.entryPremium || 0) * (t.contracts || 1) * 100); }, 0);
        if (deployedCapital >= accountBalance * 0.9) { // 90% cap to leave headroom
            console.log('[Options] ⛔ Skipping ' + ticker + ' — deployed capital $' + deployedCapital.toFixed(0) + ' exceeds 90% of $' + accountBalance);
            return null;
        }
        var strategy = isBullish ? 'long_call' : 'long_put';

        // Target strike: ATM based on confidence
        var strikeRound = stockPrice > 100 ? 5 : 1;
        var targetStrike;
        if (signalResult.confidence >= 70) {
            // High confidence: ATM (closest to current price)
            targetStrike = Math.round(stockPrice / strikeRound) * strikeRound;
        } else if (signalResult.confidence >= 55) {
            // Medium confidence: slightly OTM
            if (isBullish) {
                targetStrike = Math.ceil(stockPrice / strikeRound) * strikeRound;
            } else {
                targetStrike = Math.floor(stockPrice / strikeRound) * strikeRound;
            }
        } else {
            // Lower confidence: more OTM for better R:R
            if (isBullish) {
                targetStrike = Math.ceil((stockPrice * 1.02) / strikeRound) * strikeRound;
            } else {
                targetStrike = Math.floor((stockPrice * 0.98) / strikeRound) * strikeRound;
            }
        }

        // DTE: 14 days for day/intraday, 30 for swing
        var dte = 14;

        // Try to find real contract and premium from Polygon
        var strike = targetStrike;
        var expirationDate = null;
        var premium = 0;
        var contractSymbol = null;
        var usedRealData = false;

        var realContract = await this._findRealContract(ticker, optionType, targetStrike, dte);
        if (realContract) {
            strike = realContract.strike;
            expirationDate = realContract.expirationDate;
            contractSymbol = realContract.contractSymbol;

            var realPremium = await this._getRealPremium(ticker, strike, expirationDate, optionType, realContract._uwData);
            if (realPremium && realPremium.ask > 0) {
                premium = realPremium.ask; // Use ask price for BUY orders
                usedRealData = true;
                console.log('[Options] ðŸ“Š Real data: ' + ticker + ' ' + optionType.toUpperCase() + ' $' + strike + ' exp ' + expirationDate + ' | Bid: $' + realPremium.bid + ' Ask: $' + realPremium.ask + ' Vol: ' + realPremium.volume);
            } else if (realPremium && realPremium.last > 0) {
                premium = realPremium.last;
                usedRealData = true;
            }
        }

        // No real data from Polygon — DO NOT create trade with fake premium
        if (!usedRealData) {
            console.warn('[Options] ⛔ Skipping ' + ticker + ' — no real premium data from UW/Polygon');
            return null;
        }
        if (!expirationDate) {
            expirationDate = this._calcExpiry(dte);
        }

        // Skip if premium is too expensive (> $50 per share = $5000 per contract)
        if (premium > 50) {
            console.warn('[Options] âš ï¸ Skipping ' + ticker + ': premium $' + premium + ' too expensive');
            return null;
        }

        // Contracts: 1-3 based on confidence
        var contracts = signalResult.confidence >= 80 ? 3 : signalResult.confidence >= 70 ? 2 : 1;

        // Cap max premium per trade at $500 per contract
        if (premium * 100 * contracts > 5000) {
            contracts = Math.max(1, Math.floor(5000 / (premium * 100)));
        }

        var trade = this.openTrade({
            ticker: ticker,
            optionType: optionType,
            strategy: strategy,
            strike: strike,
            dte: dte,
            premium: premium,
            contracts: contracts,
            stockPrice: stockPrice,
            confidence: signalResult.confidence,
            direction: signalResult.direction,
            signals: (signalResult.signals || []).slice(0, 5).map(function (s) { return s.name || s; }),
            features: signalResult.features || [],
            autoEntry: true,
            signalVersion: version,
            session: 'AUTO',
            horizon: 'day_trade',
            expirationDate: expirationDate,
            contractSymbol: contractSymbol,
            usedRealData: usedRealData
        });

        if (trade) {
            var src = usedRealData ? 'ðŸ“Š REAL' : 'âš ï¸ EST';
            console.log(src + ' Auto [' + version + ']: ' + optionType.toUpperCase() + ' ' + ticker + ' $' + strike + ' x' + contracts + ' @ $' + premium + ' exp ' + expirationDate + ' (conf: ' + signalResult.confidence + '%)');
        }
        return trade;
    }
}

module.exports = OptionsPaperTrading;

