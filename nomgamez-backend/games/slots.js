function createSlotsPlugin() {
  const symbols = ['⬡', '💎', '🔮', '⚡', '🌀', '🔷', '🌐'];
  const symbolPayout = { '⬡': 50, '💎': 20, '🔮': 10, '⚡': 5, '🌀': 3, '🔷': 2, '🌐': 1.5 };

  return {
    id: 'slots',
    name: 'Plasma Slots',
    defaultConfig: {
      active: true,
      payoutMultiplier: 10,
      houseEdgePct: 10,
      description: '7 symbols. 50× jackpot on triple ⬡.',
      minBet: 0.1,
      maxBet: 10.0,
    },
    verification: {
      scheme: 'deterministic-v1',
      proofType: 'reel-proof',
      status: 'active',
      note: 'Submit reel proof so the server can recompute the deterministic slot result',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'slots',
          symbols,
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const reels = [0, 1, 2].map((i) => symbols[tools.seededInt(session.id, `slot:reel:${i}`, symbols.length) - 1]);
      const won = reels[0] === reels[1] && reels[1] === reels[2];
      const multiplier = won ? symbolPayout[reels[0]] : 0;

      if (Array.isArray(proof.reels) && proof.reels.join('|') !== reels.join('|')) {
        return { valid: false, reason: `Slots proof mismatch: expected ${reels.join(' ')}` };
      }
      if (proof.multiplier !== undefined && Number(proof.multiplier) !== multiplier) {
        return { valid: false, reason: `Slots proof mismatch: expected multiplier ${multiplier}` };
      }

      return {
        valid: true,
        won,
        score: multiplier,
        details: { reels, multiplier },
      };
    },
  };
}

module.exports = { createSlotsPlugin };
