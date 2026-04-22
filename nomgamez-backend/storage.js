const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class PersistentStateStore {
  constructor(filePath, { legacyFilePath = null } = {}) {
    this.filePath = filePath;
    this.legacyFilePath = legacyFilePath;
    this.dir = path.dirname(filePath);
    this.saveTimer = null;
    this.saveDelayMs = 200;
    this.snapshotProvider = null;

    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this._initSchema();
    this._migrateLegacyState();
  }

  setSnapshotProvider(provider) {
    this.snapshotProvider = provider;
  }

  load() {
    try {
      const rows = this.db.prepare(`
        SELECT scope, payload
        FROM state_snapshots
      `).all();

      if (!rows.length) return null;

      const snapshot = {};
      for (const row of rows) {
        snapshot[row.scope] = JSON.parse(row.payload);
      }
      this._overlayStructuredState(snapshot);
      return snapshot;
    } catch (err) {
      console.error('[storage] Failed to load state from sqlite:', err.message);
      return null;
    }
  }

  scheduleSave() {
    if (!this.snapshotProvider) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), this.saveDelayMs);
  }

  saveNow() {
    if (!this.snapshotProvider) return;

    try {
      const snapshot = this.snapshotProvider();
      const upsert = this.db.prepare(`
        INSERT INTO state_snapshots (scope, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `);

      this.db.exec('BEGIN');
      try {
        for (const [scope, payload] of Object.entries(snapshot)) {
          upsert.run(scope, JSON.stringify(payload), Date.now());
        }
        this._persistStructuredState(snapshot);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      console.error('[storage] Failed to persist sqlite state:', err.message);
    }
  }

  appendTreasuryLedger(entry) {
    try {
      this.db.prepare(`
        INSERT INTO treasury_ledger (id, ts, type, ref_id, amount_znn, data_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        entry.id,
        entry.ts,
        entry.type,
        entry.refId || null,
        entry.amountZnn == null ? null : Number(entry.amountZnn),
        JSON.stringify(entry.data || {})
      );
    } catch (err) {
      console.error('[storage] Failed to append treasury ledger entry:', err.message);
    }
  }

  getRecentTreasuryLedger(limit = 100) {
    return this.db.prepare(`
      SELECT id, ts, type, ref_id, amount_znn, data_json
      FROM treasury_ledger
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      id: row.id,
      ts: row.ts,
      type: row.type,
      refId: row.ref_id,
      amountZnn: row.amount_znn,
      data: safeJson(row.data_json, {}),
    }));
  }

  appendTreasuryReconciliation(snapshot) {
    try {
      this.db.prepare(`
        INSERT INTO treasury_reconciliations (
          timestamp, ok, reason, source, balance_znn, min_reserve_znn,
          available_for_payout_znn, pending_liability_znn, headroom_znn,
          liability_counts_json, issues_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(timestamp) DO UPDATE SET
          ok = excluded.ok,
          reason = excluded.reason,
          source = excluded.source,
          balance_znn = excluded.balance_znn,
          min_reserve_znn = excluded.min_reserve_znn,
          available_for_payout_znn = excluded.available_for_payout_znn,
          pending_liability_znn = excluded.pending_liability_znn,
          headroom_znn = excluded.headroom_znn,
          liability_counts_json = excluded.liability_counts_json,
          issues_json = excluded.issues_json,
          error = excluded.error
      `).run(
        snapshot.timestamp,
        snapshot.ok ? 1 : 0,
        snapshot.reason || null,
        snapshot.source || null,
        nullableNumber(snapshot.balanceZnn),
        nullableNumber(snapshot.minReserveZnn),
        nullableNumber(snapshot.availableForPayoutZnn),
        nullableNumber(snapshot.pendingLiabilityZnn),
        nullableNumber(snapshot.headroomZnn),
        JSON.stringify(snapshot.liabilityCounts || {}),
        JSON.stringify(snapshot.issues || []),
        snapshot.error || null
      );
    } catch (err) {
      console.error('[storage] Failed to append treasury reconciliation:', err.message);
    }
  }

  getRecentTreasuryReconciliations(limit = 100) {
    return this.db.prepare(`
      SELECT timestamp, ok, reason, source, balance_znn, min_reserve_znn,
             available_for_payout_znn, pending_liability_znn, headroom_znn,
             liability_counts_json, issues_json, error
      FROM treasury_reconciliations
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      ok: !!row.ok,
      timestamp: row.timestamp,
      reason: row.reason,
      source: row.source,
      balanceZnn: row.balance_znn,
      minReserveZnn: row.min_reserve_znn,
      availableForPayoutZnn: row.available_for_payout_znn,
      pendingLiabilityZnn: row.pending_liability_znn,
      headroomZnn: row.headroom_znn,
      liabilityCounts: safeJson(row.liability_counts_json, {}),
      issues: safeJson(row.issues_json, []),
      error: row.error,
    }));
  }

  // ── SESSIONS ────────────────────────────────────────────

  getAllSessions() {
    return this.db.prepare(`
      SELECT payload_json
      FROM sessions
      ORDER BY created_at ASC
    `).all().map((row) => safeJson(row.payload_json, {}));
  }

  getSessionById(sessionId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM sessions
      WHERE id = ?
    `).get(sessionId);
    return row ? safeJson(row.payload_json, {}) : null;
  }

  countSessions() {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get().count;
  }

  getPendingSessions(now = Date.now()) {
    return this.db.prepare(`
      SELECT payload_json
      FROM sessions
      WHERE state = 'PENDING_DEPOSIT' AND expires_at > ?
      ORDER BY created_at ASC
    `).all(now).map((row) => safeJson(row.payload_json, {}));
  }

  getWinningSessions() {
    return this.db.prepare(`
      SELECT payload_json
      FROM sessions
      WHERE state = 'GAME_WON'
      ORDER BY created_at ASC
    `).all().map((row) => safeJson(row.payload_json, {}));
  }

  getSessionStats() {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM sessions
      GROUP BY state
    `).all();
    const counts = Object.fromEntries(rows.map((row) => [row.state, row.count]));
    return {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      pending: counts.PENDING_DEPOSIT || 0,
      active: counts.GAME_ACTIVE || 0,
      won: (counts.GAME_WON || 0) + (counts.AWAITING_PAYOUT_CHOICE || 0) + (counts.PAYOUT_SENT || 0),
      lost: counts.GAME_LOST || 0,
    };
  }

  upsertSession(session) {
    this.db.prepare(`
      INSERT INTO sessions (
        id, player_address, game_id, bet_amount, payout_amount, state,
        created_at, expires_at, deposit_tx_hash, payout_tx_hash, game_result,
        game_score, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        player_address = excluded.player_address,
        game_id = excluded.game_id,
        bet_amount = excluded.bet_amount,
        payout_amount = excluded.payout_amount,
        state = excluded.state,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        deposit_tx_hash = excluded.deposit_tx_hash,
        payout_tx_hash = excluded.payout_tx_hash,
        game_result = excluded.game_result,
        game_score = excluded.game_score,
        payload_json = excluded.payload_json
    `).run(
      session.id,
      session.playerAddress || null,
      session.gameId || null,
      nullableNumber(session.betAmount),
      nullableNumber(session.payoutAmount),
      session.state || null,
      nullableNumber(session.createdAt),
      nullableNumber(session.expiresAt),
      session.depositTxHash || null,
      session.payoutTxHash || null,
      session.gameResult || null,
      nullableNumber(session.gameScore),
      JSON.stringify(session)
    );
  }

  deleteSession(sessionId) {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  /**
   * Returns [hash, seen_at] pairs so TTL can be preserved across restarts.
   */
  getSeenHashes() {
    return this.db.prepare(`
      SELECT hash, seen_at
      FROM seen_hashes
      ORDER BY seen_at ASC
    `).all().map((row) => [row.hash, row.seen_at]);
  }

  /**
   * Fast O(1) single-hash lookup — avoids loading all hashes into memory.
   */
  isHashSeen(hash) {
    return !!this.db.prepare(`
      SELECT 1 FROM seen_hashes WHERE hash = ? LIMIT 1
    `).get(hash);
  }

  addSeenHash(hash) {
    this.db.prepare(`
      INSERT INTO seen_hashes (hash, seen_at)
      VALUES (?, ?)
      ON CONFLICT(hash) DO NOTHING
    `).run(hash, Date.now());
  }

  /**
   * Evict seen_hashes older than ttlMs from the DB.
   * Called by the cleanup scheduler to mirror the in-memory eviction.
   */
  evictOldSeenHashes(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    const result = this.db.prepare(`
      DELETE FROM seen_hashes WHERE seen_at < ?
    `).run(cutoff);
    if (result.changes > 0)
      console.log(`[storage] Evicted ${result.changes} stale tx hashes from DB`);
  }

  // ── MARKETS ─────────────────────────────────────────────

  getAllMarkets() {
    return this.db.prepare(`
      SELECT payload_json
      FROM markets
      ORDER BY created_at ASC
    `).all().map((row) => safeJson(row.payload_json, {}));
  }

  getMarketById(marketId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM markets
      WHERE id = ?
    `).get(marketId);
    return row ? safeJson(row.payload_json, {}) : null;
  }

  getOpenMarkets({ limit = 20, category = null } = {}) {
    const query = category
      ? `
        SELECT payload_json
        FROM markets
        WHERE state = 'OPEN' AND category = ?
        ORDER BY total_pool DESC
        LIMIT ?
      `
      : `
        SELECT payload_json
        FROM markets
        WHERE state = 'OPEN'
        ORDER BY total_pool DESC
        LIMIT ?
      `;
    const rows = category
      ? this.db.prepare(query).all(category, limit)
      : this.db.prepare(query).all(limit);
    return rows.map((row) => safeJson(row.payload_json, {}));
  }

  getRecentlyResolvedMarkets(limit = 10) {
    return this.db.prepare(`
      SELECT payload_json
      FROM markets
      WHERE state = 'RESOLVED'
      ORDER BY resolved_at DESC
      LIMIT ?
    `).all(limit).map((row) => safeJson(row.payload_json, {}));
  }

  getMarketsDueForLocking(now = Date.now()) {
    return this.db.prepare(`
      SELECT payload_json
      FROM markets
      WHERE state = 'OPEN' AND resolves_at <= ?
      ORDER BY resolves_at ASC
    `).all(now).map((row) => safeJson(row.payload_json, {}));
  }

  getMarketsDueForResolution(now = Date.now()) {
    return this.db.prepare(`
      SELECT payload_json
      FROM markets
      WHERE state = 'LOCKED' AND resolves_at <= ?
      ORDER BY resolves_at ASC
    `).all(now).map((row) => safeJson(row.payload_json, {}));
  }

  getMarketStats() {
    const marketRows = this.db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM markets
      GROUP BY state
    `).all();
    const marketCounts = Object.fromEntries(marketRows.map((row) => [row.state, row.count]));
    const positionRow = this.db.prepare(`
      SELECT COUNT(*) AS total_positions, COALESCE(SUM(amount_znn), 0) AS total_volume
      FROM market_positions
    `).get();

    return {
      total: Object.values(marketCounts).reduce((sum, count) => sum + count, 0),
      open: marketCounts.OPEN || 0,
      locked: marketCounts.LOCKED || 0,
      resolved: marketCounts.RESOLVED || 0,
      totalPositions: positionRow.total_positions || 0,
      totalVolume: Number(positionRow.total_volume || 0),
    };
  }

  upsertMarket(market) {
    this.db.prepare(`
      INSERT INTO markets (
        id, question, description, category, type, resolves_at, created_at,
        creator_address, state, yes_pool, no_pool, total_pool, max_pool,
        position_count, outcome, resolved_at, platform_fee, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        description = excluded.description,
        category = excluded.category,
        type = excluded.type,
        resolves_at = excluded.resolves_at,
        created_at = excluded.created_at,
        creator_address = excluded.creator_address,
        state = excluded.state,
        yes_pool = excluded.yes_pool,
        no_pool = excluded.no_pool,
        total_pool = excluded.total_pool,
        max_pool = excluded.max_pool,
        position_count = excluded.position_count,
        outcome = excluded.outcome,
        resolved_at = excluded.resolved_at,
        platform_fee = excluded.platform_fee,
        payload_json = excluded.payload_json
    `).run(
      market.id,
      market.question || null,
      market.description || null,
      market.category || null,
      market.type || null,
      nullableNumber(market.resolvesAt),
      nullableNumber(market.createdAt),
      market.creatorAddress || null,
      market.state || null,
      nullableNumber(market.yesPool),
      nullableNumber(market.noPool),
      nullableNumber(market.totalPool),
      nullableNumber(market.maxPool),
      nullableNumber(market.positionCount),
      market.outcome || null,
      nullableNumber(market.resolvedAt),
      nullableNumber(market.platformFee),
      JSON.stringify(market)
    );
  }

  deleteMarket(marketId) {
    this.db.prepare(`DELETE FROM markets WHERE id = ?`).run(marketId);
  }

  getAllPositions() {
    return this.db.prepare(`
      SELECT payload_json
      FROM market_positions
      ORDER BY created_at ASC
    `).all().map((row) => safeJson(row.payload_json, {}));
  }

  getPositionById(positionId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM market_positions
      WHERE id = ?
    `).get(positionId);
    return row ? safeJson(row.payload_json, {}) : null;
  }

  getPositionsByMarketId(marketId) {
    return this.db.prepare(`
      SELECT payload_json
      FROM market_positions
      WHERE market_id = ?
      ORDER BY created_at ASC
    `).all(marketId).map((row) => safeJson(row.payload_json, {}));
  }

  getPositionsByPlayerAddress(playerAddress) {
    return this.db.prepare(`
      SELECT payload_json
      FROM market_positions
      WHERE player_address = ?
      ORDER BY created_at DESC
    `).all(playerAddress).map((row) => safeJson(row.payload_json, {}));
  }

  upsertPosition(position) {
    this.db.prepare(`
      INSERT INTO market_positions (
        id, market_id, player_address, side, amount_znn, potential_payout,
        state, created_at, funded_at, deposit_tx_hash, payout_tx_hash,
        payout_kind, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        market_id = excluded.market_id,
        player_address = excluded.player_address,
        side = excluded.side,
        amount_znn = excluded.amount_znn,
        potential_payout = excluded.potential_payout,
        state = excluded.state,
        created_at = excluded.created_at,
        funded_at = excluded.funded_at,
        deposit_tx_hash = excluded.deposit_tx_hash,
        payout_tx_hash = excluded.payout_tx_hash,
        payout_kind = excluded.payout_kind,
        payload_json = excluded.payload_json
    `).run(
      position.id,
      position.marketId || null,
      position.playerAddress || null,
      position.side || null,
      nullableNumber(position.amountZnn),
      nullableNumber(position.potentialPayout),
      position.state || null,
      nullableNumber(position.createdAt),
      nullableNumber(position.fundedAt),
      position.depositTxHash || null,
      position.payoutTxHash || null,
      position.payoutKind || null,
      JSON.stringify(position)
    );
  }

  deletePosition(positionId) {
    this.db.prepare(`DELETE FROM market_positions WHERE id = ?`).run(positionId);
  }

  getMarketPayoutQueue() {
    return this.db.prepare(`
      SELECT position_id, type
      FROM market_payout_queue
      ORDER BY queued_at ASC
    `).all().map((row) => ({ positionId: row.position_id, type: row.type }));
  }

  getPositionsDueForPayout(limit = 10) {
    return this.db.prepare(`
      SELECT q.position_id, q.type
      FROM market_payout_queue q
      JOIN market_positions p ON p.id = q.position_id
      WHERE (q.type = 'win' AND p.state = 'WON')
         OR (q.type = 'refund' AND p.state = 'REFUNDED')
      ORDER BY q.queued_at ASC
      LIMIT ?
    `).all(limit).map((row) => ({ positionId: row.position_id, type: row.type }));
  }

  enqueueMarketPayout(item) {
    this.db.prepare(`
      INSERT INTO market_payout_queue (position_id, type, queued_at)
      VALUES (?, ?, ?)
      ON CONFLICT(position_id, type) DO NOTHING
    `).run(item.positionId, item.type, Date.now());
  }

  dequeueMarketPayout(positionId, type = null) {
    if (type) {
      this.db.prepare(`
        DELETE FROM market_payout_queue
        WHERE position_id = ? AND type = ?
      `).run(positionId, type);
      return;
    }
    this.db.prepare(`
      DELETE FROM market_payout_queue
      WHERE position_id = ?
    `).run(positionId);
  }

  // ── PAYOUT WORKER ───────────────────────────────────────

  getPayoutQueue() {
    return this.db.prepare(`
      SELECT payload_json
      FROM payout_queue
      ORDER BY next_attempt_at ASC
    `).all().map((row) => safeJson(row.payload_json, {}));
  }

  getPayoutQueueStatus() {
    return this.db.prepare(`
      SELECT session_id, attempts, next_attempt_at
      FROM payout_queue
      ORDER BY next_attempt_at ASC
    `).all().map((row) => ({
      sessionId: row.session_id,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  upsertPayoutQueueItem(item) {
    this.db.prepare(`
      INSERT INTO payout_queue (
        session_id, attempts, next_attempt_at, kind, payload_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        attempts = excluded.attempts,
        next_attempt_at = excluded.next_attempt_at,
        kind = excluded.kind,
        payload_json = excluded.payload_json
    `).run(
      item.sessionId,
      Number(item.attempts || 0),
      Number(item.nextAttemptAt || Date.now()),
      item.kind || null,
      JSON.stringify(item)
    );
  }

  deletePayoutQueueItem(sessionId) {
    this.db.prepare(`DELETE FROM payout_queue WHERE session_id = ?`).run(sessionId);
  }

  getPayoutLedger() {
    return this.db.prepare(`
      SELECT session_id, payload_json
      FROM payout_ledger
      ORDER BY created_at ASC
    `).all().map((row) => [row.session_id, safeJson(row.payload_json, {})]);
  }

  getPayoutLedgerRecord(sessionId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM payout_ledger
      WHERE session_id = ?
    `).get(sessionId);
    return row ? safeJson(row.payload_json, {}) : null;
  }

  upsertPayoutLedgerRecord(sessionId, record) {
    this.db.prepare(`
      INSERT INTO payout_ledger (
        session_id, state, amount, to_address, reason, status, tx_hash,
        attempts, last_attempt_at, last_queued_at, next_attempt_at, sent_at,
        failed_at, last_error, created_at, last_updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state = excluded.state,
        amount = excluded.amount,
        to_address = excluded.to_address,
        reason = excluded.reason,
        status = excluded.status,
        tx_hash = excluded.tx_hash,
        attempts = excluded.attempts,
        last_attempt_at = excluded.last_attempt_at,
        last_queued_at = excluded.last_queued_at,
        next_attempt_at = excluded.next_attempt_at,
        sent_at = excluded.sent_at,
        failed_at = excluded.failed_at,
        last_error = excluded.last_error,
        created_at = excluded.created_at,
        last_updated_at = excluded.last_updated_at,
        payload_json = excluded.payload_json
    `).run(
      sessionId,
      record.state || null,
      nullableNumber(record.amount),
      record.toAddress || null,
      record.reason || null,
      record.status || null,
      record.txHash || null,
      nullableNumber(record.attempts),
      nullableNumber(record.lastAttemptAt),
      nullableNumber(record.lastQueuedAt),
      nullableNumber(record.nextAttemptAt),
      nullableNumber(record.sentAt),
      nullableNumber(record.failedAt),
      record.lastError || null,
      nullableNumber(record.createdAt),
      nullableNumber(record.lastUpdatedAt),
      JSON.stringify(record)
    );
  }

  _initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- FULL sync: every write is flushed before the call returns.
      -- Slower than NORMAL but eliminates data loss on power failure.
      -- Required for a real-money platform.
      PRAGMA synchronous = FULL;
      -- Keep WAL auto-checkpointed at a reasonable size
      PRAGMA wal_autocheckpoint = 1000;

      CREATE TABLE IF NOT EXISTS state_snapshots (
        scope TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS treasury_ledger (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        ref_id TEXT,
        amount_znn REAL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS treasury_reconciliations (
        timestamp INTEGER PRIMARY KEY,
        ok INTEGER NOT NULL,
        reason TEXT,
        source TEXT,
        balance_znn REAL,
        min_reserve_znn REAL,
        available_for_payout_znn REAL,
        pending_liability_znn REAL,
        headroom_znn REAL,
        liability_counts_json TEXT NOT NULL,
        issues_json TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        player_address TEXT,
        game_id TEXT,
        bet_amount REAL,
        payout_amount REAL,
        state TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        deposit_tx_hash TEXT,
        payout_tx_hash TEXT,
        game_result TEXT,
        game_score REAL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seen_hashes (
        hash TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY,
        question TEXT,
        description TEXT,
        category TEXT,
        type TEXT,
        resolves_at INTEGER,
        created_at INTEGER,
        creator_address TEXT,
        state TEXT,
        yes_pool REAL,
        no_pool REAL,
        total_pool REAL,
        max_pool REAL,
        position_count INTEGER,
        outcome TEXT,
        resolved_at INTEGER,
        platform_fee REAL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_positions (
        id TEXT PRIMARY KEY,
        market_id TEXT,
        player_address TEXT,
        side TEXT,
        amount_znn REAL,
        potential_payout REAL,
        state TEXT,
        created_at INTEGER,
        funded_at INTEGER,
        deposit_tx_hash TEXT,
        payout_tx_hash TEXT,
        payout_kind TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_payout_queue (
        position_id TEXT NOT NULL,
        type TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        PRIMARY KEY (position_id, type)
      );

      CREATE TABLE IF NOT EXISTS payout_queue (
        session_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        kind TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payout_ledger (
        session_id TEXT PRIMARY KEY,
        state TEXT,
        amount REAL,
        to_address TEXT,
        reason TEXT,
        status TEXT,
        tx_hash TEXT,
        attempts INTEGER,
        last_attempt_at INTEGER,
        last_queued_at INTEGER,
        next_attempt_at INTEGER,
        sent_at INTEGER,
        failed_at INTEGER,
        last_error TEXT,
        created_at INTEGER,
        last_updated_at INTEGER,
        payload_json TEXT NOT NULL
      );

      -- ── INDEXES ─────────────────────────────────────────
      -- These cover the hot query paths and prevent full-table scans.

      -- Sessions: deposit polling reads by state + expiry
      CREATE INDEX IF NOT EXISTS idx_sessions_state
        ON sessions(state, expires_at);

      -- Sessions: player history lookup
      CREATE INDEX IF NOT EXISTS idx_sessions_player
        ON sessions(player_address);

      -- Markets: open market listing (most common read)
      CREATE INDEX IF NOT EXISTS idx_markets_state_pool
        ON markets(state, total_pool DESC);

      -- Markets: category filter (sports vs crypto)
      CREATE INDEX IF NOT EXISTS idx_markets_category
        ON markets(category, state);

      -- Markets: resolution due-date scan
      CREATE INDEX IF NOT EXISTS idx_markets_resolves_at
        ON markets(resolves_at, state);

      -- Positions: market breakdown
      CREATE INDEX IF NOT EXISTS idx_positions_market
        ON market_positions(market_id, state);

      -- Positions: player history
      CREATE INDEX IF NOT EXISTS idx_positions_player
        ON market_positions(player_address);

      -- Payout queue: next-up ordering
      CREATE INDEX IF NOT EXISTS idx_payout_queue_next
        ON payout_queue(next_attempt_at);

      -- Seen hashes: TTL eviction scan
      CREATE INDEX IF NOT EXISTS idx_seen_hashes_seen_at
        ON seen_hashes(seen_at);
    `);
  }

  _migrateLegacyState() {
    if (!this.legacyFilePath || !fs.existsSync(this.legacyFilePath)) return;

    const existing = this.db.prepare(`SELECT COUNT(*) AS count FROM state_snapshots`).get();
    if (existing.count > 0) return;

    try {
      const legacy = JSON.parse(fs.readFileSync(this.legacyFilePath, 'utf8'));
      const upsert = this.db.prepare(`
        INSERT INTO state_snapshots (scope, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `);

      this.db.exec('BEGIN');
      try {
        for (const [scope, payload] of Object.entries(legacy)) {
          upsert.run(scope, JSON.stringify(payload), Date.now());
        }
        this._persistStructuredState(legacy);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      console.log(`[storage] Migrated legacy runtime state from ${this.legacyFilePath}`);
    } catch (err) {
      console.error('[storage] Failed to migrate legacy runtime state:', err.message);
    }
  }

  _overlayStructuredState(snapshot) {
    const sessionCount = this.db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get().count;
    if (sessionCount > 0) {
      snapshot.sessions = {
        sessions: this.db.prepare(`SELECT payload_json FROM sessions ORDER BY created_at ASC`).all().map((row) => safeJson(row.payload_json, {})),
        seenHashes: this.db.prepare(`SELECT hash, seen_at FROM seen_hashes ORDER BY seen_at ASC`).all().map((row) => [row.hash, row.seen_at]),
      };
    }

    const marketCount = this.db.prepare(`SELECT COUNT(*) AS count FROM markets`).get().count;
    if (marketCount > 0) {
      snapshot.markets = {
        markets: this.db.prepare(`SELECT payload_json FROM markets ORDER BY created_at ASC`).all().map((row) => safeJson(row.payload_json, {})),
        positions: this.db.prepare(`SELECT payload_json FROM market_positions ORDER BY created_at ASC`).all().map((row) => safeJson(row.payload_json, {})),
        payoutQueue: this.db.prepare(`SELECT position_id, type FROM market_payout_queue ORDER BY queued_at ASC`).all().map((row) => ({
          positionId: row.position_id,
          type: row.type,
        })),
      };
    }

    const payoutQueueCount = this.db.prepare(`SELECT COUNT(*) AS count FROM payout_queue`).get().count;
    const payoutLedgerCount = this.db.prepare(`SELECT COUNT(*) AS count FROM payout_ledger`).get().count;
    if (payoutQueueCount > 0 || payoutLedgerCount > 0) {
      snapshot.payoutWorker = {
        payoutQueue: this.db.prepare(`SELECT payload_json FROM payout_queue ORDER BY next_attempt_at ASC`).all().map((row) => safeJson(row.payload_json, {})),
        payoutLedger: this.db.prepare(`SELECT session_id, payload_json FROM payout_ledger ORDER BY created_at ASC`).all().map((row) => [
          row.session_id,
          safeJson(row.payload_json, {}),
        ]),
      };
    }
  }

  _persistStructuredState(snapshot) {
    if (snapshot.sessions) this._persistSessions(snapshot.sessions);
    if (snapshot.markets) this._persistMarkets(snapshot.markets);
    if (snapshot.payoutWorker) this._persistPayoutWorker(snapshot.payoutWorker);
  }

  _persistSessions(state) {
    this.db.prepare(`DELETE FROM sessions`).run();
    this.db.prepare(`DELETE FROM seen_hashes`).run();

    const insertSession = this.db.prepare(`
      INSERT INTO sessions (
        id, player_address, game_id, bet_amount, payout_amount, state,
        created_at, expires_at, deposit_tx_hash, payout_tx_hash, game_result,
        game_score, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertHash = this.db.prepare(`
      INSERT INTO seen_hashes (hash, seen_at)
      VALUES (?, ?)
    `);

    for (const session of state.sessions || []) {
      insertSession.run(
        session.id,
        session.playerAddress || null,
        session.gameId || null,
        nullableNumber(session.betAmount),
        nullableNumber(session.payoutAmount),
        session.state || null,
        nullableNumber(session.createdAt),
        nullableNumber(session.expiresAt),
        session.depositTxHash || null,
        session.payoutTxHash || null,
        session.gameResult || null,
        nullableNumber(session.gameScore),
        JSON.stringify(session)
      );
    }

    for (const entry of state.seenHashes || []) {
      // Support both old format (string) and new format ([hash, seenAt])
      const [hash, seenAt] = Array.isArray(entry) ? entry : [entry, Date.now()];
      insertHash.run(hash, seenAt);
    }
  }

  _persistMarkets(state) {
    this.db.prepare(`DELETE FROM markets`).run();
    this.db.prepare(`DELETE FROM market_positions`).run();
    this.db.prepare(`DELETE FROM market_payout_queue`).run();

    const insertMarket = this.db.prepare(`
      INSERT INTO markets (
        id, question, description, category, type, resolves_at, created_at,
        creator_address, state, yes_pool, no_pool, total_pool, max_pool,
        position_count, outcome, resolved_at, platform_fee, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPosition = this.db.prepare(`
      INSERT INTO market_positions (
        id, market_id, player_address, side, amount_znn, potential_payout,
        state, created_at, funded_at, deposit_tx_hash, payout_tx_hash,
        payout_kind, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertQueue = this.db.prepare(`
      INSERT INTO market_payout_queue (position_id, type, queued_at)
      VALUES (?, ?, ?)
    `);

    for (const market of state.markets || []) {
      insertMarket.run(
        market.id,
        market.question || null,
        market.description || null,
        market.category || null,
        market.type || null,
        nullableNumber(market.resolvesAt),
        nullableNumber(market.createdAt),
        market.creatorAddress || null,
        market.state || null,
        nullableNumber(market.yesPool),
        nullableNumber(market.noPool),
        nullableNumber(market.totalPool),
        nullableNumber(market.maxPool),
        nullableNumber(market.positionCount),
        market.outcome || null,
        nullableNumber(market.resolvedAt),
        nullableNumber(market.platformFee),
        JSON.stringify(market)
      );
    }

    for (const position of state.positions || []) {
      insertPosition.run(
        position.id,
        position.marketId || null,
        position.playerAddress || null,
        position.side || null,
        nullableNumber(position.amountZnn),
        nullableNumber(position.potentialPayout),
        position.state || null,
        nullableNumber(position.createdAt),
        nullableNumber(position.fundedAt),
        position.depositTxHash || null,
        position.payoutTxHash || null,
        position.payoutKind || null,
        JSON.stringify(position)
      );
    }

    for (const item of state.payoutQueue || []) {
      insertQueue.run(item.positionId, item.type, Date.now());
    }
  }

  _persistPayoutWorker(state) {
    this.db.prepare(`DELETE FROM payout_queue`).run();
    this.db.prepare(`DELETE FROM payout_ledger`).run();

    const insertQueue = this.db.prepare(`
      INSERT INTO payout_queue (
        session_id, attempts, next_attempt_at, kind, payload_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const insertLedger = this.db.prepare(`
      INSERT INTO payout_ledger (
        session_id, state, amount, to_address, reason, status, tx_hash,
        attempts, last_attempt_at, last_queued_at, next_attempt_at, sent_at,
        failed_at, last_error, created_at, last_updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of state.payoutQueue || []) {
      insertQueue.run(
        item.sessionId,
        Number(item.attempts || 0),
        Number(item.nextAttemptAt || Date.now()),
        item.kind || null,
        JSON.stringify(item)
      );
    }

    for (const [sessionId, record] of state.payoutLedger || []) {
      insertLedger.run(
        sessionId,
        record.state || null,
        nullableNumber(record.amount),
        record.toAddress || null,
        record.reason || null,
        record.status || null,
        record.txHash || null,
        nullableNumber(record.attempts),
        nullableNumber(record.lastAttemptAt),
        nullableNumber(record.lastQueuedAt),
        nullableNumber(record.nextAttemptAt),
        nullableNumber(record.sentAt),
        nullableNumber(record.failedAt),
        record.lastError || null,
        nullableNumber(record.createdAt),
        nullableNumber(record.lastUpdatedAt),
        JSON.stringify(record)
      );
    }
  }
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

module.exports = { PersistentStateStore };
