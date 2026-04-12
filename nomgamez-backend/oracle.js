// oracle.js — Market Resolution Oracle
// Fetches real-world data and resolves prediction markets automatically
// Data sources: CoinGecko (price), ZenonHub (on-chain), CoinMarketCap (dominance)

const axios = require('axios');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const ZENONHUB_BASE  = 'https://zenonhub.io/api';

// Asset ID map for CoinGecko
const ASSET_IDS = {
  'BTC':  'bitcoin',
  'ETH':  'ethereum',
  'ZNN':  'zenon-2',
  'SOL':  'solana',
  'BNB':  'binancecoin',
  'XRP':  'ripple',
};

// In-memory price cache (5 min TTL)
const priceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ─────────────────────────────────────────
// DATA FETCHERS
// ─────────────────────────────────────────

/**
 * Fetch current price for an asset in USD
 */
async function getPrice(asset) {
  const id = ASSET_IDS[asset.toUpperCase()] || asset.toLowerCase();
  const cacheKey = `price:${id}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;

  try {
    const res = await axios.get(`${COINGECKO_BASE}/simple/price`, {
      params: { ids: id, vs_currencies: 'usd' },
      timeout: 8000,
    });
    const price = res.data[id]?.usd;
    if (!price) throw new Error(`No price data for ${id}`);
    priceCache.set(cacheKey, { price, ts: Date.now() });
    console.log(`[oracle] ${asset} price: $${price}`);
    return price;
  } catch (err) {
    console.error(`[oracle] getPrice(${asset}) failed:`, err.message);
    return null;
  }
}

/**
 * Fetch BTC market dominance %
 */
async function getBtcDominance() {
  const cacheKey = 'btc_dominance';
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value;

  try {
    const res = await axios.get(`${COINGECKO_BASE}/global`, { timeout: 8000 });
    const dom = res.data.data?.market_cap_percentage?.btc;
    if (!dom) throw new Error('No dominance data');
    priceCache.set(cacheKey, { value: dom, ts: Date.now() });
    console.log(`[oracle] BTC dominance: ${dom.toFixed(1)}%`);
    return dom;
  } catch (err) {
    console.error('[oracle] getBtcDominance failed:', err.message);
    return null;
  }
}

/**
 * Fetch recent ZNN on-chain transaction count (last N hours)
 */
async function getZnnTransactionCount(hours = 24) {
  try {
    const since = Date.now() - hours * 3600_000;
    const res = await axios.get(`${ZENONHUB_BASE}/nom/account-block/count`, {
      params: { since: Math.floor(since / 1000) },
      timeout: 8000,
    });
    const count = res.data?.data?.count || res.data?.count;
    console.log(`[oracle] ZNN tx count (${hours}h): ${count}`);
    return count;
  } catch (err) {
    // Fallback: fetch recent list and count
    try {
      const res = await axios.get(`${ZENONHUB_BASE}/nom/account-block/list`, {
        params: { page: 0, count: 100 },
        timeout: 8000,
      });
      const txs = res.data?.data?.list || [];
      const cutoff = Date.now() - hours * 3600_000;
      const recent = txs.filter(tx => (tx.momentumTimestamp || tx.timestamp || 0) * 1000 > cutoff);
      return recent.length;
    } catch (e) {
      console.error('[oracle] getZnnTransactionCount failed:', e.message);
      return null;
    }
  }
}

/**
 * Get latest ZNN momentum (block height)
 */
async function getZnnMomentumHeight() {
  try {
    const res = await axios.get(`${ZENONHUB_BASE}/nom/momentum/list`, {
      params: { page: 0, count: 1 },
      timeout: 8000,
    });
    const list = res.data?.data?.list || [];
    return list[0]?.height || null;
  } catch (err) {
    console.error('[oracle] getZnnMomentumHeight failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────
// MARKET RESOLVER
// ─────────────────────────────────────────

/**
 * Resolve a single market based on its type and resolutionData.
 * Returns 'yes', 'no', or 'void'
 */
async function resolveMarket(market) {
  const { type, resolutionData: d } = market;

  try {
    switch (type) {
      case 'price_above': {
        const price = await getPrice(d.asset);
        if (price === null) return 'void';
        const result = price > parseFloat(d.targetPrice) ? 'yes' : 'no';
        console.log(`[oracle] price_above — ${d.asset} $${price} vs $${d.targetPrice} → ${result}`);
        return result;
      }

      case 'price_below': {
        const price = await getPrice(d.asset);
        if (price === null) return 'void';
        const result = price < parseFloat(d.targetPrice) ? 'yes' : 'no';
        console.log(`[oracle] price_below — ${d.asset} $${price} vs $${d.targetPrice} → ${result}`);
        return result;
      }

      case 'price_change_up': {
        // Requires baseline price stored at market creation
        const currentPrice = await getPrice(d.asset);
        if (currentPrice === null || !d.baselinePrice) return 'void';
        const changePct = ((currentPrice - d.baselinePrice) / d.baselinePrice) * 100;
        const result = changePct >= parseFloat(d.targetPct) ? 'yes' : 'no';
        console.log(`[oracle] price_change_up — ${d.asset} +${changePct.toFixed(2)}% vs ${d.targetPct}% → ${result}`);
        return result;
      }

      case 'price_recovery': {
        const currentPrice = await getPrice(d.asset);
        if (currentPrice === null || !d.baselinePrice) return 'void';
        const result = currentPrice >= d.baselinePrice ? 'yes' : 'no';
        console.log(`[oracle] price_recovery — ${d.asset} $${currentPrice} vs baseline $${d.baselinePrice} → ${result}`);
        return result;
      }

      case 'btc_dominance': {
        const dom = await getBtcDominance();
        if (dom === null) return 'void';
        const result = d.direction === 'above'
          ? (dom > parseFloat(d.threshold) ? 'yes' : 'no')
          : (dom < parseFloat(d.threshold) ? 'yes' : 'no');
        console.log(`[oracle] btc_dominance — ${dom.toFixed(1)}% vs ${d.direction} ${d.threshold}% → ${result}`);
        return result;
      }

      case 'znn_transactions': {
        const count = await getZnnTransactionCount(d.hours || 24);
        if (count === null) return 'void';
        const result = count > parseInt(d.targetCount) ? 'yes' : 'no';
        console.log(`[oracle] znn_transactions — ${count} vs ${d.targetCount} → ${result}`);
        return result;
      }

      case 'custom':
        // Custom markets must be resolved manually
        return 'void';

      default:
        console.warn(`[oracle] Unknown market type: ${type}`);
        return 'void';
    }
  } catch (err) {
    console.error(`[oracle] resolveMarket(${market.id}) error:`, err.message);
    return 'void';
  }
}

// ─────────────────────────────────────────
// RESEARCH ENGINE
// ─────────────────────────────────────────

/**
 * Fetch current market data snapshot for bot research.
 * Returns structured data the bot uses to generate market ideas.
 */
async function getMarketSnapshot() {
  const [btcPrice, ethPrice, znnPrice, btcDom] = await Promise.allSettled([
    getPrice('BTC'),
    getPrice('ETH'),
    getPrice('ZNN'),
    getBtcDominance(),
  ]);

  const snapshot = {
    timestamp: Date.now(),
    prices: {
      BTC: btcPrice.value || null,
      ETH: ethPrice.value || null,
      ZNN: znnPrice.value || null,
    },
    btcDominance: btcDom.value || null,
    // Store baseline for change-based markets
    baselinePrices: {
      BTC: btcPrice.value || null,
      ETH: ethPrice.value || null,
      ZNN: znnPrice.value || null,
    },
  };

  return snapshot;
}

/**
 * Calculate price change since last snapshot
 * Used by bot to detect significant moves worth betting on
 */
function calcPriceChange(currentPrice, previousPrice) {
  if (!previousPrice || !currentPrice) return 0;
  return ((currentPrice - previousPrice) / previousPrice) * 100;
}

module.exports = {
  getPrice,
  getBtcDominance,
  getZnnTransactionCount,
  getZnnMomentumHeight,
  resolveMarket,
  getMarketSnapshot,
  calcPriceChange,
  ASSET_IDS,
};
