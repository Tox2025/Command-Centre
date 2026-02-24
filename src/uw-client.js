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

  // == NEW: Short Screener (auto-discover squeeze candidates) ==
  async getShortScreener(params = {}) {
    return this._fetch('/short_screener', params);
  }

  // == NEW: Interpolated IV (better IV surface for options pricing) ==
  async getInterpolatedIV(ticker, date) {
    return this._fetch(`/stock/${ticker}/interpolated-iv`, date ? { date } : {});
  }

  // == NEW: Short Interest V2 with float data (replaces V1) ==
  async getShortInterestV2(ticker) {
    return this._fetch(`/shorts/${ticker}/interest-float/v2`);
  }

  // == NEW: Historical Risk Reversal Skew (put/call sentiment) ==
  async getRiskReversalSkew(ticker, delta) {
    return this._fetch(`/stock/${ticker}/historical-risk-reversal-skew`, delta ? { delta } : {});
  }

  // == NEW: Insider Sector Flow (sector-level insider sentiment) ==
  async getInsiderSectorFlow(sector) {
    return this._fetch(`/insider/${sector}/sector-flow`);
  }

  // ── Phase E: Priority 1 Endpoints ──────────────────────────

  // E1: Option Contract Flow — flow for a specific contract
  async getOptionContractFlow(contractId) {
    return this._fetch(`/option-contract/${contractId}/flow`);
  }

  // E2: Option Contract Historic — historical data for specific contract
  async getOptionContractHistoric(contractId) {
    return this._fetch(`/option-contract/${contractId}/historic`);
  }

  // E3: Option Contract Intraday — intraday data for specific contract
  async getOptionContractIntraday(contractId) {
    return this._fetch(`/option-contract/${contractId}/intraday`);
  }

  // E4: Option Contract Volume Profile — volume profile for specific contract
  async getOptionContractVolumeProfile(contractId) {
    return this._fetch(`/option-contract/${contractId}/volume-profile`);
  }

  // E5: Full Options Tape — complete options tape for a date
  async getFullOptionsTape(date) {
    return this._fetch(`/option-trades/full-tape/${date}`);
  }

  // E6: OI Per Strike — open interest breakdown by strike
  async getOIPerStrike(ticker) {
    return this._fetch(`/stock/${ticker}/oi-per-strike`);
  }

  // E7: OI Per Expiry — open interest breakdown by expiry
  async getOIPerExpiry(ticker) {
    return this._fetch(`/stock/${ticker}/oi-per-expiry`);
  }

  // E8: ATM Chains — at-the-money options chains
  async getATMChains(ticker, expiration) {
    return this._fetch(`/stock/${ticker}/atm-chains`, expiration ? { expiration } : {});
  }

  // E9: Stock Price Levels — volume profile price levels
  async getStockPriceLevels(ticker) {
    return this._fetch(`/stock/${ticker}/stock-price-levels`);
  }

  // E10: Stock Volume Price Levels — volume at price
  async getStockVolumePriceLevels(ticker) {
    return this._fetch(`/stock/${ticker}/stock-volume-price-levels`);
  }

  // ── Phase F: Priority 2 Endpoints ──────────────────────────

  // F1: Expiry Breakdown — options activity by expiry
  async getExpiryBreakdown(ticker) {
    return this._fetch(`/stock/${ticker}/expiry-breakdown`);
  }

  // F2: Spot GEX by Expiry+Strike — granular GEX analysis
  async getSpotGEXByExpiryStrike(ticker) {
    return this._fetch(`/stock/${ticker}/spot-exposures/expiry-strike`);
  }

  // F2b: Spot GEX for specific expiry — GEX at specific expiry date
  async getSpotGEXByExpiry(ticker, expiry) {
    return this._fetch(`/stock/${ticker}/spot-exposures/${expiry}/strike`);
  }

  // F3: Greek Flow by Expiry — time-targeted greek exposure
  async getGreekFlowByExpiry(ticker, expiry) {
    return this._fetch(`/stock/${ticker}/greek-flow/${expiry}`);
  }

  // F3b: Group Flow Greek — group flow greek analysis
  async getGroupFlowGreek(flowGroup) {
    return this._fetch(`/group-flow/${flowGroup}/greek-flow`);
  }

  // F3c: Group Flow by Expiry — group flow greek for specific expiry
  async getGroupFlowGreekByExpiry(flowGroup, expiry) {
    return this._fetch(`/group-flow/${flowGroup}/greek-flow/${expiry}`);
  }

  // F4: ETF Info — ETF information and metadata
  async getETFInfo(ticker) {
    return this._fetch(`/etfs/${ticker}/info`);
  }

  // F4b: ETF Weights — ETF holdings and weights
  async getETFWeights(ticker) {
    return this._fetch(`/etfs/${ticker}/weights`);
  }

  // F5: Institution Sectors — institution sector exposure
  async getInstitutionSectors(name) {
    return this._fetch(`/institution/${encodeURIComponent(name)}/sectors`);
  }

  // F5b: Institution Activity V2 — updated activity endpoint
  async getInstitutionActivityV2(name) {
    return this._fetch(`/institution/${encodeURIComponent(name)}/activity/v2`);
  }

  // F5c: Ticker Ownership — who owns a ticker
  async getTickerOwnership(ticker) {
    return this._fetch(`/institution/${ticker}/ownership`);
  }

  // F6: Politician Holdings — politicians holding a specific ticker
  async getPoliticianHolders(ticker) {
    return this._fetch(`/politician-portfolios/holders/${ticker}`);
  }

  // F6b: Politician Portfolio — a politician's full portfolio
  async getPoliticianPortfolio(politicianId) {
    return this._fetch(`/politician-portfolios/${politicianId}`);
  }

  // F7: Seasonality Performers — top performers for a month
  async getSeasonalityPerformers(month) {
    return this._fetch(`/seasonality/${month}/performers`);
  }

  // F7b: Seasonality Year-Month — granular year-month seasonality
  async getSeasonalityYearMonth(ticker) {
    return this._fetch(`/seasonality/${ticker}/year-month`);
  }

  // == Alerts ==
  async getAlerts() {
    return this._fetch('/alerts');
  }

  async getAlertConfig() {
    return this._fetch('/alerts/configuration');
  }
}

// ── D1/D2: UW WebSocket Client for Lit and Off-Lit Trade Streams ──
class UWWebSocketClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.litTrades = {};      // { ticker: [recent trades] }
    this.offLitTrades = {};   // { ticker: [recent dark pool prints] }
    this.subscribedTickers = [];
    this.handlers = {};       // event handlers
    this.maxTradesPerTicker = 50;
  }

  connect(tickers = []) {
    const self = this;
    this.subscribedTickers = tickers.map(t => t.toUpperCase());

    try {
      const WebSocket = require('ws');
      this.ws = new WebSocket('wss://ws.unusualwhales.com/trades', {
        headers: { 'Authorization': 'Bearer ' + this.apiKey }
      });

      this.ws.on('open', function () {
        self.connected = true;
        self.reconnectDelay = 5000;
        console.log('🐋 UW WebSocket connected');
        // Subscribe to channels
        self._subscribe();
      });

      this.ws.on('message', function (data) {
        try {
          var msg = JSON.parse(data);
          self._handleMessage(msg);
        } catch (e) { /* skip malformed messages */ }
      });

      this.ws.on('close', function () {
        self.connected = false;
        if (!self._wsCloseLogged || (Date.now() - self._wsCloseLogged > 300000)) {
          console.log('🐋 UW WebSocket disconnected, reconnecting (backoff: ' + Math.round(self.reconnectDelay / 1000) + 's)...');
          self._wsCloseLogged = Date.now();
        }
        self._reconnect();
      });

      this.ws.on('error', function (err) {
        if (!self._wsErrorLogged || (Date.now() - self._wsErrorLogged > 300000)) {
          console.error('🐋 UW WebSocket error:', err.message, '(suppressing repeat errors for 5min)');
          self._wsErrorLogged = Date.now();
        }
      });
    } catch (e) {
      console.error('🐋 UW WebSocket connection failed:', e.message);
      this._reconnect();
    }
  }

  _subscribe() {
    if (!this.ws || !this.connected) return;
    // Subscribe to lit_trades and off_lit_trades channels
    var payload = {
      action: 'subscribe',
      channels: ['lit_trades', 'off_lit_trades'],
      tickers: this.subscribedTickers
    };
    this.ws.send(JSON.stringify(payload));
    console.log('🐋 Subscribed to lit/off-lit trades for ' + this.subscribedTickers.length + ' tickers');
  }

  _handleMessage(msg) {
    var channel = msg.channel || msg.type || '';
    var ticker = (msg.ticker || msg.symbol || '').toUpperCase();
    if (!ticker) return;

    var trade = {
      ticker: ticker,
      price: parseFloat(msg.price || msg.p || 0),
      size: parseInt(msg.size || msg.s || msg.volume || 0, 10),
      timestamp: msg.timestamp || msg.t || Date.now(),
      exchange: msg.exchange || msg.x || null,
      conditions: msg.conditions || msg.c || [],
      side: msg.side || null
    };

    if (channel === 'lit_trades' || channel === 'lit') {
      if (!this.litTrades[ticker]) this.litTrades[ticker] = [];
      this.litTrades[ticker].unshift(trade);
      if (this.litTrades[ticker].length > this.maxTradesPerTicker) {
        this.litTrades[ticker] = this.litTrades[ticker].slice(0, this.maxTradesPerTicker);
      }
      if (this.handlers.onLitTrade) this.handlers.onLitTrade(trade);
    } else if (channel === 'off_lit_trades' || channel === 'off_lit') {
      if (!this.offLitTrades[ticker]) this.offLitTrades[ticker] = [];
      this.offLitTrades[ticker].unshift(trade);
      if (this.offLitTrades[ticker].length > this.maxTradesPerTicker) {
        this.offLitTrades[ticker] = this.offLitTrades[ticker].slice(0, this.maxTradesPerTicker);
      }
      if (this.handlers.onOffLitTrade) this.handlers.onOffLitTrade(trade);
    }
  }

  _reconnect() {
    var self = this;
    var delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 300000); // max 5 minutes
    setTimeout(function () {
      self.connect(self.subscribedTickers);
    }, delay);
  }

  updateSubscriptions(newTickers) {
    this.subscribedTickers = newTickers.map(t => t.toUpperCase());
    if (this.connected) this._subscribe();
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  getLitTrades(ticker) {
    return this.litTrades[(ticker || '').toUpperCase()] || [];
  }

  getOffLitTrades(ticker) {
    return this.offLitTrades[(ticker || '').toUpperCase()] || [];
  }

  // Get trade flow summary for signal engine consumption
  getTradeFlowSummary(ticker) {
    var t = (ticker || '').toUpperCase();
    var lit = this.litTrades[t] || [];
    var offLit = this.offLitTrades[t] || [];
    if (lit.length === 0 && offLit.length === 0) return null;

    var litBuyVol = 0, litSellVol = 0, offLitVol = 0;
    for (var i = 0; i < lit.length; i++) {
      if (lit[i].side === 'buy' || lit[i].side === 'B') litBuyVol += lit[i].size;
      else if (lit[i].side === 'sell' || lit[i].side === 'S') litSellVol += lit[i].size;
    }
    for (var j = 0; j < offLit.length; j++) {
      offLitVol += offLit[j].size;
    }

    return {
      litBuyVolume: litBuyVol,
      litSellVolume: litSellVol,
      litRatio: litBuyVol + litSellVol > 0 ? litBuyVol / (litBuyVol + litSellVol) : 0.5,
      offLitVolume: offLitVol,
      offLitTradeCount: offLit.length,
      totalLitTrades: lit.length,
      avgLitSize: lit.length > 0 ? lit.reduce(function (s, t) { return s + t.size; }, 0) / lit.length : 0,
      avgOffLitSize: offLit.length > 0 ? offLit.reduce(function (s, t) { return s + t.size; }, 0) / offLit.length : 0
    };
  }

  disconnect() {
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.connected = false;
  }

  isConnected() { return this.connected; }
}

module.exports = { UWClient, UWWebSocketClient };
