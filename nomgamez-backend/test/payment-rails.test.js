const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ASSET,
  normalizeAsset,
  isValidAddressForAsset,
  getEnabledDepositAssets,
  getEnabledPayoutAssets,
  getPayoutOption,
  buildPaymentSummary,
} = require('../payment-rails');

test('normalizeAsset uppercases supported rails', () => {
  assert.equal(normalizeAsset('btc'), ASSET.BTC);
  assert.equal(normalizeAsset('znn'), ASSET.ZNN);
});

test('address validation matches BTC and ZNN rails', () => {
  assert.equal(isValidAddressForAsset('ZNN', 'z1qexampleaddress123'), true);
  assert.equal(isValidAddressForAsset('BTC', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'), true);
  assert.equal(isValidAddressForAsset('BTC', 'z1qexampleaddress123'), false);
});

test('enabled rails derive from configured infra', () => {
  const serverConfig = {
    PLATFORM_ADDRESS: 'z1qplatform',
    PLATFORM_SEED: 'seed words',
    BTC_DEPOSIT_ADDRESS: 'bc1qdeposit',
    BTC_WALLET_RPC_URL: 'http://127.0.0.1:8332',
  };

  assert.deepEqual(getEnabledDepositAssets(serverConfig), ['ZNN', 'BTC']);
  assert.deepEqual(getEnabledPayoutAssets(serverConfig), ['ZNN', 'BTC']);
});

test('payment summary exposes promo configuration', () => {
  const summary = buildPaymentSummary(
    { PLATFORM_ADDRESS: 'z1qplatform', PLATFORM_SEED: 'seed', BTC_DEPOSIT_ADDRESS: 'bc1qdeposit', BTC_WALLET_RPC_URL: 'http://wallet' },
    { btcWinMultiplier: 2, znnPromoWinMultiplier: 20, znnPromoMaxPayoutZnn: 100, maxPromoEligibleDepositUsd: 250, btcValidBets: [0.0001, 0.001] }
  );

  assert.equal(summary.btcWinMultiplier, 2);
  assert.equal(summary.znnPromoWinMultiplier, 20);
  assert.equal(summary.znnPromoMaxPayoutZnn, 100);
  assert.deepEqual(summary.btcValidBets, [0.0001, 0.001]);
});

test('payout option lookup finds the requested asset', () => {
  const session = {
    quote: {
      payoutOptions: [
        { asset: 'BTC', amount: 0.002 },
        { asset: 'ZNN', amount: 20 },
      ],
    },
  };

  assert.deepEqual(getPayoutOption(session, 'btc'), { asset: 'BTC', amount: 0.002 });
  assert.equal(getPayoutOption(session, 'eth'), null);
});
