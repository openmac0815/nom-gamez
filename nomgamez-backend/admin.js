// admin.js — Platform Operations Layer
// Everything the bot needs to run, monitor, and change the platform
// Exposes structured metrics, alerts, action logs, health checks
// The bot calls these before every action — no more flying blind

const { config } = require('./config');

// ─────────────────────────────────────────────────────────────
// ALERT SYSTEM
// Structured events the bot reads from GET /admin/alerts
// Not logs — machine-readable state objects
// ─────────────────────────────────────────────────────────────

const ALERT_SEVERITY = {
  INFO:     'info',
  WARN:     'warn',
  CRITICAL: 'critical',
};

const ALERT_TYPE = {
  PAYOUT_FAILURE:       'payout_failure',
  PAYOUT_CIRCUIT_OPEN:  'payout_circuit_open',
  ORACLE_DOWN:          'oracle_down',
  ORACLE_DEGRADED:      'oracle_degraded',
  EXPLORER_DOWN:        'explorer_down',
  SESSION_BACKLOG:      'session_backlog',
  MARKET_STUCK:         'market_stuck',
  QUEUE_OVERFLOW:       'queue_overflow',
  NODE_DISCONNECT:      'node_disconnect',
  FREE_PLAY_POOL_LOW:   'free_play_pool_low',
  BOT_RESEARCH_FAILED:  'bot_research_failed',
  PUBLISHER_FAILING:    'publisher_failing',
};

class AlertManager {
  constructor() {
    this.alerts  = [];     // active alerts (auto-resolved when condition clears)
    this.history = [];     // last 500 alert events (raised + resolved)
    this.MAX_ACTIVE  = 100;
    this.MAX_HISTORY = 500;
    this._persist = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  raise(type, severity, message, data = {}) {
    // Deduplicate — don't spam same alert type
    const existing = this.alerts.find(a => a.type === type && !a.resolved);
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
      existing.data     = { ...existing.data, ...data };
      return existing;
    }

    const alert = {
      id:        randomId(),
      type,
      severity,
      message,
      data,
      raisedAt:  Date.now(),
      lastSeen:  Date.now(),
      resolved:  false,
      resolvedAt: null,
      count:     1,
    };

    this.alerts.unshift(alert);
    this.history.unshift({ ...alert, event: 'raised' });
    if (this.alerts.length  > this.MAX_ACTIVE)  this.alerts.pop();
    if (this.history.length > this.MAX_HISTORY) this.history.pop();

    console.log(`[ALERT][${severity.toUpperCase()}] ${type}: ${message}`);
    this._persist?.();
    return alert;
  }

  resolve(type, message = 'Resolved') {
    const alert = this.alerts.find(a => a.type === type && !a.resolved);
    if (!alert) return;
    alert.resolved   = true;
    alert.resolvedAt = Date.now();
    this.history.unshift({ ...alert, event: 'resolved', resolveMessage: message });
    if (this.history.length > this.MAX_HISTORY) this.history.pop();
    console.log(`[alert] Resolved: ${type} — ${message}`);
    this._persist?.();
    return alert;
  }

  getActive(severity = null) {
    const active = this.alerts.filter(a => !a.resolved);
    return severity ? active.filter(a => a.severity === severity) : active;
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }

  hasCritical() {
    return this.alerts.some(a => !a.resolved && a.severity === ALERT_SEVERITY.CRITICAL);
  }

  hasType(type) {
    return this.alerts.some(a => a.type === type && !a.resolved);
  }

  clearAll() {
    this.alerts.forEach(a => { if (!a.resolved) a.resolved = true; a.resolvedAt = Date.now(); });
    this._persist?.();
  }

  exportState() {
    return {
      alerts: this.alerts.slice(),
      history: this.history.slice(),
    };
  }

  importState(state = {}) {
    this.alerts = state.alerts || [];
    this.history = state.history || [];
  }
}

// ─────────────────────────────────────────────────────────────
// BOT ACTION LOG
// Every bot action recorded with outcome — queryable by bot for self-review
// ─────────────────────────────────────────────────────────────

class BotActionLog {
  constructor() {
    this.log = [];
    this.MAX = 500;
    this._persist = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  record({ action, params = {}, success, result = null, error = null, durationMs = 0 }) {
    const entry = {
      id:         randomId(),
      ts:         Date.now(),
      action,
      params,
      success:    !!success,
      result,
      error:      error ? String(error) : null,
      durationMs,
    };
    this.log.unshift(entry);
    if (this.log.length > this.MAX) this.log.pop();
    this._persist?.();
    return entry;
  }

  getRecent(limit = 50, actionFilter = null) {
    const entries = actionFilter
      ? this.log.filter(e => e.action === actionFilter)
      : this.log;
    return entries.slice(0, limit);
  }

  // Success rate for a given action over last N entries
  successRate(action, last = 20) {
    const entries = this.log.filter(e => e.action === action).slice(0, last);
    if (!entries.length) return null;
    const wins = entries.filter(e => e.success).length;
    return parseFloat((wins / entries.length * 100).toFixed(1));
  }

  // Average duration for an action (to detect slowdowns)
  avgDuration(action, last = 20) {
    const entries = this.log.filter(e => e.action === action && e.durationMs > 0).slice(0, last);
    if (!entries.length) return null;
    return Math.round(entries.reduce((sum, e) => sum + e.durationMs, 0) / entries.length);
  }

  summary() {
    const actions = [...new Set(this.log.map(e => e.action))];
    return actions.map(a => ({
      action:      a,
      successRate: this.successRate(a),
      avgDurationMs: this.avgDuration(a),
      totalCalls:  this.log.filter(e => e.action === a).length,
    }));
  }

  exportState() {
    return { log: this.log.slice() };
  }

  importState(state = {}) {
    this.log = state.log || [];
  }
}

// ─────────────────────────────────────────────────────────────
// ENGAGEMENT TRACKER
// Tracks which market types, games, and features drive real activity
// Bot uses this to re-weight market creation
// ─────────────────────────────────────────────────────────────

class EngagementTracker {
  constructor() {
    // marketId → { positionCount, totalVolumeZnn, createdAt, type, firstPositionMs }
    this.markets  = new Map();
    // gameId → { plays, wins, totalBetZnn, totalPayoutZnn }
    this.games    = new Map();
    // marketType → { created, positionsTaken, totalVolumeZnn, avgPositionsPerMarket }
    this.byType   = new Map();
    // hourly play counts for detecting activity patterns
    this.hourlyPlays = new Array(24).fill(0);
    this._persist = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  trackMarketCreated(market) {
    this.markets.set(market.id, {
      positionCount:  0,
      totalVolumeZnn: 0,
      createdAt:      Date.now(),
      type:           market.type,
      firstPositionMs: null,
    });

    const bt = this.byType.get(market.type) || { created:0, positionsTaken:0, totalVolumeZnn:0 };
    bt.created++;
    this.byType.set(market.type, bt);
    this._persist?.();
  }

  trackPositionTaken(marketId, amountZnn, marketType) {
    const m = this.markets.get(marketId);
    if (m) {
      if (m.positionCount === 0) m.firstPositionMs = Date.now() - m.createdAt;
      m.positionCount++;
      m.totalVolumeZnn += amountZnn;
    }

    const bt = this.byType.get(marketType) || { created:0, positionsTaken:0, totalVolumeZnn:0 };
    bt.positionsTaken++;
    bt.totalVolumeZnn += amountZnn;
    this.byType.set(marketType, bt);
    this._persist?.();
  }

  trackGamePlayed(gameId, betZnn, won, payoutZnn = 0) {
    const g = this.games.get(gameId) || { plays:0, wins:0, totalBetZnn:0, totalPayoutZnn:0 };
    g.plays++;
    if (won) g.wins++;
    g.totalBetZnn    += betZnn;
    g.totalPayoutZnn += payoutZnn;
    this.games.set(gameId, g);

    const hour = new Date().getHours();
    this.hourlyPlays[hour]++;
    this._persist?.();
  }

  // Return engagement stats per market type — used by bot to re-weight
  getMarketTypePerformance() {
    const result = [];
    for (const [type, data] of this.byType) {
      const avgPositions = data.created > 0
        ? parseFloat((data.positionsTaken / data.created).toFixed(2))
        : 0;
      result.push({
        type,
        created:         data.created,
        positionsTaken:  data.positionsTaken,
        totalVolumeZnn:  parseFloat(data.totalVolumeZnn.toFixed(4)),
        avgPositionsPerMarket: avgPositions,
        currentWeight:   config.get(`bot.marketWeights.${type}`) || 50,
      });
    }
    return result.sort((a, b) => b.avgPositionsPerMarket - a.avgPositionsPerMarket);
  }

  getGameStats() {
    const result = [];
    for (const [gameId, data] of this.games) {
      result.push({
        gameId,
        ...data,
        winRate:    data.plays > 0 ? parseFloat((data.wins/data.plays*100).toFixed(1)) : null,
        netPnlZnn:  parseFloat((data.totalBetZnn - data.totalPayoutZnn).toFixed(4)),
      });
    }
    return result;
  }

  // Peak hour detection — bot can schedule research around this
  getPeakHours() {
    const max = Math.max(...this.hourlyPlays);
    return this.hourlyPlays
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  exportState() {
    return {
      markets: Array.from(this.markets.entries()),
      games: Array.from(this.games.entries()),
      byType: Array.from(this.byType.entries()),
      hourlyPlays: this.hourlyPlays.slice(),
    };
  }

  importState(state = {}) {
    this.markets = new Map(state.markets || []);
    this.games = new Map(state.games || []);
    this.byType = new Map(state.byType || []);
    this.hourlyPlays = Array.isArray(state.hourlyPlays) ? state.hourlyPlays.slice(0, 24) : new Array(24).fill(0);
    while (this.hourlyPlays.length < 24) this.hourlyPlays.push(0);
  }
}

// ─────────────────────────────────────────────────────────────
// HEALTH MONITOR
// Tracks connectivity and health of external dependencies
// Sets alerts when things break, clears them when they recover
// ─────────────────────────────────────────────────────────────

class HealthMonitor {
  constructor(alertManager) {
    this.alerts     = alertManager;
    this.checks     = {
      oracle:         { ok: true, consecutiveFails: 0, lastCheck: null, lastError: null },
      explorer:       { ok: true, consecutiveFails: 0, lastCheck: null, lastError: null },
      zenonNode:      { ok: true, consecutiveFails: 0, lastCheck: null, lastError: null },
      payoutWorker:   { ok: true, consecutiveFails: 0, lastCheck: null, lastError: null },
    };
    this._persist = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  recordSuccess(service) {
    const c = this.checks[service];
    if (!c) return;
    c.consecutiveFails = 0;
    c.lastCheck        = Date.now();
    if (!c.ok) {
      c.ok = true;
      // Clear the corresponding alert
      const alertMap = {
        oracle:   ALERT_TYPE.ORACLE_DOWN,
        explorer: ALERT_TYPE.EXPLORER_DOWN,
        zenonNode: ALERT_TYPE.NODE_DISCONNECT,
      };
      if (alertMap[service]) this.alerts.resolve(alertMap[service], `${service} recovered`);
    }
    this._persist?.();
  }

  recordFailure(service, error) {
    const c = this.checks[service];
    if (!c) return;
    c.consecutiveFails++;
    c.lastCheck = Date.now();
    c.lastError = String(error);

    const threshold = config.get('oracle.failureThreshold') || 3;
    if (c.consecutiveFails >= threshold) {
      c.ok = false;
      const alertMap = {
        oracle:   [ALERT_TYPE.ORACLE_DOWN,       ALERT_SEVERITY.CRITICAL, `Oracle API down — ${c.consecutiveFails} consecutive failures`],
        explorer: [ALERT_TYPE.EXPLORER_DOWN,      ALERT_SEVERITY.CRITICAL, `ZenonHub explorer unreachable — deposits cannot be verified`],
        zenonNode:[ALERT_TYPE.NODE_DISCONNECT,    ALERT_SEVERITY.CRITICAL, `Zenon node disconnected — payouts blocked`],
      };
      if (alertMap[service]) {
        const [type, sev, msg] = alertMap[service];
        this.alerts.raise(type, sev, msg, { consecutiveFails: c.consecutiveFails, lastError: c.lastError });
      }
    } else if (c.consecutiveFails >= Math.ceil(threshold / 2)) {
      // Degraded warning before full outage
      if (service === 'oracle') {
        this.alerts.raise(ALERT_TYPE.ORACLE_DEGRADED, ALERT_SEVERITY.WARN,
          `Oracle API degraded — ${c.consecutiveFails} failures`, { error });
      }
    }
    this._persist?.();
  }

  getStatus() {
    return Object.fromEntries(
      Object.entries(this.checks).map(([k, v]) => [k, {
        ok: v.ok,
        consecutiveFails: v.consecutiveFails,
        lastCheck: v.lastCheck,
        lastError: v.lastError,
      }])
    );
  }

  // Alias — server.js reads health.services.oracle etc.
  get services() {
    return this.getStatus();
  }

  isHealthy() {
    return Object.values(this.checks).every(c => c.ok);
  }

  isSafeToCreateMarkets() {
    // Don't create markets if oracle is down (can't resolve them)
    return this.checks.oracle.ok;
  }

  isSafeToAcceptDeposits() {
    // Don't accept deposits if explorer is down (can't verify) or node down (can't payout)
    return this.checks.explorer.ok && this.checks.zenonNode.ok;
  }

  exportState() {
    return { checks: this.checks };
  }

  importState(state = {}) {
    if (state.checks) this.checks = state.checks;
  }
}

// ─────────────────────────────────────────────────────────────
// PAYOUT METRICS
// Tracks payout queue depth and failure patterns
// Bot reads this before deciding whether to accept new bets
// ─────────────────────────────────────────────────────────────

class PayoutMetrics {
  constructor(alertManager) {
    this.alerts         = alertManager;
    this.queueDepth     = 0;
    this.oldestQueuedMs = null;
    this.totalSent      = 0;
    this.totalFailed    = 0;
    this.consecutiveFails = 0;
    this.circuitOpen    = false;
    this.circuitOpenAt  = null;
    this.history        = [];  // last 100 payout outcomes
    this._persist = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  recordQueued(sessionId) {
    this.queueDepth++;
    if (!this.oldestQueuedMs) this.oldestQueuedMs = Date.now();
    this._persist?.();
  }

  recordSent(sessionId, amountZnn, durationMs) {
    this.queueDepth       = Math.max(0, this.queueDepth - 1);
    this.totalSent++;
    this.consecutiveFails = 0;
    this.oldestQueuedMs   = this.queueDepth === 0 ? null : this.oldestQueuedMs;
    this.history.unshift({ ts: Date.now(), sessionId, outcome: 'sent', amountZnn, durationMs });
    if (this.history.length > 100) this.history.pop();
    this.alerts.resolve(ALERT_TYPE.PAYOUT_FAILURE, 'Payout succeeded — resetting');
    this._persist?.();
  }

  recordFailed(sessionId, error, willRetry = false) {
    this.queueDepth    = Math.max(0, this.queueDepth - 1);
    this.totalFailed++;
    this.consecutiveFails++;
    this.history.unshift({ ts: Date.now(), sessionId, outcome: 'failed', error: String(error), willRetry });
    if (this.history.length > 100) this.history.pop();

    const threshold = config.get('payouts.circuitBreakerThreshold') || 3;

    this.alerts.raise(
      ALERT_TYPE.PAYOUT_FAILURE,
      this.consecutiveFails >= threshold ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.WARN,
      `Payout failed (${this.consecutiveFails} consecutive) — ${String(error).slice(0, 100)}`,
      { sessionId, consecutiveFails: this.consecutiveFails, willRetry }
    );

    if (this.consecutiveFails >= threshold && !this.circuitOpen) {
      this.openCircuit();
    }
    this._persist?.();
  }

  openCircuit() {
    this.circuitOpen   = true;
    this.circuitOpenAt = Date.now();
    this.alerts.raise(
      ALERT_TYPE.PAYOUT_CIRCUIT_OPEN,
      ALERT_SEVERITY.CRITICAL,
      `Payout circuit breaker OPEN — all payouts halted after ${this.consecutiveFails} consecutive failures`,
      { openAt: this.circuitOpenAt }
    );
    console.error('[CIRCUIT BREAKER] Payouts halted — manual review required or auto-reset in', config.get('payouts.circuitBreakerResetMs') / 60000, 'min');

    // Auto-reset after configured delay
    setTimeout(() => this.resetCircuit(), config.get('payouts.circuitBreakerResetMs'));
    this._persist?.();
  }

  resetCircuit() {
    this.circuitOpen      = false;
    this.circuitOpenAt    = null;
    this.consecutiveFails = 0;
    this.alerts.resolve(ALERT_TYPE.PAYOUT_CIRCUIT_OPEN, 'Circuit breaker auto-reset');
    console.log('[circuit breaker] Payouts re-enabled');
    this._persist?.();
  }

  forceResetCircuit() {
    this.resetCircuit();
  }

  isCircuitOpen() {
    return this.circuitOpen;
  }

  getStats() {
    const ageMs = this.oldestQueuedMs ? Date.now() - this.oldestQueuedMs : null;
    return {
      queueDepth:         this.queueDepth,
      oldestQueueAgeMs:   ageMs,
      oldestQueueAgeMins: ageMs ? parseFloat((ageMs / 60000).toFixed(1)) : null,
      totalSent:          this.totalSent,
      totalFailed:        this.totalFailed,
      consecutiveFails:   this.consecutiveFails,
      circuitOpen:        this.circuitOpen,
      circuitOpenAt:      this.circuitOpenAt,
      recentHistory:      this.history.slice(0, 10),
    };
  }

  // Alias used by admin routes
  getMetrics() { return this.getStats(); }

  exportState() {
    return {
      queueDepth: this.queueDepth,
      oldestQueuedMs: this.oldestQueuedMs,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      consecutiveFails: this.consecutiveFails,
      circuitOpen: this.circuitOpen,
      circuitOpenAt: this.circuitOpenAt,
      history: this.history.slice(),
    };
  }

  importState(state = {}) {
    Object.assign(this, {
      queueDepth: state.queueDepth || 0,
      oldestQueuedMs: state.oldestQueuedMs || null,
      totalSent: state.totalSent || 0,
      totalFailed: state.totalFailed || 0,
      consecutiveFails: state.consecutiveFails || 0,
      circuitOpen: !!state.circuitOpen,
      circuitOpenAt: state.circuitOpenAt || null,
      history: state.history || [],
    });
  }
}

// ─────────────────────────────────────────────────────────────
// ADMIN CONTROLLER
// Central object exposed to server.js and bot.js
// Single interface to all monitoring, config, and control
// ─────────────────────────────────────────────────────────────

class AdminController {
  // constructor optionally accepts { config } but we use the singleton from config.js
  constructor(_opts = {}) {
    this.alerts      = new AlertManager();
    this.botActions  = new BotActionLog();   // also accessible as botLog for legacy callers
    this.engagement  = new EngagementTracker();
    this.health      = new HealthMonitor(this.alerts);
    this.payouts     = new PayoutMetrics(this.alerts);
    this.startTime   = Date.now();
    this._worker     = null;  // wired after construction to avoid circular deps
    this._persist = null;
  }

  // Legacy alias
  get botLog() { return this.botActions; }

  // Wire in the PayoutWorker after construction
  setPayoutWorker(worker) {
    this._worker = worker;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
    this.alerts.setPersistence(saveFn);
    this.botActions.setPersistence(saveFn);
    this.engagement.setPersistence(saveFn);
    this.health.setPersistence(saveFn);
    this.payouts.setPersistence(saveFn);
  }

  // ── FULL HEALTH SNAPSHOT ────────────────────────────────

  /**
   * The bot calls this before every research cycle.
   * Returns a structured status the bot can act on — not a string.
   */
  getFullHealth(sessions, markets) {
    const now = Date.now();

    // Check session backlog
    const sessStats    = sessions?.stats() || {};
    const backlogCount = sessStats.pending || 0;
    if (backlogCount > 20) {
      this.alerts.raise(ALERT_TYPE.SESSION_BACKLOG, ALERT_SEVERITY.WARN,
        `${backlogCount} sessions stuck in PENDING_DEPOSIT`, { count: backlogCount });
    } else {
      this.alerts.resolve(ALERT_TYPE.SESSION_BACKLOG);
    }

    // Check for locked markets stuck awaiting resolution
    const mktStats    = markets?.stats() || {};
    const lockedCount = mktStats.locked || 0;
    if (lockedCount > 5) {
      this.alerts.raise(ALERT_TYPE.MARKET_STUCK, ALERT_SEVERITY.WARN,
        `${lockedCount} markets locked and awaiting oracle resolution`, { count: lockedCount });
    } else {
      this.alerts.resolve(ALERT_TYPE.MARKET_STUCK);
    }

    return {
      timestamp:           now,
      uptimeMs:            now - this.startTime,
      uptimeHours:         parseFloat(((now - this.startTime) / 3600000).toFixed(2)),
      services:            this.health.getStatus(),
      isHealthy:           this.health.isHealthy(),
      safeToCreateMarkets: this.health.isSafeToCreateMarkets(),
      safeToAcceptDeposits: this.health.isSafeToAcceptDeposits(),
      criticalAlerts:      this.alerts.getActive(ALERT_SEVERITY.CRITICAL).length,
      warnAlerts:          this.alerts.getActive(ALERT_SEVERITY.WARN).length,
      sessions:            sessStats,
      markets:             mktStats,
      payouts:             this.payouts.getStats(),
      activeGames:         config.getActiveGameIds(),
    };
  }

  // ── CONVENIENCE WRAPPERS ────────────────────────────────

  raiseAlert(type, severity, message, data) {
    return this.alerts.raise(type, severity, message, data);
  }

  resolveAlert(type, message) {
    return this.alerts.resolve(type, message);
  }

  recordBotAction(opts) {
    return this.botActions.record(opts);
  }

  // ── ENGAGEMENT FEEDBACK → CONFIG ────────────────────────

  /**
   * Called periodically by bot to update market type weights
   * based on which types are actually getting positions taken.
   */
  rebalanceMarketWeights() {
    const performance = this.engagement.getMarketTypePerformance();
    const changes     = [];

    for (const perf of performance) {
      const currentWeight = config.get(`bot.marketWeights.${perf.type}`);
      if (currentWeight === undefined) continue;

      // Types with above-average engagement get a weight boost
      // Types with zero engagement get a gentle reduction
      if (perf.avgPositionsPerMarket > 1.5) {
        const delta = Math.min(10, Math.round(perf.avgPositionsPerMarket * 2));
        const entry = config.adjustMarketWeight(perf.type, +delta, 'bot');
        if (entry) changes.push({ type: perf.type, delta: +delta });
      } else if (perf.created > 3 && perf.positionsTaken === 0) {
        const entry = config.adjustMarketWeight(perf.type, -5, 'bot');
        if (entry) changes.push({ type: perf.type, delta: -5 });
      }
    }

    if (changes.length > 0) {
      console.log('[admin] Market weights rebalanced:', JSON.stringify(changes));
    }
    if (changes.length > 0) this._persist?.();
    return changes;
  }

  exportState() {
    return {
      alerts: this.alerts.exportState(),
      botActions: this.botActions.exportState(),
      engagement: this.engagement.exportState(),
      health: this.health.exportState(),
      payouts: this.payouts.exportState(),
      startTime: this.startTime,
    };
  }

  importState(state = {}) {
    if (state.startTime) this.startTime = state.startTime;
    this.alerts.importState(state.alerts);
    this.botActions.importState(state.botActions);
    this.engagement.importState(state.engagement);
    this.health.importState(state.health);
    this.payouts.importState(state.payouts);
  }
}

// ─────────────────────────────────────────────────────────────
// SINGLETON  (optional — server.js can also instantiate its own)
// ─────────────────────────────────────────────────────────────
const admin = new AdminController();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = {
  admin,
  AdminController,
  AlertManager,
  BotActionLog,
  EngagementTracker,
  HealthMonitor,
  PayoutMetrics,
  ALERT_TYPE,
  ALERT_SEVERITY,
};
