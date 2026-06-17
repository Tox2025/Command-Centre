const BrokerClient = require('./client');

class IBKRClient extends BrokerClient {
    constructor(config = {}) {
        super(config);
        this.name = 'IBKR';
        this.port = config.port || 4002; // 4002 is paper, 4001 is live
        this.host = config.host || '127.0.0.1';
        this.ib = null;
        this.nextOrderId = null;
        
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

        return new Promise((resolve, reject) => {
            this.ib = new this.IBApi({ host: this.host, port: this.port });

            this.ib.on(this.EventName.connected, () => {
                console.log(`[IBKR] Successfully connected to Gateway on port ${this.port}`);
                this.isConnected = true;
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

            try {
                this.ib.connect();
            } catch (err) {
                reject(err);
            }
        });
    }

    async disconnect() {
        if (this.ib && this.isConnected) {
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
        
        if (!this.isConnected || !this.ib || !this.nextOrderId) {
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

        // Adaptive Order: We default to a Market order if premiums are cheap, but 
        // we can dynamically switch to a Limit order based on user IBKR settings/data.
        const order = {
            action: params.action.toUpperCase(),
            orderType: this.OrderType.MKT, // Testing MKT first, can change to LMT
            totalQuantity: params.quantity,
            tif: 'DAY',
            transmit: true,
            outsideRth: true // Important for extended hours testing
        };

        // If a limit price is provided, adapt to LMT
        if (params.limitPrice) {
            order.orderType = this.OrderType.LMT;
            order.lmtPrice = parseFloat(params.limitPrice);
        }

        console.log(`[IBKR] Transmitting Order ID ${id}: ${order.orderType} order for ${contract.symbol}`);
        this.ib.placeOrder(id, contract, order);
        
        return {
            orderId: id.toString(),
            status: 'SUBMITTED', // Bi-directional listener will update this to FILLED later
            filledPrice: 0 
        };
    }

    async placeEquityOrder(params) {
        console.log(`[IBKR] Placing Equity Order: ${params.action} ${params.quantity}x ${params.ticker}`);
        if (!this.isConnected || !this.ib || !this.nextOrderId) return { orderId: 'SIM_' + Date.now(), status: 'FILLED' };
        
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

        this.ib.placeOrder(id, contract, order);
        return { orderId: id.toString(), status: 'SUBMITTED', filledPrice: 0 };
    }

    async closeOptionPosition(position) {
        console.log(`[IBKR] Closing Position: ${position.ticker} ${position.strike} ${position.optionType}`);
        if (!this.isConnected || !this.ib || !this.nextOrderId) return { orderId: 'SIM_CLOSE_' + Date.now(), status: 'FILLED' };

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

        const order = {
            action: 'SELL',
            orderType: this.OrderType.MKT, // Try MKT, will be rejected if no live data
            totalQuantity: position.contracts || 1,
            tif: 'DAY',
            transmit: true
        };

        this.ib.placeOrder(id, contract, order);
        return { orderId: id.toString(), status: 'SUBMITTED', filledPrice: 0 };
    }
}

module.exports = IBKRClient;
