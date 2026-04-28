function createSlotsPlugin() {
  const { outcome, toInt } = require('../lib/fair');

  const SYMBOLS = ['🍒', '🍋', '🍊', '⭐', '💎', '7️⃣'];
  const PAYOUTS = {
    '🍒🍒🍒': 5,
    '🍋🍋🍋': 8,
    '🍊🍊🍊': 10,
    '⭐⭐⭐': 20,
    '💎💎💎': 50,
    '7️⃣7️⃣7️⃣': 100,
    '🍒🍒*': 2,   // two cherries
    '💎💎*': 10,  // two diamonds
  };

  function evaluate(reels) {
    const key = reels.join('');
    if (PAYOUTS[key]) return { multiplier: PAYOUTS[key], combo: key };
    // Check two-matches
    if (reels[0] === reels[1]) {
      const partialKey = `${reels[0]}${reels[0]}*`;
      if (PAYOUTS[partialKey]) return { multiplier: PAYOUTS[partialKey], combo: partialKey };
    }
    return { multiplier: 0, combo: key };
  }

  return {
    id: 'slots',
    name: 'Slots',
    defaultConfig: {
      active: true,
      payoutMultiplier: 10,
      houseEdgePct: 15,
      description: 'Three-reel slots. Cherries, lemons, diamonds, and 7s. Provably fair.',
      minBet: 0.05,
      maxBet: 5.0,
    },
    verification: {
      scheme: 'commit-reveal-v1',
      proofType: 'reels-proof',
      status: 'active',
      note: 'Each reel = HMAC-SHA256(serverSeed, cs:nonce:slots:reel:N) mod 6',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'slots',
          symbols: SYMBOLS,
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};

      // Commit-reveal: generate 3 reel positions
      const serverSeed = session.serverSeed;
      const clientSeed = session.clientSeed || '';
      const nonce = session.nonce || 0;
      const reels = [];
      for (let i = 0; i < 3; i++) {
        const hash = outcome(serverSeed, clientSeed, `${nonce}:${i}`, 'slots');
        reels.push(toInt(hash, SYMBOLS.length));
      }
      const result = reels.map(r => SYMBOLS[r]);

      if (proof.claimedReels) {
        const claimed = proof.claimedReels;
        if (claimed[0] !== result[0] || claimed[1] !== result[1] || claimed[2] !== result[2]) {
          return { valid: false, reason: `Slots mismatch: expected ${result.join('|')}` };
        }
      }

      const { multiplier, combo } = evaluate(result);
      const won = multiplier > 0;
      return {
        valid: true,
        won,
        score: multiplier,
        details: { reels: result, combo, multiplier },
      };
    },
  };
}

module.exports = { createSlotsPlugin };
