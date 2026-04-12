const DICE_MODES = {
  range:   { check: r => r >= 40 && r <= 60 },
  over50:  { check: r => r > 50 },
  under50: { check: r => r < 50 },
  lucky77: { check: r => r >= 70 && r <= 80 },
  odd:     { check: r => r % 2 !== 0 },
  jackpot: { check: r => r === 100 },
};

const SYMS = ['⬡', '💎', '🔮', '⚡', '🌀', '🔷', '🌐'];
const SYM_PAY = { '⬡':50, '💎':20, '🔮':10, '⚡':5, '🌀':3, '🔷':2, '🌐':1.5 };

function seededInt(seed, nonce, max) {
  let h = 0x12345678;
  const s = `${seed}:${nonce}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return (Math.abs(h) % max) + 1;
}

function verifyGameResult(session, payload = {}) {
  const proof = payload.proof || {};

  switch (session.gameId) {
    case 'dice':
      return verifyDice(session, proof);
    case 'slots':
      return verifySlots(session, proof);
    case 'shooter':
      return {
        valid: false,
        reason: 'Shooter payouts are disabled until replayable server-side verification is implemented',
      };
    default:
      return { valid: false, reason: `Unsupported game: ${session.gameId}` };
  }
}

function verifyDice(session, proof) {
  const modeId = proof.modeId;
  const mode = DICE_MODES[modeId];
  if (!mode) return { valid: false, reason: 'Invalid dice mode proof' };

  const roll = seededInt(session.id, 'dice:roll', 100);
  if (proof.claimedRoll !== undefined && Number(proof.claimedRoll) !== roll) {
    return { valid: false, reason: `Dice proof mismatch: expected roll ${roll}` };
  }

  return {
    valid: true,
    won: mode.check(roll),
    score: roll,
    details: { modeId, roll },
  };
}

function verifySlots(session, proof) {
  const reels = [0, 1, 2].map(i => SYMS[seededInt(session.id, `slot:reel:${i}`, SYMS.length) - 1]);
  const won = reels[0] === reels[1] && reels[1] === reels[2];
  const multiplier = won ? SYM_PAY[reels[0]] : 0;

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
}

module.exports = {
  verifyGameResult,
  seededInt,
  DICE_MODES,
  SYMS,
  SYM_PAY,
};
