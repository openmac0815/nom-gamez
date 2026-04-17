function createDicePlugin() {
  const modes = {
    range:   { id: 'range', label: '40-60', check: (r) => r >= 40 && r <= 60 },
    over50:  { id: 'over50', label: 'Over 50', check: (r) => r > 50 },
    under50: { id: 'under50', label: 'Under 50', check: (r) => r < 50 },
    lucky77: { id: 'lucky77', label: 'Lucky 77', check: (r) => r >= 70 && r <= 80 },
    odd:     { id: 'odd', label: 'Odd', check: (r) => r % 2 !== 0 },
    jackpot: { id: 'jackpot', label: 'Jackpot', check: (r) => r === 100 },
  };

  return {
    id: 'dice',
    name: 'Hash Dice',
    defaultConfig: {
      active: true,
      payoutMultiplier: 10,
      houseEdgePct: 10,
      description: 'Roll d100. Six win modes. Provably fair.',
      minBet: 0.1,
      maxBet: 10.0,
    },
    verification: {
      scheme: 'deterministic-v1',
      proofType: 'mode-proof',
      status: 'active',
      note: 'Submit selected dice mode so the server can recompute the deterministic roll',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'dice',
          modes: Object.values(modes).map(({ id, label }) => ({ id, label })),
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const modeId = proof.modeId;
      const mode = modes[modeId];
      if (!mode) return { valid: false, reason: 'Invalid dice mode proof' };

      const roll = tools.seededInt(session.id, 'dice:roll', 100);
      if (proof.claimedRoll !== undefined && Number(proof.claimedRoll) !== roll) {
        return { valid: false, reason: `Dice proof mismatch: expected roll ${roll}` };
      }

      return {
        valid: true,
        won: mode.check(roll),
        score: roll,
        details: { modeId, roll, modeLabel: mode.label },
      };
    },
  };
}

module.exports = { createDicePlugin };
