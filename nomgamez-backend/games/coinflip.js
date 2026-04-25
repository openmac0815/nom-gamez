/**
 * Coinflip Game Plugin
 * Simplest possible provably fair game - 50/50 odds
 * Heads (1-50) vs Tails (51-100) on d100 roll
 */

function createCoinflipPlugin() {
  return {
    id: 'coinflip',
    name: 'Coinflip',
    defaultConfig: {
      active: true,
      payoutMultiplier: 1.98,  // 2x minus 1% house edge
      houseEdgePct: 1,
      description: 'Heads or Tails? 50/50 odds, provably fair.',
      minBet: 0.1,
      maxBet: 10.0,
    },
    verification: {
      scheme: 'deterministic-v1',
      proofType: 'side-proof',
      status: 'active',
      note: 'Submit chosen side (heads/tails) for server verification',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'coinflip',
          sides: [
            { id: 'heads', label: 'Heads', icon: '👑' },
            { id: 'tails', label: 'Tails', icon: '🪙' },
          ],
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const chosenSide = proof.side;

      if (!chosenSide || !['heads', 'tails'].includes(chosenSide)) {
        return { valid: false, reason: 'Invalid side choice. Must be "heads" or "tails"' };
      }

      // Roll d100: 1-50 = heads, 51-100 = tails
      const roll = tools.seededInt(session.id, 'coinflip:roll', 100);
      const result = roll <= 50 ? 'heads' : 'tails';
      const won = result === chosenSide;

      return {
        valid: true,
        won,
        score: roll,
        details: { chosenSide, result, roll, sideLabel: result === 'heads' ? 'Heads 👑' : 'Tails 🪙' },
      };
    },
  };
}

module.exports = { createCoinflipPlugin };
