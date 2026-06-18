// Diagnostic script: connects to IBKR Gateway and logs ALL events
const { IBApi, EventName } = require('@stoqey/ib');

console.log('🔍 IBKR Gateway Diagnostic Test');
console.log('================================');

const ib = new IBApi({ host: '127.0.0.1', port: 4002 });

// Log EVERY event from the Gateway
Object.keys(EventName).forEach(key => {
    ib.on(EventName[key], (...args) => {
        console.log(`[EVENT] ${key}:`, JSON.stringify(args).substring(0, 200));
    });
});

ib.on(EventName.connected, () => {
    console.log('\n✅ TCP Connected to Gateway');
    console.log('Requesting nextValidId...');
    ib.reqIds(-1);
});

ib.on(EventName.nextValidId, (orderId) => {
    console.log(`\n🎯 nextValidId received: ${orderId}`);
});

ib.on(EventName.error, (err, code, reqId) => {
    console.log(`\n❌ Error: code=${code}, reqId=${reqId}, msg=${err.message || err}`);
});

console.log('Connecting...');
ib.connect();

// Wait 10 seconds then report
setTimeout(() => {
    console.log('\n================================');
    console.log('🔍 Diagnostic complete.');
    ib.disconnect();
    process.exit(0);
}, 10000);
