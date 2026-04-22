// server.js — NOM-GAMEZ Backend v2
// BTC-first gaming + prediction market platform on Zenon Network
// The experience is the product. Zenon is the infrastructure.

const logger = require('./logger');
logger.installConsoleFilters();
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');

const { config }              = require('./config');
const { SessionManager }      = require('./sessions');
const { PayoutWorker }        = require('./payouts');
const { verifyDeposit }       = require('./zenon');
const { verifyBtcDeposit }    = require('./btc');
const { MarketManager, publicMarket } = require('./markets');
const { verifyGameResult }    = require('./verifier');
const { Publisher }           = require('./publisher');
const { BotAgent }            = require('./bot');
const { FeedManager }         = require('./feed');
const { FreePlayManager }     = require('./freeplay');
const { AdminController }     = require('./admin');
const { PersistentStateStore } = require('./storage');
const { TreasuryManager }     = require('./treasury');
const { getGameSessionMetadata, getPublicGameDefinitions } = require('./games');
const { CreditManager } = require('./credits');
const { payoutLock }   = require('./payout-lock');
const { GameService, ServiceError } = require('./game-service');
const { CreditService }             = require('./credit-service');
const {
  ASSET,
  normalizeAsset,
  isValidAddressForAsset,
  getEnabledDepositAssets,
  getEnabledPayoutAssets,
  buildQuote,
  getPayoutOption,
  buildPaymentSummary,
} = require('./payment-rails');

// ─────────────────────────────────────────
// SERVER CONFIG  (from env — not in ConfigStore,
// these are deploy-time secrets/addresses)
// ─────────────────────────────────────────
const SERVER_CONFIG = {
  PLATFORM_SEED:    process.env.PLATFORM_SEED,
  PLATFORM_ADDRESS: process.env.PLATFORM_ADDRESS,
  BTC_DEPOSIT_ADDRESS: process.env.BTC_DEPOSIT_ADDRESS || '',
  ZNN_NODE_URL:     process.env.ZNN_NODE_URL     || 'wss://my.hc1node.com:35998',
  EXPLORER_API:     process.env.EXPLORER_API     || 'https://zenonhub.io/api',
  BTC_RPC_URL:      process.env.BTC_RPC_URL || '',
  BTC_RPC_USER:     process.env.BTC_RPC_USER || '',
  BTC_RPC_PASS:     process.env.BTC_RPC_PASS || '',
  BTC_MIN_CONFIRMATIONS: parseInt(process.env.BTC_MIN_CONFIRMATIONS) || 1,
  BTC_WALLET_RPC_URL:  process.env.BTC_WALLET_RPC_URL || '',
  BTC_WALLET_RPC_USER: process.env.BTC_WALLET_RPC_USER || '',
  BTC_WALLET_RPC_PASS: process.env.BTC_WALLET_RPC_PASS || '',
  BTC_WALLET_RPC_WALLET: process.env.BTC_WALLET_RPC_WALLET || '',
  PORT:             parseInt(process.env.PORT)   || 3001,
  HOST:             process.env.HOST || '127.0.0.1',
  CORS_ORIGIN:      process.env.CORS_ORIGIN      || '*',
  DEPOSIT_TIMEOUT:  parseInt(process.env.DEPOSIT_TIMEOUT) || 300,
  MAX_SESSIONS:     parseInt(process.env.MAX_SESSIONS)    || 100,
  BOT_ENABLED:      process.env.BOT_ENABLED !== 'false',
  ADMIN_TOKEN:      process.env.ADMIN_TOKEN || '',
  ENABLE_UNSAFE_MARKETS:      process.env.ENABLE_UNSAFE_MARKETS === 'true',
  ENABLE_UNSAFE_FREEPLAY:     process.env.ENABLE_UNSAFE_FREEPLAY === 'true',
  TEST_MODE_ENABLED: process.env.TEST_MODE_ENABLED === 'true',
};

if (!SERVER_CONFIG.PLATFORM_SEED)    { console.error('ERROR: PLATFORM_SEED not set'); process.exit(1); }
if (!SERVER_CONFIG.PLATFORM_ADDRESS) { console.error('ERROR: PLATFORM_ADDRESS not set'); process.exit(1); }

// ─────────────────────────────────────────
// INIT SYSTEMS
// ─────────────────────────────────────────
const app      = express();
const sessions = new SessionManager();
const markets  = new MarketManager();
const credits  = new CreditManager();
const feed     = new FeedManager();
const freeplay = new FreePlayManager();
const publisher = new Publisher();

// Admin controller wires everything together
const adminCtrl = new AdminController({ config });

// Wire admin into workers
const worker = new PayoutWorker({
  sessionManager: sessions,
  marketManager:  markets,
  serverConfig:   SERVER_CONFIG,
  adminController: adminCtrl,
});

const treasury = new TreasuryManager({
  sessionManager: sessions,
  marketManager: markets,
  serverConfig: SERVER_CONFIG,
  adminController: adminCtrl,
});

const bot = new BotAgent({
  marketManager:   markets,
  publisher,
  adminController: adminCtrl,
});

// ── Service layer — business logic lives here, routes are thin wrappers ──
const gameService = new GameService({
  sessions, worker, feed, bot: null, // bot wired below after instantiation
  adminCtrl, config, serverConfig: SERVER_CONFIG,
});
const creditService = new CreditService({
  credits, feed, serverConfig: SERVER_CONFIG,
});

// Admin needs a reference back to the payout worker for queue inspection
adminCtrl.setPayoutWorker(worker);
adminCtrl.setTreasuryManager(treasury);
worker.setTreasury(treasury);
gameService.bot = bot; // deferred: bot created after gameService

const stateStore = new PersistentStateStore(
  path.join(__dirname, 'data', 'runtime-state.sqlite'),
  {
    legacyFilePath: path.join(__dirname, 'data', 'runtime-state.json'),
  }
);

sessions.setStore(stateStore);
markets.setStore(stateStore);
worker.setStore(stateStore);

const schedulePersist = () => stateStore.scheduleSave();
sessions.setPersistence(schedulePersist);
markets.setPersistence(schedulePersist);
credits.setPersistence(schedulePersist);
freeplay.setPersistence(schedulePersist);
config.setPersistence(schedulePersist);
adminCtrl.setPersistence(schedulePersist);
worker.setPersistence(schedulePersist);
treasury.setPersistence(schedulePersist);
treasury.setDatabase(stateStore);

const persistedState = stateStore.load();
if (persistedState) {
  sessions.importState(persistedState.sessions);
  markets.importState(persistedState.markets);
  credits.importState(persistedState.credits);
  freeplay.importState(persistedState.freeplay);
  config.importState(persistedState.config);
  adminCtrl.importState(persistedState.admin);
  worker.importState(persistedState.payoutWorker);
  treasury.importState(persistedState.treasury);
  console.log('[storage] Restored runtime state from disk');
}

stateStore.setSnapshotProvider(() => ({
  savedAt: Date.now(),
  credits: credits.exportState(),
  freeplay: freeplay.exportState(),
  config: config.exportState(),
  admin: adminCtrl.exportState(),
  treasury: treasury.exportState(),
}));

const jsonLimit = '32kb';
const requestBuckets = new Map();
let server = null;
let publisherFlushInterval = null;

function getBtcNodeRpcConfig() {
  return {
    url: SERVER_CONFIG.BTC_RPC_URL,
    username: SERVER_CONFIG.BTC_RPC_USER,
    password: SERVER_CONFIG.BTC_RPC_PASS,
  };
}

function getBtcWalletRpcConfig() {
  return {
    url: SERVER_CONFIG.BTC_WALLET_RPC_URL,
    username: SERVER_CONFIG.BTC_WALLET_RPC_USER,
    password: SERVER_CONFIG.BTC_WALLET_RPC_PASS,
    wallet: SERVER_CONFIG.BTC_WALLET_RPC_WALLET || null,
  };
}

function validateOptionalPlayerAddress(address) {
  if (!address) return true;
  return isValidAddressForAsset(ASSET.ZNN, address) || isValidAddressForAsset(ASSET.BTC, address);
}

/**
 * Route error handler for ServiceError (typed) and unexpected errors.
 * Keeps route handlers clean — just throw, don't res.status().json().
 */
function handleServiceError(err, res) {
  if (err.name === 'ServiceError') {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[route] Unexpected error:', err.message, err.stack?.split('\n')[1]);
  return res.status(500).json({ error: 'Internal server error' });
}

function tooManyRequests(windowMs, maxRequests) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.method}:${req.baseUrl}${req.path}`;
    const bucket = requestBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      requestBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many requests' });
    }

    bucket.count++;
    return next();
  };
}

function requireAdminAuth(req, res, next) {
  if (!SERVER_CONFIG.ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin API disabled until ADMIN_TOKEN is configured' });
  }

  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Admin authorization required' });
  }

  const provided = match[1];
  const expected = SERVER_CONFIG.ADMIN_TOKEN;
  const valid = provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!valid) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }

  return next();
}

function denyUnsafeFeature(message) {
  return (req, res) => res.status(503).json({ error: message });
}

function validateSessionId(req, res, next) {
  if (!/^[a-f0-9]{32}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }
  return next();
}

function validatePositionId(req, res, next) {
  if (!/^pos_[a-f0-9]{16}$/i.test(req.params.posId)) {
    return res.status(400).json({ error: 'Invalid position id' });
  }
  return next();
}

function validateMarketId(req, res, next) {
  if (!/^mkt_[a-f0-9]{16}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid market id' });
  }
  return next();
}

const allowedOrigins = SERVER_CONFIG.CORS_ORIGIN === '*'
  ? null
  : SERVER_CONFIG.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!allowedOrigins) return cb(new Error('CORS origin not allowed'));
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: jsonLimit }));

// Logger
app.use((req, res, next) => {
  if (!req.path.startsWith('/feed/events')) // don't log SSE polling
    res.on('finish', () => logger.request(req, res));
  next();
});

// ─────────────────────────────────────────
// PLATFORM INFO
// ─────────────────────────────────────────

app.get('/info', (req, res) => {
  res.json({
    platform:        'NOM-GAMEZ',
    version:         '2.0.0',
    tagline:         'Provably fair. No accounts. BTC accepted.',
    depositAddress:  SERVER_CONFIG.PLATFORM_ADDRESS,
    testModeEnabled: SERVER_CONFIG.TEST_MODE_ENABLED,
    paymentRails:    buildPaymentSummary(SERVER_CONFIG, config.get('payments')),
    validBets:       config.getValidBets(),
    games:           config.getActiveGameIds(),
    gameDefinitions: getPublicGameDefinitions().map((definition) => ({
      ...definition,
      runtime: config.getGame(definition.id),
    })),
    payoutMultiplier: 10,
    depositTimeoutSeconds: SERVER_CONFIG.DEPOSIT_TIMEOUT,
    publisherStatus: publisher.status(),
    freePlayConfig: {
      maxPayout:      config.get('freePlay.maxPayoutZnn'),
      winProbability: config.get('freePlay.winProbability'),
      resetsAt:       'midnight UTC',
    },
  });
});

app.get('/stats', (req, res) => {
  res.json({
    sessions:  sessions.stats(),
    markets:   markets.stats(),
    feed:      feed.getStats(),
    freeplay:  freeplay.stats(),
    publisher: publisher.status(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    uptime:  Math.round(process.uptime()),
    version: '2.0.0',
    services: {
      oracle:    adminCtrl.health.services.oracle,
      explorer:  adminCtrl.health.services.explorer,
      zenonNode: adminCtrl.health.services.zenonNode,
    },
  });
});

app.get('/ready', (req, res) => {
  const treasuryStatus = treasury.getStatus();
  const health = adminCtrl.getFullHealth(sessions, markets);
  const ready = Boolean(worker.running) && (!SERVER_CONFIG.BOT_ENABLED || bot.running) && !!treasuryStatus.lastReconciliation;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'starting',
    workerRunning: worker.running,
    botRunning: bot.running,
    treasuryReconciled: !!treasuryStatus.lastReconciliation,
    safeToCreateMarkets: health.safeToCreateMarkets,
    safeToAcceptDeposits: health.safeToAcceptDeposits,
  });
});

// ─────────────────────────────────────────
// GAMES — Session-based
// ─────────────────────────────────────────

app.post('/session/create', async (req, res) => {
  try {
    const { session, quote, depositAddress, useTestMode, preferredPayoutAsset,
            verification, gameMetadata } = await gameService.createSession({
      playerAddress:         req.body?.playerAddress,
      gameId:                req.body?.gameId,
      betAmount:             req.body?.betAmount,
      depositAsset:          req.body?.depositAsset,
      preferredPayoutAsset:  req.body?.preferredPayoutAsset,
      preferredPayoutAddress: req.body?.preferredPayoutAddress,
      testMode:              req.body?.testMode,
    });

    res.json({
      sessionId:     session.id,
      state:         useTestMode ? 'DEPOSIT_CONFIRMED' : session.state,
      depositAsset:  session.depositAsset,
      depositTo:     useTestMode ? 'TEST MODE' : depositAddress,
      depositAmount: useTestMode ? 0 : quote.depositAmount,
      payoutAmount:  session.payoutAmount,
      expiresAt:     session.expiresAt,
      testMode:      useTestMode,
      quote,
      payoutOptions: quote.payoutOptions,
      preferredPayoutAsset: preferredPayoutAsset || null,
      instructions: useTestMode
        ? ['Test mode enabled — no deposit required',
           'Wins show simulated payout status instead of sending funds']
        : [`Send exactly ${quote.depositAmount} ${session.depositAsset} to ${depositAddress}`,
           req.body?.playerAddress ? `From your address: ${req.body.playerAddress}` : 'Keep the txid handy',
           `Session expires in ${SERVER_CONFIG.DEPOSIT_TIMEOUT}s`],
      verification,
      gameMetadata,
    });
  } catch (err) {
    handleServiceError(err, res);
  }
});

app.get('/session/:id', validateSessionId, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId:    s.id,
    state:        s.state,
    playerAddress: s.playerAddress,
    gameId:       s.gameId,
    depositAsset: s.depositAsset || ASSET.ZNN,
    depositAddress: s.depositAddress || SERVER_CONFIG.PLATFORM_ADDRESS,
    betAmount:    s.betAmount,
    depositAmount: s.depositAmount ?? s.betAmount,
    payoutAmount: s.payoutAmount,
    payoutAsset:  s.payoutAsset || null,
    payoutAddress: s.payoutAddress || null,
    payoutChoice: s.payoutChoice || null,
    payoutOptions: s.payoutOptions || s.quote?.payoutOptions || null,
    quote:        s.quote || null,
    depositTxHash: s.depositTxHash,
    payoutTxHash: s.payoutTxHash,
    gameResult:   s.gameResult,
    gameScore:    s.gameScore,
    gameDetails:  s.gameDetails || null,
    isTestMode:   !!s.isTestMode,
    expiresAt:    s.expiresAt,
  });
});

app.post('/session/:id/verify-deposit', validateSessionId, tooManyRequests(60_000, 10),
  payoutLock.middleware(req => `session:${req.params.id}`),
  async (req, res) => {
  try {
    const { asset, amount, txHash } = await gameService.verifyDeposit(
      req.params.id, req.body?.txHash
    );
    res.json({ success: true, state: 'DEPOSIT_CONFIRMED', asset, amount, txHash });
  } catch (err) {
    handleServiceError(err, res);
  }
});

app.post('/session/:id/start', validateSessionId, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.state !== 'DEPOSIT_CONFIRMED')
    return res.status(400).json({ error: `Cannot start — session is ${s.state}` });

  sessions.gameStarted(s.id);
  res.json({ success: true, state: 'GAME_ACTIVE', sessionId: s.id });
});

app.post(
  '/session/:id/result',
  validateSessionId,
  tooManyRequests(60_000, 5),
  payoutLock.middleware(req => `session:${req.params.id}`),
  async (req, res) => {
  try {
    const outcome = await gameService.submitResult(req.params.id, req.body || {});
    if (!outcome.won) {
      return res.json({ success: true, result: 'LOSS', verification: outcome.verification, message: 'Better luck next time.' });
    }
    if (outcome.requiresPayoutChoice) {
      return res.json({ success: true, result: 'WIN', requiresPayoutChoice: true,
        payoutOptions: outcome.payoutOptions, message: 'Choose BTC or ZNN payout to finalize your win.' });
    }
    res.json({
      success:      true,
      result:       'WIN',
      payoutAmount: outcome.payoutAmount,
      payoutAsset:  outcome.payoutAsset,
      payoutOptions: outcome.payoutOptions,
      verification: outcome.verification,
      message:      outcome.testMode
        ? 'Test win recorded. No real payout was sent.'
        : `Payout queued via ${outcome.payoutAsset || 'selected rail'}`,
    });
  } catch (err) {
    handleServiceError(err, res);
  }
});

app.post('/session/:id/payout-choice', validateSessionId, tooManyRequests(60_000, 10),
  payoutLock.middleware(req => `session:${req.params.id}`),
  (req, res) => {
  try {
    const choice = gameService.choosePayoutRail(
      req.params.id,
      req.body?.asset,
      String(req.body?.address || '').trim()
    );
    res.json({
      success:     true,
      state:       'GAME_WON',
      payoutChoice: choice,
      message:     `Payout queued via ${choice.asset}`,
    });
  } catch (err) {
    handleServiceError(err, res);
  }
});

app.get('/session/:id/payout-status', validateSessionId, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const payoutRecord = worker.getPayoutRecord(req.params.id);
  res.json({
    state:        s.state,
    payoutTxHash: s.payoutTxHash || null,
    payoutAmount: s.payoutAmount,
    payoutAsset:  s.payoutAsset || s.payoutChoice?.asset || null,
    payoutChoice: s.payoutChoice || null,
    payoutOptions: s.payoutOptions || s.quote?.payoutOptions || null,
    isTestMode:   !!s.isTestMode,
    payoutRecord,
    explorerUrl:  s.payoutTxHash && !s.isTestMode ? `https://zenonhub.io/explorer/transaction/${s.payoutTxHash}` : null,
  });
});

// ─────────────────────────────────────────
// PREDICTION MARKETS
// ─────────────────────────────────────────

app.get('/markets', (req, res) => {
  const { category, limit } = req.query;
  res.json({
    markets: markets.getOpenMarkets({ category, limit: parseInt(limit) || 20 }),
    stats:   markets.stats(),
  });
});

app.get('/markets/recent', (req, res) => {
  res.json({ markets: markets.getRecentlyResolved({ limit: 10 }) });
});

app.get('/markets/:id', validateMarketId, (req, res) => {
  const market = markets.getMarket(req.params.id);
  if (!market) return res.status(404).json({ error: 'Market not found' });

  const positions = markets.getMarketPositions(req.params.id).map(p => ({
    id: p.id,
    side: p.side,
    amountZnn: p.amountZnn,
    state: p.state,
    depositTxHash: p.depositTxHash,
    payoutTxHash: p.payoutTxHash,
    potentialPayout: p.potentialPayout,
    createdAt: p.createdAt,
  }));

  res.json({ market: publicMarket(market), positions });
});

app.post(
  '/markets/:id/position',
  validateMarketId,
  tooManyRequests(60_000, 10),
  SERVER_CONFIG.ENABLE_UNSAFE_MARKETS
    ? (req, res) => {
  const { playerAddress, side, amountZnn } = req.body;

  if (!playerAddress || !playerAddress.startsWith('z1q'))
    return res.status(400).json({ error: 'Invalid Zenon address' });

  try {
    const position = markets.takePosition({
      marketId:      req.params.id,
      playerAddress,
      side,
      amountZnn:     parseFloat(amountZnn),
    });

    res.json({
      success:    true,
      positionId: position.id,
      side:       position.side,
      amountZnn:  position.amountZnn,
      state:      position.state,
      depositTo:  SERVER_CONFIG.PLATFORM_ADDRESS,
      depositAmount: position.amountZnn,
      instructions: [
        `Send exactly ${position.amountZnn} ZNN to ${SERVER_CONFIG.PLATFORM_ADDRESS}`,
        `Include your position ID: ${position.id}`,
      ],
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
    : denyUnsafeFeature('Prediction market deposits are disabled until settlement and payout safety are implemented')
);

app.post(
  '/markets/:id/position/:posId/confirm',
  validateMarketId,
  validatePositionId,
  tooManyRequests(60_000, 10),
  SERVER_CONFIG.ENABLE_UNSAFE_MARKETS
    ? async (req, res) => {
  const { txHash } = req.body;
  if (!txHash) return res.status(400).json({ error: 'txHash required' });

  if (sessions.isHashSeen(txHash))
    return res.status(400).json({ error: 'Transaction hash already used' });

  const position = markets.getPosition(req.params.posId);
  if (!position) return res.status(404).json({ error: 'Position not found' });

  const result = await verifyDeposit({
    txHash,
    expectedFrom:    position.playerAddress,
    expectedAmount:  position.amountZnn,
    platformAddress: SERVER_CONFIG.PLATFORM_ADDRESS,
    explorerApi:     SERVER_CONFIG.EXPLORER_API,
  });

  if (!result.valid)
    return res.status(400).json({ error: `Deposit verification failed: ${result.reason}` });

  markets.confirmPositionDeposit(req.params.posId, txHash);
  sessions.addSeenHash(txHash);
  const market = markets.getMarket(req.params.id);
  const fundedPosition = markets.getPosition(req.params.posId);
  feed.pushPositionTaken({ playerAddress: fundedPosition.playerAddress, side: fundedPosition.side, amountZnn: fundedPosition.amountZnn, marketQuestion: market.question });
  adminCtrl.engagement.trackPositionTaken(req.params.id, fundedPosition.amountZnn, market.type);
  schedulePersist();
  res.json({ success: true, positionId: req.params.posId, txHash });
}
    : denyUnsafeFeature('Prediction market settlement is disabled until payout processing is implemented')
);

app.get('/markets/player/:address', (req, res) => {
  const positions = markets.getPlayerPositions(req.params.address);
  res.json({ positions: positions.map(p => ({
    id: p.id,
    marketId: p.marketId,
    side: p.side,
    amountZnn: p.amountZnn,
    potentialPayout: p.potentialPayout,
    state: p.state,
    createdAt: p.createdAt,
  }))});
});

app.post(
  '/markets/create',
  tooManyRequests(60_000, 5),
  SERVER_CONFIG.ENABLE_UNSAFE_MARKETS
    ? (req, res) => {
  const { question, description, resolvesAt, creatorAddress, category } = req.body;

  if (!question || question.length < 10 || question.length > 200)
    return res.status(400).json({ error: 'Question must be 10–200 characters' });

  if (!resolvesAt || new Date(resolvesAt) <= new Date())
    return res.status(400).json({ error: 'resolvesAt must be in the future' });

  if (!creatorAddress || !creatorAddress.startsWith('z1q'))
    return res.status(400).json({ error: 'Invalid creator address' });

  try {
    const market = markets.createMarket({
      question:    question.trim(),
      description: (description || '').trim(),
      category:    category || 'custom',
      type:        'custom',
      resolvesAt:  new Date(resolvesAt).getTime(),
      creatorAddress,
      tags:        ['user-created'],
    });

    feed.pushMarketOpened({ market });
    res.json({ success: true, market: publicMarket(market) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
    : denyUnsafeFeature('User-created markets are disabled until custom market resolution is implemented')
);

// ─────────────────────────────────────────
// FREE PLAY
// ─────────────────────────────────────────

app.get('/freeplay/check/:address', (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'];
  res.json(freeplay.checkEligibility(req.params.address, ip));
});

app.post(
  '/freeplay/play',
  tooManyRequests(60_000, 5),
  SERVER_CONFIG.ENABLE_UNSAFE_FREEPLAY
    ? (req, res) => {
  const { address } = req.body;
  if (!address || !address.startsWith('z1q'))
    return res.status(400).json({ error: 'Invalid Zenon address' });

  const ip     = req.ip || req.headers['x-forwarded-for'];
  const result = freeplay.requestFreePlay(address, ip);

  if (result.won) {
    feed.pushFreePlay({ playerAddress: address, won: true, prize: result.payout });
    if (result.payout >= 1.0) bot.announceWin(address, result.payout, 'free play');
  }

  res.json(result);
}
    : denyUnsafeFeature('Free play is disabled until abuse resistance and payout safety are implemented')
);

app.post(
  '/freeplay/claim',
  tooManyRequests(60_000, 5),
  SERVER_CONFIG.ENABLE_UNSAFE_FREEPLAY
    ? async (req, res) => {
  const { claimToken, address } = req.body;
  if (!claimToken || !address)
    return res.status(400).json({ error: 'claimToken and address required' });

  const result = freeplay.claimWin(claimToken, address);
  if (!result.success)
    return res.status(400).json({ error: result.reason });

  const freeSession = sessions.create({ playerAddress: address, gameId: 'freeplay', betAmount: 0, depositTimeout: 60 });
  sessions.depositConfirmed(freeSession.id);
  sessions.gameStarted(freeSession.id);
  sessions.gameEnded(freeSession.id, { won: true, score: result.payout });
  const s = sessions.get(freeSession.id);
  s.payoutAmount = result.payout;
  worker.queuePayout(freeSession.id);

  res.json({
    success:   true,
    payout:    result.payout,
    address:   result.address,
    sessionId: freeSession.id,
    message:   `${result.payout} ZNN will be sent to your address shortly.`,
  });
}
    : denyUnsafeFeature('Free play claims are disabled until abuse resistance and payout safety are implemented')
);

// ─────────────────────────────────────────
// LIVE FEED (Server-Sent Events)
// ─────────────────────────────────────────

app.get('/feed/events', (req, res) => {
  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');
  res.flushHeaders();

  feed.addListener(res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    feed.removeListener(res);
  });
});

app.get('/feed/recent', (req, res) => {
  res.json({ events: feed.getRecent(30), stats: feed.getStats() });
});

// ─────────────────────────────────────────
// GAME HALL CREDITS API
// Deposit once → play multiple games → cash out remainder
// ─────────────────────────────────────────

/**
 * POST /credit/create
 * Create a game pass (credit balance).
 * Body: { playerAddress, depositAsset, depositAmount, creditAmount? }
 * Returns: { passId, depositAddress, depositAmount, depositAsset, expiresAt }
 */
app.post('/credit/create', tooManyRequests(60_000, 10), async (req, res) => {
  try {
    const { pass, depositAddress } = await creditService.createPass({
      playerAddress: req.body?.playerAddress,
      depositAsset:  req.body?.depositAsset,
      depositAmount: req.body?.depositAmount,
    });
    res.json({
      passId:        pass.id,
      depositAddress,
      depositAmount: pass.depositAmount,
      depositAsset:  pass.depositAsset,
      creditAmount:  pass.creditAmount,
      expiresAt:     pass.expiresAt,
      state:         pass.state,
    });
  } catch (err) {
    handleServiceError(err, res);
  }
});

/**
 * POST /credit/:passId/verify-deposit
 * Verify the deposit and activate the pass.
 * Body: { txHash }
 */
app.post('/credit/:passId/verify-deposit', tooManyRequests(60_000, 10),
  payoutLock.middleware(req => `credit:${req.params.passId}`),
  async (req, res) => {
  try {
    const active = await creditService.verifyDeposit(req.params.passId, req.body?.txHash);
    res.json({ ok: true, passId: active.id, balance: active.balance, state: active.state });
  } catch (err) {
    handleServiceError(err, res);
  }
});

/**
 * GET /credit/pass/:playerAddress
 * Get the active game pass for a player.
 */
app.get('/credit/pass/:playerAddress', (req, res) => {
  const pass = credits.getActivePass(req.params.playerAddress);
  if (!pass) return res.status(404).json({ error: 'No active pass' });
  res.json({
    passId:        pass.id,
    balance:       pass.balance,
    state:         pass.state,
    confirmedAt:   pass.confirmedAt,
    passExpiresAt: pass.passExpiresAt,
    rounds:        pass.rounds.length,
  });
});

/**
 * GET /credit/:passId
 * Full pass state.
 */
app.get('/credit/:passId', (req, res) => {
  const pass = credits.get(req.params.passId);
  if (!pass) return res.status(404).json({ error: 'Pass not found' });
  res.json(pass);
});

/**
 * POST /credit/:passId/cashout
 * Request cashout of remaining credits.
 * Body: { payoutAsset, payoutAddress }
 */
app.post('/credit/:passId/cashout', tooManyRequests(60_000, 5),
  payoutLock.middleware(req => `credit:${req.params.passId}`),
  (req, res) => {
  try {
    const result = creditService.requestCashout(req.params.passId, {
      payoutAsset:    req.body?.payoutAsset,
      payoutAddress:  req.body?.payoutAddress,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    handleServiceError(err, res);
  }
});

/**
 * GET /credit/stats
 * Platform-wide credit stats.
 */
app.get('/credit/stats', (req, res) => {
  res.json(credits.stats());
});

// ─────────────────────────────────────────
// ADMIN API
// All routes expose live operational data.
// The bot reads these to make decisions;
// operators call them manually for debugging.
// No auth layer here — add IP allowlist in
// your reverse proxy for production.
// ─────────────────────────────────────────

app.use('/admin', requireAdminAuth, tooManyRequests(60_000, 60));

/**
 * GET /admin/health
 * Full operational health snapshot
 */
app.get('/admin/health', (req, res) => {
  const health = adminCtrl.getFullHealth(sessions, markets);
  health.payoutLock = { heldKeys: payoutLock.size() };
  res.json(health);
});

/**
 * GET /admin/alerts
 * Active alerts — what needs attention right now
 * ?severity=critical|warning|info
 */
app.get('/admin/alerts', (req, res) => {
  const { severity } = req.query;
  res.json({
    alerts:      adminCtrl.alerts.getActive(severity || null),
    hasCritical: adminCtrl.alerts.hasCritical(),
    count:       adminCtrl.alerts.getActive().length,
  });
});

/**
 * POST /admin/alerts/:type/resolve
 * Manually resolve a specific alert
 */
app.post('/admin/alerts/:type/resolve', (req, res) => {
  const { message } = req.body;
  adminCtrl.alerts.resolve(req.params.type, message || 'Manually resolved');
  res.json({ success: true, type: req.params.type });
});

/**
 * GET /admin/config
 * Full runtime config (live values, not defaults)
 */
app.get('/admin/config', (req, res) => {
  res.json({
    config:  config.getAll(),
    history: config.getHistory(20),
  });
});

/**
 * PATCH /admin/config
 * Live-patch a config value without restart
 * Body: { path: 'bot.researchIntervalMs', value: 7200000 }
 * OR: { changes: [ { path, value }, ... ] }
 */
app.patch('/admin/config', (req, res) => {
  try {
    const { path, value, changes } = req.body;
    let results;
    if (changes && Array.isArray(changes)) {
      results = config.patchMany(changes, 'admin');
    } else if (path !== undefined && value !== undefined) {
      results = [ config.patch(path, value, 'admin') ];
    } else {
      return res.status(400).json({ error: 'Provide { path, value } or { changes: [...] }' });
    }
    res.json({ success: true, applied: results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /admin/queue/payouts
 * Current payout queue depth + item details
 */
app.get('/admin/queue/payouts', (req, res) => {
  res.json(worker.getQueueStatus());
});

/**
 * POST /admin/circuit-breaker/reset
 * Force-reset the payout circuit breaker after investigation
 */
app.post('/admin/circuit-breaker/reset', (req, res) => {
  worker.forceResetCircuit();
  res.json({ success: true, message: 'Circuit breaker reset. Payouts will resume on next cycle.' });
});

/**
 * GET /admin/bot/actions
 * Recent bot action log — success rates, durations
 * ?limit=50
 */
app.get('/admin/bot/actions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    actions: adminCtrl.botActions.getRecent(limit),
    summary: adminCtrl.botActions.summary(),
  });
});

/**
 * POST /admin/bot/research
 * Trigger an immediate research cycle (e.g. after a big price move)
 */
app.post('/admin/bot/research', async (req, res) => {
  try {
    await bot.triggerResearch();
    res.json({ success: true, message: 'Research cycle triggered.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/markets/performance
 * Market type engagement data — what players bet on most
 */
app.get('/admin/markets/performance', (req, res) => {
  res.json({
    byType:         adminCtrl.engagement.getMarketTypePerformance(),
    peakHours:      adminCtrl.engagement.getPeakHours(),
    currentWeights: config.get('bot.marketWeights'),
  });
});

/**
 * POST /admin/markets/rebalance
 * Manually trigger weight rebalancing from engagement data
 */
app.post('/admin/markets/rebalance', (req, res) => {
  adminCtrl.rebalanceMarketWeights();
  res.json({
    success: true,
    newWeights: config.get('bot.marketWeights'),
    message: 'Market weights rebalanced from engagement data.',
  });
});

/**
 * GET /admin/games
 * All games (active + inactive) with their current config
 */
app.get('/admin/games', (req, res) => {
  res.json({
    games:       config.get('games'),
    activeGames: config.getActiveGames(),
  });
});

/**
 * POST /admin/games/register
 * Register a new game or update existing one at runtime
 * Body: { id, name, active, payoutMultiplier, houseEdgePct, description, minBet, maxBet }
 */
app.post('/admin/games/register', (req, res) => {
  try {
    const game = config.registerGame(req.body, 'admin');
    res.json({ success: true, game });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /admin/games/:id
 * Toggle a game on/off, or patch specific fields
 * Body: { active: true|false } or { field: value }
 */
app.patch('/admin/games/:id', (req, res) => {
  const gameId = req.params.id;
  try {
    const results = [];
    for (const [field, value] of Object.entries(req.body)) {
      const entry = config.patch(`games.${gameId}.${field}`, value, 'admin');
      results.push(entry);
    }
    res.json({ success: true, applied: results, game: config.getGame(gameId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /admin/payouts/metrics
 * Payout success rate, average duration, failure history
 */
app.get('/admin/payouts/metrics', (req, res) => {
  res.json(adminCtrl.payouts.getMetrics());
});

/**
 * GET /admin/treasury
 * Current treasury health, liabilities and reconciliation history
 */
app.get('/admin/treasury', (req, res) => {
  res.json(treasury.getStatus());
});

/**
 * POST /admin/treasury/reconcile
 * Force a wallet reconciliation now
 */
app.post('/admin/treasury/reconcile', async (req, res) => {
  const snapshot = await treasury.reconcile({ force: true, reason: 'admin' });
  res.json(snapshot);
});

/**
 * POST /admin/treasury/halt
 * Body: { scope: 'payouts'|'bot'|'all', active: true|false, reason?: string }
 */
app.post('/admin/treasury/halt', (req, res) => {
  const { scope = 'all', active, reason } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Provide active: true|false' });
  }
  res.json(treasury.setHalt(scope, active, reason || 'manual operator action', 'admin'));
});

/**
 * GET /admin/config/history
 * Audit log of all config changes
 */
app.get('/admin/config/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ history: config.getHistory(limit) });
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
function onServerStarted() {
  const addr = SERVER_CONFIG.PLATFORM_ADDRESS;
  console.log(`
╔═══════════════════════════════════════════════╗
║   NOM-GAMEZ v2.0 — Autonomous Gaming Platform ║
║   Provably fair. No accounts. BTC accepted.   ║
╠═══════════════════════════════════════════════╣
║  Port    : ${`${SERVER_CONFIG.HOST}:${SERVER_CONFIG.PORT}`.padEnd(36)}║
║  Address : ${addr.slice(0, 36).padEnd(36)}║
║  Bot     : ${SERVER_CONFIG.BOT_ENABLED ? 'ENABLED ✓' : 'DISABLED ✗'}${' '.repeat(SERVER_CONFIG.BOT_ENABLED ? 27 : 28)}║
╚═══════════════════════════════════════════════╝
  `);

  if (!SERVER_CONFIG.ADMIN_TOKEN) {
    console.warn('[security] ADMIN_TOKEN not set — all /admin routes are disabled');
  }
  console.warn('[security] Deterministic server-side verification enabled for dice and slots; shooter remains disabled');
  if (!SERVER_CONFIG.ENABLE_UNSAFE_MARKETS) {
    console.warn('[security] Prediction market wagering disabled until settlement is implemented');
  }
  if (!SERVER_CONFIG.ENABLE_UNSAFE_FREEPLAY) {
    console.warn('[security] Free play disabled until abuse resistance is implemented');
  }

  treasury.start();
  treasury.reconcile({ force: true, reason: 'startup' }).catch((err) => {
    console.error('[treasury] Startup reconciliation failed:', err.message);
  });
  worker.start();
  if (SERVER_CONFIG.BOT_ENABLED) bot.start();

  // Flush publisher queue every minute
  publisherFlushInterval = setInterval(() => publisher.flushQueue(), 60_000);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const instance = app.listen(SERVER_CONFIG.PORT, SERVER_CONFIG.HOST, () => {
      server = instance;
      onServerStarted();
      resolve(instance);
    });

    instance.once('error', (err) => {
      logger.error('Server startup failed', {
        code: err.code,
        message: err.message,
        host: SERVER_CONFIG.HOST,
        port: SERVER_CONFIG.PORT,
      });
      reject(err);
    });
  });
}

function shutdown(code = 0) {
  console.log('\n[server] Shutting down...');
  bot.stop();
  worker.stop();
  treasury.stop();
  if (publisherFlushInterval) clearInterval(publisherFlushInterval);
  stateStore.saveNow();

  const forceExitTimer = setTimeout(() => process.exit(code), 2000);

  if (server) {
    return server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(code);
    });
  }
  clearTimeout(forceExitTimer);
  return process.exit(code);
}

process.on('SIGINT', () => {
  shutdown(0);
});

process.on('SIGTERM', () => {
  shutdown(0);
});

if (require.main === module) {
  startServer().catch(() => {
    shutdown(1);
  });
}

module.exports = {
  app,
  startServer,
  shutdown,
  SERVER_CONFIG,
};
