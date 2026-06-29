const BrokerClient = require('./client');

class IBKRClient extends BrokerClient {
    constructor(config = {}) {
        super(config);
        this.name = 'IBKR';
        this.port = config.port || 4002; // 4002 is paper, 4001 is live
        this.host = config.host || '127.0.0.1';
        this.ib = null;
        this.nextOrderId = null;
        
        // Reconnection settings
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 30000; // 30 seconds
        this._reconnectTimer = null;
        this._intentionalDisconnect = false;

        // Order tracking: orderId → { tradeId, action, ticker, timestamp }
        this.orderMap = new Map();
        
        // Listeners for bi-directional state tracking
        this.onOrderStatus = null; 
        
        try {
            const { IBApi, EventName, OrderAction, OrderType, SecType } = require('@stoqey/ib');
            this.IBApi = IBApi;
            this.EventName = EventName;
            this.OrderAction = OrderAction;
            this.OrderType = OrderType;
            this.SecType = SecType;
        } catch (e) {
            console.warn('⚠️ @stoqey/ib not installed yet. IBKR integration will be simulated.');
        }
    }

    async connect() {
        if (!this.IBApi) {
            console.log(`[IBKR] Simulated connection on ${this.host}:${this.port}`);
            this.isConnected = true;
            return true;
        }

        this._intentionalDisconnect = false;

        return new Promise((resolve, reject) => {
            this.ib = new this.IBApi({ host: this.host, port: this.port });

            this.ib.on(this.EventName.connected, () => {
                console.log(`[IBKR] Successfully connected to Gateway on port ${this.port}`);
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.ib.reqIds(-1);
                resolve(true);
            });

            this.ib.on(this.EventName.nextValidId, (orderId) => {
                this.nextOrderId = orderId;
            });

            // BI-DIRECTIONAL EVENT LISTENER: Order Status Updates
            this.ib.on(this.EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
                console.log(`[IBKR] Order ${id} Status Update: ${status} | Filled: ${filled} | AvgPrice: $${avgFillPrice}`);
                if (this.onOrderStatus) {
                    this.onOrderStatus({
                        orderId: id.toString(),
                        status: status.toUpperCase(), // e.g., 'FILLED', 'CANCELLED', 'SUBMITTED'
                        filledQty: filled,
                        filledPrice: avgFillPrice
                    });
                }
            });

            // BI-DIRECTIONAL EVENT LISTENER: Rejections & Errors
            this.ib.on(this.EventName.error, (err, code, reqId) => {
                if (code >= 2000 && code <= 2199) {
                    // Informational messages (e.g. market data farm connections)
                    return; 
                }

                // Critical warning: Read-only mode means fix-readonly agent didn't run
                if (code === 321) {
                    console.error(`[IBKR] ⚠️ CRITICAL: API still in Read-Only mode! Fix-readonly agent may not have run.`);
                }

                console.error(`[IBKR] Error (${code}) for OrderID/ReqID ${reqId}: ${err.message}`);
                
                if (!this.isConnected) {
                    reject(new Error(err.message));
                }

                // If error is related to an active order placement (rejection)
                if (reqId && reqId > -1 && this.onOrderStatus) {
                    // Common rejection codes: 201 (Order rejected), 202 (Cancelled), 399 (Warning)
                    if (code === 201 || code === 202 || code === 161 || code === 330) {
                        this.onOrderStatus({
                            orderId: reqId.toString(),
                            status: 'REJECTED',
                            reason: err.message
                        });
                    }
                }
            });

            // AUTO-RECONNECT: Listen for disconnection
            this.ib.on(this.EventName.disconnected, () => {
                this.isConnected = false;
                console.log('[IBKR] Disconnected from Gateway.');

                if (!this._intentionalDisconnect) {
                    this._scheduleReconnect();
                }
            });

            try {
                this.ib.connect();
            } catch (err) {
                reject(err);
            }
        });
    }

    // ── Auto-reconnect with backoff ──────────────────────────
    _scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[IBKR] ❌ Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
            return;
        }

        this.reconnectAttempts++;
        var delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 300000); // max 5 min
        console.log(`[IBKR] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        this._reconnectTimer = setTimeout(() => {
            console.log(`[IBKR] 🔄 Reconnect attempt #${this.reconnectAttempts}...`);
            try {
                this.ib.connect();
            } catch (e) {
                console.error('[IBKR] Reconnect failed:', e.message);
                this._scheduleReconnect();
            }
        }, delay);
    }

    async disconnect() {
        if (this.ib && this.isConnected) {
            this._intentionalDisconnect = true;
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this.ib.disconnect();
            this.isConnected = false;
            console.log('[IBKR] Disconnected.');
        }
    }

    async getBalances() {
        if (!this.isConnected || !this.ib) {
            return { cash: 25000, totalValue: 25000, buyingPower: 25000 };
        }
        return { cash: 25000, totalValue: 25000, buyingPower: 25000 };
    }

    // New helper to fetch current bid/ask/last (Requires Live Data)
    async getMarketData(contract) {
        return new Promise((resolve) => {
            if (!this.ib) return resolve(null);
            let reqId = this.nextOrderId++;
            let tickData = { bid: 0, ask: 0, last: 0 };
            
            // Listen for tick prices
            const onTickPrice = (id, tickType, price) => {
                if (id === reqId && price > 0) {
                    if (tickType === 1) tickData.bid = price; // bid
                    if (tickType === 2) tickData.ask = price; // ask
                    if (tickType === 4) tickData.last = price; // last
                }
            };
            this.ib.on(this.EventName.tickPrice, onTickPrice);
            
            // Request snapshot (true = snapshot, no streaming)
            this.ib.reqMktData(reqId, contract, "", true, false);
            
            // Resolve after 2.5 seconds max
            setTimeout(() => {
                this.ib.off(this.EventName.tickPrice, onTickPrice);
                resolve(tickData.ask > 0 ? tickData : null);
            }, 2500);
        });
    }

    async placeOptionOrder(params) {
        console.log(`[IBKR] Validating Option Order: ${params.action} ${params.quantity}x ${params.ticker} ${params.strike} ${params.optionType}`);
        
        // BLOCK silent simulation when BROKER_EXECUTION is true
        if (!this.isConnected || !this.ib || !this.nextOrderId) {
            if (process.env.BROKER_EXECUTION === 'true') {
                console.error('[IBKR] ⚠️ NOT CONNECTED — order BLOCKED (BROKER_EXECUTION=true)');
                return { orderId: null, status: 'FAILED', reason: 'disconnected' };
            }
            return { orderId: 'SIM_IBKR_' + Date.now(), status: 'FILLED', filledPrice: params.premium || 1.50 };
        }

        const id = this.nextOrderId++;
        const expiry = params.expirationDate ? params.expirationDate.replace(/-/g, '') : '';
        
        const contract = {
            secType: this.SecType.OPT,
            symbol: params.ticker,
            exchange: 'SMART',
            currency: 'USD',
            lastTradeDateOrContractMonth: expiry,
            strike: parseFloat(params.strike),
            right: params.optionType.toUpperCase() === 'CALL' ? 'C' : 'P',
            multiplier: '100'
        };

        // Use MARKET orders for options (user configured IBKR for MKT)
        const order = {
            action: params.action.toUpperCase(),
            orderType: this.OrderType.MKT,
            totalQuantity: params.quantity,
            tif: 'DAY',
            transmit: true,
            outsideRth: true // Allow extended hours
        };

        // Track order for status feedback
        this.orderMap.set(id, {
            action: params.action,
            ticker: params.ticker,
            strike: params.strike,
            optionType: params.optionType,
            timestamp: Date.now()
        });

        console.log(`[IBKR] Transmitting Order ID ${id}: MKT order for ${contract.symbol} ${params.strike} ${params.optionType}`);
        this.ib.placeOrder(id, contract, order);
        
        return {
            orderId: id.toString(),
            status: 'SUBMITTED', // Bi-directional listener will update this to FILLED later
            filledPrice: 0 
        };
    }

    async placeEquityOrder(params) {
        console.log(`[IBKR] Placing Equity Order: ${params.action} ${params.quantity}x ${params.ticker}`);

        if (!this.isConnected || !this.ib || !this.nextOrderId) {
            if (process.env.BROKER_EXECUTION === 'true') {
                console.error('[IBKR] ⚠️ NOT CONNECTED — equity order BLOCKED');
                return { orderId: null, status: 'FAILED', reason: 'disconnected' };
            }
            return { orderId: 'SIM_' + Date.now(), status: 'FILLED' };
        }
        
        const id = this.nextOrderId++;
        const contract = {
            secType: this.SecType.STK,
            symbol: params.ticker,
            exchange: 'SMART',
            currency: 'USD'
        };

        const order = {
            action: params.action.toUpperCase(),
            orderType: params.limitPrice ? this.OrderType.LMT : this.OrderType.MKT,
            totalQuantity: params.quantity,
            tif: 'DAY',
            transmit: true,
            outsideRth: true // Allow extended hours execution
        };
        
        if (params.limitPrice) order.lmtPrice = parseFloat(params.limitPrice);

        this.orderMap.set(id, { action: params.action, ticker: params.ticker, timestamp: Date.now() });

        this.ib.placeOrder(id, contract, order);
        return { orderId: id.toString(), status: 'SUBMITTED', filledPrice: 0 };
    }

    async closeOptionPosition(position) {
        console.log(`[IBKR] Closing Position: ${position.ticker} ${position.strike} ${position.optionType}`);

        if (!this.isConnected || !this.ib || !this.nextOrderId) {
            if (process.env.BROKER_EXECUTION === 'true') {
                console.error('[IBKR] ⚠️ NOT CONNECTED — close order BLOCKED');
                return { orderId: null, status: 'FAILED', reason: 'disconnected' };
            }
            return { orderId: 'SIM_CLOSE_' + Date.now(), status: 'FILLED' };
        }

        const id = this.nextOrderId++;
        const expiry = position.expirationDate ? position.expirationDate.replace(/-/g, '') : '';

        const contract = {
            secType: this.SecType.OPT,
            symbol: position.ticker,
            exchange: 'SMART',
            currency: 'USD',
            lastTradeDateOrContractMonth: expiry,
            strike: parseFloat(position.strike),
            right: position.optionType.toUpperCase() === 'CALL' ? 'C' : 'P',
            multiplier: '100'
        };

        // Use MKT for closes — LMT at stale bid price fails when market moves
        const order = {
            action: 'SELL',
            orderType: this.OrderType.MKT,
            totalQuantity: position.contracts || 1,
            tif: 'DAY',
            transmit: true
        };

        this.orderMap.set(id, { action: 'SELL', ticker: position.ticker, strike: position.strike, timestamp: Date.now() });

        this.ib.placeOrder(id, contract, order);
        return { orderId: id.toString(), status: 'SUBMITTED', filledPrice: 0 };
    }
}

module.exports = IBKRClient;
