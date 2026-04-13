// zenon.js — Zenon Network interaction layer
// Wraps znn-ts-sdk for deposit watching and payout sending

const axios = require('axios');

// ZNN token standard on Zenon Network
const ZNN_TOKEN_STANDARD = 'zts1znnxxxxxxxxxxxxx9z4ulx';
// 1 ZNN = 100000000 (8 decimals)
const ZNN_DECIMALS = 1e8;
let cachedSdk = null;

/**
 * Convert ZNN float to raw integer
 */
function toRaw(znn) {
  return Math.round(parseFloat(znn) * ZNN_DECIMALS);
}

/**
 * Convert raw integer to ZNN float
 */
function fromRaw(raw) {
  return parseInt(raw) / ZNN_DECIMALS;
}

/**
 * Query ZenonHub explorer API for transactions to/from an address
 * Returns array of recent transactions
 */
async function getAddressTransactions(address, explorerApi) {
  try {
    const url = `${explorerApi}/nom/account-block/list?address=${address}&page=0&count=20`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data && res.data.data && res.data.data.list) {
      return res.data.data.list;
    }
    return [];
  } catch (err) {
    console.error('[zenon] getAddressTransactions error:', err.message);
    return [];
  }
}

/**
 * Look up a specific transaction hash via explorer
 */
async function getTransactionByHash(hash, explorerApi) {
  try {
    const url = `${explorerApi}/nom/account-block/detail?hash=${hash}`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data && res.data.data) {
      return res.data.data;
    }
    return null;
  } catch (err) {
    console.error('[zenon] getTransactionByHash error:', err.message);
    return null;
  }
}

async function loadZenonSdk() {
  if (cachedSdk) return cachedSdk;
  try {
    const sdk = await import('znn-ts-sdk/dist/index.node.js');
    const root = sdk.default || sdk;
    cachedSdk = {
      Znn: root.Zenon,
      KeyStore: root.KeyStore,
      AccountBlockTemplate: root.AccountBlockTemplate,
      Primitives: root.Primitives,
      Constants: root.Constants,
    };
    return cachedSdk;
  } catch (err) {
    throw new Error('znn-ts-sdk not installed. Run: npm install github:dexter703/znn-ts-sdk');
  }
}

function extractZnnBalance(payload) {
  const visited = new Set();
  const queue = [payload];

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const tokenStandard = current.tokenStandard || current.zts || current.token?.tokenStandard;
    const rawBalance = current.balance ?? current.amount ?? current.available ?? current.tokenBalance;

    if (tokenStandard === ZNN_TOKEN_STANDARD && rawBalance !== undefined && rawBalance !== null) {
      return fromRaw(rawBalance);
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return null;
}

async function getWalletBalance({ address, explorerApi, nodeUrl = null }) {
  const errors = [];

  if (nodeUrl) {
    try {
      return await getWalletBalanceFromNode({ address, nodeUrl });
    } catch (err) {
      errors.push(`node: ${err.message}`);
    }
  }

  const endpoints = [
    `${explorerApi}/embedded/token/getByOwner?address=${address}`,
    `${explorerApi}/embedded/token.getByOwner?address=${address}`,
    `${explorerApi}/ledger/get-account-info?address=${address}`,
    `${explorerApi}/ledger/account-info?address=${address}`,
    `${explorerApi}/nom/account/info?address=${address}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { timeout: 8000 });
      const balanceZnn = extractZnnBalance(res.data);
      if (balanceZnn !== null) {
        return { balanceZnn, source: url };
      }
      errors.push(`No ZNN balance found in response from ${url}`);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  throw new Error(`Unable to reconcile wallet balance. ${errors.slice(0, 3).join(' | ')}`);
}

async function getWalletBalanceFromNode({ address, nodeUrl }) {
  const { Znn, Primitives } = await loadZenonSdk();
  const zenon = Znn.getSingleton();

  try {
    await zenon.initialize(nodeUrl, false);
    const parsedAddress = Primitives.Address.parse(address);
    const accountInfo = await zenon.ledger.getAccountInfoByAddress(parsedAddress);
    const balanceZnn = extractZnnBalanceFromAccountInfo(accountInfo);

    if (balanceZnn == null) {
      throw new Error('ZNN balance not present in node account info');
    }

    return { balanceZnn, source: `node:${nodeUrl}` };
  } finally {
    try { zenon.client?.websocket?.close(); } catch (_) {}
  }
}

function extractZnnBalanceFromAccountInfo(accountInfo) {
  if (!accountInfo) return null;
  const list = [];

  if (Array.isArray(accountInfo.balanceInfoList)) list.push(...accountInfo.balanceInfoList);
  if (accountInfo.balanceInfoMap && typeof accountInfo.balanceInfoMap === 'object') {
    list.push(...Object.values(accountInfo.balanceInfoMap));
  }

  for (const item of list) {
    const tokenStd = String(item?.token?.tokenStandard?.toString?.() || item?.token?.tokenStandard || item?.tokenStandard || '');
    if (tokenStd !== ZNN_TOKEN_STANDARD) continue;

    if (item.balanceWithDecimals != null) return parseFloat(item.balanceWithDecimals);
    if (item.balanceFormatted != null) return parseFloat(item.balanceFormatted);
    if (item.balance != null) return fromRaw(item.balance.toString ? item.balance.toString() : item.balance);
  }

  return null;
}

/**
 * Verify a deposit transaction:
 * - Correct destination (platform address)
 * - Correct token (ZNN)
 * - Correct amount
 * - Came from expected sender address
 * Returns { valid, amount, fromAddress, confirmations }
 */
async function verifyDeposit({ txHash, expectedFrom, expectedAmount, platformAddress, explorerApi }) {
  const tx = await getTransactionByHash(txHash, explorerApi);

  if (!tx) {
    return { valid: false, reason: 'Transaction not found' };
  }

  const toAddr = tx.toAddress || tx.address;
  const fromAddr = tx.address || tx.fromAddress;
  const tokenStd = tx.tokenStandard || (tx.token && tx.token.tokenStandard);
  const rawAmount = tx.amount || tx.data?.amount;

  // Check destination
  if (toAddr && toAddr.toLowerCase() !== platformAddress.toLowerCase()) {
    return { valid: false, reason: `Wrong destination: got ${toAddr}` };
  }

  // Check token is ZNN
  if (tokenStd && tokenStd !== ZNN_TOKEN_STANDARD) {
    return { valid: false, reason: `Wrong token: ${tokenStd}` };
  }

  // Check sender matches player address
  if (expectedFrom && fromAddr && fromAddr.toLowerCase() !== expectedFrom.toLowerCase()) {
    return { valid: false, reason: `Sender mismatch: expected ${expectedFrom}, got ${fromAddr}` };
  }

  // Check amount
  const receivedRaw = parseInt(rawAmount || 0);
  const expectedRaw = toRaw(expectedAmount);
  const tolerance = Math.round(ZNN_DECIMALS * 0.001); // 0.001 ZNN tolerance

  if (Math.abs(receivedRaw - expectedRaw) > tolerance) {
    return {
      valid: false,
      reason: `Amount mismatch: expected ${expectedAmount} ZNN (${expectedRaw}), got ${fromRaw(receivedRaw)} ZNN (${receivedRaw})`
    };
  }

  return {
    valid: true,
    amount: fromRaw(receivedRaw),
    fromAddress: fromAddr,
    txHash: tx.hash || txHash,
    height: tx.height,
  };
}

/**
 * Poll explorer for incoming deposit from a player address
 * Used for automatic detection (no manual tx hash entry)
 * Returns tx object if found, null otherwise
 */
async function pollForDeposit({ platformAddress, fromAddress, expectedAmount, explorerApi, seenHashes }) {
  const txs = await getAddressTransactions(platformAddress, explorerApi);

  for (const tx of txs) {
    const hash = tx.hash;
    if (seenHashes.has(hash)) continue;

    const fromAddr = tx.address || tx.fromAddress;
    const tokenStd = tx.tokenStandard || (tx.token && tx.token.tokenStandard);
    const rawAmount = parseInt(tx.amount || 0);
    const expectedRaw = toRaw(expectedAmount);
    const tolerance = Math.round(ZNN_DECIMALS * 0.001);

    if (
      fromAddr && fromAddr.toLowerCase() === fromAddress.toLowerCase() &&
      tokenStd === ZNN_TOKEN_STANDARD &&
      Math.abs(rawAmount - expectedRaw) <= tolerance
    ) {
      return { hash, amount: fromRaw(rawAmount), fromAddress: fromAddr };
    }
  }
  return null;
}

/**
 * Send ZNN payout using znn-ts-sdk
 * Loads wallet from mnemonic, sends to player address
 */
async function sendPayout({ mnemonic, toAddress, amount, nodeUrl }) {
  if (!mnemonic || typeof mnemonic !== 'string' || mnemonic.trim().split(/\s+/).length < 12) {
    throw new Error('Invalid wallet mnemonic');
  }
  if (!toAddress || !String(toAddress).startsWith('z1q')) {
    throw new Error('Invalid payout destination address');
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new Error('Invalid payout amount');
  }

  const { Znn, KeyStore, AccountBlockTemplate, Primitives, Constants } = await loadZenonSdk();

  const zenon = Znn.getSingleton();

  try {
    await zenon.initialize(nodeUrl, false);

    // Load wallet from mnemonic
    const keyStore = await KeyStore.fromMnemonic(mnemonic);
    const keyPair = keyStore.getKeyPair(0); // first address

    const rawAmount = toRaw(amount);
    const toAddr = Primitives.Address.parse(toAddress);

    const block = AccountBlockTemplate.send(toAddr, Constants.znnZts, BigInt(rawAmount));

    console.log(`[payout] Sending ${amount} ZNN (${rawAmount} raw) to ${toAddress}`);
    await zenon.send(block, keyPair);
    console.log(`[payout] TX sent: ${block.hash}`);
    return { success: true, txHash: block.hash.toString() };
  } catch (err) {
    console.error('[payout] Send failed:', err.message);
    throw err;
  } finally {
    try { zenon.client?.websocket?.close(); } catch (_) {}
  }
}

module.exports = {
  toRaw,
  fromRaw,
  ZNN_TOKEN_STANDARD,
  ZNN_DECIMALS,
  getAddressTransactions,
  getTransactionByHash,
  getWalletBalance,
  getWalletBalanceFromNode,
  verifyDeposit,
  pollForDeposit,
  sendPayout,
};
