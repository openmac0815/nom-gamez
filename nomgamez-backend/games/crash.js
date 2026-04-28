function createCrashPlugin() {
  const { outcome, toFloat } = require('../lib/fair');

  return {
    id: 'crash',
    name: 'Crash',
    defaultConfig: {
      active: true,
      payoutMultiplier: 2,
      houseEdgePct: 5,
      description: 'Watch the multiplier grow. Cash out before it crashes! Provably fair.',
      minBet: 0.01,
      maxBet: 50.0,
    },
    verification: {
      scheme: 'commit-reveal-v1',
      proofType: 'cashout-proof',
      status: 'active',
      note: 'Crash point = 1 + (HMAC-SHA256(serverSeed, cs:nonce:crash) mod 9900)/100; transparent algorithm',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'crash',
          note: 'Cash out before the multiplier crashes!',
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const cashoutAt = Number(proof.cashoutAt) || 0; // multiplier where player cashed out

      // Commit-reveal: compute crash point
      const serverSeed = session.serverSeed;
      const clientSeed = session.clientSeed || '';
      const nonce = session.nonce || 0;
      const hash = outcome(serverSeed, clientSeed, nonce, 'crash');
      // crashPoint: 1.00 to 100.00 (house edge: 1% chance of instant crash at 1.00)
      const r = toFloat(hash); // [0,1)
      const crashPoint = Math.max(1.0, 1.0 + Math.floor(r * 9900) / 100); // 1.00 - 100.00

      const crashedAt = crashPoint;
      const won = cashoutAt > 0 && cashoutAt <= crashedAt;
      const payoutMult = won ? cashoutAt : 0;

      return {
        valid: true,
        won,
        score: cashoutAt,
        details: { crashPoint: crashedAt.toFixed(2), cashoutAt: cashoutAt.toFixed(2), payoutMult },
      };
    },
  };
}

module.exports = { createCrashPlugin };
