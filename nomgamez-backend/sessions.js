// sessions.js — In-memory session store for game sessions
// Each session tracks: player, bet, deposit status, game outcome, payout

const crypto = require('crypto');

// Session states
const STATE = {
  PENDING_DEPOSIT: 'PENDING_DEPOSIT',   // waiting for player to send ZNN
  DEPOSIT_CONFIRMING: 'DEPOSIT_CONFIRMING', // tx found, waiting confirm
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',   // deposit verified, game can start
  GAME_ACTIVE: 'GAME_ACTIVE',           // game in progress
  AWAITING_PAYOUT_CHOICE: 'AWAITING_PAYOUT_CHOICE', // winner must choose payout rail/address
  GAME_WON: 'GAME_WON',                 // player won, payout queued
  GAME_LOST: 'GAME_LOST',               // player lost
  PAYOUT_SENT: 'PAYOUT_SENT',           // winnings sent
  PAYOUT_FAILED: 'PAYOUT_FAILED',       // payout tx failed
  EXPIRED: 'EXPIRED',                   // deposit timeout
};

// TTL for seen-hash entries — keep for 7 days (covers any realistic reorg window)
const SEEN_HASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SessionManager {
  constructor() {
    this.sessions = new Map();
    // seenHashes: Map<txHash, seenAtMs> — bounded by TTL, not unbounded Set
    this.seenHashes = new Map();
    this._persist = null;
    this._store = null;
    // Clean up expired sessions every 5 min
    this._cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this._cleanupTimer.unref?.();
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  setStore(store) {
    this._store = store;
  }

  /**
   * Create a new game session
   */
  create({ playerAddress, gameId, betAmount, depositTimeout, isTestMode = false }) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      id: sessionId,
      playerAddress,
      gameId,
      betAmount: parseFloat(betAmount),
      payoutAmount: parseFloat((betAmount * 10).toFixed(8)), // 10x payout on win
      payoutAsset: null,
      payoutAddress: null,
      payoutChoice: null,
      quote: null,
      state: STATE.PENDING_DEPOSIT,
      createdAt: Date.now(),
      expiresAt: Date.now() + (depositTimeout * 1000),
      depositTxHash: null,
      payoutTxHash: null,
      gameResult: null,
      gameScore: null,
      isTestMode: Boolean(isTestMode),
      pollCount: 0,
      log: [`[${ts()}] Session created — ${gameId} — bet: ${betAmount} ZNN${isTestMode ? ' — TEST MODE' : ''}`],
    };
    this.sessions.set(sessionId, session);
    this._store?.upsertSession(session);
    console.log(`[session] Created ${sessionId} | ${playerAddress} | ${gameId} | ${betAmount} ZNN`);
    this._persist?.();
    return session;
  }

  get(sessionId) {
    if (this._store) return this._store.getSessionById(sessionId);
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Update session state and log the transition
   */
  setState(sessionId, newState, extra = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const prev = s.state;
    s.state = newState;
    Object.assign(s, extra);
    s.log.push(`[${ts()}] ${prev} → ${newState}${extra.note ? ' // ' + extra.note : ''}`);
    this._store?.upsertSession(s);
    console.log(`[session] ${sessionId} | ${prev} → ${newState}`);
    this._persist?.();
    return s;
  }

  /**
   * Mark deposit as found (manual hash or auto-detected)
   */
  depositFound(sessionId, txHash) {
    this.seenHashes.set(txHash, Date.now());
    this._store?.addSeenHash(txHash);
    this._persist?.();
    return this.setState(sessionId, STATE.DEPOSIT_CONFIRMING, {
      depositTxHash: txHash,
      note: `tx: ${txHash}`,
    });
  }

  /**
   * Mark deposit confirmed — game may now start
   */
  depositConfirmed(sessionId) {
    return this.setState(sessionId, STATE.DEPOSIT_CONFIRMED);
  }

  /**
   * Mark game as started
   */
  gameStarted(sessionId) {
    return this.setState(sessionId, STATE.GAME_ACTIVE, {
      gameStartedAt: Date.now(),
    });
  }

  /**
   * Record game result
   */
  gameEnded(sessionId, { won, score, details = null }) {
    return this.setState(sessionId, won ? STATE.GAME_WON : STATE.GAME_LOST, {
      gameResult: won ? 'WIN' : 'LOSS',
      gameScore: score,
      gameDetails: details,
      gameEndedAt: Date.now(),
    });
  }

  awaitingPayoutChoice(sessionId, { payoutOptions = null } = {}) {
    return this.setState(sessionId, STATE.AWAITING_PAYOUT_CHOICE, {
      payoutOptions,
      payoutChoiceRequestedAt: Date.now(),
    });
  }

  setQuote(sessionId, quote) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    s.quote = quote;
    this._store?.upsertSession(s);
    this._persist?.();
    return s;
  }

  setPayoutChoice(sessionId, payoutChoice) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    s.payoutChoice = payoutChoice;
    s.payoutAsset = payoutChoice?.asset || null;
    s.payoutAddress = payoutChoice?.address || null;
    s.payoutAmount = payoutChoice?.amount ?? s.payoutAmount;
    s.payoutOptions = payoutChoice?.availableOptions || s.payoutOptions || null;
    this._store?.upsertSession(s);
    this._persist?.();
    return s;
  }

  /**
   * Mark payout as sent
   */
  payoutSent(sessionId, txHash) {
    return this.setState(sessionId, STATE.PAYOUT_SENT, {
      payoutTxHash: txHash,
      note: `payout tx: ${txHash}`,
    });
  }

  payoutFailed(sessionId, reason) {
    return this.setState(sessionId, STATE.PAYOUT_FAILED, { note: reason });
  }

  /**
   * Check if hash was already used (prevent replay).
   * Also checks the persistent store as a second line of defence.
   */
  isHashSeen(hash) {
    if (this.seenHashes.has(hash)) return true;
    if (this._store?.isHashSeen?.(hash)) return true;
    return false;
  }

  addSeenHash(hash) {
    if (!hash) return;
    this.seenHashes.set(hash, Date.now());
    this._store?.addSeenHash(hash);
    this._persist?.();
  }

  /**
   * Get all sessions needing deposit polling
   */
  getPendingSessions() {
    if (this._store) return this._store.getPendingSessions(Date.now());
    const now = Date.now();
    return Array.from(this.sessions.values()).filter(s =>
      s.state === STATE.PENDING_DEPOSIT && s.expiresAt > now
    );
  }

  /**
   * Get sessions ready for payout
   */
  getWinningSessions() {
    if (this._store) return this._store.getWinningSessions();
    return Array.from(this.sessions.values()).filter(s =>
      s.state === STATE.GAME_WON
    );
  }

  /**
   * Expire old pending sessions and evict stale seen-hashes.
   */
  cleanup() {
    const now = Date.now();
    let expired = 0;
    for (const [id, s] of this.sessions) {
      if (s.state === STATE.PENDING_DEPOSIT && s.expiresAt < now) {
        this.setState(id, STATE.EXPIRED);
        expired++;
      }
      // Remove very old sessions from memory (>2hrs)
      if (now - s.createdAt > 2 * 60 * 60 * 1000) {
        this.sessions.delete(id);
        this._store?.deleteSession(id);
        this._persist?.();
      }
    }
    if (expired > 0) console.log(`[session] Expired ${expired} sessions`);

    // Evict seen-hashes older than TTL to prevent unbounded memory growth
    let evicted = 0;
    for (const [hash, seenAt] of this.seenHashes) {
      if (now - seenAt > SEEN_HASH_TTL_MS) {
        this.seenHashes.delete(hash);
        evicted++;
      }
    }
    if (evicted > 0) console.log(`[session] Evicted ${evicted} stale tx hashes`);

    // Mirror eviction in persistent store
    this._store?.evictOldSeenHashes?.(SEEN_HASH_TTL_MS);
  }

  /**
   * Summary stats
   */
  stats() {
    if (this._store) return this._store.getSessionStats();
    const all = Array.from(this.sessions.values());
    return {
      total: all.length,
      pending: all.filter(s => s.state === STATE.PENDING_DEPOSIT).length,
      active: all.filter(s => s.state === STATE.GAME_ACTIVE).length,
      won: all.filter(s => s.state === STATE.GAME_WON || s.state === STATE.AWAITING_PAYOUT_CHOICE || s.state === STATE.PAYOUT_SENT).length,
      lost: all.filter(s => s.state === STATE.GAME_LOST).length,
    };
  }

  exportState() {
    return {
      sessions:   Array.from(this.sessions.values()),
      // Export as [hash, timestamp] pairs for TTL preservation across restarts
      seenHashes: Array.from(this.seenHashes.entries()),
    };
  }

  importState(state = {}) {
    const sessions   = this._store ? this._store.getAllSessions()  : (state.sessions   || []);
    const seenHashes = this._store ? this._store.getSeenHashes()   : (state.seenHashes || []);
    this.sessions = new Map(sessions.map(s => [s.id, s]));

    // Support both old format (string[]) and new format ([hash, ts][])
    this.seenHashes = new Map(
      seenHashes.map(entry =>
        Array.isArray(entry) ? entry : [entry, Date.now()]
      )
    );
  }
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

module.exports = { SessionManager, STATE };
