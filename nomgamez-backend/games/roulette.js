function createRoulettePlugin() {
  const { outcome, toInt } = require('../lib/fair');

  const BETS = {
    red:   { label: 'Red',   numbers: [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36], payout: 2 },
    black: { label: 'Black', numbers: [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35], payout: 2 },
    green: { label: 'Green', numbers: [0], payout: 36 },
    even:  { label: 'Even',  numbers: Array.from({length:18}, (_,i)=>(i+1)*2),               payout: 2 },
    odd:   { label: 'Odd',   numbers: Array.from({length:18}, (_,i)=>(i+1)*2-1),             payout: 2 },
    low:   { label: '1-18', numbers: Array.from({length:18}, (_,i)=>i+1),                   payout: 2 },
    high:  { label: '19-36',numbers: Array.from({length:18}, (_,i)=>i+19),                  payout: 2 },
  };

  return {
    id: 'roulette',
    name: 'European Roulette',
    defaultConfig: {
      active: true,
      payoutMultiplier: 2,
      houseEdgePct: 2.7, // single-zero
      description: 'European roulette. 37 numbers. Provably fair.',
      minBet: 0.05,
      maxBet: 20.0,
    },
    verification: {
      scheme: 'commit-reveal-v1',
      proofType: 'bet-proof',
      status: 'active',
      note: 'Outcome = HMAC-SHA256(serverSeed, clientSeed:nonce:roulette) mod 37',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'roulette',
          bets: Object.entries(BETS).map(([id, { label, payout }]) => ({ id, label, payout })),
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const betId = proof.betId;
      const bet = BETS[betId];
      if (!bet) return { valid: false, reason: 'Invalid roulette bet proof' };

      // Commit-reveal PRNG
      const serverSeed = session.serverSeed;
      const clientSeed = session.clientSeed || '';
      const nonce = session.nonce || 0;
      const hash = outcome(serverSeed, clientSeed, nonce, 'roulette');
      const number = toInt(hash, 37); // 0-36

      const won = bet.numbers.includes(number);
      return {
        valid: true,
        won,
        score: number,
        details: { betId, number, betLabel: bet.label, color: number === 0 ? 'green' : (bet.numbers.includes(number) ? (BETS.red.numbers.includes(number)?'red':'black') : 'n/a') },
      };
    },
  };
}

module.exports = { createRoulettePlugin };
