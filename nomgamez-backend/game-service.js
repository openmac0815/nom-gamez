// game-service.js — Business logic for game session lifecycle
//
// All session state transitions live here. server.js routes call these
// methods and only handle request parsing + response shaping.
//
// Constructor receives dependencies by injection so the service is
// testable without spinning up Express.

const { ASSET, normalizeAsset, isValidAddressForAsset,
        getEnabledDepositAssets, getEnabledPayoutAssets,
        buildQuote, getPayoutOption } = require('./payment-rails');
const { verifyDeposit }    = require('./zenon');
const { verifyBtcDeposit } = require('./btc');
const { verifyGameResult } = require('./verifier');
const { getGameSessionMetadata } = require('./games');

class GameService {
  /**
   * @param {object} deps
   * @param {object} deps.sessions      — SessionManager
   * @param {object} deps.worker        — PayoutWorker
   * @param {object} deps.feed          — FeedManager
   * @param {object} deps.bot           — BotAgent
   * @param {object} deps.adminCtrl     — AdminController
   * @param {object} deps.config        — ConfigStore
   * @param {object} deps.serverConfig  — SERVER_CONFIG (deploy-time constants)
   */
  constructor({ sessions, worker, feed, bot, adminCtrl, config, serverConfig }) {
    this.sessions     = sessions;
    this.worker       = worker;
    this.feed         = feed;
    this.bot          = bot;
    this.admin        = adminCtrl;
    this.config       = config;
    this.serverConfig = serverConfig;
  }

  // ── CREATE SESSION ──────────────────────────────────────

  /**
   * Validate inputs, build a price quote, and create a new game session.
   * Returns { session, quote, instructions, verification } or throws ServiceError.
   */
  async createSession({
    playerAddress,
    gameId,
    betAmount,
    depositAsset: rawDepositAsset,
    preferredPayoutAsset: rawPayoutAsset,
    preferredPayoutAddress: rawPayoutAddr,
    testMode: wantsTest,
  }) {
    const cfg          = this.serverConfig;
    const depositAsset = normalizeAsset(rawDepositAsset || ASSET.ZNN);
    const useTestMode  = cfg.TEST_MODE_ENABLED && wantsTest === true;

    // Input validation
    if (playerAddress && !this._isValidPlayerAddress(playerAddress))
      throw new ServiceError(400, 'Invalid player address. Use a BTC or Zenon address.');

    const enabledDeposits = getEnabledDepositAssets(cfg);
    if (!enabledDeposits.includes(depositAsset))
      throw new ServiceError(400, `Unsupported deposit asset. Options: ${enabledDeposits.join(', ')}`);

    const activeGameIds = this.config.getActiveGameIds();
    if (!activeGameIds.includes(gameId))
      throw new ServiceError(400, `Invalid game. Options: ${activeGameIds.join(', ')}`);

    const validBets = depositAsset === ASSET.BTC
      ? (this.config.get('payments.btcValidBets') || [])
      : this.config.getValidBets();
    const bet = parseFloat(betAmount);
    if (!validBets.some(v => Math.abs(v - bet) < 0.001))
      throw new ServiceError(400, `Invalid bet. Options: ${validBets.join(', ')}`);

    if (this.sessions.stats().total >= cfg.MAX_SESSIONS)
      throw new ServiceError(503, 'Server at capacity, try again shortly');

    // Quote
    let quote;
    try {
      quote = await buildQuote({
        depositAsset,
        depositAmount: bet,
        paymentConfig: this.config.get('payments'),
      });
    } catch (err) {
      throw new ServiceError(503, err.message);
    }

    // Optional preferred payout
    const preferredPayoutAsset = normalizeAsset(rawPayoutAsset || '');
    const preferredPayoutAddr  = String(rawPayoutAddr || playerAddress || '').trim();
    if (preferredPayoutAsset) {
      const enabledPayouts = getEnabledPayoutAssets(cfg);
      if (!enabledPayouts.includes(preferredPayoutAsset))
        throw new ServiceError(400, `Unsupported payout asset. Options: ${enabledPayouts.join(', ')}`);
      if (!isValidAddressForAsset(preferredPayoutAsset, preferredPayoutAddr))
        throw new ServiceError(400, `Invalid ${preferredPayoutAsset} payout address`);
    }

    // Create session
    const session = this.sessions.create({
      playerAddress: playerAddress || null,
      gameId,
      betAmount:      bet,
      depositTimeout: cfg.DEPOSIT_TIMEOUT,
      isTestMode:     useTestMode,
    });
    const depositAddress = depositAsset === ASSET.BTC
      ? cfg.BTC_DEPOSIT_ADDRESS
      : cfg.PLATFORM_ADDRESS;

    this.sessions.setState(session.id, session.state, {
      depositAsset,
      depositAmount:  quote.depositAmount,
      depositAddress,
      payoutOptions:  quote.payoutOptions,
      quote,
    });
    this.sessions.setQuote(session.id, quote);

    if (preferredPayoutAsset) {
      const option = getPayoutOption({ quote }, preferredPayoutAsset);
      this.sessions.setPayoutChoice(session.id, {
        asset:            preferredPayoutAsset,
        address:          preferredPayoutAddr,
        amount:           option?.amount ?? null,
        availableOptions: quote.payoutOptions,
      });
    }

    if (useTestMode) this.sessions.depositConfirmed(session.id);

    return {
      session:      this.sessions.get(session.id),
      quote,
      depositAddress,
      useTestMode,
      preferredPayoutAsset: preferredPayoutAsset || null,
      verification: {
        ...(getGameSessionMetadata(gameId)?.verification || {}),
        gameId,
        sessionSeed: session.id,
      },
      gameMetadata: getGameSessionMetadata(gameId) || null,
    };
  }

  // ── VERIFY DEPOSIT ──────────────────────────────────────

  /**
   * Verify an on-chain deposit transaction and activate the session.
   * Returns { asset, amount, txHash } or throws ServiceError.
   * IMPORTANT: caller must hold payoutLock before calling this.
   */
  async verifyDeposit(sessionId, txHash) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ServiceError(404, 'Session not found');
    if (s.state !== 'PENDING_DEPOSIT')
      throw new ServiceError(400, `Session is ${s.state}, not PENDING_DEPOSIT`);
    if (!txHash || txHash.length < 10)
      throw new ServiceError(400, 'Invalid transaction hash');
    if (this.sessions.isHashSeen(txHash))
      throw new ServiceError(400, 'Transaction hash already used');

    const depositAsset = normalizeAsset(s.depositAsset || ASSET.ZNN);
    const cfg          = this.serverConfig;

    const result = depositAsset === ASSET.BTC
      ? await verifyBtcDeposit({
          txid: txHash,
          expectedAddress:   s.depositAddress || cfg.BTC_DEPOSIT_ADDRESS,
          expectedAmountBtc: s.depositAmount ?? s.quote?.depositAmount ?? s.betAmount,
          minConfirmations:  cfg.BTC_MIN_CONFIRMATIONS || 1,
          rpcConfig: { url: cfg.BTC_RPC_URL, username: cfg.BTC_RPC_USER, password: cfg.BTC_RPC_PASS },
        })
      : await verifyDeposit({
          txHash,
          expectedFrom:    s.playerAddress,
          expectedAmount:  s.depositAmount ?? s.betAmount,
          platformAddress: s.depositAddress || cfg.PLATFORM_ADDRESS,
          explorerApi:     cfg.EXPLORER_API,
        });

    if (!result.valid)
      throw new ServiceError(400, `Deposit verification failed: ${result.reason}`);

    this.sessions.depositFound(sessionId, txHash);
    this.sessions.depositConfirmed(sessionId);
    this.admin?.health?.recordSuccess?.('explorer');
    this.feed?.pushGamePlayed?.({
      playerAddress: s.playerAddress,
      betAmount:     s.betAmount,
      gameId:        s.gameId,
      won:           false,
    });

    return { asset: depositAsset, amount: result.amount || result.amountBtc, txHash };
  }

  // ── SUBMIT GAME RESULT ──────────────────────────────────

  /**
   * Verify a game result and queue payout if won.
   * IMPORTANT: caller must hold payoutLock before calling this.
   */
  async submitResult(sessionId, resultBody) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ServiceError(404, 'Session not found');
    if (s.state !== 'GAME_ACTIVE')
      throw new ServiceError(400, `Cannot submit result — session is ${s.state}`);

    const verification = verifyGameResult(s, resultBody || {});
    if (!verification.valid)
      throw new ServiceError(400, verification.reason);

    this.sessions.gameEnded(sessionId, {
      won:     verification.won,
      score:   verification.score || 0,
      details: verification.details || null,
    });
    this.admin?.engagement?.trackGamePlayed?.(
      s.gameId, s.betAmount, verification.won, verification.won ? s.payoutAmount : 0
    );

    if (!verification.won)
      return { won: false, verification: verification.details || null };

    const refreshed    = this.sessions.get(sessionId);
    const payoutOptions = refreshed?.quote?.payoutOptions || s.quote?.payoutOptions || [];

    if (s.isTestMode) {
      const preferred = refreshed?.payoutChoice || s.payoutChoice || payoutOptions[0] || null;
      if (preferred) {
        this.sessions.setPayoutChoice(sessionId, {
          asset:            preferred.asset,
          address:          preferred.address || s.playerAddress || null,
          amount:           preferred.amount,
          availableOptions: payoutOptions,
        });
      }
      this.sessions.payoutSent(sessionId, `test-${sessionId}`);
      return { won: true, testMode: true, payoutOptions, verification: verification.details || null };
    }

    if (refreshed?.payoutChoice?.asset && refreshed?.payoutChoice?.address) {
      this.worker.queuePayout(sessionId);
      this.feed?.pushWin?.({
        playerAddress: refreshed.payoutChoice.address,
        amountZnn:     refreshed.payoutChoice.asset === ASSET.ZNN
                         ? refreshed.payoutChoice.amount
                         : s.payoutAmount,
        gameId: s.gameId,
      });
      this.bot?.announceWin?.(
        refreshed.payoutChoice.address,
        refreshed.payoutChoice.asset === ASSET.ZNN
          ? refreshed.payoutChoice.amount
          : s.payoutAmount,
        s.gameId
      );
      return {
        won:          true,
        payoutQueued: true,
        payoutAmount: refreshed.payoutChoice.amount,
        payoutAsset:  refreshed.payoutChoice.asset,
        payoutOptions,
        verification: verification.details || null,
      };
    }

    // No payout choice yet — ask client to pick a rail
    this.sessions.awaitingPayoutChoice(sessionId, { payoutOptions });
    return {
      won:                  true,
      requiresPayoutChoice: true,
      payoutOptions,
      verification:         verification.details || null,
    };
  }

  // ── PAYOUT CHOICE ───────────────────────────────────────

  /**
   * Record a player's chosen payout rail and queue the payout.
   * IMPORTANT: caller must hold payoutLock before calling this.
   */
  choosePayoutRail(sessionId, asset, address) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ServiceError(404, 'Session not found');
    if (!['AWAITING_PAYOUT_CHOICE', 'GAME_WON'].includes(s.state))
      throw new ServiceError(400, `Cannot choose payout while session is ${s.state}`);

    const normalised = normalizeAsset(asset);
    if (!normalised) throw new ServiceError(400, 'Unsupported payout asset');

    const enabledPayouts = getEnabledPayoutAssets(this.serverConfig);
    if (!enabledPayouts.includes(normalised))
      throw new ServiceError(400, `Unsupported payout asset. Options: ${enabledPayouts.join(', ')}`);
    if (!isValidAddressForAsset(normalised, address))
      throw new ServiceError(400, `Invalid ${normalised} payout address`);

    const option = getPayoutOption(s, normalised);
    if (!option)
      throw new ServiceError(400, `Payout asset ${normalised} is not available for this session`);

    this.sessions.setPayoutChoice(sessionId, {
      asset:            normalised,
      address,
      amount:           option.amount,
      availableOptions: s.quote?.payoutOptions || [],
    });
    this.sessions.setState(sessionId, 'GAME_WON', { note: `payout choice: ${normalised}` });
    this.worker.queuePayout(sessionId);

    return { asset: normalised, address, amount: option.amount };
  }

  // ── HELPERS ─────────────────────────────────────────────

  _isValidPlayerAddress(address) {
    return isValidAddressForAsset(ASSET.ZNN, address)
        || isValidAddressForAsset(ASSET.BTC, address);
  }
}

// ── TYPED ERROR ─────────────────────────────────────────────────────────────

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name   = 'ServiceError';
    this.status = status;
  }
}

module.exports = { GameService, ServiceError };
