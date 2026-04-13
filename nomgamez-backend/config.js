// config.js — Centralized Runtime Configuration
// Single source of truth for every operational parameter
// All values are live — PATCH /admin/config updates them without restart
// The bot reads from here before every action

const defaultConfig = {

  // ── GAMES ─────────────────────────────────────────────────
  // The game registry. Each entry is a full game descriptor.
  // Add a game here + implement its frontend UI = it's live.
  games: {
    dice: {
      id:          'dice',
      name:        'Hash Dice',
      active:      true,
      payoutMultiplier: 10,
      houseEdgePct: 10,
      description: 'Roll d100. Six win modes. Provably fair.',
      minBet:      0.1,
      maxBet:      10.0,
    },
    slots: {
      id:          'slots',
      name:        'Plasma Slots',
      active:      true,
      payoutMultiplier: 10, // base; actual varies by symbol match
      houseEdgePct: 10,
      description: '7 symbols. 50× jackpot on triple ⬡.',
      minBet:      0.1,
      maxBet:      10.0,
    },
    shooter: {
      id:          'shooter',
      name:        'Space Shooter',
      active:      false,
      payoutMultiplier: 10,
      houseEdgePct: 10,
      description: 'Survive 5 waves. Skill-based. Verification rebuild in progress.',
      minBet:      0.1,
      maxBet:      10.0,
    },
  },

  // ── BETS ──────────────────────────────────────────────────
  validBets: [0.1, 0.5, 1.0, 2.0, 5.0, 10.0],

  // ── SESSIONS ──────────────────────────────────────────────
  depositTimeoutSeconds: 300,
  maxConcurrentSessions: 100,
  sessionArchiveHours:   2,    // sessions purged from memory after this

  // ── MARKETS ───────────────────────────────────────────────
  market: {
    platformFeePct:      2,      // % of total pool taken as platform fee
    minPositionZnn:      0.1,
    maxPositionZnn:      50.0,
    maxPoolZnn:          500,
    maxOpenMarkets:      15,
    marketsPerCycle:     3,
    archiveAgeDays:      7,
  },

  // ── BOT ───────────────────────────────────────────────────
  bot: {
    enabled:             true,
    researchIntervalMs:  4 * 60 * 60 * 1000,   // 4 hours
    resolutionIntervalMs: 5 * 60 * 1000,        // 5 minutes
    priceMoveThresholdPct: 3.0,
    durations: {
      short:  2  * 60 * 60 * 1000,
      medium: 24 * 60 * 60 * 1000,
      long:   7  * 24 * 60 * 60 * 1000,
    },
    // Market type weights — bot creates proportionally more of high-weight types
    // Adjusted automatically based on engagement data (positions taken per market)
    marketWeights: {
      price_above:    70,
      price_below:    60,
      price_change_up: 65,
      price_recovery:  90,  // reactive — highest weight
      btc_dominance:   55,
      znn_transactions: 40,
      custom:          50,
    },
  },

  // ── FREE PLAY ─────────────────────────────────────────────
  freePlay: {
    enabled:           true,
    winProbability:    0.25,
    minPayoutZnn:      0.1,
    maxPayoutZnn:      2.0,
    claimWindowMs:     10 * 60 * 1000,
    maxPerIpPerDay:    2,
  },

  // ── PUBLISHER ─────────────────────────────────────────────
  publisher: {
    rateLimitMs:         60 * 1000,
    winAnnounceMinZnn:   2.0,
    maxQueueSize:        50,
  },

  // ── PAYOUTS ───────────────────────────────────────────────
  payouts: {
    pollIntervalMs:      10 * 1000,
    processIntervalMs:   15 * 1000,
    maxRetries:          3,
    retryDelayMs:        30 * 1000,
    circuitBreakerThreshold: 3,      // consecutive failures before halt
    circuitBreakerResetMs:   5 * 60 * 1000, // auto-reset after 5 min
  },

  // ── TREASURY / LIVE SAFETY ───────────────────────────────
  treasury: {
    reconcileIntervalMs: 60 * 1000,
    balanceFreshnessMs:  3 * 60 * 1000,
    blockedRetryDelayMs: 60 * 1000,
    minReserveZnn:       25,
    maxSinglePayoutZnn:  50,
    maxPendingLiabilityZnn: 250,
    haltPayoutsOnRisk:   true,
    haltBotOnRisk:       true,
  },

  // ── ORACLE ────────────────────────────────────────────────
  oracle: {
    priceCacheTtlMs:  5 * 60 * 1000,
    requestTimeoutMs: 8 * 1000,
    // If this many consecutive fetches fail, oracle is considered down
    failureThreshold: 3,
  },

};

// ─────────────────────────────────────────────────────────────
// LIVE CONFIG STORE
// Holds the current running config (starts as deep clone of defaults)
// The bot and all modules read from here — never from hardcoded constants
// ─────────────────────────────────────────────────────────────

class ConfigStore {
  constructor() {
    this._config  = deepClone(defaultConfig);
    this._history = [];   // audit log of every change
    this._persist = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  // ── READ ────────────────────────────────────────────────

  get(path) {
    if (!path) return this._config;
    return path.split('.').reduce((obj, key) => obj?.[key], this._config);
  }

  getAll() {
    return deepClone(this._config);
  }

  // ── WRITE ───────────────────────────────────────────────

  /**
   * Patch one or more config values at runtime.
   * path: dot-notation string e.g. 'bot.maxOpenMarkets'
   * value: new value
   * changedBy: 'bot' | 'admin' | 'system'
   */
  patch(path, value, changedBy = 'system') {
    const parts  = path.split('.');
    const key    = parts.pop();
    const parent = parts.reduce((obj, k) => {
      if (!obj[k]) throw new Error(`Config path not found: ${path}`);
      return obj[k];
    }, this._config);

    if (!(key in parent)) throw new Error(`Config key does not exist: ${path}`);

    const before = parent[key];
    parent[key]  = value;

    const entry = {
      ts: Date.now(),
      path,
      before,
      after: value,
      changedBy,
    };
    this._history.push(entry);
    if (this._history.length > 200) this._history.shift();

    console.log(`[config] ${changedBy} patched ${path}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`);
    this._persist?.();
    return entry;
  }

  /**
   * Bulk patch — apply multiple changes at once
   * changes: [ { path, value }, ... ]
   */
  patchMany(changes, changedBy = 'system') {
    return changes.map(({ path, value }) => this.patch(path, value, changedBy));
  }

  /**
   * Register a new game at runtime
   */
  registerGame(gameDescriptor, changedBy = 'system') {
    const { id } = gameDescriptor;
    if (!id) throw new Error('Game descriptor must have an id');
    const exists = !!this._config.games[id];
    this._config.games[id] = { ...gameDescriptor };
    const action = exists ? 'updated' : 'registered';
    console.log(`[config] Game ${action}: ${id}`);
    this._history.push({ ts: Date.now(), path: `games.${id}`, action, changedBy, data: gameDescriptor });
    this._persist?.();
    return this._config.games[id];
  }

  /**
   * Toggle a game on or off
   */
  toggleGame(gameId, active, changedBy = 'system') {
    if (!this._config.games[gameId]) throw new Error(`Unknown game: ${gameId}`);
    return this.patch(`games.${gameId}.active`, active, changedBy);
  }

  // ── QUERIES ─────────────────────────────────────────────

  getActiveGames() {
    return Object.values(this._config.games).filter(g => g.active);
  }

  getActiveGameIds() {
    return this.getActiveGames().map(g => g.id);
  }

  getGame(gameId) {
    return this._config.games[gameId] || null;
  }

  getValidBets() {
    return this._config.validBets;
  }

  getHistory(limit = 50) {
    return this._history.slice(-limit);
  }

  // ── BOT WEIGHT UPDATER ───────────────────────────────────

  /**
   * Adjust market type weights based on engagement data.
   * Called by bot.js after measuring which market types attract more volume.
   * delta: how much to shift the weight (positive = boost, negative = reduce)
   */
  adjustMarketWeight(marketType, delta, changedBy = 'bot') {
    const key  = `bot.marketWeights.${marketType}`;
    const curr = this.get(key);
    if (curr === undefined) return;
    const newVal = Math.max(10, Math.min(100, curr + delta));
    return this.patch(key, newVal, changedBy);
  }

  exportState() {
    return {
      config: this.getAll(),
      history: this._history.slice(),
    };
  }

  importState(state = {}) {
    if (state.config) this._config = deepClone(state.config);
    if (Array.isArray(state.history)) this._history = state.history.slice(-200);
  }
}

// ── SINGLETON ───────────────────────────────────────────────
const config = new ConfigStore();

// ── HELPERS ─────────────────────────────────────────────────
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = { config, ConfigStore, defaultConfig };
