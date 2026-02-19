// Congressional Committee & Politician Data
// Covers the ~80 most active congressional stock traders
// Committee assignments should be periodically updated

const SECTOR_COMMITTEE_MAP = {
    'Technology': ['Commerce', 'Intelligence', 'Science'],
    'Healthcare': ['Health', 'Commerce', 'Finance', 'Ways and Means'],
    'Defense': ['Armed Services', 'Intelligence', 'Appropriations'],
    'Energy': ['Energy', 'Natural Resources', 'Environment'],
    'Finance': ['Finance', 'Banking', 'Financial Services', 'Ways and Means'],
    'Telecom': ['Commerce', 'Intelligence'],
    'Transportation': ['Transportation', 'Commerce'],
    'Agriculture': ['Agriculture'],
    'Real Estate': ['Banking', 'Financial Services'],
    'Crypto': ['Banking', 'Financial Services', 'Agriculture'],
    'AI': ['Commerce', 'Intelligence', 'Science', 'Armed Services'],
};

const TICKER_SECTOR_MAP = {
    AAPL: 'Technology', MSFT: 'Technology', GOOGL: 'Technology', GOOG: 'Technology',
    META: 'Technology', AMZN: 'Technology', NVDA: 'Technology', AMD: 'Technology',
    TSLA: 'Technology', INTC: 'Technology', CRM: 'Technology', ORCL: 'Technology',
    AVGO: 'Technology', QCOM: 'Technology', MU: 'Technology', ASML: 'Technology',
    TSM: 'Technology', PLTR: 'Technology', APP: 'Technology', NBIS: 'Technology',
    SNOW: 'Technology', NET: 'Technology', CRWD: 'Technology', PANW: 'Technology',

    UNH: 'Healthcare', JNJ: 'Healthcare', PFE: 'Healthcare', MRNA: 'Healthcare',
    LLY: 'Healthcare', ABBV: 'Healthcare', MRK: 'Healthcare', BMY: 'Healthcare',
    TMO: 'Healthcare', ABT: 'Healthcare', ISRG: 'Healthcare', AMGN: 'Healthcare',

    LMT: 'Defense', RTX: 'Defense', NOC: 'Defense', GD: 'Defense', BA: 'Defense',
    HII: 'Defense', LHX: 'Defense', LDOS: 'Defense',

    XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy', OXY: 'Energy',
    NEE: 'Energy', DUK: 'Energy', SO: 'Energy', FSLR: 'Energy', ENPH: 'Energy',

    JPM: 'Finance', BAC: 'Finance', GS: 'Finance', MS: 'Finance', WFC: 'Finance',
    BLK: 'Finance', SCHW: 'Finance', C: 'Finance', V: 'Finance', MA: 'Finance',
    AXP: 'Finance', PYPL: 'Finance', SQ: 'Finance', COIN: 'Finance',

    T: 'Telecom', VZ: 'Telecom', TMUS: 'Telecom',

    DAL: 'Transportation', UAL: 'Transportation', AAL: 'Transportation',
    UNP: 'Transportation', CSX: 'Transportation', FDX: 'Transportation',
};

// Top congressional traders - name maps to profile
// Updated: Feb 2026 - Congress 119th session
// Sources: opensecrets.org, quiverquant.com, unusualwhales.com
const POLITICIANS = {
    'Nancy Pelosi': { party: 'D', state: 'CA', chamber: 'House', committees: ['Intelligence'], active: true, notes: 'Former Speaker' },
    'Dan Crenshaw': { party: 'R', state: 'TX', chamber: 'House', committees: ['Energy', 'Intelligence'], active: true },
    'Tommy Tuberville': { party: 'R', state: 'AL', chamber: 'Senate', committees: ['Armed Services', 'Agriculture', 'Veterans Affairs'], active: true },
    'Markwayne Mullin': { party: 'R', state: 'OK', chamber: 'Senate', committees: ['Armed Services', 'Commerce', 'Environment', 'Intelligence'], active: true },
    'Mark Green': { party: 'R', state: 'TN', chamber: 'House', committees: ['Homeland Security', 'Armed Services'], active: true },
    'John Curtis': { party: 'R', state: 'UT', chamber: 'Senate', committees: ['Energy', 'Commerce', 'Foreign Relations'], active: true },
    'Ro Khanna': { party: 'D', state: 'CA', chamber: 'House', committees: ['Armed Services', 'Oversight'], active: true },
    'Josh Gottheimer': { party: 'D', state: 'NJ', chamber: 'House', committees: ['Financial Services', 'Intelligence'], active: true },
    'Michael McCaul': { party: 'R', state: 'TX', chamber: 'House', committees: ['Foreign Affairs', 'Homeland Security', 'Intelligence'], active: true },
    'John McGuire': { party: 'R', state: 'VA', chamber: 'House', committees: ['Armed Services', 'Natural Resources'], active: true },
    'French Hill': { party: 'R', state: 'AR', chamber: 'House', committees: ['Financial Services', 'Intelligence'], active: true },
    'Pat Fallon': { party: 'R', state: 'TX', chamber: 'House', committees: ['Armed Services', 'Oversight'], active: true },
    'Diana Harshbarger': { party: 'R', state: 'TN', chamber: 'House', committees: ['Energy', 'Homeland Security'], active: true },
    'Marjorie Taylor Greene': { party: 'R', state: 'GA', chamber: 'House', committees: ['Homeland Security', 'Oversight'], active: true },
    'Kevin Hern': { party: 'R', state: 'OK', chamber: 'House', committees: ['Ways and Means', 'Budget'], active: true },
    'Greg Steube': { party: 'R', state: 'FL', chamber: 'House', committees: ['Judiciary', 'Armed Services'], active: true },
    'Morgan McGarvey': { party: 'D', state: 'KY', chamber: 'House', committees: ['Judiciary', 'Budget'], active: true },
    'Shelley Moore Capito': { party: 'R', state: 'WV', chamber: 'Senate', committees: ['Appropriations', 'Commerce', 'Environment', 'Rules'], active: true },
    'Tim Scott': { party: 'R', state: 'SC', chamber: 'Senate', committees: ['Banking', 'Finance', 'Health'], active: true },
    'Cynthia Lummis': { party: 'R', state: 'WY', chamber: 'Senate', committees: ['Banking', 'Commerce', 'Environment'], active: true },
    'Pete Ricketts': { party: 'R', state: 'NE', chamber: 'Senate', committees: ['Armed Services', 'Banking', 'Foreign Relations'], active: true },
    'Bill Hagerty': { party: 'R', state: 'TN', chamber: 'Senate', committees: ['Appropriations', 'Banking', 'Foreign Relations', 'Rules'], active: true },
    'Gary Peters': { party: 'D', state: 'MI', chamber: 'Senate', committees: ['Armed Services', 'Commerce', 'Homeland Security'], active: true },
    'Suzan DelBene': { party: 'D', state: 'WA', chamber: 'House', committees: ['Ways and Means'], active: true },
    'Daniel Goldman': { party: 'D', state: 'NY', chamber: 'House', committees: ['Judiciary', 'Homeland Security'], active: true },
    'Debbie Wasserman Schultz': { party: 'D', state: 'FL', chamber: 'House', committees: ['Appropriations'], active: true },
    'Rick Scott': { party: 'R', state: 'FL', chamber: 'Senate', committees: ['Armed Services', 'Budget', 'Commerce', 'Homeland Security'], active: true },
    'Katie Porter': { party: 'D', state: 'CA', chamber: 'House', committees: ['Natural Resources', 'Oversight'], active: false, notes: 'Lost 2024 Senate bid' },
    'Virginia Foxx': { party: 'R', state: 'NC', chamber: 'House', committees: ['Education', 'Oversight'], active: true },
    'Earl Blumenauer': { party: 'D', state: 'OR', chamber: 'House', committees: ['Ways and Means'], active: false, notes: 'Retired 2024' },
};

// Normalize politician name for lookup (handles "Hon." prefix, extra spaces)
function normalizeName(raw) {
    if (!raw) return '';
    return raw
        .replace(/^Hon\.\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Find politician profile by name (fuzzy match)
function findPolitician(rawName) {
    const name = normalizeName(rawName);
    // Exact match
    if (POLITICIANS[name]) return { ...POLITICIANS[name], matchedName: name };
    // Last-name match
    const lastName = name.split(' ').pop();
    for (const [fullName, data] of Object.entries(POLITICIANS)) {
        if (fullName.split(' ').pop() === lastName) {
            return { ...data, matchedName: fullName };
        }
    }
    return null;
}

// Get sector for a ticker
function getTickerSector(ticker) {
    return TICKER_SECTOR_MAP[ticker] || null;
}

// Check if a trade might reflect insider knowledge
// Returns { flag: bool, reason: string, severity: 'LOW'|'MEDIUM'|'HIGH' }
function analyzeInsiderFlag(trade) {
    const result = { flag: false, reason: '', severity: 'LOW', committees: [], filingDelay: 0, politician: null };

    const pol = findPolitician(trade.name || trade.reporter);
    if (pol) {
        result.politician = pol;
        result.committees = pol.committees || [];
    }

    // Filing delay (transaction_date vs filed_at_date)
    if (trade.transaction_date && trade.filed_at_date) {
        const txn = new Date(trade.transaction_date);
        const filed = new Date(trade.filed_at_date);
        result.filingDelay = Math.round((filed - txn) / (1000 * 60 * 60 * 24));
    }

    const sector = getTickerSector(trade.ticker);
    if (!sector || !pol) return result;

    // Check if any of their committees overlap with the ticker's sector
    const relevantCommittees = SECTOR_COMMITTEE_MAP[sector] || [];
    const overlap = (pol.committees || []).filter(c =>
        relevantCommittees.some(rc => c.toLowerCase().includes(rc.toLowerCase()) || rc.toLowerCase().includes(c.toLowerCase()))
    );

    if (overlap.length > 0) {
        result.flag = true;
        result.reason = `Sits on ${overlap.join(', ')} — oversees ${sector} sector`;
        result.severity = result.filingDelay > 30 ? 'HIGH' : 'MEDIUM';
    }

    // Late filing is suspicious on its own
    if (result.filingDelay > 45) {
        result.flag = true;
        result.severity = 'HIGH';
        result.reason = (result.reason ? result.reason + '. ' : '') + `Filed ${result.filingDelay} days after trade`;
    } else if (result.filingDelay > 30) {
        result.flag = true;
        if (result.severity === 'LOW') result.severity = 'MEDIUM';
        result.reason = (result.reason ? result.reason + '. ' : '') + `Filed ${result.filingDelay} days late`;
    }

    return result;
}

// Enrich an array of congressional trades with committee and insider analysis
function enrichCongressTrades(trades) {
    return trades.map(trade => {
        const analysis = analyzeInsiderFlag(trade);
        return {
            ...trade,
            _committees: analysis.committees,
            _party: analysis.politician?.party || null,
            _state: analysis.politician?.state || null,
            _chamber: analysis.politician?.chamber || trade.member_type || null,
            _filingDelay: analysis.filingDelay,
            _insiderFlag: analysis.flag,
            _insiderReason: analysis.reason,
            _insiderSeverity: analysis.severity,
            _politicianNotes: analysis.politician?.notes || null,
        };
    });
}

module.exports = {
    enrichCongressTrades,
    findPolitician,
    getTickerSector,
    analyzeInsiderFlag,
    POLITICIANS,
    SECTOR_COMMITTEE_MAP,
    TICKER_SECTOR_MAP,
};
