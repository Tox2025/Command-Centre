// News Sentiment Classifier
// Keyword-based sentiment scoring for news headlines (-100 to +100)

const BULLISH_WORDS = [
    'upgrade', 'beat', 'beats', 'exceeds', 'surpass', 'record', 'high', 'rally',
    'surge', 'soar', 'jump', 'gain', 'positive', 'bullish', 'outperform',
    'buy', 'strong', 'growth', 'profit', 'revenue', 'earnings beat',
    'raised guidance', 'raises guidance', 'upside', 'breakout', 'momentum',
    'recovery', 'rebound', 'acquisition', 'buyback', 'dividend', 'expand',
    'innovation', 'partnership', 'contract', 'approval', 'fda approval',
    'analyst upgrade', 'price target raised', 'overweight', 'outperform',
    'new high', 'all-time high', 'ath', 'blowout', 'crush', 'smash'
];

const BEARISH_WORDS = [
    'downgrade', 'miss', 'misses', 'below', 'decline', 'drop', 'fall',
    'crash', 'plunge', 'sink', 'loss', 'negative', 'bearish', 'underperform',
    'sell', 'weak', 'slowdown', 'deficit', 'warning', 'guidance cut',
    'lowered guidance', 'lowers guidance', 'downside', 'breakdown',
    'recession', 'layoff', 'layoffs', 'lawsuit', 'investigation', 'probe',
    'sec', 'fraud', 'default', 'bankruptcy', 'delisting', 'recall',
    'analyst downgrade', 'price target cut', 'underweight', 'underperform',
    'new low', 'insider selling', 'dilution', 'offering', 'secondary'
];

const STRONG_BULL = ['blowout earnings', 'massive beat', 'fda approval', 'all-time high', 'record revenue'];
const STRONG_BEAR = ['bankruptcy', 'fraud', 'sec investigation', 'guidance cut', 'massive miss'];

class NewsSentiment {
    constructor() {
        this.cache = {};
        this.cacheTTL = 300000; // 5 min
    }

    // Score a single headline: returns -100 to +100
    scoreHeadline(headline) {
        if (!headline) return 0;
        var lower = headline.toLowerCase();
        var bullScore = 0, bearScore = 0;

        // Check strong phrases first (worth more)
        STRONG_BULL.forEach(function (phrase) {
            if (lower.includes(phrase)) bullScore += 3;
        });
        STRONG_BEAR.forEach(function (phrase) {
            if (lower.includes(phrase)) bearScore += 3;
        });

        // Check individual words
        BULLISH_WORDS.forEach(function (word) {
            if (lower.includes(word)) bullScore += 1;
        });
        BEARISH_WORDS.forEach(function (word) {
            if (lower.includes(word)) bearScore += 1;
        });

        var total = bullScore + bearScore;
        if (total === 0) return 0;

        // Normalize to -100 to +100
        var raw = (bullScore - bearScore) / Math.max(total, 1);
        return Math.round(raw * 100);
    }

    // Score multiple headlines for a ticker
    analyze(ticker, headlines) {
        if (!headlines || headlines.length === 0) return { score: 0, count: 0, bullish: 0, bearish: 0, neutral: 0 };

        var self = this;
        var scores = headlines.map(function (h) {
            var text = typeof h === 'string' ? h : (h.headline || h.title || '');
            return self.scoreHeadline(text);
        });

        var bullish = 0, bearish = 0, neutral = 0;
        scores.forEach(function (s) {
            if (s > 10) bullish++;
            else if (s < -10) bearish++;
            else neutral++;
        });

        // Weighted average: recent headlines worth more
        var weightedSum = 0, weightTotal = 0;
        for (var i = 0; i < scores.length; i++) {
            var weight = 1 + (scores.length - i) * 0.1; // newer = higher weight
            weightedSum += scores[i] * weight;
            weightTotal += weight;
        }
        var avgScore = Math.round(weightedSum / (weightTotal || 1));

        var result = {
            score: Math.max(-100, Math.min(100, avgScore)),
            count: headlines.length,
            bullish: bullish,
            bearish: bearish,
            neutral: neutral,
            label: avgScore > 30 ? 'BULLISH' : avgScore < -30 ? 'BEARISH' : 'NEUTRAL'
        };

        this.cache[ticker] = { data: result, ts: Date.now() };
        return result;
    }

    getCached(ticker) {
        var c = this.cache[ticker];
        if (c && Date.now() - c.ts < this.cacheTTL) return c.data;
        return null;
    }
}

module.exports = { NewsSentiment, BULLISH_WORDS, BEARISH_WORDS };
