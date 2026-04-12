// feed.js — Social Proof Activity Feed
// Maintains a live stream of platform events for the frontend ticker
// "47 people watching" "someone just won 5 ZNN" "new market: will BTC..."
// This is the heartbeat of the platform — makes it feel alive

const crypto = require('crypto');

// ─────────────────────────────────────────
// EVENT TYPES
// ─────────────────────────────────────────

const EVENT = {
  WIN:            'win',            // player won a game
  MARKET_WIN:     'market_win',     // player won a prediction market
  MARKET_OPENED:  'market_opened',  // new market available
  MARKET_CLOSED:  'market_closed',  // market resolved
  POSITION_TAKEN: 'position_taken', // someone took a side on a market
  GAME_PLAYED:    'game_played',    // someone played (won or lost)
  FREE_PLAY:      'free_play',      // someone used daily free play
  MILESTONE:      'milestone',      // platform milestone (volume, users)
};

// Max events to keep in memory
const MAX_EVENTS = 200;
// Max age in ms (6 hours — older events pruned)
const MAX_AGE    = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────
// FEED MANAGER
// ─────────────────────────────────────────

class FeedManager {
  constructor() {
    this.events = [];          // newest first
    this.onlineCount = 0;      // simulated active user count
    this.totalVolume = 0;      // total ZNN wagered all time
    this.totalWins   = 0;
    this.listeners   = [];     // SSE clients waiting for events

    // Simulate realistic online count fluctuation
    this._onlineCountTimer = setInterval(() => this._tickOnlineCount(), 30_000);
    // Cleanup old events
    this._cleanupTimer = setInterval(() => this._cleanup(), 10 * 60 * 1000);
    // Seed with some initial activity to avoid empty feed on first launch
    this._seedInitialActivity();
  }

  // ─── PUSH EVENTS ──────────────────────

  /**
   * Record a game win
   */
  pushWin({ playerAddress, amountZnn, gameId }) {
    this.totalVolume += amountZnn / 10; // bet was 1/10th of payout
    this.totalWins++;
    this._push({
      type: EVENT.WIN,
      text: this._winText(playerAddress, amountZnn, gameId),
      amount: amountZnn,
      game: gameId,
      address: this._shortAddr(playerAddress),
    });
  }

  /**
   * Record a game play (outcome doesn't matter for the feed)
   */
  pushGamePlayed({ playerAddress, betAmount, gameId, won }) {
    this.totalVolume += betAmount;
    if (!won) {
      // Only show losses occasionally to keep feed positive
      if (Math.random() > 0.8) {
        this._push({
          type: EVENT.GAME_PLAYED,
          text: `${this._shortAddr(playerAddress)} played ${this._gameName(gameId)}`,
          address: this._shortAddr(playerAddress),
          game: gameId,
        });
      }
    }
  }

  /**
   * Record a new market opening
   */
  pushMarketOpened({ market }) {
    this._push({
      type: EVENT.MARKET_OPENED,
      text: `📊 New bet: "${this._truncate(market.question, 60)}"`,
      marketId: market.id,
    });
  }

  /**
   * Record a market resolution
   */
  pushMarketClosed({ market }) {
    const outcome = market.outcome === 'yes' ? 'YES ✅' : 'NO ❌';
    this._push({
      type: EVENT.MARKET_CLOSED,
      text: `📊 Resolved ${outcome}: "${this._truncate(market.question, 50)}"`,
      marketId: market.id,
      outcome: market.outcome,
    });
  }

  /**
   * Record someone taking a position on a market
   */
  pushPositionTaken({ playerAddress, side, amountZnn, marketQuestion }) {
    this.totalVolume += amountZnn;
    const sideText = side === 'yes' ? 'YES' : 'NO';
    this._push({
      type: EVENT.POSITION_TAKEN,
      text: `${this._shortAddr(playerAddress)} bet ${amountZnn.toFixed(1)} ZNN on ${sideText} — "${this._truncate(marketQuestion, 45)}"`,
      address: this._shortAddr(playerAddress),
      side,
      amount: amountZnn,
    });
  }

  /**
   * Record a market win payout
   */
  pushMarketWin({ playerAddress, amountZnn, marketQuestion }) {
    this.totalWins++;
    this._push({
      type: EVENT.MARKET_WIN,
      text: `🏆 ${this._shortAddr(playerAddress)} won ${amountZnn.toFixed(2)} ZNN — "${this._truncate(marketQuestion, 40)}"`,
      address: this._shortAddr(playerAddress),
      amount: amountZnn,
    });
  }

  /**
   * Record a free play use
   */
  pushFreePlay({ playerAddress, won, prize }) {
    if (won) {
      this._push({
        type: EVENT.FREE_PLAY,
        text: `🎁 ${this._shortAddr(playerAddress)} won ${prize.toFixed(2)} ZNN on free play!`,
        address: this._shortAddr(playerAddress),
        amount: prize,
      });
    }
  }

  // ─── READ METHODS ─────────────────────

  /**
   * Get recent events for frontend feed
   */
  getRecent(limit = 30) {
    return this.events.slice(0, limit).map(e => ({
      id: e.id,
      type: e.type,
      text: e.text,
      timestamp: e.timestamp,
      age: this._ageText(e.timestamp),
      amount: e.amount || null,
    }));
  }

  /**
   * Get platform stats for the header ticker
   */
  getStats() {
    return {
      onlineCount: this.onlineCount,
      totalVolume: parseFloat(this.totalVolume.toFixed(2)),
      totalWins:   this.totalWins,
      eventCount:  this.events.length,
    };
  }

  /**
   * Register a Server-Sent Events listener
   */
  addListener(res) {
    this.listeners.push(res);
    // Send current state immediately on connect
    this._sendToListener(res, {
      type: 'init',
      events: this.getRecent(20),
      stats: this.getStats(),
    });
  }

  removeListener(res) {
    this.listeners = this.listeners.filter(l => l !== res);
  }

  // ─── INTERNAL ─────────────────────────

  _push(event) {
    const full = {
      id: crypto.randomBytes(4).toString('hex'),
      timestamp: Date.now(),
      ...event,
    };
    this.events.unshift(full); // newest first
    if (this.events.length > MAX_EVENTS) this.events.pop();

    // Push to SSE listeners
    this._broadcast({ type: 'event', event: {
      id: full.id,
      type: full.type,
      text: full.text,
      timestamp: full.timestamp,
      age: 'just now',
      amount: full.amount || null,
    }});
  }

  _broadcast(data) {
    const json = `data: ${JSON.stringify(data)}\n\n`;
    this.listeners = this.listeners.filter(res => {
      try {
        res.write(json);
        return true;
      } catch (_) {
        return false; // remove dead connections
      }
    });
  }

  _sendToListener(res, data) {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  }

  _tickOnlineCount() {
    // Realistic fluctuation: base 3–8, spikes to 15–40 occasionally
    const base = 3 + Math.floor(Math.random() * 6);
    const spike = Math.random() < 0.15 ? Math.floor(Math.random() * 25) : 0;
    this.onlineCount = base + spike;
    this._broadcast({ type: 'stats', stats: this.getStats() });
  }

  _cleanup() {
    const cutoff = Date.now() - MAX_AGE;
    this.events = this.events.filter(e => e.timestamp > cutoff);
  }

  /**
   * Seed with some plausible initial events so the platform doesn't
   * look empty on first launch.
   */
  _seedInitialActivity() {
    const fakeAddresses = [
      'z1qpsjv3wzzuuztdrjy6vvjswwz59t0v0gn8qf9e',
      'z1qqjnwjjpnue8xmmpanz6csze6tcmtzzdtfswpm',
      'z1qq7n4nxhz0y5slx0w36y2qzxcr6j0kkh4asyjd',
      'z1qr8yvqztygj5rknt9xt7xdak3zrjsxr7qw0mzq',
    ];
    const games = ['dice', 'slots', 'shooter'];
    const questions = [
      'Will BTC hold above $95,000 in the next 2 hours?',
      'Will ETH break $3,500 by end of day?',
      'BTC dominance stays above 52% this week.',
    ];

    const now = Date.now();
    const seedEvents = [
      { type: EVENT.WIN, text: `🎲 ${this._shortAddr(fakeAddresses[0])} won 18.00 ZNN on dice`, amount: 18, timestamp: now - 4 * 60_000 },
      { type: EVENT.POSITION_TAKEN, text: `${this._shortAddr(fakeAddresses[1])} bet 2.0 ZNN on YES — "${questions[0]}"`, timestamp: now - 9 * 60_000 },
      { type: EVENT.WIN, text: `🔮 ${this._shortAddr(fakeAddresses[2])} won 45.00 ZNN on slots`, amount: 45, timestamp: now - 17 * 60_000 },
      { type: EVENT.POSITION_TAKEN, text: `${this._shortAddr(fakeAddresses[3])} bet 5.0 ZNN on NO — "${questions[1]}"`, timestamp: now - 23 * 60_000 },
      { type: EVENT.MARKET_OPENED, text: `📊 New bet: "${questions[2]}"`, timestamp: now - 35 * 60_000 },
      { type: EVENT.WIN, text: `🚀 ${this._shortAddr(fakeAddresses[0])} won 90.00 ZNN on shooter`, amount: 90, timestamp: now - 52 * 60_000 },
    ];

    seedEvents.forEach(e => {
      this.events.push({
        id: crypto.randomBytes(4).toString('hex'),
        ...e,
      });
    });

    this.totalVolume = 42.7;
    this.totalWins   = 3;
    this.onlineCount = 4 + Math.floor(Math.random() * 5);
  }

  // ─── TEXT HELPERS ─────────────────────

  _shortAddr(addr) {
    if (!addr) return 'anon';
    return addr.slice(0, 8) + '…' + addr.slice(-4);
  }

  _winText(addr, amount, game) {
    const emoji = amount >= 50 ? '🚀' : amount >= 20 ? '🔥' : amount >= 10 ? '💎' : '🎲';
    return `${emoji} ${this._shortAddr(addr)} won ${amount.toFixed(2)} ZNN on ${this._gameName(game)}`;
  }

  _gameName(gameId) {
    const names = { dice: 'Hash Dice', slots: 'Plasma Slots', shooter: 'Space Shooter' };
    return names[gameId] || gameId;
  }

  _truncate(str, max) {
    return str.length <= max ? str : str.slice(0, max - 1) + '…';
  }

  _ageText(timestamp) {
    const diff = Date.now() - timestamp;
    const s = Math.floor(diff / 1000);
    if (s < 60)   return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)   return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }
}

module.exports = { FeedManager, EVENT };
