/**
 * Self-Healing Module
 * Monitors platform health and automatically recovers from common failures
 * Works with the AI command system for autonomous operation
 */

const { config } = require('./config');
const { admin } = require('./admin');

class SelfHealingMonitor {
  constructor(opts = {}) {
    this.adminCtrl = opts.adminCtrl;
    this.treasury = opts.treasury;
    this.worker = opts.worker;
    this.bot = opts.bot;
    this.sessions = opts.sessions;
    this.markets = opts.markets;
    this.server = opts.server;

    this.intervalId = null;
    this.isRunning = false;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5;

    // Recovery actions taken (for audit)
    this.recoveryLog = [];
    this.MAX_LOG = 100;
  }

  /**
   * Start the self-healing monitor
   */
  start() {
    if (this.isRunning) return;
    if (!config.get('ai.selfHealingEnabled')) {
      console.log('[self-heal] Self-healing disabled in config');
      return;
    }

    this.isRunning = true;
    const interval = config.get('ai.healthCheckIntervalMs') || 30000;

    this.intervalId = setInterval(() => {
      this.checkAndHeal().catch(err => {
        console.error('[self-heal] Check failed:', err.message);
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          console.error('[self-heal] Too many consecutive failures, stopping monitor');
          this.stop();
        }
      });
    }, interval);

    console.log(`[self-heal] Self-healing monitor started (interval: ${interval}ms)`);
  }

  /**
   * Stop the monitor
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[self-heal] Self-healing monitor stopped');
  }

  /**
   * Main check-and-heal cycle
   */
  async checkAndHeal() {
    const health = this.adminCtrl?.getFullHealth(this.sessions, this.markets);
    if (!health) return;

    const actions = [];

    // Check 1: Circuit breaker stuck open
    if (health.payouts?.circuitOpen) {
      const openTime = health.payouts.circuitOpenAt;
      const resetMs = config.get('payouts.circuitBreakerResetMs') || 300000;

      // If circuit has been open longer than reset time + buffer, force reset
      if (openTime && (Date.now() - openTime) > resetMs + 60000) {
        actions.push(this.forceResetCircuit());
      }
    }

    // Check 2: Stuck sessions (PENDING_DEPOSIT for too long)
    const staleSessions = this.findStaleSessions();
    if (staleSessions.length > 0) {
      actions.push(this.cleanupStaleSessions(staleSessions));
    }

    // Check 3: Markets stuck in LOCKED state
    if (health.markets?.locked > 5) {
      actions.push(this.resolveStuckMarkets());
    }

    // Check 4: Treasury halted but conditions OK
    if (health.treasury?.halted?.payouts && health.treasury?.balance_znn >= config.get('treasury.minReserveZnn')) {
      actions.push(this.resumePayoutsIfSafe());
    }

    // Check 5: Critical alerts that can be auto-resolved
    const criticalAlerts = this.adminCtrl?.alerts.getActive('critical') || [];
    for (const alert of criticalAlerts) {
      if (this.canAutoResolve(alert)) {
        actions.push(this.autoResolveAlert(alert));
      }
    }

    // Execute all recovery actions
    if (actions.length > 0) {
      console.log(`[self-heal] Found ${actions.length} recovery action(s)`);
      const results = await Promise.allSettled(actions);
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          this.logRecovery(`Action ${idx + 1}: ${result.value}`);
        } else {
          console.error(`[self-heal] Action ${idx + 1} failed:`, result.reason);
        }
      });
    }

    this.consecutiveFailures = 0;
    return { actions: actions.length };
  }

  /**
   * Find sessions that have been pending too long
   */
  findStaleSessions() {
    if (!this.sessions) return [];
    const now = Date.now();
    const timeoutMs = (config.get('depositTimeoutSeconds') || 300) * 1000;
    const allSessions = this.sessions.getAll ? this.sessions.getAll() : [];
    return allSessions.filter(s =>
      s.state === 'PENDING_DEPOSIT' &&
      (now - (s.createdAt || 0)) > timeoutMs * 2  // 2x timeout = stale
    );
  }

  /**
   * Clean up stale sessions
   */
  async cleanupStaleSessions(staleSessions) {
    let cleaned = 0;
    for (const session of staleSessions) {
      try {
        this.sessions.remove(session.id);
        cleaned++;
      } catch (err) {
        console.warn(`[self-heal] Failed to remove session ${session.id}:`, err.message);
      }
    }
    return `Cleaned up ${cleaned} stale session(s)`;
  }

  /**
   * Force reset circuit breaker if stuck
   */
  async forceResetCircuit() {
    if (this.worker) {
      this.worker.forceResetCircuit();
      return 'Force-reset stuck circuit breaker';
    }
    return 'Cannot reset circuit - worker not available';
  }

  /**
   * Try to resolve stuck markets
   */
  async resolveStuckMarkets() {
    if (!this.markets || !this.markets.resolveDueMarkets) return 'Market resolution not available';
    try {
      const resolved = await this.markets.resolveDueMarkets();
      return `Resolved ${resolved} stuck market(s)`;
    } catch (err) {
      return `Failed to resolve markets: ${err.message}`;
    }
  }

  /**
   * Resume payouts if it's safe
   */
  async resumePayoutsIfSafe() {
    const health = this.adminCtrl?.getFullHealth(this.sessions, this.markets);
    if (!health?.safeToAcceptDeposits) {
      return 'Not safe to resume payouts yet';
    }
    if (this.treasury) {
      this.treasury.setHalt('payouts', false, 'self-heal', 'self-heal');
      return 'Resumed payouts (conditions OK)';
    }
    return 'Cannot resume payouts - treasury not available';
  }

  /**
   * Check if an alert can be auto-resolved
   */
  canAutoResolve(alert) {
    // Auto-resolve alerts that are likely transient
    const autoResolvable = [
      'oracle_degraded',
      'session_backlog',  // Clears automatically when sessions are cleaned
    ];
    return autoResolvable.includes(alert.type);
  }

  /**
   * Auto-resolve an alert
   */
  async autoResolveAlert(alert) {
    this.adminCtrl?.alerts.resolve(alert.type, 'Auto-resolved by self-healing monitor');
    return `Auto-resolved alert: ${alert.type}`;
  }

  /**
   * Log a recovery action
   */
  logRecovery(message) {
    const entry = {
      ts: Date.now(),
      message,
    };
    this.recoveryLog.unshift(entry);
    if (this.recoveryLog.length > this.MAX_LOG) this.recoveryLog.pop();
    console.log(`[self-heal] ${message}`);
  }

  /**
   * Get recovery log
   */
  getRecoveryLog(limit = 20) {
    return this.recoveryLog.slice(0, limit);
  }

  /**
   * Export state for persistence
   */
  exportState() {
    return {
      recoveryLog: this.recoveryLog.slice(),
      isRunning: this.isRunning,
    };
  }

  /**
   * Import state from persistence
   */
  importState(state = {}) {
    this.recoveryLog = state.recoveryLog || [];
    // Note: don't auto-start from imported state - let server.js control that
  }
}

// Singleton instance
const selfHealer = new SelfHealingMonitor();

module.exports = {
  SelfHealingMonitor,
  selfHealer,
};
