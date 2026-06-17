const IBKRClient = require('./src/broker/ibkr.js');

async function test() {
    console.log("🚀 Starting IBKR Integration Test...");
    const client = new IBKRClient({ port: 4002, host: '127.0.0.1' });

    // Setup bi-directional listener for the test
    client.onOrderStatus = (statusObj) => {
        console.log(`\n✅ EVENT LISTENER FIRED:`);
        console.log(`Order ID: ${statusObj.orderId}`);
        console.log(`Status: ${statusObj.status}`);
        if (statusObj.filledQty) console.log(`Filled Qty: ${statusObj.filledQty}`);
        if (statusObj.filledPrice) console.log(`Avg Price: $${statusObj.filledPrice}`);
        if (statusObj.reason) console.log(`Reason: ${statusObj.reason}`);
        console.log("------------------------\n");
    };

    try {
        await client.connect();
        
        // Wait 2 seconds for Gateway to sync nextValidId
        await new Promise(r => setTimeout(r, 2000));

        console.log("\n1. Testing Extended Hours Equity Order (SPY LIMIT BUY)...");
        // Using an absurdly low limit price so it doesn't actually fill, just tests routing and acceptance
        const equityOrder = await client.placeEquityOrder({
            action: 'BUY',
            ticker: 'SPY',
            quantity: 1,
            limitPrice: 10.00 // Way out of money limit
        });
        console.log("Local Order State:", equityOrder);

        // Wait to catch IBKR's bi-directional callbacks
        console.log("\nWaiting 5 seconds for IBKR callbacks...");
        await new Promise(r => setTimeout(r, 5000));
        
        await client.disconnect();
        console.log("Test complete.");
        process.exit(0);

    } catch (e) {
        console.error("Test failed:", e);
        process.exit(1);
    }
}

test();
