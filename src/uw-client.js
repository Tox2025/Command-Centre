// Unusual Whales API Client - V2
// Full endpoint reference: https://api.unusualwhales.com/docs

const BASE_URL = 'https://api.unusualwhales.com/api';

class UWClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    };
    // Rate limiter: sliding window, 100 req/min (headroom below UW's 120 limit)
    this._requestTimestamps = [];
    this._rateLimit = 100;        // max requests per window
    this._rateWindow = 60 * 1000; // 60 seconds
    this._queue = [];
    this._processing = false;
  }

  // Wait until we have capacity in the sliding window
  async _waitForCapacity() {
    const now = Date.now();
    // Trim old timestamps outside the window
    this._requestTimestamps = this._requestTimestamps.filter(ts => now - ts < this._rateWindow);
    if (this._requestTimestamps.length < this._rateLimit) {
      this._requestTimestamps.push(now);
      return; // capacity available
    }
    // Wait until the oldest request in the window expires
    const oldest = this._requestTimestamps[0];
    const waitMs = (oldest + this._rateWindow) - now + 50; // +50ms buffer
    if (waitMs > 0) {
      console.log(`⏳ UW rate limiter: ${this._requestTimestamps.length}/${this._rateLimit} req/min — waiting ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    // Recurse to re-check after waiting
    return this._waitForCapacity();
  }

  async _fetch(endpoint, params = {}) {
    await this._waitForCapacity();

    const url = new URL(`${BASE_URL}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    try {
      const res = await fetch(url.toString(), { headers: this.headers });

      // Handle rate limit (429) with retry
      if (res.status === 429) {
        // Read the reset header if available
        const resetMs = parseInt(res.headers.get('x-uw-req-per-minute-reset') || '5000', 10);
        const waitTime = Math.min(Math.max(resetMs, 2000), 30000); // 2-30s
        console.log(`🚫 UW 429 on ${endpoint} — backing off ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        // Retry once after backoff
        const retry = await fetch(url.toString(), { headers: this.headers });
        if (!retry.ok) {
          const text = await retry.text();
          console.error(`UW API retry failed ${retry.status} on ${endpoint}: ${text.substring(0, 200)}`);
          return null;
        }
        this._requestTimestamps.push(Date.now());
        return await retry.json();
      }

      if (!res.ok) {
        const text = await res.text();
        console.error(`UW API error ${res.status} on ${endpoint}: ${text}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`UW API fetch failed for ${endpoint}:`, err.message);
      return null;
    }
  }

  // == Stock Data ==
  async getStockQuote(ticker) {
    return this._fetch(`/stock/${ticker}/info`);
  }

  async getHistoricalPrice(ticker, candleSize = '1d') {
    return this._fetch(`/stock/${ticker}/ohlc/${candleSize}`);
  }

  async getHistoricalCandles(ticker, candleSize = '1d', days = 180) {
    const data = await this._fetch(`/stock/${ticker}/ohlc/${candleSize}`);
    if (!data || !data.data) return null;
    const candles = (Array.isArray(data.data) ? data.data : []).map(c => ({
      date: c.date || c.timestamp || c.t,
      open: parseFloat(c.open || c.o || 0),
      high: parseFloat(c.high || c.h || 0),
      low: parseFloat(c.low || c.l || 0),
      close: parseFloat(c.close || c.c || 0),
      volume: parseFloat(c.volume || c.v || 0)
    })).filter(c => c.close > 0);
    return candles.slice(-days);
  }

  async getStockVolume(ticker) {
    return this._fetch(`/stock/${ticker}/options-volume`);
  }

  async getStockState(ticker) {
    return this._fetch(`/stock/${ticker}/stock-state`);
  }

  async getFloatData(ticker) {
    return this._fetch(`/shorts/${ticker}/interest-float`);
  }

  // == Options Flow ==
  async getFlowAlerts(params = {}) {
    return this._fetch('/option-trades/flow-alerts', params);
  }

  async getFlowByTicker(ticker) {
    return this._fetch(`/stock/${ticker}/flow-recent`);
  }

  async getFlowAlertsByTicker(ticker) {
    return this._fetch(`/stock/${ticker}/flow-alerts`);
  }

  async getFlowPerStrike(ticker) {
    return this._fetch(`/stock/${ticker}/flow-per-strike`);
  }

  async getFlowPerExpiry(ticker) {
    return this._fetch(`/stock/${ticker}/flow-per-expiry`);
  }

  async getOptionVolumeLevels(ticker) {
    return this._fetch(`/stock/${ticker}/options-volume`);
  }

  async getNetPremium(ticker) {
    return this._fetch(`/stock/${ticker}/net-prem-ticks`);
  }

  async getOptionChain(ticker, expiry) {
    return this._fetch(`/stock/${ticker}/option-contracts`, { expiry });
  }

  async getMaxPain(ticker) {
    return this._fetch(`/stock/${ticker}/max-pain`);
  }

  async getIVRank(ticker) {
    return this._fetch(`/stock/${ticker}/iv-rank`);
  }

  async getOIChange(ticker) {
    return this._fetch(`/stock/${ticker}/oi-change`);
  }

  // == Dark Pool ==
  async getDarkPoolLevels(ticker) {
    return this._fetch(`/darkpool/${ticker}`);
  }

  async getDarkPoolRecent() {
    return this._fetch('/darkpool/recent');
  }

  async getLitFlow(ticker) {
    return this._fetch(`/lit-flow/${ticker}`);
  }

  // == Greek Exposure (GEX) ==
  async getGEXByStrike(ticker) {
    return this._fetch(`/stock/${ticker}/greek-exposure/strike`);
  }

  async getGEXByExpiry(ticker) {
    return this._fetch(`/stock/${ticker}/greek-exposure/expiry`);
  }

  async getGEXByStrikeExpiry(ticker) {
    return this._fetch(`/stock/${ticker}/greek-exposure/strike-expiry`);
  }

  async getSpotExposures(ticker) {
    return this._fetch(`/stock/${ticker}/spot-exposures`);
  }

  async getGreeks(ticker) {
    return this._fetch(`/stock/${ticker}/greeks`);
  }

  async getGreekFlow(ticker) {
    return this._fetch(`/stock/${ticker}/greek-flow`);
  }

  // == Market ==
  async getMarketTide() {
    return this._fetch('/market/market-tide');
  }

  async getSectorTide(sector) {
    return this._fetch(`/market/${sector}/sector-tide`);
  }

  async getETFTide(ticker) {
    return this._fetch(`/market/${ticker}/etf-tide`);
  }

  async getMarketSpike() {
    return this._fetch('/market/spike');
  }

  async getMarketCorrelations() {
    return this._fetch('/market/correlations');
  }

  async getSectorETFs() {
    return this._fetch('/market/sector-etfs');
  }

  async getTotalOptionsVolume() {
    return this._fetch('/market/total-options-volume');
  }

  async getMarketOIChange() {
    return this._fetch('/market/oi-change');
  }

  async getTopNetImpact() {
    return this._fetch('/market/top-net-impact');
  }

  async getEconomicCalendar() {
    return this._fetch('/market/economic-calendar');
  }

  async getInsiderBuySells() {
    return this._fetch('/market/insider-buy-sells');
  }

  // == Congressional Trading ==
  async getCongressTrades() {
    return this._fetch('/politician-portfolios/recent_trades');
  }

  async getCongressTrader() {
    return this._fetch('/congress/congress-trader');
  }

  async getCongressLateReports() {
    return this._fetch('/congress/late-reports');
  }

  async getCongressRecentTrades() {
    return this._fetch('/congress/recent-trades');
  }

  async getCongressDisclosures() {
    return this._fetch('/politician-portfolios/disclosures');
  }

  async getPoliticianHolders(ticker) {
    return this._fetch(`/politician-portfolios/holders/${ticker}`);
  }

  // == Insider Transactions ==
  async getInsiderTransactions(params = {}) {
    return this._fetch('/insider/transactions', params);
  }

  async getInsiderByTicker(ticker) {
    return this._fetch(`/insider/${ticker}`);
  }

  async getInsiderTickerFlow(ticker) {
    return this._fetch(`/insider/${ticker}/ticker-flow`);
  }

  // == Short Interest ==
  async getShortInterest(ticker) {
    return this._fetch(`/shorts/${ticker}/interest-float`);
  }

  async getShortVolume(ticker) {
    return this._fetch(`/shorts/${ticker}/volume-and-ratio`);
  }

  async getShortData(ticker) {
    return this._fetch(`/shorts/${ticker}/data`);
  }

  async getFailsToDeliver(ticker) {
    return this._fetch(`/shorts/${ticker}/ftds`);
  }

  // == Institutions ==
  async getInstitutions() {
    return this._fetch('/institutions');
  }

  async getInstitutionOwnership(ticker) {
    return this._fetch(`/institution/${ticker}/ownership`);
  }

  async getLatestFilings() {
    return this._fetch('/institutions/latest_filings');
  }

  // == Earnings ==
  async getEarnings(ticker) {
    return this._fetch(`/earnings/${ticker}`);
  }

  async getEarningsPremarket() {
    return this._fetch('/earnings/premarket');
  }

  async getEarningsAfterhours() {
    return this._fetch('/earnings/afterhours');
  }

  // == News ==
  async getNewsHeadlines() {
    return this._fetch('/news/headlines');
  }

  // == Screener ==
  async getAnalystRatings(ticker) {
    return this._fetch('/screener/analysts', { ticker });
  }

  async screenStocks(params = {}) {
    return this._fetch('/screener/stocks', params);
  }

  async screenOptionContracts(params = {}) {
    return this._fetch('/screener/option-contracts', params);
  }

  // == Seasonality ==
  async getMarketSeasonality() {
    return this._fetch('/seasonality/market');
  }

  async getTickerSeasonality(ticker) {
    return this._fetch(`/seasonality/${ticker}/monthly`);
  }

  // == Volatility ==
  async getRealizedVol(ticker) {
    return this._fetch(`/stock/${ticker}/volatility/realized`);
  }

  async getVolStats(ticker) {
    return this._fetch(`/stock/${ticker}/volatility/stats`);
  }

  async getTermStructure(ticker) {
    return this._fetch(`/stock/${ticker}/volatility/term-structure`);
  }

  async getIVSkew(ticker) {
    return this._fetch(`/stock/${ticker}/historical-risk-reversal-skew`);
  }

  // == ETFs ==
  async getETFHoldings(ticker) {
    return this._fetch(`/etfs/${ticker}/holdings`);
  }

  async getETFExposure(ticker) {
    return this._fetch(`/etfs/${ticker}/exposure`);
  }

  async getETFFlow(ticker) {
    return this._fetch(`/etfs/${ticker}/in-outflow`);
  }

  // == Phase 2: New Endpoints ==

  // NOPE — Net Options Pricing Effect (UW proprietary directional predictor)
  async getNOPE(ticker) {
    return this._fetch(`/stock/${ticker}/nope`);
  }

  // Intraday strike flow (real-time magnetic price levels)
  async getFlowPerStrikeIntraday(ticker) {
    return this._fetch(`/stock/${ticker}/flow-per-strike-intraday`);
  }

  // FDA Calendar (biotech event risk)
  async getFDACalendar() {
    return this._fetch('/market/fda-calendar');
  }

  // Institution Holdings (who owns what)
  async getInstitutionHoldings(ticker) {
    return this._fetch(`/institution/${ticker}/holdings`);
  }

  // Institution Activity (recent buys/sells by institutions)
  async getInstitutionActivity(ticker) {
    return this._fetch(`/institution/${ticker}/activity`);
  }

  // Short Volumes by Exchange (where shorts are coming from)
  async getShortVolumesByExchange(ticker) {
    return this._fetch(`/shorts/${ticker}/volumes-by-exchange`);
  }

  // Analyst Ratings for a ticker (consensus targets)
  async getAnalystRatingsByTicker(ticker) {
    return this._fetch(`/analyst/${ticker}/ratings`);
  }

  // == Alerts ==
  async getAlerts() {
    return this._fetch('/alerts');
  }

  async getAlertConfig() {
    return this._fetch('/alerts/configuration');
  }
}

module.exports = UWClient;
