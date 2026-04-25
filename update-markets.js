/**
 * Node script to update markets.js with atomic settlement logic
 */
const fs = require('fs');
const path = require('path');

const marketsPath = path.join(__dirname, 'nomgamez-backend', 'markets.js');
let content = fs.readFileSync(marketsPath, 'utf8');

// 1. Add JSDoc to resolveMarket function
const resolveMarketStart = content.indexOf('resolveMarket(marketId, outcome, resolvedBy = \'oracle\') {');
if (resolveMarketStart === -1) {
  console.error('Could not find resolveMarket function');
  process.exit(1);
}

// Find the start of the comment before resolveMarket
const commentStart = content.lastIndexOf('// ─── RESOLVE', resolveMarketStart);
if (commentStart === -1) {
  // Try to find the line before resolveMarket
  const lines = content.slice(0, resolveMarketStart).split('\n');
  let insertLine = lines.length;
  // Add JSDoc before resolveMarket
  const jsdoc = `  /**
   * Resolve a market with a given outcome.
   * Atomic operation: all updates are rolled back if any step fails.
   * Calculates payouts, queues them.
   * outcome: 'yes' | 'no' | 'void'
   * @param {string} marketId - ID of market to resolve
   * @param {string} outcome - Resolution outcome
   * @param {string} resolvedBy - Who/what resolved the market
   * @returns {object} Resolved market object
   */
  `;
  // Insert JSDoc before resolveMarket
  const before = content.slice(0, resolveMarketStart);
  const after = content.slice(resolveMarketStart);
  content = before + jsdoc + after;
  // Update resolveMarketStart since we added JSDoc
  const newResolveStart = content.indexOf('resolveMarket(marketId, outcome, resolvedBy = \'oracle\') {');
  
  // 2. Add state save and try block after initial checks
  // Find the line after the initial checks (market not found, already resolved)
  const initialChecksEnd = content.indexOf("if (market.state === MARKET_STATE.RESOLVED)", newResolveStart);
  const initialChecksLineEnd = content.indexOf('\n', initialChecksEnd) + 1;
  const tryBlock = `
    // Save state for rollback in case of failure
    const originalMarket = JSON.parse(JSON.stringify(market));
    const originalPositions = new Map();
    const positionsToUpdate = this.getMarketPositions(marketId).filter(pos => 
      pos.state === POSITION_STATE.OPEN || pos.state === POSITION_STATE.PENDING_DEPOSIT
    );
    positionsToUpdate.forEach(pos => {
      originalPositions.set(pos.id, JSON.parse(JSON.stringify(pos)));
    });

    try {
  `;
  content = content.slice(0, initialChecksLineEnd) + tryBlock + content.slice(initialChecksLineEnd);
  
  // 3. Find the end of the resolveMarket function and add catch block
  // Find the closing brace of resolveMarket
  let braceCount = 0;
  let inFunction = false;
  let funcEnd = -1;
  for (let i = newResolveStart; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
      inFunction = true;
    } else if (content[i] === '}') {
      braceCount--;
      if (inFunction && braceCount === 0) {
        funcEnd = i;
        break;
      }
    }
  }
  
  if (funcEnd === -1) {
    console.error('Could not find end of resolveMarket function');
    process.exit(1);
  }
  
  // Insert catch block before the closing brace
  const catchBlock = `
    } catch (error) {
      // Rollback all changes
      this.markets.set(marketId, originalMarket);
      originalPositions.forEach((pos, posId) => {
        this.positions.set(posId, pos);
      });
      // Clear any payout queue entries added during the failed attempt
      this.payoutQueue = this.payoutQueue.filter(item => 
        !positionsToUpdate.some(pos => pos.id === item.positionId)
      );
      console.error(\`[market] Failed to resolve \${marketId}, rolled back:\`, error.message);
      throw error; // Re-throw so caller knows resolution failed
    }
  `;
  content = content.slice(0, funcEnd) + catchBlock + content.slice(funcEnd);
}

// Write updated content back
fs.writeFileSync(marketsPath, content, 'utf8');
console.log('Successfully updated markets.js with atomic settlement logic');
