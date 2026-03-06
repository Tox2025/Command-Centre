const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'options-paper-trades.json');

try {
    if (!fs.existsSync(DATA_PATH)) {
        console.log('❌ File not found:', DATA_PATH);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    let migrated = 0;

    if (Array.isArray(data.trades)) {
        data.trades.forEach(trade => {
            if (!trade.signalVersion) {
                trade.signalVersion = 'v1.0';
                migrated++;
            }
        });
    }

    if (migrated > 0) {
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
        console.log(`✅ Migrated ${migrated} trades to v1.0 version tag.`);
    } else {
        console.log('ℹ️ No untagged trades found.');
    }
} catch (e) {
    console.error('❌ Migration error:', e.message);
    process.exit(1);
}
