// treasury.js — Treasury ledger, wallet reconciliation, and autonomous safety gates

const { config } = require('./config');
const { getWalletBalance } = require('./zenon');
const { STATE } = require('./sessions');

class TreasuryManager {
  constructor({ sessionManager, marketManager, serverConfig, adminController = null }) {
    this.sessions = sessionManager;
    this.markets = marketManager;
    this.serverConfig = serverConfig;
    this.adminCtrl = adminController;

    this.lastReconciliation = null;
    this.walletSnapshots = [];
    this.ledger = [];
    this.halts = {
      payouts: { active: false, reason: null, source: null, updatedAt: null },
      bot: { active: false, reason: null, source: null, updatedAt: null },
    };

    this._persist = null;
    this._timer = null;
    this._db = null;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  setDatabase(store) {
    this._db = store;
  }

  start() {
    if (this._timer) return;
    const interval = config.get('treasury.reconcileIntervalMs') || 60_000;
    this._timer = setInterval(() => {
      this.reconcile({ reason: 'interval' }).catch((err) => {
        this._recordLedger('reconcile_failed', null, null, { error: err.message, reason: 'interval' });
      });
    }, interval);
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  setAdmin(adminController) {
    this.adminCtrl = adminController;
  }

  calculateLiabilities() {
    const sessionItems = Array.from(this.sessions.sessions.values())
      .filter((session) => session.state === STATE.GAME_WON && !session.payoutTxHash)
      .map((session) => ({
        id: session.id,
        kind: 'session_win',
        amountZnn: session.payoutAmount,
        toAddress: session.playerAddress,
      }));

    const marketItems = Array.from(this.markets.positions.values())
      .filter((position) =>
        ((position.state === 'WON' && position.potentialPayout > 0) ||
         (position.state === 'REFUNDED' && position.amountZnn > 0)) &&
        !position.payoutTxHash
      )
      .map((position) => ({
        id: position.id,
        kind: position.state === 'REFUNDED' ? 'market_refund' : 'market_win',
        amountZnn: position.state === 'REFUNDED' ? position.amountZnn : position.potentialPayout,
        toAddress: position.playerAddress,
      }));

    const all = sessionItems.concat(marketItems);
    const totalPendingZnn = roundZnn(all.reduce((sum, item) => sum + Number(item.amountZnn || 0), 0));

    return {
      totalPendingZnn,
      counts: {
        sessions: sessionItems.length,
        markets: marketItems.length,
        total: all.length,
      },
      items: all.slice(0, 100),
    };
  }

  async reconcile({ force = false, reason = 'manual' } = {}) {
    const now = Date.now();
    const staleAfterMs = config.get('treasury.balanceFreshnessMs') || 180_000;
    if (!force && this.lastReconciliation && now - this.lastReconciliation.timestamp < Math.min(staleAfterMs, 60_000)) {
      return this.lastReconciliation;
    }

    try {
      const balance = await getWalletBalance({
        address: this.serverConfig.PLATFORM_ADDRESS,
        explorerApi: this.serverConfig.EXPLORER_API,
        nodeUrl: this.serverConfig.ZNN_NODE_URL,
      });
      const liabilities = this.calculateLiabilities();
      const minReserveZnn = Number(config.get('treasury.minReserveZnn') || 0);
      const maxPendingLiabilityZnn = Number(config.get('treasury.maxPendingLiabilityZnn') || 0);
      const availableForPayoutZnn = roundZnn(Math.max(0, balance.balanceZnn - minReserveZnn));
      const headroomZnn = roundZnn(balance.balanceZnn - minReserveZnn - liabilities.totalPendingZnn);
      const issues = [];

      if (balance.balanceZnn < minReserveZnn) {
        issues.push(`reserve below minimum (${balance.balanceZnn.toFixed(4)} < ${minReserveZnn.toFixed(4)} ZNN)`);
      }
      if (maxPendingLiabilityZnn > 0 && liabilities.totalPendingZnn > maxPendingLiabilityZnn) {
        issues.push(`pending liabilities above limit (${liabilities.totalPendingZnn.toFixed(4)} > ${maxPendingLiabilityZnn.toFixed(4)} ZNN)`);
      }
      if (liabilities.totalPendingZnn > balance.balanceZnn) {
        issues.push(`wallet balance cannot cover pending liabilities (${balance.balanceZnn.toFixed(4)} < ${liabilities.totalPendingZnn.toFixed(4)} ZNN)`);
      }

      const snapshot = {
        ok: issues.length === 0,
        timestamp: now,
        reason,
        source: balance.source,
        balanceZnn: roundZnn(balance.balanceZnn),
        minReserveZnn,
        availableForPayoutZnn,
        pendingLiabilityZnn: liabilities.totalPendingZnn,
        headroomZnn,
        liabilityCounts: liabilities.counts,
        issues,
      };

      this.lastReconciliation = snapshot;
      this.walletSnapshots.unshift(snapshot);
      if (this.walletSnapshots.length > 100) this.walletSnapshots.pop();
      this._recordLedger('reconcile', null, snapshot.balanceZnn, { reason, issues, source: balance.source });
      this._db?.appendTreasuryReconciliation(snapshot);
      this._applyRiskAlerts(snapshot);
      this._persist?.();
      return snapshot;
    } catch (err) {
      const failed = {
        ok: false,
        timestamp: now,
        reason,
        balanceZnn: null,
        minReserveZnn: Number(config.get('treasury.minReserveZnn') || 0),
        availableForPayoutZnn: null,
        pendingLiabilityZnn: this.calculateLiabilities().totalPendingZnn,
        headroomZnn: null,
        liabilityCounts: this.calculateLiabilities().counts,
        issues: [`wallet reconciliation failed: ${err.message}`],
        error: err.message,
      };
      this.lastReconciliation = failed;
      this._recordLedger('reconcile_failed', null, null, { reason, error: err.message });
      this._db?.appendTreasuryReconciliation(failed);
      this._applyRiskAlerts(failed);
      this._persist?.();
      return failed;
    }
  }

  async authorizePayout({ ledgerId, amountZnn, toAddress, reason = 'payout' }) {
    const maxSinglePayoutZnn = Number(config.get('treasury.maxSinglePayoutZnn') || 0);
    const retryDelayMs = config.get('treasury.blockedRetryDelayMs') || 60_000;

    if (this.halts.payouts.active) {
      const denial = this._buildDenial(`payouts halted: ${this.halts.payouts.reason || 'manual stop'}`, retryDelayMs);
      this._recordLedger('payout_blocked', ledgerId, amountZnn, { toAddress, reason, blockReason: denial.reason });
      return denial;
    }

    if (maxSinglePayoutZnn > 0 && amountZnn > maxSinglePayoutZnn) {
      const denial = this._buildDenial(`payout exceeds single-payout limit (${amountZnn.toFixed(4)} > ${maxSinglePayoutZnn.toFixed(4)} ZNN)`, retryDelayMs);
      this._recordLedger('payout_blocked', ledgerId, amountZnn, { toAddress, reason, blockReason: denial.reason });
      return denial;
    }

    const snapshot = await this.reconcile({ reason: `payout:${ledgerId}` });
    const freshnessMs = Date.now() - snapshot.timestamp;
    const maxFreshnessMs = config.get('treasury.balanceFreshnessMs') || 180_000;

    if (!snapshot.ok) {
      const denial = this._buildDenial(snapshot.issues[0] || 'treasury reconciliation failed', retryDelayMs, snapshot);
      this._recordLedger('payout_blocked', ledgerId, amountZnn, { toAddress, reason, blockReason: denial.reason });
      return denial;
    }

    if (freshnessMs > maxFreshnessMs) {
      const denial = this._buildDenial(`wallet balance is stale (${Math.round(freshnessMs / 1000)}s old)`, retryDelayMs, snapshot);
      this._recordLedger('payout_blocked', ledgerId, amountZnn, { toAddress, reason, blockReason: denial.reason });
      return denial;
    }

    if (amountZnn > snapshot.availableForPayoutZnn) {
      const denial = this._buildDenial(`available payout headroom too low (${snapshot.availableForPayoutZnn.toFixed(4)} ZNN available after reserve)`, retryDelayMs, snapshot);
      this._recordLedger('payout_blocked', ledgerId, amountZnn, { toAddress, reason, blockReason: denial.reason });
      return denial;
    }

    this._recordLedger('payout_authorized', ledgerId, amountZnn, {
      toAddress,
      reason,
      balanceZnn: snapshot.balanceZnn,
      pendingLiabilityZnn: snapshot.pendingLiabilityZnn,
    });
    return { ok: true, snapshot };
  }

  recordPayoutSent({ ledgerId, amountZnn, txHash, toAddress, kind = 'payout' }) {
    this._recordLedger('payout_sent', ledgerId, amountZnn, { txHash, toAddress, kind });
  }

  recordPayoutFailed({ ledgerId, amountZnn, error, toAddress, kind = 'payout' }) {
    this._recordLedger('payout_failed', ledgerId, amountZnn, { error, toAddress, kind });
  }

  isSafeToCreateMarkets() {
    if (!config.get('treasury.haltBotOnRisk')) return true;
    const snapshot = this.lastReconciliation;
    return !this.halts.bot.active && !!snapshot && snapshot.ok;
  }

  isSafeToAcceptDeposits() {
    const snapshot = this.lastReconciliation;
    return !this.halts.payouts.active && !!snapshot && snapshot.ok;
  }

  setHalt(scope = 'all', active, reason = 'manual', source = 'admin') {
    const scopes = scope === 'all' ? ['payouts', 'bot'] : [scope];
    for (const key of scopes) {
      if (!this.halts[key]) continue;
      this.halts[key] = {
        active: !!active,
        reason,
        source,
        updatedAt: Date.now(),
      };
    }
    this._recordLedger(active ? 'halt_enabled' : 'halt_cleared', scope, null, { reason, source });
    this._persist?.();
    return this.getStatus();
  }

  getStatus() {
    const liabilities = this.calculateLiabilities();
    const freshnessMs = this.lastReconciliation ? Date.now() - this.lastReconciliation.timestamp : null;
    return {
      lastReconciliation: this.lastReconciliation,
      balanceFreshnessMs: freshnessMs,
      halts: this.halts,
      liabilities,
      recentLedger: this.ledger.slice(0, 30),
      recentSnapshots: this.walletSnapshots.slice(0, 10),
      safeToCreateMarkets: this.isSafeToCreateMarkets(),
      safeToAcceptDeposits: this.isSafeToAcceptDeposits(),
    };
  }

  exportState() {
    return {
      lastReconciliation: this.lastReconciliation,
      walletSnapshots: this.walletSnapshots.slice(),
      ledger: this.ledger.slice(),
      halts: this.halts,
    };
  }

  importState(state = {}) {
    this.lastReconciliation = state.lastReconciliation || null;
    this.walletSnapshots = this._db?.getRecentTreasuryReconciliations(100) || state.walletSnapshots || [];
    this.ledger = this._db?.getRecentTreasuryLedger(500) || state.ledger || [];
    this.halts = state.halts || this.halts;
    if (!this.lastReconciliation && this.walletSnapshots.length > 0) {
      this.lastReconciliation = this.walletSnapshots[0];
    }
  }

  _applyRiskAlerts(snapshot) {
    if (!this.adminCtrl) return;

    const issues = snapshot.issues || [];
    const hasReconFailure = issues.some((issue) => issue.includes('reconciliation failed'));
    const hasLowReserve = issues.some((issue) => issue.includes('reserve below minimum'));
    const hasHighLiability = issues.some((issue) => issue.includes('pending liabilities above limit') || issue.includes('cannot cover pending liabilities'));

    if (hasReconFailure) {
      this.adminCtrl.alerts.raise('TREASURY_RECONCILIATION_FAILED', 'critical', issues[0], snapshot);
    } else {
      this.adminCtrl.alerts.resolve('TREASURY_RECONCILIATION_FAILED', 'Wallet reconciliation healthy again');
    }

    if (hasLowReserve) {
      this.adminCtrl.alerts.raise('TREASURY_LOW_RESERVE', 'critical', issues.find((issue) => issue.includes('reserve below minimum')), snapshot);
    } else {
      this.adminCtrl.alerts.resolve('TREASURY_LOW_RESERVE', 'Reserve back above minimum');
    }

    if (hasHighLiability) {
      this.adminCtrl.alerts.raise('TREASURY_LIABILITY_LIMIT', 'critical', issues.find((issue) => issue.includes('pending liabilities') || issue.includes('cannot cover pending liabilities')), snapshot);
    } else {
      this.adminCtrl.alerts.resolve('TREASURY_LIABILITY_LIMIT', 'Liabilities back inside configured limit');
    }

    const shouldAutoHalt = config.get('treasury.haltPayoutsOnRisk') && !snapshot.ok;
    const shouldBotHalt = config.get('treasury.haltBotOnRisk') && !snapshot.ok;

    if (shouldAutoHalt) {
      this.setHalt('payouts', true, issues[0] || 'treasury risk detected', 'auto');
      this.adminCtrl.alerts.raise('TREASURY_AUTO_HALTED', 'critical', `Treasury auto-halted payouts: ${issues[0] || 'risk detected'}`, snapshot);
    } else if (this.halts.payouts.active && this.halts.payouts.source === 'auto') {
      this.setHalt('payouts', false, 'treasury recovered', 'auto');
      this.adminCtrl.alerts.resolve('TREASURY_AUTO_HALTED', 'Treasury recovered and payouts auto-resumed');
    }

    if (shouldBotHalt) {
      this.setHalt('bot', true, issues[0] || 'treasury risk detected', 'auto');
    } else if (this.halts.bot.active && this.halts.bot.source === 'auto') {
      this.setHalt('bot', false, 'treasury recovered', 'auto');
    }
  }

  _buildDenial(reason, retryDelayMs, snapshot = null) {
    return {
      ok: false,
      retryable: true,
      retryAt: Date.now() + retryDelayMs,
      reason,
      snapshot,
    };
  }

  _recordLedger(type, refId, amountZnn, data = {}) {
    this.ledger.unshift({
      id: randomId(),
      ts: Date.now(),
      type,
      refId,
      amountZnn: amountZnn == null ? null : roundZnn(amountZnn),
      data,
    });
    if (this.ledger.length > 500) this.ledger.pop();
    this._db?.appendTreasuryLedger(this.ledger[0]);
    this._persist?.();
  }
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function roundZnn(value) {
  return parseFloat(Number(value || 0).toFixed(8));
}

module.exports = { TreasuryManager };
