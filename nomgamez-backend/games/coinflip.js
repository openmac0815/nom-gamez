function createCoinflipPlugin() {
  const { outcome, toInt } = require('../lib/fair');

  return {
    id: 'coinflip',
    name: 'Coinflip',
    defaultConfig: {
      active: true,
      payoutMultiplier: 2,
      houseEdgePct: 0, // 50/50, no house edge
      description: 'Heads or Tails. Pure 50/50. Provably fair.',
      minBet: 0.01,
      maxBet: 100.0,
    },
    verification: {
      scheme: 'commit-reveal-v1',
      proofType: 'choice-proof',
      status: 'active',
      note: 'Client picks heads/tails; outcome = HMAC-SHA256(serverSeed, clientSeed:nonce:coinflip) mod 2',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'coinflip',
          choices: [
            { id: 'heads', label: 'Heads' },
            { id: 'tails', label: 'Tails' },
          ],
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const pick = proof.pick; // 'heads' or 'tails'
      if (!pick || (pick !== 'heads' && pick !== 'tails')) {
        return { valid: false, reason: 'Invalid coinflip choice proof' };
      }

      // Commit-reveal PRNG
      const serverSeed = session.serverSeed;
      const clientSeed = session.clientSeed || '';
      const nonce = session.nonce || 0;
      const hash = outcome(serverSeed, clientSeed, nonce, 'coinflip');
      const flip = toInt(hash, 2) === 0 ? 'heads' : 'tails';

      if (proof.claimedFlip && proof.claimedFlip !== flip) {
        return { valid: false, reason: `Coinflip mismatch: expected ${flip}` };
      }

      const won = (pick === flip);
      return {
        valid: true,
        won,
        score: won ? 1 : 0,
        details: { pick, flip },
      };
    },
  };
}

module.exports = { createCoinflipPlugin };
