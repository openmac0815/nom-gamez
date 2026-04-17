// payouts.js — Background Payout Worker v2
// Circuit breaker, exponential backoff, admin metrics integration
// Bot can read payout health via admin.payouts.getStats()

const { sendPayout, pollForDeposit } = require('./zenon');
const { sendBtcPayout } = require('./btc');
const { STATE } = require('./sessions');
const { config }  = require('./config');
const { ASSET } = require('./payment-rails');

class PayoutWorker {
  constructor({ sessionManager, marketManager = null, serverConfig, adminController = null, treasuryManager = null }) {
    this.sessions    = sessionManager;
    this.markets     = marketManager;
    this.serverConfig = serverConfig;            // PLATFORM_SEED, PLATFORM_ADDRESS, etc.
    this.adminCtrl   = adminController;          // optional — wired after admin module loads
    this.treasury    = treasuryManager;
    this.running     = false;
    this.payoutQueue = [];                       // [ { sessionId, attempts, nextAttemptAt } ]
    this.payoutLedger = new Map();               // sessionId -> payout lifecycle record
    this.pollInterval   = null;
    this.payoutInterval = null;
    this._persist = null;
    this._store = null;
  }

  // Wire in admin controller after construction (avoids circular deps)
  setAdmin(adminController) {
    this.adminCtrl = adminController;
  }

  setTreasury(treasuryManager) {
    this.treasury = treasuryManager;
  }

  setPersistence(saveFn) {
    this._persist = saveFn;
  }

  setStore(store) {
    this._store = store;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const cfg = config.get('payouts');
    console.log('[payout] Worker started');
    this.pollInterval   = setInterval(() => this.pollDeposits(),    cfg.pollIntervalMs    || 10000);
    this.payoutInterval = setInterval(() => this.processPayouts(),  cfg.processIntervalMs || 15000);
  }

  stop() {
    this.running = false;
    clearInterval(this.pollInterval);
    clearInterval(this.payoutInterval);
    console.log('[payout] Worker stopped');
  }

  // ── DEPOSIT AUTO-POLL ─────────────────────────────────────

  async pollDeposits() {
    // Skip if deposits are unsafe (explorer or node down)
    if (this.adminCtrl && !this.adminCtrl.isSafeToAcceptDeposits()) return;

    const pending = this.sessions.getPendingSessions();
    if (!pending.length) return;

    for (const session of pending) {
      if ((session.depositAsset || ASSET.ZNN) !== ASSET.ZNN) continue;
      try {
        session.pollCount++;
        const found = await pollForDeposit({
          platformAddress: this.serverConfig.PLATFORM_ADDRESS,
          fromAddress:     session.playerAddress,
          expectedAmount:  session.betAmount,
          explorerApi:     this.serverConfig.EXPLORER_API,
          seenHashes:      this.sessions.seenHashes,
        });

        if (found) {
          console.log(`[payout] Auto-detected deposit for ${session.id}: ${found.hash}`);
          this.sessions.depositFound(session.id, found.hash);
          this.sessions.depositConfirmed(session.id);
          if (this.adminCtrl) this.adminCtrl.health.recordSuccess('explorer');
        }
      } catch (err) {
        console.error(`[payout] Poll error for ${session.id}:`, err.message);
        if (this.adminCtrl) this.adminCtrl.health.recordFailure('explorer', err.message);
      }
    }
  }

  // ── QUEUE MANAGEMENT ──────────────────────────────────────

  queuePayout(sessionId, reason = 'session_win') {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.payoutTxHash || session.state === STATE.PAYOUT_SENT) {
      const existingSent = this._ensureLedgerRecord(sessionId, session, reason);
      existingSent.status = 'sent';
      existingSent.txHash = session.payoutTxHash || existingSent.txHash || null;
      existingSent.lastUpdatedAt = Date.now();
      this._persist?.();
      return existingSent;
    }

    const record = this._ensureLedgerRecord(sessionId, session, reason);
    if (record.status === 'sent') return record;

    const already = this.payoutQueue.find(q => q.sessionId === sessionId);
    if (!already) {
      this.payoutQueue.push({ sessionId, attempts: 0, nextAttemptAt: Date.now() });
      this._store?.upsertPayoutQueueItem({ sessionId, attempts: 0, nextAttemptAt: Date.now() });
      record.status = 'queued';
      record.lastQueuedAt = Date.now();
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(sessionId, record);
      if (this.adminCtrl) this.adminCtrl.payouts.recordQueued(sessionId);
      console.log(`[payout] Queued: ${sessionId} | queue depth: ${this.payoutQueue.length}`);
      this._persist?.();
    }
    return record;
  }

  // ── PAYOUT PROCESSING ─────────────────────────────────────

  async processPayouts() {
    // Check circuit breaker FIRST
    if (this.adminCtrl?.payouts.isCircuitOpen()) {
      console.warn('[payout] Circuit breaker OPEN — skipping processing');
      return;
    }

    // Auto-pick up GAME_WON sessions not yet explicitly queued
    const winners = this.sessions.getWinningSessions();
    for (const s of winners) {
      if (!this.payoutQueue.find(q => q.sessionId === s.id)) {
        this.queuePayout(s.id);
      }
    }

    if (this.markets) {
      for (const posItem of this.markets.getPositionsDueForPayout(20)) {
        const queueId = `market:${posItem.positionId}`;
        if (!this.payoutQueue.find(q => q.sessionId === queueId)) {
          this.queueMarketPayout(posItem.positionId, posItem.type);
        }
      }
    }

    if (!this.payoutQueue.length) return;

    // Process next due item
    const now  = Date.now();
    const item = this.payoutQueue.find(q => q.nextAttemptAt <= now);
    if (!item) return;

    // Remove from queue (will re-add on failure if retries remain)
    this.payoutQueue = this.payoutQueue.filter(q => q !== item);
    this._store?.deletePayoutQueueItem(item.sessionId);
    this._persist?.();

    if (item.sessionId.startsWith('market:')) {
      return this._processMarketPayout(item);
    }

    const session = this.sessions.get(item.sessionId);
    if (!session || session.state !== STATE.GAME_WON) return;
    const record = this._ensureLedgerRecord(item.sessionId, session);

    if (record.status === 'sent' || session.state === STATE.PAYOUT_SENT || session.payoutTxHash) {
      if (session.state !== STATE.PAYOUT_SENT && session.payoutTxHash) {
        this.sessions.payoutSent(item.sessionId, session.payoutTxHash);
      }
      record.status = 'sent';
      record.txHash = session.payoutTxHash || record.txHash || null;
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(item.sessionId, record);
      this._persist?.();
      return;
    }

    const start = Date.now();
    const payoutChoice = session.payoutChoice || {
      asset: ASSET.ZNN,
      address: session.playerAddress,
      amount: session.payoutAmount,
    };
    console.log(`[payout] Processing: ${item.sessionId} | attempt ${item.attempts + 1} | ${payoutChoice.amount} ${payoutChoice.asset} → ${payoutChoice.address}`);
    record.status = 'processing';
    record.attempts = item.attempts + 1;
    record.lastAttemptAt = Date.now();
    record.lastUpdatedAt = Date.now();
    record.amount = payoutChoice.amount;
    record.asset = payoutChoice.asset;
    record.toAddress = payoutChoice.address;
    record.lastError = null;
    this._syncLedgerRecord(item.sessionId, record);
    this._persist?.();

    try {
      const treasuryAuth = await this._authorizeOrRequeue(item, {
        ledgerId: item.sessionId,
        amountZnn: payoutChoice.asset === ASSET.ZNN ? payoutChoice.amount : 0,
        toAddress: payoutChoice.address,
        reason: 'session_win',
        record,
      });
      if (!treasuryAuth.ok) return;

      const result = payoutChoice.asset === ASSET.BTC
        ? await sendBtcPayout({
          address: payoutChoice.address,
          amountBtc: payoutChoice.amount,
          walletRpcConfig: {
            url: this.serverConfig.BTC_WALLET_RPC_URL,
            username: this.serverConfig.BTC_WALLET_RPC_USER,
            password: this.serverConfig.BTC_WALLET_RPC_PASS,
            wallet: this.serverConfig.BTC_WALLET_RPC_WALLET || null,
          },
        })
        : await sendPayout({
          mnemonic: this.serverConfig.PLATFORM_SEED,
          toAddress: payoutChoice.address,
          amount:    payoutChoice.amount,
          nodeUrl:   this.serverConfig.ZNN_NODE_URL,
        });

      this.sessions.payoutSent(item.sessionId, result.txHash);
      record.status = 'sent';
      record.txHash = result.txHash;
      record.sentAt = Date.now();
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(item.sessionId, record);
      const duration = Date.now() - start;
      console.log(`[payout] ✓ ${payoutChoice.amount} ${payoutChoice.asset} → ${payoutChoice.address} | tx: ${result.txHash} | ${duration}ms`);

      if (this.adminCtrl) {
        this.adminCtrl.payouts.recordSent(item.sessionId, payoutChoice.amount, duration);
        this.adminCtrl.health.recordSuccess(payoutChoice.asset === ASSET.BTC ? 'btcWallet' : 'zenonNode');
        this.adminCtrl.recordBotAction({
          action:     'payout_sent',
          params:     { sessionId: item.sessionId, amount: payoutChoice.amount, asset: payoutChoice.asset },
          success:    true,
          result:     { txHash: result.txHash },
          durationMs: duration,
        });
      }
      if (payoutChoice.asset === ASSET.ZNN) {
        this.treasury?.recordPayoutSent({
          ledgerId: item.sessionId,
          amountZnn: payoutChoice.amount,
          txHash: result.txHash,
          toAddress: payoutChoice.address,
          kind: 'session_win',
        });
      }
      this._persist?.();

    } catch (err) {
      const maxRetries = config.get('payouts.maxRetries') || 3;
      const willRetry  = item.attempts + 1 < maxRetries;
      record.lastError = err.message;
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(item.sessionId, record);

      console.error(`[payout] ✗ Failed: ${item.sessionId} | attempt ${item.attempts + 1}/${maxRetries} | ${err.message}`);

      if (this.adminCtrl) {
        this.adminCtrl.payouts.recordFailed(item.sessionId, err.message, willRetry);
        this.adminCtrl.health.recordFailure('zenonNode', err.message);
        this.adminCtrl.recordBotAction({
          action:  'payout_failed',
          params:  { sessionId: item.sessionId, attempt: item.attempts + 1 },
          success: false,
          error:   err.message,
        });
      }
      if (payoutChoice.asset === ASSET.ZNN) {
        this.treasury?.recordPayoutFailed({
          ledgerId: item.sessionId,
          amountZnn: payoutChoice.amount,
          error: err.message,
          toAddress: payoutChoice.address,
          kind: 'session_win',
        });
      }

      if (willRetry && !this.adminCtrl?.payouts.isCircuitOpen()) {
        // Exponential backoff: 30s, 60s, 120s...
        const baseDelay = config.get('payouts.retryDelayMs') || 30000;
        const delay     = baseDelay * Math.pow(2, item.attempts);
        item.attempts++;
        item.nextAttemptAt = Date.now() + delay;
        this.payoutQueue.push(item);
        this._store?.upsertPayoutQueueItem(item);
        record.status = 'retry_scheduled';
        record.nextAttemptAt = item.nextAttemptAt;
        this._syncLedgerRecord(item.sessionId, record);
        // Session stays GAME_WON for retry
        this.sessions.setState(item.sessionId, STATE.GAME_WON, { note: `retry ${item.attempts} in ${Math.round(delay/1000)}s` });
        console.log(`[payout] Retry ${item.attempts} scheduled in ${Math.round(delay/1000)}s`);
        this._persist?.();
      } else {
        this.sessions.payoutFailed(item.sessionId, `Max retries exceeded: ${err.message}`);
        record.status = 'failed';
        record.failedAt = Date.now();
        this._syncLedgerRecord(item.sessionId, record);
        console.error(`[payout] GAVE UP on ${item.sessionId} after ${item.attempts + 1} attempts`);
        this._persist?.();
      }
    }
  }

  // ── STATUS ────────────────────────────────────────────────

  getQueueStatus() {
    const items = this._store
      ? this._store.getPayoutQueueStatus()
      : this.payoutQueue.map(q => ({
          sessionId: q.sessionId,
          attempts: q.attempts,
          nextAttemptAt: q.nextAttemptAt,
        }));
    return {
      depth:         items.length,
      items:         items.map(q => ({
        sessionId: q.sessionId,
        attempts: q.attempts,
        nextAttemptAt: q.nextAttemptAt,
        waitMs: Math.max(0, q.nextAttemptAt - Date.now()),
      })),
      circuitOpen:   this.adminCtrl?.payouts.isCircuitOpen() || false,
    };
  }

  // Force-reset the circuit breaker (admin action)
  forceResetCircuit() {
    this.adminCtrl?.payouts.forceResetCircuit();
  }

  getPayoutRecord(sessionId) {
    if (this._store) return this._store.getPayoutLedgerRecord(sessionId);
    return this.payoutLedger.get(sessionId) || null;
  }

  queueMarketPayout(positionId, payoutKind) {
    if (!this.markets) return null;
    const pos = this.markets.getPosition(positionId);
    if (!pos) return null;

    const ledgerId = `market:${positionId}`;
    const record = this._ensureLedgerRecord(ledgerId, {
      state: pos.state,
      payoutAmount: payoutKind === 'refund' ? pos.amountZnn : pos.potentialPayout,
      playerAddress: pos.playerAddress,
      payoutTxHash: pos.payoutTxHash,
    }, payoutKind);
    if (record.status === 'sent') return record;

    const already = this.payoutQueue.find(q => q.sessionId === ledgerId);
    if (!already) {
      this.payoutQueue.push({ sessionId: ledgerId, attempts: 0, nextAttemptAt: Date.now(), kind: payoutKind });
      this._store?.upsertPayoutQueueItem({ sessionId: ledgerId, attempts: 0, nextAttemptAt: Date.now(), kind: payoutKind });
      record.status = 'queued';
      record.lastQueuedAt = Date.now();
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(ledgerId, record);
      if (this.adminCtrl) this.adminCtrl.payouts.recordQueued(ledgerId);
      this._persist?.();
    }
    return record;
  }

  async _processMarketPayout(item) {
    if (!this.markets) return;
    const positionId = item.sessionId.replace(/^market:/, '');
    const payoutItem = this.markets.takeDuePayout(positionId);
    const pos = this.markets.getPosition(positionId);
    if (!payoutItem || !pos) return;

    const payoutKind = payoutItem.type;
    const amount = payoutKind === 'refund' ? pos.amountZnn : pos.potentialPayout;
    const record = this._ensureLedgerRecord(item.sessionId, {
      state: pos.state,
      payoutAmount: amount,
      playerAddress: pos.playerAddress,
      payoutTxHash: pos.payoutTxHash,
    }, payoutKind);

    if (record.status === 'sent' || pos.state === 'PAID' || pos.payoutTxHash) {
      if (pos.state !== 'PAID' && pos.payoutTxHash) {
        this.markets.markPositionPaid(positionId, pos.payoutTxHash, payoutKind);
      }
      record.status = 'sent';
      record.txHash = pos.payoutTxHash || record.txHash || null;
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(item.sessionId, record);
      this._persist?.();
      return;
    }

    record.status = 'processing';
    record.attempts = item.attempts + 1;
    record.lastAttemptAt = Date.now();
    record.lastUpdatedAt = Date.now();
    record.amount = amount;
    record.toAddress = pos.playerAddress;
    record.lastError = null;
    this._syncLedgerRecord(item.sessionId, record);
    this._persist?.();

    try {
      const treasuryAuth = await this._authorizeOrRequeue(item, {
        ledgerId: item.sessionId,
        amountZnn: amount,
        toAddress: pos.playerAddress,
        reason: payoutKind === 'refund' ? 'market_refund' : 'market_win',
        record,
        marketPositionId: positionId,
        payoutKind,
      });
      if (!treasuryAuth.ok) return;

      const result = await sendPayout({
        mnemonic: this.serverConfig.PLATFORM_SEED,
        toAddress: pos.playerAddress,
        amount,
        nodeUrl: this.serverConfig.ZNN_NODE_URL,
      });

      this.markets.markPositionPaid(positionId, result.txHash, payoutKind);
      record.status = 'sent';
      record.txHash = result.txHash;
      record.sentAt = Date.now();
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(item.sessionId, record);

      if (this.adminCtrl) {
        this.adminCtrl.payouts.recordSent(item.sessionId, amount, 0);
        this.adminCtrl.health.recordSuccess('zenonNode');
        this.adminCtrl.recordBotAction({
          action: 'market_payout_sent',
          params: { positionId, payoutKind, amountZnn: amount },
          success: true,
          result: { txHash: result.txHash },
          durationMs: 0,
        });
      }
      this.treasury?.recordPayoutSent({
        ledgerId: item.sessionId,
        amountZnn: amount,
        txHash: result.txHash,
        toAddress: pos.playerAddress,
        kind: payoutKind,
      });
      this._persist?.();
    } catch (err) {
      const maxRetries = config.get('payouts.maxRetries') || 3;
      const willRetry = item.attempts + 1 < maxRetries;
      record.lastError = err.message;
      record.lastUpdatedAt = Date.now();
      this._syncLedgerRecord(item.sessionId, record);

      if (this.adminCtrl) {
        this.adminCtrl.payouts.recordFailed(item.sessionId, err.message, willRetry);
        this.adminCtrl.health.recordFailure('zenonNode', err.message);
        this.adminCtrl.recordBotAction({
          action: 'market_payout_failed',
          params: { positionId, payoutKind, attempt: item.attempts + 1 },
          success: false,
          error: err.message,
        });
      }
      this.treasury?.recordPayoutFailed({
        ledgerId: item.sessionId,
        amountZnn: amount,
        error: err.message,
        toAddress: pos.playerAddress,
        kind: payoutKind,
      });

      if (willRetry && !this.adminCtrl?.payouts.isCircuitOpen()) {
        const baseDelay = config.get('payouts.retryDelayMs') || 30000;
        const delay = baseDelay * Math.pow(2, item.attempts);
        item.attempts++;
        item.nextAttemptAt = Date.now() + delay;
        this.payoutQueue.push(item);
        this._store?.upsertPayoutQueueItem(item);
        this.markets.payoutQueue.push({ positionId, type: payoutKind });
        record.status = 'retry_scheduled';
        record.nextAttemptAt = item.nextAttemptAt;
        this._syncLedgerRecord(item.sessionId, record);
      } else {
        record.status = 'failed';
        record.failedAt = Date.now();
        this._syncLedgerRecord(item.sessionId, record);
      }
      this._persist?.();
    }
  }

  _ensureLedgerRecord(sessionId, session = null, reason = 'session_win') {
    const existing = this.payoutLedger.get(sessionId);
    if (existing) return existing;

    const s = session || this.sessions.get(sessionId);
    const record = {
      sessionId,
      state: s?.state || null,
      amount: s?.payoutAmount ?? null,
      toAddress: s?.playerAddress || null,
      reason,
      asset: s?.payoutChoice?.asset || null,
      status: s?.payoutTxHash ? 'sent' : 'created',
      txHash: s?.payoutTxHash || null,
      attempts: 0,
      lastAttemptAt: null,
      lastQueuedAt: null,
      nextAttemptAt: null,
      sentAt: s?.payoutTxHash ? Date.now() : null,
      failedAt: null,
      lastError: null,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };
    this.payoutLedger.set(sessionId, record);
    this._syncLedgerRecord(sessionId, record);
    return record;
  }

  exportState() {
    return {
      payoutQueue: this.payoutQueue.slice(),
      payoutLedger: Array.from(this.payoutLedger.entries()),
    };
  }

  importState(state = {}) {
    const queue = this._store ? this._store.getPayoutQueue() : (state.payoutQueue || []);
    const ledger = this._store ? this._store.getPayoutLedger() : (state.payoutLedger || []);
    this.payoutQueue = queue;
    this.payoutLedger = new Map(ledger);
  }

  async _authorizeOrRequeue(item, { ledgerId, amountZnn, toAddress, reason, record, marketPositionId = null, payoutKind = null }) {
    if (!amountZnn || amountZnn <= 0) return { ok: true };
    if (!this.treasury) return { ok: true };

    const auth = await this.treasury.authorizePayout({ ledgerId, amountZnn, toAddress, reason });
    if (auth.ok) return auth;

    record.status = 'blocked_treasury';
    record.lastError = auth.reason;
    record.nextAttemptAt = auth.retryAt;
    record.lastUpdatedAt = Date.now();
    this.payoutQueue.push({
      ...item,
      nextAttemptAt: auth.retryAt,
    });
    this._store?.upsertPayoutQueueItem({
      ...item,
      nextAttemptAt: auth.retryAt,
    });

    if (marketPositionId && payoutKind && this.markets) {
      this.markets.payoutQueue.push({ positionId: marketPositionId, type: payoutKind });
      this.markets._store?.enqueueMarketPayout({ positionId: marketPositionId, type: payoutKind });
    }

    this._syncLedgerRecord(ledgerId, record);
    console.warn(`[payout] Treasury blocked ${ledgerId}: ${auth.reason}`);
    this._persist?.();
    return auth;
  }

  _syncLedgerRecord(sessionId, record) {
    this._store?.upsertPayoutLedgerRecord(sessionId, record);
  }
}

module.exports = { PayoutWorker };
