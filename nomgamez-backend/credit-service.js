// credit-service.js — Business logic for the Game Hall credit system
//
// Owns all credit pass lifecycle transitions.
// server.js routes call these methods; they only handle req/res.

const { ASSET, normalizeAsset, isValidAddressForAsset,
        getEnabledDepositAssets, getEnabledPayoutAssets,
        buildQuote } = require('./payment-rails');
const { verifyDeposit }    = require('./zenon');
const { verifyBtcDeposit } = require('./btc');
const { ServiceError }     = require('./game-service');

class CreditService {
  /**
   * @param {object} deps
   * @param {object} deps.credits      — CreditManager
   * @param {object} deps.feed         — FeedManager
   * @param {object} deps.serverConfig — SERVER_CONFIG
   */
  constructor({ credits, feed, serverConfig }) {
    this.credits      = credits;
    this.feed         = feed;
    this.serverConfig = serverConfig;
  }

  // ── CREATE PASS ─────────────────────────────────────────

  /**
   * Create a game-hall credit pass. Returns pass + deposit details.
   */
  async createPass({ playerAddress, depositAsset: rawAsset, depositAmount }) {
    if (!playerAddress)
      throw new ServiceError(400, 'playerAddress required');

    const amt = parseFloat(depositAmount);
    if (!depositAmount || isNaN(amt) || amt <= 0)
      throw new ServiceError(400, 'depositAmount must be a positive number');

    const asset = normalizeAsset(rawAsset || 'ZNN');
    if (!asset) throw new ServiceError(400, 'Unsupported asset');

    if (!isValidAddressForAsset(ASSET.ZNN, playerAddress)
        && !isValidAddressForAsset(ASSET.BTC, playerAddress))
      throw new ServiceError(400, `Invalid address for ${asset}`);

    let quote;
    try {
      quote = await buildQuote({ asset, amount: amt });
    } catch (e) {
      throw new ServiceError(502, `Quote error: ${e.message}`);
    }

    const pass = this.credits.create({
      playerAddress,
      depositAsset:   asset,
      depositAmount:  amt,
      creditAmount:   quote.znnEquivalent ?? amt,
      depositTimeout: this.serverConfig.DEPOSIT_TIMEOUT,
    });

    const depositAddress = asset === ASSET.BTC
      ? this.serverConfig.BTC_DEPOSIT_ADDRESS
      : this.serverConfig.PLATFORM_ADDRESS;

    return { pass, depositAddress, quote };
  }

  // ── VERIFY DEPOSIT ──────────────────────────────────────

  /**
   * Verify deposit and activate the pass.
   * IMPORTANT: caller must hold payoutLock before calling this.
   */
  async verifyDeposit(passId, txHash) {
    if (!txHash) throw new ServiceError(400, 'txHash required');

    const pass = this.credits.get(passId);
    if (!pass) throw new ServiceError(404, 'Pass not found');
    if (pass.state !== 'PENDING_DEPOSIT')
      throw new ServiceError(400, `Pass is ${pass.state}, not PENDING_DEPOSIT`);

    const cfg = this.serverConfig;
    let verified = false;

    try {
      if (pass.depositAsset === ASSET.BTC) {
        const result = await verifyBtcDeposit({
          txid:              txHash,
          expectedAddress:   cfg.BTC_DEPOSIT_ADDRESS,
          expectedAmountBtc: pass.depositAmount,
          minConfirmations:  cfg.BTC_MIN_CONFIRMATIONS || 1,
          rpcConfig: { url: cfg.BTC_RPC_URL, username: cfg.BTC_RPC_USER, password: cfg.BTC_RPC_PASS },
        });
        verified = result?.valid && result.amount >= pass.depositAmount * 0.999;
      } else {
        const result = await verifyDeposit({
          txHash,
          expectedFrom:    pass.playerAddress,
          expectedAmount:  pass.depositAmount,
          platformAddress: cfg.PLATFORM_ADDRESS,
          explorerApi:     cfg.EXPLORER_API,
        });
        verified = result?.valid && (result.amount ?? 0) >= pass.depositAmount * 0.999;
      }
    } catch (err) {
      throw new ServiceError(502, `Verification error: ${err.message}`);
    }

    if (!verified) throw new ServiceError(402, 'Deposit not confirmed yet');

    const active = this.credits.confirmDeposit(passId, txHash);
    this.feed?.pushEvent?.({
      type:          'credit_pass_activated',
      passId,
      playerAddress: active.playerAddress,
      credits:       active.balance,
    });

    return active;
  }

  // ── CASHOUT ─────────────────────────────────────────────

  /**
   * Request cashout of remaining credit balance.
   * IMPORTANT: caller must hold payoutLock before calling this.
   */
  requestCashout(passId, { payoutAsset: rawAsset, payoutAddress }) {
    if (!rawAsset || !payoutAddress)
      throw new ServiceError(400, 'payoutAsset and payoutAddress required');

    const asset = normalizeAsset(rawAsset);
    if (!asset) throw new ServiceError(400, 'Unsupported payout asset');
    if (!isValidAddressForAsset(asset, payoutAddress))
      throw new ServiceError(400, `Invalid address for ${asset}`);

    const enabledPayouts = getEnabledPayoutAssets(this.serverConfig);
    if (!enabledPayouts.includes(asset))
      throw new ServiceError(400, `Unsupported payout asset. Options: ${enabledPayouts.join(', ')}`);

    let result;
    try {
      result = this.credits.requestCashout(passId, { payoutAsset: asset, payoutAddress });
    } catch (err) {
      throw new ServiceError(400, err.message);
    }

    this.feed?.pushEvent?.({
      type:   'credit_cashout_requested',
      passId: result.passId,
      amount: result.amount,
      asset:  result.asset,
    });

    return result;
  }
}

module.exports = { CreditService };
