/**
 * Roulette Game Plugin
 * European Roulette (0-36) with multiple bet types
 * Provably fair using seeded PRNG
 */

// European roulette: 0 is green, 1-36 split into red/black
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const BLACK_NUMBERS = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];

function isRed(number) {
  return RED_NUMBERS.includes(number);
}

function isBlack(number) {
  return BLACK_NUMBERS.includes(number);
}

const BET_TYPES = {
  straight: {
    id: 'straight',
    label: 'Straight Up',
    description: 'Bet on a single number (0-36)',
    payoutMultiplier: 36,  // 35:1 plus original bet
    houseEdgePct: 2.7,   // European roulette edge
  },
  red: {
    id: 'red',
    label: 'Red',
    description: 'Bet on red numbers',
    payoutMultiplier: 2,
    houseEdgePct: 2.7,
  },
  black: {
    id: 'black',
    label: 'Black',
    description: 'Bet on black numbers',
    payoutMultiplier: 2,
    houseEdgePct: 2.7,
  },
  even: {
    id: 'even',
    label: 'Even',
    description: 'Bet on even numbers (excludes 0)',
    payoutMultiplier: 2,
    houseEdgePct: 2.7,
  },
  odd: {
    id: 'odd',
    label: 'Odd',
    description: 'Bet on odd numbers (excludes 0)',
    payoutMultiplier: 2,
    houseEdgePct: 2.7,
  },
  '1-18': {
    id: '1-18',
    label: '1 to 18',
    description: 'Low numbers',
    payoutMultiplier: 2,
    houseEdgePct: 2.7,
  },
  '19-36': {
    id: '19-36',
    label: '19 to 36',
    description: 'High numbers',
    payoutMultiplier: 2,
    houseEdgePct: 2.7,
  },
};

function createRoulettePlugin() {
  return {
    id: 'roulette',
    name: 'Roulette',
    defaultConfig: {
      active: true,
      payoutMultiplier: 2,  // Default for even-money bets
      houseEdgePct: 2.7,
      description: 'European Roulette. 0-36. Multiple bet types. Provably fair.',
      minBet: 0.1,
      maxBet: 5.0,
      betTypes: Object.keys(BET_TYPES),
    },
    verification: {
      scheme: 'deterministic-v1',
      proofType: 'bet-proof',
      status: 'active',
      note: 'Submit chosen bet type and number (for straight bets) for verification',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'roulette',
          betTypes: Object.values(BET_TYPES).map(({ id, label, description, payoutMultiplier }) => ({
            id,
            label,
            description,
            payoutMultiplier,
          })),
          redNumbers: RED_NUMBERS,
          blackNumbers: BLACK_NUMBERS,
          totalNumbers: 37, // 0-36
        },
      };
    },
    verifyResult(session, payload, tools) {
      const proof = payload.proof || {};
      const betType = proof.betType;
      const chosenNumber = proof.number !== undefined ? parseInt(proof.number) : null;

      if (!BET_TYPES[betType]) {
        return { valid: false, reason: `Invalid bet type. Options: ${Object.keys(BET_TYPES).join(', ')}` };
      }

      // For straight bets, validate the chosen number
      if (betType === 'straight') {
        if (chosenNumber === null || chosenNumber < 0 || chosenNumber > 36) {
          return { valid: false, reason: 'Straight bet requires a valid number (0-36)' };
        }
      }

      // Generate the winning number (0-36)
      const winningNumber = tools.seededInt(session.id, 'roulette:spin', 37);
      const winningColor = winningNumber === 0 ? 'green' : (isRed(winningNumber) ? 'red' : 'black');

      // Check if bet wins
      let won = false;
      let payoutMultiplier = 0;

      switch (betType) {
        case 'straight':
          won = winningNumber === chosenNumber;
          payoutMultiplier = BET_TYPES.straight.payoutMultiplier;
          break;
        case 'red':
          won = winningColor === 'red';
          payoutMultiplier = BET_TYPES.red.payoutMultiplier;
          break;
        case 'black':
          won = winningColor === 'black';
          payoutMultiplier = BET_TYPES.black.payoutMultiplier;
          break;
        case 'even':
          won = winningNumber > 0 && winningNumber % 2 === 0;
          payoutMultiplier = BET_TYPES.even.payoutMultiplier;
          break;
        case 'odd':
          won = winningNumber > 0 && winningNumber % 2 === 1;
          payoutMultiplier = BET_TYPES.odd.payoutMultiplier;
          break;
        case '1-18':
          won = winningNumber >= 1 && winningNumber <= 18;
          payoutMultiplier = BET_TYPES['1-18'].payoutMultiplier;
          break;
        case '19-36':
          won = winningNumber >= 19 && winningNumber <= 36;
          payoutMultiplier = BET_TYPES['19-36'].payoutMultiplier;
          break;
      }

      return {
        valid: true,
        won,
        score: winningNumber,
        details: {
          winningNumber,
          winningColor,
          betType,
          chosenNumber: betType === 'straight' ? chosenNumber : undefined,
          payoutMultiplier: won ? payoutMultiplier : 0,
          colorLabel: winningNumber === 0 ? '🟢 0' : (winningColor === 'red' ? '🔴' : '⚫') + ' ' + winningNumber,
        },
      };
    },
  };
}

module.exports = { createRoulettePlugin };
