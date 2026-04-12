// sessions.js — In-memory session store for game sessions
// Each session tracks: player, bet, deposit status, game outcome, payout

const crypto = require('crypto');

// Session states
const STATE = {
  PENDING_DEPOSIT: 'PENDING_DEPOSIT',   // waiting for player to send ZNN
  DEPOSIT_CONFIRMING: 'DEPOSIT_CONFIRMING', // tx found, waiting confirm
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',   // deposit verified, game can start
  GAME_ACTIVE: 'GAME_ACTIVE',           // game in progress
  GAME_WON: 'GAME_WON',                 // player won, payout queued
  GAME_LOST: 'GAME_LOST',               // player lost
  PAYOUT_SENT: 'PAYOUT_SENT',           // winnings sent
  PAYOUT_FAILED: 'PAYOUT_FAILED',       // payout tx failed
  EXPIRED: 'EXPIRED',                   // deposit timeout
};

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.seenHashes = new Set(); // prevent double-counting deposits
    this._persist = null;
    // Clean up expired sessions every 5 min
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  /**
   * Create a new game session
   */
  create({ playerAddress, gameId, betAmount, depositTimeout }) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      id: sessionId,
      playerAddress,
      gameId,
      betAmount: parseFloat(betAmount),
      payoutAmount: parseFloat((betAmount * 10).toFixed(8)), // 10x payout on win
      state: STATE.PENDING_DEPOSIT,
      createdAt: Date.now(),
      expiresAt: Date.now() + (depositTimeout * 1000),
      depositTxHash: null,
      payoutTxHash: null,
      gameResult: null,
      gameScore: null,
      pollCount: 0,
      log: [`[${ts()}] Session created — ${gameId} — bet: ${betAmount} ZNN`],
    };
    this.sessions.set(sessionId, session);
    console.log(`[session] Created ${sessionId} | ${playerAddress} | ${gameId} | ${betAmount} ZNN`);
    this._persist?.();
    return session;
  }

  get(sessionId) {
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
    console.log(`[session] ${sessionId} | ${prev} → ${newState}`);
    this._persist?.();
    return s;
  }

  /**
   * Mark deposit as found (manual hash or auto-detected)
   */
  depositFound(sessionId, txHash) {
    this.seenHashes.add(txHash);
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
   * Check if hash was already used (prevent replay)
   */
  isHashSeen(hash) {
    return this.seenHashes.has(hash);
  }

  /**
   * Get all sessions needing deposit polling
   */
  getPendingSessions() {
    const now = Date.now();
    return Array.from(this.sessions.values()).filter(s =>
      s.state === STATE.PENDING_DEPOSIT && s.expiresAt > now
    );
  }

  /**
   * Get sessions ready for payout
   */
  getWinningSessions() {
    return Array.from(this.sessions.values()).filter(s =>
      s.state === STATE.GAME_WON
    );
  }

  /**
   * Expire old pending sessions
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
        this._persist?.();
      }
    }
    if (expired > 0) console.log(`[session] Expired ${expired} sessions`);
  }

  /**
   * Summary stats
   */
  stats() {
    const all = Array.from(this.sessions.values());
    return {
      total: all.length,
      pending: all.filter(s => s.state === STATE.PENDING_DEPOSIT).length,
      active: all.filter(s => s.state === STATE.GAME_ACTIVE).length,
      won: all.filter(s => s.state === STATE.GAME_WON || s.state === STATE.PAYOUT_SENT).length,
      lost: all.filter(s => s.state === STATE.GAME_LOST).length,
    };
  }

  exportState() {
    return {
      sessions: Array.from(this.sessions.values()),
      seenHashes: Array.from(this.seenHashes),
    };
  }

  importState(state = {}) {
    this.sessions = new Map((state.sessions || []).map(session => [session.id, session]));
    this.seenHashes = new Set(state.seenHashes || []);
  }
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

module.exports = { SessionManager, STATE };
