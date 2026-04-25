// markets.js — Prediction Market System
// Manages bet markets: creation, positions, resolution, payouts
// Markets are either system-generated (by the bot) or user-created

const crypto = require('crypto');

// ─────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────

const MARKET_STATE = {
  OPEN:     'OPEN',       // accepting positions
  LOCKED:   'LOCKED',     // deadline passed, awaiting resolution
  RESOLVED: 'RESOLVED',   // outcome determined, payouts sent
  VOIDED:   'VOIDED',     // cancelled (no resolution possible)
};

const POSITION_STATE = {
  PENDING_DEPOSIT: 'PENDING_DEPOSIT', // created, waiting for funding
  OPEN:     'OPEN',       // funded position held, awaiting resolution
  WON:      'WON',        // market resolved in this position's favour
  LOST:     'LOST',       // market resolved against this position
  REFUNDED: 'REFUNDED',   // market voided, deposit returned
  PAID:     'PAID',       // payout tx sent
  CANCELLED: 'CANCELLED', // never funded or explicitly removed from settlement
};

// Platform fee: 2% of winning pot
const PLATFORM_FEE = 0.02;

// Min/max position in ZNN
const MIN_POSITION = 0.1;
const MAX_POSITION = 50.0;

// ─────────────────────────────────────────
// MARKET TEMPLATES
// ─────────────────────────────────────────
// The bot uses these to generate human-readable questions from raw data

const MARKET_TYPES = {
  // Price action
  PRICE_ABOVE: {
    id: 'price_above',
    category: 'price',
    template: (asset, price, deadline) =>
      `Will ${asset} be above $${price} at ${deadline}?`,
    resolveKey: 'priceAbove',
  },
  PRICE_BELOW: {
    id: 'price_below',
    category: 'price',
    template: (asset, price, deadline) =>
      `Will ${asset} be below $${price} at ${deadline}?`,
    resolveKey: 'priceBelow',
  },
  PRICE_CHANGE_UP: {
    id: 'price_change_up',
    category: 'price',
    template: (asset, pct, window) =>
      `Will ${asset} gain more than ${pct}% in the next ${window}?`,
    resolveKey: 'priceChangeUp',
  },
  PRICE_RECOVERY: {
    id: 'price_recovery',
    category: 'price',
    template: (asset, window) =>
      `Will ${asset} recover its last-hour loss within ${window}?`,
    resolveKey: 'priceRecovery',
  },
  // Market structure
  BTC_DOMINANCE: {
    id: 'btc_dominance',
    category: 'macro',
    template: (direction, threshold, deadline) =>
      `Will BTC dominance go ${direction} ${threshold}% by ${deadline}?`,
    resolveKey: 'btcDominance',
  },
  // On-chain / Zenon network (hidden from users)
  ZNN_TRANSACTIONS: {
    id: 'znn_transactions',
    category: 'onchain',
    template: (count, window) =>
      `Will there be more than ${count} on-chain transactions in the next ${window}?`,
    resolveKey: 'znnTransactions',
  },
  // Custom / free-form (user created or bot narrative)
  CUSTOM: {
    id: 'custom',
    category: 'custom',
    template: (question) => question,
    resolveKey: 'custom',
  },
};

// ─────────────────────────────────────────
// MARKET MANAGER
// ─────────────────────────────────────────

class MarketManager {
  constructor() {
    this.markets = new Map();       // marketId → market
    this.positions = new Map();     // positionId → position
    this.payoutQueue = [];          // positions awaiting payout
    this._persist = null;
    this._store = null;
    // Cleanup old markets every hour
    this._cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this._cleanupTimer.unref?.();
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  setStore(store) {
    this._store = store;
  }

  // ─── CREATE ───────────────────────────

  /**
   * Create a new market.
   * creator: 'system' or a player address (for user-created markets)
   */
  createMarket({
    question,
    description = '',
    category = 'custom',
    type = 'custom',
    resolvesAt,          // Unix ms timestamp when oracle checks
    creatorAddress = 'system',
    tags = [],
    resolutionData = {}, // stored params for oracle to use at resolution time
    initialPool = 0,     // ZNN platform puts in to seed liquidity (optional)
    maxPool = 500,       // cap in ZNN
  }) {
    const id = 'mkt_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();

    if (!resolvesAt || resolvesAt <= now) {
      throw new Error('resolvesAt must be in the future');
    }

    const market = {
      id,
      question,
      description,
      category,
      type,
      resolvesAt,
      createdAt: now,
      creatorAddress,
      tags,
      resolutionData,    // { asset, price, direction, ... }
      state: MARKET_STATE.OPEN,
      // Pool tracking
      yesPool: initialPool,     // ZNN bet YES
      noPool: 0,                // ZNN bet NO
      totalPool: initialPool,
      maxPool,
      positionCount: 0,
      // Resolution
      outcome: null,    // 'yes' | 'no'
      resolvedAt: null,
      platformFee: 0,
      // Social
      shareText: null,  // pre-generated for bot posting
      tweetId: null,    // if bot tweeted about it
      log: [`[${ts()}] Market created — ${question}`],
    };

    // Pre-generate share text for the bot
    market.shareText = generateShareText(market);

    this.markets.set(id, market);
    this._store?.upsertMarket(market);
    console.log(`[market] Created ${id} | ${question.slice(0, 60)}`);
    this._persist?.();
    return market;
  }

  // ─── TAKE POSITION ────────────────────

  /**
   * Player takes a YES or NO position.
   * Returns position object with deposit instructions.
   */
  takePosition({ marketId, playerAddress, side, amountZnn }) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error('Market not found');
    if (market.state !== MARKET_STATE.OPEN) throw new Error(`Market is ${market.state}`);
    if (Date.now() >= market.resolvesAt - 60_000) throw new Error('Market closing soon — positions locked');

    const amount = parseFloat(amountZnn);
    if (amount < MIN_POSITION) throw new Error(`Minimum position: ${MIN_POSITION} ZNN`);
    if (amount > MAX_POSITION) throw new Error(`Maximum position: ${MAX_POSITION} ZNN`);

    const newTotal = market.totalPool + amount;
    if (newTotal > market.maxPool) {
      throw new Error(`Pool cap reached. Max ${market.maxPool} ZNN total.`);
    }

    if (!['yes', 'no'].includes(side)) throw new Error('Side must be yes or no');

    const positionId = 'pos_' + crypto.randomBytes(8).toString('hex');
    const position = {
      id: positionId,
      marketId,
      playerAddress,
      side,
      amountZnn: amount,
      potentialPayout: 0, // calculated at resolution time
      state: POSITION_STATE.PENDING_DEPOSIT,
      createdAt: Date.now(),
      fundedAt: null,
      depositTxHash: null,
      payoutTxHash: null,
      payoutKind: null,
      log: [`[${ts()}] Position created — awaiting deposit — ${side.toUpperCase()} — ${amount} ZNN`],
    };

    this.positions.set(positionId, position);
    market.log.push(`[${ts()}] New pending position: ${side} ${amount} ZNN from ${playerAddress.slice(0, 12)}…`);
    this._store?.upsertPosition(position);
    this._store?.upsertMarket(market);

    console.log(`[market] Position ${positionId} | ${side} ${amount} ZNN on ${marketId}`);
    this._persist?.();
    return position;
  }

  /**
   * Confirm a position's deposit (after on-chain verification)
   */
  confirmPositionDeposit(positionId, txHash) {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error('Position not found');
    if (pos.state !== POSITION_STATE.PENDING_DEPOSIT) {
      throw new Error(`Position is ${pos.state}, not awaiting deposit`);
    }
    const market = this.markets.get(pos.marketId);
    if (!market) throw new Error('Market not found');
    if (market.state !== MARKET_STATE.OPEN) throw new Error(`Market is ${market.state}`);

    const newTotal = market.totalPool + pos.amountZnn;
    if (newTotal > market.maxPool) {
      throw new Error(`Pool cap reached. Max ${market.maxPool} ZNN total.`);
    }

    pos.depositTxHash = txHash;
    pos.fundedAt = Date.now();
    pos.state = POSITION_STATE.OPEN;
    pos.log.push(`[${ts()}] Deposit confirmed — tx: ${txHash}`);

    if (pos.side === 'yes') market.yesPool += pos.amountZnn;
    else market.noPool += pos.amountZnn;
    market.totalPool += pos.amountZnn;
    market.positionCount++;
    market.log.push(`[${ts()}] Funded position: ${pos.side} ${pos.amountZnn} ZNN from ${pos.playerAddress.slice(0, 12)}…`);
    this._store?.upsertPosition(pos);
    this._store?.upsertMarket(market);
    this._persist?.();
    return pos;
  }

  /**
   * Resolve a market with a given outcome.
   * Atomic operation: all updates are rolled back if any step fails.
   * Calculates payouts, queues them.
   * outcome: 'yes' | 'no' | 'void'
   * @param {string} marketId - ID of market to resolve
   * @param {string} outcome - Resolution outcome
   * @param {string} resolvedBy - Who/what resolved the market
   * @returns {object} Resolved market object
   */
  resolveMarket(marketId, outcome, resolvedBy = 'oracle') {
    const market = this.markets.get(marketId);
    if (!market) throw new Error('Market not found');
    if (market.state === MARKET_STATE.RESOLVED) throw new Error('Already resolved');

    // Save state for rollback in case of failure
    const originalMarket = JSON.parse(JSON.stringify(market));
    const originalPositions = new Map();
    const positionsToUpdate = this.getMarketPositions(marketId).filter(pos => 
      pos.state === POSITION_STATE.OPEN || pos.state === POSITION_STATE.PENDING_DEPOSIT
    );
    positionsToUpdate.forEach(pos => {
      originalPositions.set(pos.id, JSON.parse(JSON.stringify(pos)));
    });

    try {
      if (outcome === 'void') {
        market.state = MARKET_STATE.VOIDED;
        market.resolvedAt = Date.now();
        market.log.push(`[${ts()}] Market voided by ${resolvedBy}`);
        // Queue refunds for all positions
        for (const pos of positionsToUpdate) {
          if (pos.state === POSITION_STATE.OPEN) {
            pos.state = POSITION_STATE.REFUNDED;
            pos.payoutKind = 'refund';
            this.payoutQueue.push({ positionId: pos.id, type: 'refund' });
            this._store?.enqueueMarketPayout({ positionId: pos.id, type: 'refund' });
          } else if (pos.state === POSITION_STATE.PENDING_DEPOSIT) {
            pos.state = POSITION_STATE.CANCELLED;
            pos.log.push(`[${ts()}] Cancelled — market voided before deposit was confirmed`);
            this._store?.upsertPosition(pos);
          }
        }
        this._store?.upsertMarket(market);
        this._persist?.();
        return market;
      }

      if (!['yes', 'no'].includes(outcome)) throw new Error('Outcome must be yes, no, or void');

      market.state = MARKET_STATE.RESOLVED;
      market.outcome = outcome;
      market.resolvedAt = Date.now();

      const winningPool = outcome === 'yes' ? market.yesPool : market.noPool;
      const losingPool  = outcome === 'yes' ? market.noPool  : market.yesPool;
      const totalPot    = winningPool + losingPool;
      const fee         = totalPot * PLATFORM_FEE;
      const distributable = totalPot - fee;

      market.platformFee = fee;
      market.log.push(`[${ts()}] Resolved: ${outcome.toUpperCase()} by ${resolvedBy} | pot: ${totalPot.toFixed(4)} ZNN | fee: ${fee.toFixed(4)} ZNN`);

      // Calculate each winner's payout proportional to their stake
      const positions = this.getMarketPositions(marketId).filter(pos => pos.state === POSITION_STATE.OPEN);
      for (const pos of positions) {
        if (pos.side === outcome) {
          // Winner: get back stake + proportional share of losing pool
          const share = winningPool > 0 ? pos.amountZnn / winningPool : 1;
          pos.potentialPayout = parseFloat((distributable * share).toFixed(8));
          pos.state = POSITION_STATE.WON;
          pos.payoutKind = 'win';
          this.payoutQueue.push({ positionId: pos.id, type: 'win' });
          pos.log.push(`[${ts()}] WON — payout: ${pos.potentialPayout} ZNN`);
          this._store?.enqueueMarketPayout({ positionId: pos.id, type: 'win' });
        } else {
          pos.state = POSITION_STATE.LOST;
          pos.log.push(`[${ts()}] LOST`);
        }
        this._store?.upsertPosition(pos);
      }

      for (const pos of this.getMarketPositions(marketId).filter(pos => pos.state === POSITION_STATE.PENDING_DEPOSIT)) {
        pos.state = POSITION_STATE.CANCELLED;
        pos.log.push(`[${ts()}] Cancelled — market resolved before deposit was confirmed`);
        this._store?.upsertPosition(pos);
      }

      console.log(`[market] Resolved ${marketId} → ${outcome} | ${winningPool} ZNN winning pool | ${positions.filter(p => p.state === POSITION_STATE.WON).length} winners`);
      this._store?.upsertMarket(market);
      this._persist?.();
      return market;
    } catch (error) {
      // Rollback all changes
      this.markets.set(marketId, originalMarket);
      originalPositions.forEach((pos, posId) => {
        this.positions.set(posId, pos);
      });
      // Clear any payout queue entries added during the failed attempt
      this.payoutQueue = this.payoutQueue.filter(item => 
        !positionsToUpdate.some(pos => pos.id === item.positionId)
      );
      console.error(`[market] Failed to resolve ${marketId}, rolled back:`, error.message);
      throw error; // Re-throw so caller knows resolution failed
    }
  }

  // ─── LOCK ─────────────────────────────

  /**
   * Lock market at deadline (stop accepting positions)
   */
  lockMarket(marketId) {
    const market = this.markets.get(marketId);
    if (!market || market.state !== MARKET_STATE.OPEN) return;
    market.state = MARKET_STATE.LOCKED;
    market.log.push(`[${ts()}] Market locked — awaiting resolution`);
    this._store?.upsertMarket(market);
    console.log(`[market] Locked ${marketId}`);
    this._persist?.();
    return market;
  }

  // ─── QUERIES ──────────────────────────

  getMarket(marketId) {
    if (this._store) return this._store.getMarketById(marketId);
    return this.markets.get(marketId) || null;
  }

  getPosition(positionId) {
    if (this._store) return this._store.getPositionById(positionId);
    return this.positions.get(positionId) || null;
  }

  getMarketPositions(marketId) {
    if (this._store) return this._store.getPositionsByMarketId(marketId);
    return Array.from(this.positions.values()).filter(p => p.marketId === marketId);
  }

  getPlayerPositions(playerAddress) {
    if (this._store) return this._store.getPositionsByPlayerAddress(playerAddress);
    return Array.from(this.positions.values()).filter(p => p.playerAddress === playerAddress);
  }

  getPositionsDueForPayout(limit = 10) {
    if (this._store) return this._store.getPositionsDueForPayout(limit);
    const due = [];
    for (const item of this.payoutQueue) {
      const pos = this.positions.get(item.positionId);
      if (!pos) continue;
      if (item.type === 'win' && pos.state === POSITION_STATE.WON) due.push(item);
      if (item.type === 'refund' && pos.state === POSITION_STATE.REFUNDED) due.push(item);
      if (due.length >= limit) break;
    }
    return due;
  }

  /**
   * Get open markets for the frontend feed
   */
  getOpenMarkets({ limit = 20, category = null } = {}) {
    if (this._store) {
      return this._store.getOpenMarkets({ limit, category }).map(publicMarket);
    }
    let markets = Array.from(this.markets.values())
      .filter(m => m.state === MARKET_STATE.OPEN)
      .sort((a, b) => b.totalPool - a.totalPool); // most active first

    if (category) markets = markets.filter(m => m.category === category);
    return markets.slice(0, limit).map(publicMarket);
  }

  /**
   * Get recently resolved markets
   */
  getRecentlyResolved({ limit = 10 } = {}) {
    if (this._store) {
      return this._store.getRecentlyResolvedMarkets(limit).map(publicMarket);
    }
    return Array.from(this.markets.values())
      .filter(m => m.state === MARKET_STATE.RESOLVED)
      .sort((a, b) => b.resolvedAt - a.resolvedAt)
      .slice(0, limit)
      .map(publicMarket);
  }

  /**
   * Markets due for locking (past deadline, still open)
   */
  getDueForLocking() {
    if (this._store) return this._store.getMarketsDueForLocking(Date.now());
    const now = Date.now();
    return Array.from(this.markets.values()).filter(m =>
      m.state === MARKET_STATE.OPEN && m.resolvesAt <= now
    );
  }

  /**
   * Markets due for resolution (locked, past deadline)
   */
  getDueForResolution() {
    if (this._store) return this._store.getMarketsDueForResolution(Date.now());
    const now = Date.now();
    return Array.from(this.markets.values()).filter(m =>
      m.state === MARKET_STATE.LOCKED && m.resolvesAt <= now
    );
  }

  /**
   * Drain payout queue
   */
  drainPayoutQueue(limit = 10) {
    const drained = this.payoutQueue.splice(0, limit);
    if (drained.length > 0) {
      for (const item of drained) this._store?.dequeueMarketPayout(item.positionId, item.type);
      this._persist?.();
    }
    return drained;
  }

  takeDuePayout(positionId) {
    const index = this.payoutQueue.findIndex(item => item.positionId === positionId);
    if (index === -1) return null;
    const [item] = this.payoutQueue.splice(index, 1);
    this._store?.dequeueMarketPayout(positionId, item.type);
    this._persist?.();
    return item;
  }

  markPositionPaid(positionId, txHash, payoutKind = 'win') {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error('Position not found');
    pos.state = POSITION_STATE.PAID;
    pos.payoutTxHash = txHash;
    pos.payoutKind = payoutKind;
    pos.log.push(`[${ts()}] Paid — ${payoutKind} tx: ${txHash}`);
    this._store?.upsertPosition(pos);
    this._persist?.();
    return pos;
  }

  /**
   * Stats for /stats endpoint
   */
  stats() {
    if (this._store) return this._store.getMarketStats();
    const all = Array.from(this.markets.values());
    return {
      total: all.length,
      open: all.filter(m => m.state === MARKET_STATE.OPEN).length,
      locked: all.filter(m => m.state === MARKET_STATE.LOCKED).length,
      resolved: all.filter(m => m.state === MARKET_STATE.RESOLVED).length,
      totalPositions: this.positions.size,
      totalVolume: Array.from(this.positions.values()).reduce((acc, p) => acc + p.amountZnn, 0),
    };
  }

  cleanup() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    let removed = 0;
    for (const [id, m] of this.markets) {
      if ((m.state === MARKET_STATE.RESOLVED || m.state === MARKET_STATE.VOIDED) && m.resolvedAt < cutoff) {
        this.markets.delete(id);
        this._store?.deleteMarket(id);
        removed++;
      }
    }
    for (const [id, pos] of this.positions) {
      const marketGone = !this.markets.has(pos.marketId);
      if (marketGone && pos.createdAt < cutoff) {
        this.positions.delete(id);
        this._store?.deletePosition(id);
      }
    }
    if (removed > 0) this._persist?.();
    if (removed > 0) console.log(`[market] Cleaned up ${removed} old markets`);
  }

  exportState() {
    return {
      markets: Array.from(this.markets.values()),
      positions: Array.from(this.positions.values()),
      payoutQueue: this.payoutQueue.slice(),
    };
  }

  importState(state = {}) {
    const markets = this._store ? this._store.getAllMarkets() : (state.markets || []);
    const positions = this._store ? this._store.getAllPositions() : (state.positions || []);
    const payoutQueue = this._store ? this._store.getMarketPayoutQueue() : (state.payoutQueue || []);
    this.markets = new Map(markets.map(market => [market.id, market]));
    this.positions = new Map(positions.map(position => [position.id, position]));
    this.payoutQueue = payoutQueue;
  }
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Strip internal fields for public API
 */
function publicMarket(m) {
  return {
    id: m.id,
    question: m.question,
    description: m.description,
    category: m.category,
    state: m.state,
    resolvesAt: m.resolvesAt,
    createdAt: m.createdAt,
    yesPool: parseFloat(m.yesPool.toFixed(4)),
    noPool: parseFloat(m.noPool.toFixed(4)),
    totalPool: parseFloat(m.totalPool.toFixed(4)),
    positionCount: m.positionCount,
    outcome: m.outcome,
    resolvedAt: m.resolvedAt,
    tags: m.tags,
    // Odds: implied probability from pool sizes
    yesOdds: m.totalPool > 0 ? parseFloat((m.yesPool / m.totalPool * 100).toFixed(1)) : 50,
    noOdds:  m.totalPool > 0 ? parseFloat((m.noPool  / m.totalPool * 100).toFixed(1)) : 50,
  };
}

/**
 * Generate Twitter/Telegram share text for a market
 */
function generateShareText(market) {
  const timeLeft = formatTimeLeft(market.resolvesAt - Date.now());
  const poolStr = market.totalPool > 0 ? ` Pool: ${market.totalPool.toFixed(1)} ZNN.` : '';
  return `🎲 New bet live:\n\n${market.question}\n\n${poolStr} Closes in ${timeLeft}.\n\nTake a side 👇`;
}

function formatTimeLeft(ms) {
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h/24)}d`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

module.exports = {
  MarketManager,
  MARKET_STATE,
  POSITION_STATE,
  MARKET_TYPES,
  MIN_POSITION,
  MAX_POSITION,
  publicMarket,
  generateShareText,
};
