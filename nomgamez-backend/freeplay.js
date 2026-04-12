// freeplay.js — Daily Free Play System
// One free game per address per day, funded from the platform fee pool
// The acquisition hook: zero friction, real prizes, no deposit required

const crypto = require('crypto');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────

const FREEPLAY_CONFIG = {
  // Max payout for a free play win (ZNN)
  MAX_PAYOUT: 2.0,
  // Min payout for a free play win
  MIN_PAYOUT: 0.1,
  // Win probability for free play (25% chance)
  WIN_PROBABILITY: 0.25,
  // How long the "claim window" lasts after winning (ms)
  CLAIM_WINDOW_MS: 10 * 60 * 1000, // 10 minutes
  // IP-based rate limit: max free plays per IP per day
  MAX_PER_IP: 2,
};

// Reset daily at midnight UTC
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ─────────────────────────────────────────
// FREE PLAY MANAGER
// ─────────────────────────────────────────

class FreePlayManager {
  constructor() {
    // Map: dayKey:address → count
    this.usedAddresses = new Map();
    // Map: dayKey:ip → count
    this.usedIPs       = new Map();
    // Pending claims: claimToken → { address, payout, expiresAt }
    this.pendingClaims = new Map();
    this._persist = null;

    // Daily reset
    setInterval(() => this._dailyReset(), MS_PER_DAY);
    // Clean expired claims
    setInterval(() => this._cleanClaims(), 5 * 60 * 1000);
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  // ─── PLAY ─────────────────────────────

  /**
   * Request a free play for an address.
   * Returns { eligible, reason, result?, claimToken?, payout? }
   */
  requestFreePlay(address, ip = null) {
    const today = getTodayKey();

    // Address eligibility check
    const addrKey = `${today}:${address}`;
    if (this.usedAddresses.get(addrKey)) {
      return {
        eligible: false,
        reason: 'Already used free play today. Come back tomorrow.',
        nextPlayAt: this._nextMidnightUTC(),
      };
    }

    // IP rate limit
    if (ip) {
      const ipKey = `${today}:${ip}`;
      const ipCount = this.usedIPs.get(ipKey) || 0;
      if (ipCount >= FREEPLAY_CONFIG.MAX_PER_IP) {
        return {
          eligible: false,
          reason: 'Daily limit reached from this network.',
          nextPlayAt: this._nextMidnightUTC(),
        };
      }
    }

    // Mark as used
    this.usedAddresses.set(addrKey, true);
    if (ip) {
      const ipKey = `${today}:${ip}`;
      this.usedIPs.set(ipKey, (this.usedIPs.get(ipKey) || 0) + 1);
    }
    this._persist?.();

    // Determine outcome — provably seeded with address + date for auditability
    const seed = address + today;
    const won  = seededRandom(seed, 'win') < FREEPLAY_CONFIG.WIN_PROBABILITY;

    if (!won) {
      return {
        eligible: true,
        won: false,
        message: "Better luck tomorrow! Free plays reset at midnight UTC.",
        nextPlayAt: this._nextMidnightUTC(),
      };
    }

    // Calculate prize (seeded random amount between min and max)
    const range  = FREEPLAY_CONFIG.MAX_PAYOUT - FREEPLAY_CONFIG.MIN_PAYOUT;
    const payout = parseFloat((FREEPLAY_CONFIG.MIN_PAYOUT + seededRandom(seed, 'amount') * range).toFixed(4));

    // Issue a claim token (player must provide their address to claim)
    const claimToken = crypto.randomBytes(12).toString('hex');
    this.pendingClaims.set(claimToken, {
      address,
      payout,
      createdAt: Date.now(),
      expiresAt: Date.now() + FREEPLAY_CONFIG.CLAIM_WINDOW_MS,
      claimed: false,
    });
    this._persist?.();

    console.log(`[freeplay] WIN — ${address.slice(0,12)}… | ${payout} ZNN | token: ${claimToken}`);

    return {
      eligible: true,
      won: true,
      payout,
      claimToken,
      claimWindowMinutes: Math.floor(FREEPLAY_CONFIG.CLAIM_WINDOW_MS / 60_000),
      message: `You won ${payout} ZNN! Claim within ${Math.floor(FREEPLAY_CONFIG.CLAIM_WINDOW_MS / 60_000)} minutes.`,
    };
  }

  /**
   * Claim a free play win.
   * Returns { success, payout, address } — caller queues the payout.
   */
  claimWin(claimToken, address) {
    const claim = this.pendingClaims.get(claimToken);
    if (!claim) {
      return { success: false, reason: 'Claim token not found or expired' };
    }
    if (claim.claimed) {
      return { success: false, reason: 'Already claimed' };
    }
    if (Date.now() > claim.expiresAt) {
      return { success: false, reason: 'Claim window expired' };
    }
    if (claim.address.toLowerCase() !== address.toLowerCase()) {
      return { success: false, reason: 'Address mismatch' };
    }

    claim.claimed = true;
    claim.claimedAt = Date.now();

    console.log(`[freeplay] CLAIMED — ${address.slice(0,12)}… | ${claim.payout} ZNN`);
    this._persist?.();
    return { success: true, payout: claim.payout, address: claim.address };
  }

  /**
   * Check eligibility without consuming the play
   */
  checkEligibility(address, ip = null) {
    const today  = getTodayKey();
    const addrKey = `${today}:${address}`;
    const used   = this.usedAddresses.get(addrKey) || false;

    return {
      eligible: !used,
      nextPlayAt: used ? this._nextMidnightUTC() : null,
      maxPayout: FREEPLAY_CONFIG.MAX_PAYOUT,
      winProbability: FREEPLAY_CONFIG.WIN_PROBABILITY,
    };
  }

  // ─── INTERNAL ─────────────────────────

  _dailyReset() {
    console.log('[freeplay] Daily reset');
    const today = getTodayKey();
    // Remove entries from previous days
    for (const [key] of this.usedAddresses) {
      if (!key.startsWith(today)) this.usedAddresses.delete(key);
    }
    for (const [key] of this.usedIPs) {
      if (!key.startsWith(today)) this.usedIPs.delete(key);
    }
    this._persist?.();
  }

  _cleanClaims() {
    const now = Date.now();
    for (const [token, claim] of this.pendingClaims) {
      if (claim.expiresAt < now && !claim.claimed) {
        this.pendingClaims.delete(token);
      }
    }
    this._persist?.();
  }

  _nextMidnightUTC() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return next.toISOString();
  }

  stats() {
    const today = getTodayKey();
    const todayPlays = Array.from(this.usedAddresses.keys()).filter(k => k.startsWith(today)).length;
    return {
      todayPlays,
      pendingClaims: this.pendingClaims.size,
    };
  }

  exportState() {
    return {
      usedAddresses: Array.from(this.usedAddresses.entries()),
      usedIPs: Array.from(this.usedIPs.entries()),
      pendingClaims: Array.from(this.pendingClaims.entries()),
    };
  }

  importState(state = {}) {
    this.usedAddresses = new Map(state.usedAddresses || []);
    this.usedIPs = new Map(state.usedIPs || []);
    this.pendingClaims = new Map(state.pendingClaims || []);
  }
}

// ─────────────────────────────────────────
// SEEDED RANDOM
// ─────────────────────────────────────────

/**
 * Deterministic pseudo-random [0,1) from string seed + nonce.
 * Same seed always produces same value — auditable.
 */
function seededRandom(seed, nonce) {
  const str = seed + ':' + nonce;
  let h = 0x12345678;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  // Convert to [0, 1)
  return (Math.abs(h) >>> 0) / 0xFFFFFFFF;
}

module.exports = { FreePlayManager, FREEPLAY_CONFIG, seededRandom };
