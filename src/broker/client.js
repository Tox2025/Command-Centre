/**
 * BrokerClient Interface
 * 
 * A common abstraction for all live brokerage integrations (IBKR, Schwab, etc.)
 */
class BrokerClient {
    constructor(config = {}) {
        this.config = config;
        this.isConnected = false;
        this.name = 'BaseBroker';
    }

    /**
     * Connects to the brokerage API.
     * @returns {Promise<boolean>} True if connected successfully.
     */
    async connect() {
        throw new Error('Not implemented');
    }

    /**
     * Disconnects from the brokerage API.
     */
    async disconnect() {
        throw new Error('Not implemented');
    }

    /**
     * Fetches the current account balances.
     * @returns {Promise<{cash: number, totalValue: number, buyingPower: number}>}
     */
    async getBalances() {
        throw new Error('Not implemented');
    }

    /**
     * Places a new options order.
     * @param {Object} params
     * @param {string} params.ticker - e.g., 'TSLA'
     * @param {string} params.optionType - 'call' or 'put'
     * @param {number} params.strike - e.g., 200
     * @param {string} params.expiration - 'YYYY-MM-DD'
     * @param {number} params.premium - limit price (optional, if market order omit)
     * @param {number} params.quantity - number of contracts
     * @param {string} params.action - 'BUY' or 'SELL'
     * @returns {Promise<{orderId: string, status: string, filledPrice: number}>}
     */
    async placeOptionOrder(params) {
        throw new Error('Not implemented');
    }

    /**
     * Closes an existing options position.
     * @param {Object} position - The position object from our local state
     * @returns {Promise<{orderId: string, status: string, filledPrice: number}>}
     */
    async closeOptionPosition(position) {
        throw new Error('Not implemented');
    }

    /**
     * Fetches the latest status for a specific order.
     * @param {string} orderId 
     * @returns {Promise<{status: string, filledPrice: number, filledQty: number}>}
     */
    async getOrderStatus(orderId) {
        throw new Error('Not implemented');
    }
}

module.exports = BrokerClient;
