const { getPrice } = require('./oracle');

const ASSET = {
  BTC: 'BTC',
  ZNN: 'ZNN',
};

function normalizeAsset(asset) {
  return String(asset || '').trim().toUpperCase();
}

function isValidZnnAddress(address) {
  return typeof address === 'string' && address.startsWith('z1q') && address.length >= 10;
}

function isValidBtcAddress(address) {
  return typeof address === 'string' && /^(bc1|tb1|[13]|[mn2])[a-zA-Z0-9]{20,}$/i.test(address);
}

function isValidAddressForAsset(asset, address) {
  const normalized = normalizeAsset(asset);
  if (normalized === ASSET.ZNN) return isValidZnnAddress(address);
  if (normalized === ASSET.BTC) return isValidBtcAddress(address);
  return false;
}

function getEnabledDepositAssets(serverConfig = {}) {
  const assets = [];
  if (serverConfig.PLATFORM_ADDRESS) assets.push(ASSET.ZNN);
  if (serverConfig.BTC_DEPOSIT_ADDRESS) assets.push(ASSET.BTC);
  return assets;
}

function getEnabledPayoutAssets(serverConfig = {}) {
  const assets = [];
  if (serverConfig.PLATFORM_SEED) assets.push(ASSET.ZNN);
  if (serverConfig.BTC_WALLET_RPC_URL) assets.push(ASSET.BTC);
  return assets;
}

async function buildQuote({ depositAsset, depositAmount, paymentConfig }) {
  const asset = normalizeAsset(depositAsset);
  const amount = Number(depositAmount);

  if (!Object.values(ASSET).includes(asset)) {
    throw new Error(`Unsupported deposit asset: ${depositAsset}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Deposit amount must be positive');
  }

  const [btcUsd, znnUsd] = await Promise.all([getPrice('BTC'), getPrice('ZNN')]);
  if (!btcUsd || !znnUsd) {
    throw new Error('Unable to lock BTC/ZNN reference rates right now');
  }

  const usdValue = asset === ASSET.BTC ? amount * btcUsd : amount * znnUsd;
  const btcValue = usdValue / btcUsd;
  const znnValue = usdValue / znnUsd;
  const btcPayoutAmount = roundAssetAmount(btcValue * Number(paymentConfig.btcWinMultiplier || 2), ASSET.BTC);
  const znnPayoutRaw = znnValue * Number(paymentConfig.znnPromoWinMultiplier || 20);
  const znnPayoutAmount = roundAssetAmount(
    Math.min(znnPayoutRaw, Number(paymentConfig.znnPromoMaxPayoutZnn || znnPayoutRaw)),
    ASSET.ZNN
  );
  const promoEligible = usdValue <= Number(paymentConfig.maxPromoEligibleDepositUsd || Number.MAX_SAFE_INTEGER);

  return {
    depositAsset: asset,
    depositAmount: roundAssetAmount(amount, asset),
    usdValue: roundUsd(usdValue),
    fx: {
      btcUsd: roundUsd(btcUsd),
      znnUsd: roundUsd(znnUsd),
    },
    equivalents: {
      btc: roundAssetAmount(btcValue, ASSET.BTC),
      znn: roundAssetAmount(znnValue, ASSET.ZNN),
    },
    payoutOptions: [
      {
        asset: ASSET.BTC,
        amount: btcPayoutAmount,
        multiplier: Number(paymentConfig.btcWinMultiplier || 2),
        kind: 'conservative',
      },
      {
        asset: ASSET.ZNN,
        amount: znnPayoutAmount,
        multiplier: Number(paymentConfig.znnPromoWinMultiplier || 20),
        kind: promoEligible ? 'boosted_promo' : 'capped_boosted_promo',
        capped: znnPayoutAmount < roundAssetAmount(znnPayoutRaw, ASSET.ZNN),
        promoEligible,
      },
    ],
    createdAt: Date.now(),
  };
}

function getPayoutOption(session, payoutAsset) {
  const normalized = normalizeAsset(payoutAsset);
  const quote = session?.quote;
  if (!quote?.payoutOptions) return null;
  return quote.payoutOptions.find((option) => option.asset === normalized) || null;
}

function buildPaymentSummary(serverConfig, paymentConfig) {
  return {
    enabledDepositAssets: getEnabledDepositAssets(serverConfig),
    enabledPayoutAssets: getEnabledPayoutAssets(serverConfig),
    btcWinMultiplier: Number(paymentConfig.btcWinMultiplier || 2),
    znnPromoWinMultiplier: Number(paymentConfig.znnPromoWinMultiplier || 20),
    znnPromoMaxPayoutZnn: Number(paymentConfig.znnPromoMaxPayoutZnn || 0),
    maxPromoEligibleDepositUsd: Number(paymentConfig.maxPromoEligibleDepositUsd || 0),
    btcValidBets: Array.isArray(paymentConfig.btcValidBets) ? paymentConfig.btcValidBets : [],
  };
}

function roundAssetAmount(value, asset) {
  const decimals = asset === ASSET.BTC ? 8 : 8;
  return Number(Number(value).toFixed(decimals));
}

function roundUsd(value) {
  return Number(Number(value).toFixed(4));
}

module.exports = {
  ASSET,
  normalizeAsset,
  isValidAddressForAsset,
  isValidBtcAddress,
  isValidZnnAddress,
  getEnabledDepositAssets,
  getEnabledPayoutAssets,
  buildQuote,
  getPayoutOption,
  buildPaymentSummary,
};
