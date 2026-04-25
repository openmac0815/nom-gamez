/**
 * Crash Game Plugin
 * Popular crypto game where multiplier increases until it crashes
 * Player must cash out before crash to win
 * Provably fair using seeded PRNG for crash point
 */

// Crash point calculation
// Uses a provably fair algorithm similar to many crypto crash games
// The crash point is derived from a hash, making it unpredictable but verifiable
function calculateCrashPoint(seed, context) {
  // Generate a pseudo-random number between 0 and 1 using seeded PRNG
  // We use a simple but effective algorithm for crash games
  const r = seed; // 0-99 from seededInt

  // House edge: ~1% (real crash games often use this formula)
  // Crash point = 0.99 / (1 - r/100) for r from 0-98
  // This gives crash points from 1.00x to 99.00x
  if (r >= 99) return 1.00; // 1% chance of instant crash

  const crashPoint = 0.99 / (1 - r / 100);
  return Math.max(1.00, parseFloat(crashPoint.toFixed(2)));
}

const PREDEFINED_MULTIPLIERS = [1.1, 1.2, 1.3, 1.5, 1.8, 2.0, 2.5, 3.0, 4.0, 5.0, 10.0];

function createCrashPlugin() {
  return {
    id: 'crash',
    name: 'Crash',
    defaultConfig: {
      active: true,
      payoutMultiplier: 2,  // Default, actual payout based on cashout multiplier
      houseEdgePct: 1,
      description: 'Watch the multiplier rise. Cash out before it crashes!',
      minBet: 0.1,
      maxBet: 5.0,
      maxCrashMultiplier: 100.0,  // Cap for sanity
    },
    verification: {
      scheme: 'deterministic-v1',
      proofType: 'crash-proof',
      status: 'active',
      note: 'Submit cashout multiplier to verify win/loss',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'crash',
          predefinedMultipliers: PREDEFINED_MULTIPLIERS,
          note: 'Cash out before the crash! Higher multipliers = higher risk.',
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const cashoutMultiplier = parseFloat(proof.cashoutMultiplier);

      if (!cashoutMultiplier || cashoutMultiplier < 1.0) {
        return { valid: false, reason: 'Invalid cashout multiplier. Must be >= 1.0' };
      }

      if (cashoutMultiplier > session.maxCrashMultiplier || cashoutMultiplier > 100) {
        return { valid: false, reason: 'Cashout multiplier too high. Max: 100x' };
      }

      // Generate the crash point using seeded PRNG
      // We use the session ID + context to get a deterministic value
      const r = tools.seededInt(session.id, 'crash:point', 100);
      const crashPoint = calculateCrashPoint(r);

      // Player wins if they cashed out before the crash
      const won = cashoutMultiplier <= crashPoint;

      return {
        valid: true,
        won,
        score: cashoutMultiplier,
        details: {
          crashPoint: parseFloat(crashPoint.toFixed(2)),
          cashoutMultiplier,
          bust: !won,
          payoutMultiplier: won ? cashoutMultiplier : 0,
          message: won
            ? `Cashed out at ${cashoutMultiplier}x before crash at ${crashPoint.toFixed(2)}x!`
            : `Crashed at ${crashPoint.toFixed(2)}x before you could cash out at ${cashoutMultiplier}x!`,
        },
      };
    },
  };
}

module.exports = { createCrashPlugin };
