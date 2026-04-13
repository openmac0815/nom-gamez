// bot.js — Autonomous Platform Agent v2
// Reads live config, checks platform health before acting,
// logs every action with outcome, rebalances market weights from engagement data

const { getMarketSnapshot, calcPriceChange, getPrice, getBtcDominance } = require('./oracle');
const { generateShareText } = require('./markets');
const { config } = require('./config');

// BOT_CONFIG is now a live read from config.js — no hardcoded constants
// Kept as a thin accessor for legacy callers
const BOT_CONFIG = {
  get RESEARCH_INTERVAL()   { return config.get('bot.researchIntervalMs'); },
  get RESOLUTION_INTERVAL() { return config.get('bot.resolutionIntervalMs'); },
  get PRICE_MOVE_THRESHOLD(){ return config.get('bot.priceMoveThresholdPct'); },
  get MAX_OPEN_MARKETS()    { return config.get('market.maxOpenMarkets'); },
  get MARKETS_PER_CYCLE()   { return config.get('market.marketsPerCycle'); },
  get DURATIONS()           { return config.get('bot.durations'); },
};

// ─────────────────────────────────────────
// MARKET IDEA GENERATOR
// ─────────────────────────────────────────

/**
 * Given a market snapshot, generate a list of interesting market ideas.
 * The bot picks from this list based on current conditions.
 * Each idea maps directly to MarketManager.createMarket() params.
 */
function generateMarketIdeas(snapshot, previousSnapshot) {
  const ideas = [];
  const now = Date.now();
  const { prices, btcDominance } = snapshot;

  // ── PRICE ACTION MARKETS ──────────────────

  // BTC above/below current price (short and medium term)
  if (prices.BTC) {
    const btc = prices.BTC;

    // Near-term: will BTC hold current level in 2h?
    ideas.push({
      score: 70,
      question: `Will BTC hold above $${roundPrice(btc * 0.98)} in the next 2 hours?`,
      description: `BTC is currently at $${btc.toLocaleString()}. Will it stay above the ${(-2).toFixed(0)}% level?`,
      category: 'price',
      type: 'price_above',
      resolvesAt: now + BOT_CONFIG.DURATIONS.short,
      tags: ['BTC', 'price', 'short-term'],
      resolutionData: { asset: 'BTC', targetPrice: roundPrice(btc * 0.98), baselinePrice: btc },
    });

    // Medium: classic ATH approach / key level
    const nearRound = getNearestRoundLevel(btc);
    if (nearRound) {
      ideas.push({
        score: 65,
        question: `Will BTC break $${nearRound.toLocaleString()} by tomorrow?`,
        description: `BTC is ${((btc / nearRound - 1) * 100).toFixed(1)}% away from $${nearRound.toLocaleString()}.`,
        category: 'price',
        type: 'price_above',
        resolvesAt: now + BOT_CONFIG.DURATIONS.medium,
        tags: ['BTC', 'price', 'key-level'],
        resolutionData: { asset: 'BTC', targetPrice: nearRound, baselinePrice: btc },
      });
    }

    // React to significant price moves
    if (previousSnapshot?.prices?.BTC) {
      const change = calcPriceChange(btc, previousSnapshot.prices.BTC);
      if (change <= -BOT_CONFIG.PRICE_MOVE_THRESHOLD) {
        // Drop detected — will it recover?
        ideas.push({
          score: 90, // High score — reactive markets get posted fast
          question: `BTC just dropped ${Math.abs(change).toFixed(1)}% — will it recover within 4 hours?`,
          description: `BTC fell from $${previousSnapshot.prices.BTC.toLocaleString()} to $${btc.toLocaleString()}. Recovery bet.`,
          category: 'price',
          type: 'price_recovery',
          resolvesAt: now + BOT_CONFIG.DURATIONS.short * 2, // 4h
          tags: ['BTC', 'price', 'recovery', 'volatile'],
          resolutionData: { asset: 'BTC', baselinePrice: previousSnapshot.prices.BTC },
        });
      }
      if (change >= BOT_CONFIG.PRICE_MOVE_THRESHOLD) {
        // Pump detected — will it continue?
        ideas.push({
          score: 88,
          question: `BTC just pumped ${change.toFixed(1)}% — will it gain another ${(change * 0.5).toFixed(1)}% in the next 4 hours?`,
          description: `BTC momentum play. Current: $${btc.toLocaleString()}.`,
          category: 'price',
          type: 'price_above',
          resolvesAt: now + BOT_CONFIG.DURATIONS.short * 2,
          tags: ['BTC', 'price', 'momentum', 'volatile'],
          resolutionData: { asset: 'BTC', targetPrice: roundPrice(btc * (1 + change * 0.005)), baselinePrice: btc },
        });
      }
    }
  }

  // ETH price markets
  if (prices.ETH) {
    const eth = prices.ETH;
    const nearRound = getNearestRoundLevel(eth);

    ideas.push({
      score: 60,
      question: `Will ETH be above $${roundPrice(eth * 1.03)} by end of day?`,
      description: `ETH at $${eth.toLocaleString()}. Targeting 3% up.`,
      category: 'price',
      type: 'price_above',
      resolvesAt: now + BOT_CONFIG.DURATIONS.medium,
      tags: ['ETH', 'price'],
      resolutionData: { asset: 'ETH', targetPrice: roundPrice(eth * 1.03), baselinePrice: eth },
    });

    if (nearRound) {
      ideas.push({
        score: 58,
        question: `Will ETH break $${nearRound.toLocaleString()} this week?`,
        description: `ETH is ${((eth / nearRound - 1) * 100).toFixed(1)}% from $${nearRound.toLocaleString()}.`,
        category: 'price',
        type: 'price_above',
        resolvesAt: now + BOT_CONFIG.DURATIONS.long,
        tags: ['ETH', 'price', 'key-level'],
        resolutionData: { asset: 'ETH', targetPrice: nearRound, baselinePrice: eth },
      });
    }
  }

  // ── MACRO MARKETS ─────────────────────────

  if (btcDominance) {
    const dom = btcDominance;
    ideas.push({
      score: 62,
      question: `Will BTC dominance stay above ${Math.floor(dom)}% by end of week?`,
      description: `BTC dominance currently at ${dom.toFixed(1)}%.`,
      category: 'macro',
      type: 'btc_dominance',
      resolvesAt: now + BOT_CONFIG.DURATIONS.long,
      tags: ['BTC', 'dominance', 'macro'],
      resolutionData: { direction: 'above', threshold: Math.floor(dom) },
    });

    if (dom > 55) {
      ideas.push({
        score: 55,
        question: `Is the altcoin season over? BTC dominance stays above 55% this week.`,
        description: `BTC dominance at ${dom.toFixed(1)}%. Season indicator.`,
        category: 'macro',
        type: 'btc_dominance',
        resolvesAt: now + BOT_CONFIG.DURATIONS.long,
        tags: ['dominance', 'altseason', 'macro'],
        resolutionData: { direction: 'above', threshold: 55 },
      });
    } else if (dom < 45) {
      ideas.push({
        score: 55,
        question: `Altcoin season incoming? BTC dominance drops below 45% this week.`,
        description: `BTC dominance at ${dom.toFixed(1)}%. Altseason watch.`,
        category: 'macro',
        type: 'btc_dominance',
        resolvesAt: now + BOT_CONFIG.DURATIONS.long,
        tags: ['dominance', 'altseason', 'macro'],
        resolutionData: { direction: 'below', threshold: 45 },
      });
    }
  }

  // Sort by score descending — most interesting first
  return ideas.sort((a, b) => b.score - a.score);
}

/**
 * Generate a post-resolution recap text for social sharing
 */
function generateResolutionText(market) {
  const outcome = market.outcome === 'yes' ? '✅ YES' : '❌ NO';
  const pool = market.totalPool.toFixed(2);
  const winners = market.positionCount > 0 ? market.positionCount : '—';
  return `📊 Market resolved: ${outcome}\n\n"${market.question}"\n\nTotal pot: ${pool} ZNN | ${winners} bets placed.`;
}

/**
 * Generate a win announcement for a player payout
 */
function generateWinText(playerAddress, amountZnn, gameOrMarket) {
  const short = playerAddress.slice(0, 8) + '…' + playerAddress.slice(-4);
  const emoji = amountZnn >= 10 ? '🚀' : amountZnn >= 5 ? '🔥' : '🎲';
  return `${emoji} ${short} just won ${amountZnn.toFixed(2)} ZNN on ${gameOrMarket}`;
}

// ─────────────────────────────────────────
// BOT RUNNER
// ─────────────────────────────────────────

class BotAgent {
  constructor({ marketManager, publisher, adminController = null }) {
    this.markets   = marketManager;
    this.publisher = publisher;
    this.admin     = adminController;   // health checks, action logging, weight rebalancing

    this.lastSnapshot    = null;
    this.researchTimer   = null;
    this.resolutionTimer = null;
    this.running         = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[bot] Agent started');

    // Run research immediately on start, then on interval
    this.runResearch();
    this.researchTimer   = setInterval(() => this.runResearch(),   BOT_CONFIG.RESEARCH_INTERVAL);
    this.resolutionTimer = setInterval(() => this.runResolution(), BOT_CONFIG.RESOLUTION_INTERVAL);
  }

  stop() {
    this.running = false;
    clearInterval(this.researchTimer);
    clearInterval(this.resolutionTimer);
    console.log('[bot] Agent stopped');
  }

  // ─── RESEARCH CYCLE ───────────────────

  async runResearch() {
    console.log('[bot] Research cycle started');
    const cycleStart = Date.now();

    try {
      // ── Health gate: skip if oracle is down ──────────────────
      if (this.admin && !this.admin.isSafeToCreateMarkets()) {
        const reason = this.admin.treasury?.halts?.bot?.active
          ? `treasury halt: ${this.admin.treasury.halts.bot.reason || 'risk detected'}`
          : 'platform health not safe for market creation';
        console.warn(`[bot] Market creation blocked — ${reason}`);
        this.admin.alerts.raise(
          'BOT_RESEARCH_FAILED', 'warning',
          `Research skipped: ${reason}`
        );
        return;
      }

      const snapshot = await getMarketSnapshot();
      const ideas    = generateMarketIdeas(snapshot, this.lastSnapshot);

      // Check how many open markets we already have
      const stats          = this.markets.stats();
      const slotsAvailable = BOT_CONFIG.MAX_OPEN_MARKETS - stats.open;
      if (slotsAvailable <= 0) {
        console.log(`[bot] Market cap reached (${stats.open}/${BOT_CONFIG.MAX_OPEN_MARKETS}), skipping`);
        this.lastSnapshot = snapshot;
        return;
      }

      const toCreate = ideas.slice(0, Math.min(slotsAvailable, BOT_CONFIG.MARKETS_PER_CYCLE));
      const created  = [];

      for (const idea of toCreate) {
        const t0 = Date.now();
        try {
          const market = this.markets.createMarket(idea);
          created.push(market);
          console.log(`[bot] Created market: ${market.id} — ${market.question.slice(0, 60)}`);

          if (this.admin) {
            this.admin.engagement.trackMarketCreated(market);
            this.admin.recordBotAction({
              action:     'market_created',
              params:     { id: market.id, type: market.type, question: market.question.slice(0, 60) },
              success:    true,
              result:     { marketId: market.id },
              durationMs: Date.now() - t0,
            });
          }
        } catch (err) {
          console.error('[bot] Failed to create market:', err.message);
          if (this.admin) {
            this.admin.recordBotAction({
              action:  'market_created',
              params:  { type: idea.type, question: idea.question?.slice(0, 60) },
              success: false,
              error:   err.message,
            });
          }
        }
      }

      // Publish new markets to social
      if (created.length > 0 && this.publisher) {
        // Stagger posts by 30s to avoid spam
        created.forEach((market, i) => {
          setTimeout(() => this.publisher.publishNewMarket(market), i * 30_000);
        });
      }

      // ── Rebalance market weights from engagement data ────────
      if (this.admin && created.length > 0) {
        this.admin.rebalanceMarketWeights();
      }

      // Clear any prior research-failed alert
      if (this.admin) {
        this.admin.alerts.resolve('BOT_RESEARCH_FAILED', 'Research cycle completed successfully');
      }

      this.lastSnapshot = snapshot;
      console.log(`[bot] Research done — created ${created.length} markets in ${Date.now() - cycleStart}ms`);

    } catch (err) {
      console.error('[bot] Research cycle error:', err.message);
      if (this.admin) {
        this.admin.alerts.raise(
          'BOT_RESEARCH_FAILED', 'warning',
          `Research cycle error: ${err.message}`
        );
        this.admin.recordBotAction({
          action:  'research_cycle',
          params:  {},
          success: false,
          error:   err.message,
        });
      }
    }
  }

  // ─── RESOLUTION CYCLE ─────────────────

  async runResolution() {
    try {
      // Lock markets past deadline
      const toLock = this.markets.getDueForLocking();
      for (const market of toLock) {
        this.markets.lockMarket(market.id);
        console.log(`[bot] Locked market: ${market.id}`);
      }

      // Resolve locked markets
      const { resolveMarket: oracleResolve } = require('./oracle');
      const toResolve = this.markets.getDueForResolution();

      for (const market of toResolve) {
        const t0 = Date.now();
        try {
          const outcome = await oracleResolve(market);
          this.markets.resolveMarket(market.id, outcome, 'oracle');
          console.log(`[bot] Resolved ${market.id} → ${outcome}`);

          if (this.admin) {
            this.admin.recordBotAction({
              action:     'market_resolved',
              params:     { marketId: market.id, type: market.type },
              success:    true,
              result:     { outcome },
              durationMs: Date.now() - t0,
            });
            // Mark any stuck-market alert resolved
            this.admin.alerts.resolve('MARKET_STUCK', `Market ${market.id} resolved`);
          }

          // Announce resolution on social
          if (this.publisher && outcome !== 'void') {
            const text = generateResolutionText({ ...market, outcome });
            await this.publisher.publishResolution(market, text);
          }
        } catch (err) {
          console.error(`[bot] Resolution error for ${market.id}:`, err.message);
          if (this.admin) {
            this.admin.recordBotAction({
              action:  'market_resolved',
              params:  { marketId: market.id },
              success: false,
              error:   err.message,
            });
            this.admin.alerts.raise(
              'MARKET_STUCK', 'warning',
              `Market ${market.id} failed to resolve: ${err.message}`,
              { marketId: market.id }
            );
          }
        }
      }
    } catch (err) {
      console.error('[bot] Resolution cycle error:', err.message);
    }
  }

  // ─── REACTIVE EVENTS ──────────────────

  /**
   * Called externally when a player wins — bot announces it
   */
  async announceWin(playerAddress, amountZnn, context) {
    if (!this.publisher) return;
    const text = generateWinText(playerAddress, amountZnn, context);
    try {
      await this.publisher.publishWin(text, amountZnn);
      if (this.admin) {
        this.admin.recordBotAction({
          action:  'win_announced',
          params:  { amountZnn, context },
          success: true,
        });
      }
    } catch (err) {
      console.error('[bot] announceWin error:', err.message);
      if (this.admin) {
        this.admin.recordBotAction({
          action:  'win_announced',
          params:  { amountZnn, context },
          success: false,
          error:   err.message,
        });
        this.admin.alerts.raise(
          'PUBLISHER_FAILING', 'warning',
          `Publisher error: ${err.message}`
        );
      }
    }
  }

  /**
   * Force an immediate research cycle (e.g. triggered by large price move)
   */
  async triggerResearch() {
    await this.runResearch();
  }
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Round a price to a reasonable display value
 */
function roundPrice(price) {
  if (price >= 10000) return Math.round(price / 100) * 100;
  if (price >= 1000)  return Math.round(price / 10) * 10;
  if (price >= 100)   return Math.round(price);
  if (price >= 10)    return parseFloat(price.toFixed(1));
  return parseFloat(price.toFixed(2));
}

/**
 * Find the nearest psychologically significant round number
 * e.g. BTC at $98,234 → nearest is $100,000
 */
function getNearestRoundLevel(price) {
  const levels = [];
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));

  for (const mult of [1, 1.5, 2, 2.5, 5, 7.5, 10]) {
    const level = magnitude * mult;
    if (level > price * 0.90 && level < price * 1.20) {
      levels.push(level);
    }
  }

  // Return closest above current price (next resistance level)
  const above = levels.filter(l => l > price).sort((a, b) => a - b);
  return above[0] ? roundPrice(above[0]) : null;
}

module.exports = {
  BotAgent,
  generateMarketIdeas,
  generateResolutionText,
  generateWinText,
  BOT_CONFIG,
};
