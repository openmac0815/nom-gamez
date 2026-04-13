const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PersistentStateStore } = require('../storage');
const { SessionManager, STATE } = require('../sessions');
const { MarketManager } = require('../markets');
const { PayoutWorker } = require('../payouts');

function makeStore(name) {
  const filePath = path.join(__dirname, '..', 'data', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  return {
    filePath,
    store: new PersistentStateStore(filePath),
    cleanup() {
      try { fs.unlinkSync(filePath); } catch (_) {}
    },
  };
}

test('sessions restore from sqlite-backed writes', () => {
  const { store, cleanup } = makeStore('sessions');
  try {
    const sessions = new SessionManager();
    sessions.setStore(store);

    const session = sessions.create({
      playerAddress: 'z1qa1234567890',
      gameId: 'dice',
      betAmount: 1,
      depositTimeout: 300,
    });

    sessions.depositFound(session.id, 'hash-session');
    sessions.depositConfirmed(session.id);
    sessions.gameStarted(session.id);
    sessions.gameEnded(session.id, { won: true, score: 77 });

    const restored = new SessionManager();
    restored.setStore(store);
    restored.importState({});

    assert.equal(restored.get(session.id).state, STATE.GAME_WON);
    assert.equal(restored.isHashSeen('hash-session'), true);
    assert.deepEqual(restored.stats(), {
      total: 1,
      pending: 0,
      active: 0,
      won: 1,
      lost: 0,
    });
  } finally {
    cleanup();
  }
});

test('markets restore reads and due queues from sqlite', () => {
  const { store, cleanup } = makeStore('markets');
  try {
    const markets = new MarketManager();
    markets.setStore(store);

    const openMarket = markets.createMarket({
      question: 'Will test market resolve yes?',
      type: 'custom',
      category: 'custom',
      resolvesAt: Date.now() + 5 * 60_000,
    });

    const lockedMarket = markets.createMarket({
      question: 'Will locked market be due?',
      type: 'custom',
      category: 'custom',
      resolvesAt: Date.now() + 5 * 60_000,
    });

    markets.lockMarket(lockedMarket.id);
    lockedMarket.resolvesAt = Date.now() - 1000;
    store.upsertMarket(lockedMarket);

    const position = markets.takePosition({
      marketId: openMarket.id,
      playerAddress: 'z1qb1234567890',
      side: 'yes',
      amountZnn: 1,
    });

    markets.confirmPositionDeposit(position.id, 'hash-market');
    markets.resolveMarket(openMarket.id, 'yes', 'test');

    const restored = new MarketManager();
    restored.setStore(store);
    restored.importState({});

    assert.equal(restored.getMarket(openMarket.id).state, 'RESOLVED');
    assert.equal(restored.getPosition(position.id).state, 'WON');
    assert.equal(restored.getPlayerPositions('z1qb1234567890').length, 1);
    assert.equal(restored.getRecentlyResolved({ limit: 10 }).length, 1);
    assert.equal(restored.getDueForResolution().length, 1);
    assert.equal(restored.getPositionsDueForPayout(10).length, 1);
  } finally {
    cleanup();
  }
});

test('payout worker queue and ledger restore from sqlite', () => {
  const { store, cleanup } = makeStore('payouts');
  try {
    const sessions = new SessionManager();
    sessions.setStore(store);
    const worker = new PayoutWorker({ sessionManager: sessions, marketManager: null, serverConfig: {} });
    worker.setStore(store);

    const session = sessions.create({
      playerAddress: 'z1qc1234567890',
      gameId: 'dice',
      betAmount: 1,
      depositTimeout: 300,
    });

    sessions.gameEnded(session.id, { won: true, score: 12 });
    worker.queuePayout(session.id);

    const restored = new PayoutWorker({ sessionManager: sessions, marketManager: null, serverConfig: {} });
    restored.setStore(store);
    restored.importState({});

    assert.equal(restored.getQueueStatus().depth, 1);
    assert.equal(restored.getPayoutRecord(session.id).sessionId, session.id);
  } finally {
    cleanup();
  }
});
