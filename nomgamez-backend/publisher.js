// publisher.js — Social Publisher
// Posts to Twitter/X and Telegram on behalf of the bot
// Handles: new markets, resolutions, big wins, daily recaps

// ─────────────────────────────────────────
// DEPENDENCIES (optional — graceful no-op if not installed)
// ─────────────────────────────────────────
// Twitter: npm install twitter-api-v2
// Telegram: npm install node-telegram-bot-api

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────

const PUBLISHER_CONFIG = {
  // Twitter/X — set in .env
  TWITTER_API_KEY:        process.env.TWITTER_API_KEY,
  TWITTER_API_SECRET:     process.env.TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN:   process.env.TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET:  process.env.TWITTER_ACCESS_SECRET,
  // Telegram — set in .env
  TELEGRAM_BOT_TOKEN:     process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID:    process.env.TELEGRAM_CHANNEL_ID,
  // Platform URL — linked in every post
  PLATFORM_URL:           process.env.PLATFORM_URL || 'https://nomgamez.io',
  // Only announce wins above this threshold (avoid spam)
  WIN_ANNOUNCE_MIN_ZNN:   parseFloat(process.env.WIN_ANNOUNCE_MIN || '2'),
  // Rate limiting: min ms between posts per channel
  RATE_LIMIT_MS:          60 * 1000, // 1 post per minute max
};

// ─────────────────────────────────────────
// PUBLISHER CLASS
// ─────────────────────────────────────────

class Publisher {
  constructor(config = {}) {
    this.config   = { ...PUBLISHER_CONFIG, ...config };
    this.twitter  = null;
    this.telegram = null;
    this.lastPost = { twitter: 0, telegram: 0 };
    this.queue    = [];        // pending posts
    this.enabled  = { twitter: false, telegram: false };
    this._init();
  }

  _init() {
    // Try to initialise Twitter
    try {
      const { TwitterApi } = require('twitter-api-v2');
      if (
        this.config.TWITTER_API_KEY &&
        this.config.TWITTER_API_SECRET &&
        this.config.TWITTER_ACCESS_TOKEN &&
        this.config.TWITTER_ACCESS_SECRET
      ) {
        this.twitter = new TwitterApi({
          appKey:    this.config.TWITTER_API_KEY,
          appSecret: this.config.TWITTER_API_SECRET,
          accessToken:  this.config.TWITTER_ACCESS_TOKEN,
          accessSecret: this.config.TWITTER_ACCESS_SECRET,
        });
        this.enabled.twitter = true;
        console.log('[publisher] Twitter connected ✓');
      } else {
        console.log('[publisher] Twitter keys not set — tweets disabled');
      }
    } catch (_) {
      console.log('[publisher] twitter-api-v2 not installed — run: npm install twitter-api-v2');
    }

    // Try to initialise Telegram
    try {
      const TelegramBot = require('node-telegram-bot-api');
      if (this.config.TELEGRAM_BOT_TOKEN && this.config.TELEGRAM_CHANNEL_ID) {
        this.telegram = new TelegramBot(this.config.TELEGRAM_BOT_TOKEN);
        this.enabled.telegram = true;
        console.log('[publisher] Telegram connected ✓');
      } else {
        console.log('[publisher] Telegram keys not set — Telegram disabled');
      }
    } catch (_) {
      console.log('[publisher] node-telegram-bot-api not installed — run: npm install node-telegram-bot-api');
    }
  }

  // ─── POST METHODS ─────────────────────

  /**
   * Publish a new market opening to all channels
   */
  async publishNewMarket(market) {
    const url  = `${this.config.PLATFORM_URL}/#market-${market.id}`;
    const odds = market.yesPool > 0 || market.noPool > 0
      ? ` YES ${market.yesOdds || 50}% | NO ${market.noOdds || 50}%`
      : '';

    const timeLeft = formatTimeLeft(market.resolvesAt - Date.now());

    const text = [
      `🎲 New bet open on NOM-GAMEZ`,
      ``,
      `${market.question}`,
      ``,
      `⏳ Closes in ${timeLeft}${odds}`,
      `💰 Min bet: 0.1 ZNN | BTC accepted`,
      ``,
      `Take a side 👇`,
      url,
    ].join('\n');

    await this._post(text, { type: 'market', id: market.id });
  }

  /**
   * Publish market resolution
   */
  async publishResolution(market, customText = null) {
    const url = `${this.config.PLATFORM_URL}/#market-${market.id}`;
    const outcome = market.outcome === 'yes' ? '✅ YES' : '❌ NO';
    const text = customText || [
      `📊 Market resolved: ${outcome}`,
      ``,
      `"${market.question}"`,
      ``,
      `Pool: ${market.totalPool?.toFixed(2) || '0'} ZNN`,
      url,
    ].join('\n');

    await this._post(text, { type: 'resolution', id: market.id });
  }

  /**
   * Publish a win announcement
   */
  async publishWin(winText, amountZnn) {
    if (amountZnn < this.config.WIN_ANNOUNCE_MIN_ZNN) return; // don't spam small wins

    const text = [
      winText,
      ``,
      `🎮 Play at: ${this.config.PLATFORM_URL}`,
    ].join('\n');

    await this._post(text, { type: 'win' });
  }

  /**
   * Publish a daily recap
   */
  async publishDailyRecap({ totalVolume, totalWins, biggestWin, marketsResolved }) {
    const text = [
      `📈 NOM-GAMEZ Daily Recap`,
      ``,
      `💰 Volume: ${totalVolume.toFixed(1)} ZNN`,
      `🏆 Winners: ${totalWins}`,
      biggestWin ? `🚀 Biggest win: ${biggestWin.toFixed(2)} ZNN` : null,
      `📊 Markets resolved: ${marketsResolved}`,
      ``,
      `New bets opening daily. Powered by Zenon Network.`,
      this.config.PLATFORM_URL,
    ].filter(Boolean).join('\n');

    await this._post(text, { type: 'recap' });
  }

  /**
   * Publish a reactive alert (price move detected)
   */
  async publishAlert(asset, changePercent, direction) {
    const emoji = direction === 'up' ? '📈' : '📉';
    const text = [
      `${emoji} ${asset} just moved ${Math.abs(changePercent).toFixed(1)}% ${direction}`,
      ``,
      `New recovery/momentum bet just opened on NOM-GAMEZ 👇`,
      this.config.PLATFORM_URL,
    ].join('\n');

    await this._post(text, { type: 'alert' });
  }

  // ─── INTERNAL ─────────────────────────

  async _post(text, meta = {}) {
    const results = { twitter: null, telegram: null };

    // Twitter
    if (this.enabled.twitter) {
      const now = Date.now();
      if (now - this.lastPost.twitter >= this.config.RATE_LIMIT_MS) {
        try {
          const tweet = await this.twitter.v2.tweet(text.slice(0, 280));
          this.lastPost.twitter = now;
          results.twitter = tweet.data?.id;
          console.log(`[publisher] Tweeted — id: ${tweet.data?.id} | type: ${meta.type}`);
        } catch (err) {
          console.error('[publisher] Tweet failed:', err.message);
          results.twitter = { error: err.message };
        }
      } else {
        // Queue it for later
        this.queue.push({ text, meta, channels: ['twitter'], scheduledAt: this.lastPost.twitter + this.config.RATE_LIMIT_MS });
        console.log(`[publisher] Tweet queued (rate limited)`);
      }
    }

    // Telegram
    if (this.enabled.telegram) {
      const now = Date.now();
      if (now - this.lastPost.telegram >= this.config.RATE_LIMIT_MS / 2) {
        try {
          const msg = await this.telegram.sendMessage(
            this.config.TELEGRAM_CHANNEL_ID,
            text,
            { parse_mode: 'HTML', disable_web_page_preview: false }
          );
          this.lastPost.telegram = now;
          results.telegram = msg.message_id;
          console.log(`[publisher] Telegram sent — msg: ${msg.message_id} | type: ${meta.type}`);
        } catch (err) {
          console.error('[publisher] Telegram failed:', err.message);
          results.telegram = { error: err.message };
        }
      } else {
        this.queue.push({ text, meta, channels: ['telegram'], scheduledAt: this.lastPost.telegram + this.config.RATE_LIMIT_MS / 2 });
      }
    }

    // Log even if no channels active (useful for testing)
    if (!this.enabled.twitter && !this.enabled.telegram) {
      console.log(`[publisher] (dry run) Would post:\n${text}\n`);
    }

    return results;
  }

  /**
   * Process queued posts (call this on an interval)
   */
  async flushQueue() {
    const now = Date.now();
    const due  = this.queue.filter(p => p.scheduledAt <= now);
    this.queue  = this.queue.filter(p => p.scheduledAt > now);

    for (const item of due) {
      await this._post(item.text, item.meta);
    }
  }

  /**
   * Status report
   */
  status() {
    return {
      twitter:  this.enabled.twitter,
      telegram: this.enabled.telegram,
      queued:   this.queue.length,
    };
  }
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function formatTimeLeft(ms) {
  if (ms <= 0) return 'closing';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h/24)}d ${h % 24}h`;
  if (h > 0)   return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = { Publisher, PUBLISHER_CONFIG };
