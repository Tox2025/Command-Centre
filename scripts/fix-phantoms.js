var fs = require('fs');
var d = JSON.parse(fs.readFileSync('data/options-paper-trades.json','utf8'));
var fixed = 0;
d.trades.forEach(function(t) {
    var time = new Date(t.openTime);
    var today = time.toISOString().substring(0,10);
    var hasBroker = t.brokerStatus ? true : false;
    if (today === '2026-06-29' && !hasBroker) {
        console.log('KILLING: ' + t.ticker + ' ' + t.optionType + ' $' + t.strike + ' (premarket phantom)');
        t.status = 'REJECTED';
        t.closeReason = 'Premarket phantom - no IBKR execution';
        fixed++;
    }
});
fs.writeFileSync('data/options-paper-trades.json', JSON.stringify(d, null, 2));
console.log('Fixed ' + fixed + ' phantom trades');
