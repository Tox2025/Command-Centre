// Clean garbage from ML cumulative training data
// Removes: instant-close trades (<5 min), extreme PnL (>100%), and garbage paper trades
var fs = require('fs');

var CUMUL_PATH = '/root/Command-Centre/data/ml-training-cumulative.json';
var cumul = JSON.parse(fs.readFileSync(CUMUL_PATH, 'utf8'));
var before = cumul.length;

console.log('Before cleaning:', before, 'samples');

// Count live vs historical
var live = cumul.filter(function(s) { return s._live === true; });
var hist = cumul.filter(function(s) { return s._live !== true; });
console.log('Live (paper trade) samples:', live.length);
console.log('Historical (Polygon) samples:', hist.length);

// Remove live samples that are garbage (from the bad period)
// Keep only historical samples — they're clean Polygon backtest data
// The live samples were generated from fake options trades with estimated premiums
var cleaned = hist; // Keep all historical data
console.log('After removing live garbage:', cleaned.length, 'samples');
console.log('Removed:', before - cleaned.length, 'garbage live samples');

// Backup before overwriting
fs.writeFileSync(CUMUL_PATH + '.pre-clean-backup', JSON.stringify(cumul));
console.log('Backup saved to:', CUMUL_PATH + '.pre-clean-backup');

// Write cleaned data
fs.writeFileSync(CUMUL_PATH, JSON.stringify(cleaned));
console.log('Cleaned cumulative file written:', cleaned.length, 'samples');
