const BrokerClient = require('./client');

class IBKRClient extends BrokerClient {
    constructor(config = {}) {
        super(config);
        this.name = 'IBKR';
        this.port = config.port || 4002; // 4002 is usually paper, 4001 is live
        this.host = config.host || '127.0.0.1';
        this.ib = null;
        
        // Try to load @stoqey/ib, but don't crash if it's not installed yet
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
                
                // Request the next valid ID
                this.ib.reqIds(-1);
                
                resolve(true);
            });

            this.ib.on(this.EventName.nextValidId, (orderId) => {
                this.nextOrderId = orderId;
            });

            this.ib.on(this.EventName.error, (err, code, reqId) => {
                console.error(`[IBKR] Error (${code}):`, err.message);
                if (!this.isConnected) {
                    reject(new Error(err.message));
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
        
        // Real implementation would request account summary
        return { cash: 25000, totalValue: 25000, buyingPower: 25000 };
    }

    async placeOptionOrder(params) {
        console.log(`[IBKR] Placing Option Order: ${params.action} ${params.quantity}x ${params.ticker} ${params.strike} ${params.optionType}`);
        
        if (!this.isConnected || !this.ib || !this.nextOrderId) {
            return {
                orderId: 'SIM_IBKR_' + Date.now(),
                status: 'FILLED',
                filledPrice: params.premium || 1.50
            };
        }

        const id = this.nextOrderId++;
        
        // Convert expiration (YYYY-MM-DD) to IBKR format (YYYYMMDD)
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

        const order = {
            action: params.action.toUpperCase(),
            orderType: this.OrderType.LMT,
            totalQuantity: params.quantity,
            lmtPrice: parseFloat(params.premium),
            tif: 'DAY',
            transmit: true
        };

        this.ib.placeOrder(id, contract, order);
        
        return {
            orderId: id.toString(),
            status: 'SUBMITTED',
            filledPrice: 0 // Will be updated asynchronously in a real system
        };
    }

    async closeOptionPosition(position) {
        console.log(`[IBKR] Closing Position: ${position.ticker} ${position.strike} ${position.optionType}`);
        
        if (!this.isConnected || !this.ib || !this.nextOrderId) {
            return {
                orderId: 'SIM_IBKR_CLOSE_' + Date.now(),
                status: 'FILLED',
                filledPrice: position.currentPremium || position.entryPremium
            };
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

        const order = {
            action: 'SELL',
            orderType: this.OrderType.MKT,
            totalQuantity: position.contracts || 1,
            tif: 'DAY',
            transmit: true
        };

        this.ib.placeOrder(id, contract, order);

        return {
            orderId: id.toString(),
            status: 'SUBMITTED',
            filledPrice: 0
        };
    }

    async getOrderStatus(orderId) {
        // Return simulated fill
        return { status: 'FILLED', filledPrice: 1.50, filledQty: 1 };
    }
}

module.exports = IBKRClient;
