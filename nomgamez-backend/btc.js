const axios = require('axios');

const SATS_PER_BTC = 1e8;

function toSats(amountBtc) {
  return Math.round(Number(amountBtc) * SATS_PER_BTC);
}

function fromSats(amountSats) {
  return Number(amountSats) / SATS_PER_BTC;
}

async function callBitcoinRpc({ url, username, password, wallet = null }, method, params = []) {
  if (!url) throw new Error('BTC RPC URL is not configured');

  const endpoint = wallet ? `${url.replace(/\/$/, '')}/wallet/${wallet}` : url;
  const payload = {
    jsonrpc: '1.0',
    id: `nomgamez-${Date.now()}`,
    method,
    params,
  };

  const res = await axios.post(endpoint, payload, {
    auth: username ? { username, password: password || '' } : undefined,
    timeout: 15000,
  });

  if (res.data?.error) {
    throw new Error(res.data.error.message || `${method} failed`);
  }
  return res.data?.result;
}

async function verifyBtcDeposit({ txid, expectedAddress, expectedAmountBtc, minConfirmations = 1, rpcConfig }) {
  if (!txid || String(txid).length < 16) {
    return { valid: false, reason: 'Invalid BTC transaction id' };
  }

  const tx = await callBitcoinRpc(rpcConfig, 'getrawtransaction', [txid, true]);
  if (!tx) return { valid: false, reason: 'BTC transaction not found' };

  const confirmations = Number(tx.confirmations || 0);
  if (confirmations < minConfirmations) {
    return { valid: false, reason: `BTC transaction has ${confirmations} confirmations, need ${minConfirmations}` };
  }

  const outputs = Array.isArray(tx.vout) ? tx.vout : [];
  const matching = outputs.find((vout) => {
    const addresses = [
      vout?.scriptPubKey?.address,
      ...(Array.isArray(vout?.scriptPubKey?.addresses) ? vout.scriptPubKey.addresses : []),
    ].filter(Boolean);
    return addresses.some((address) => String(address).toLowerCase() === String(expectedAddress).toLowerCase());
  });

  if (!matching) {
    return { valid: false, reason: `BTC deposit does not pay expected address ${expectedAddress}` };
  }

  const amountBtc = Number(matching.value);
  const toleranceSats = 500;
  if (Math.abs(toSats(amountBtc) - toSats(expectedAmountBtc)) > toleranceSats) {
    return {
      valid: false,
      reason: `BTC amount mismatch: expected ${expectedAmountBtc} BTC, got ${amountBtc} BTC`,
    };
  }

  return {
    valid: true,
    txid: tx.txid || txid,
    confirmations,
    amountBtc,
  };
}

async function sendBtcPayout({ address, amountBtc, walletRpcConfig }) {
  if (!address) throw new Error('BTC payout address missing');
  if (!Number.isFinite(Number(amountBtc)) || Number(amountBtc) <= 0) {
    throw new Error('Invalid BTC payout amount');
  }
  if (!walletRpcConfig?.url) {
    throw new Error('BTC wallet RPC is not configured. btcd alone cannot sign payouts; configure btcwallet/bitcoind wallet RPC.');
  }

  const txid = await callBitcoinRpc(walletRpcConfig, 'sendtoaddress', [address, Number(amountBtc)]);
  return { success: true, txHash: txid };
}

module.exports = {
  SATS_PER_BTC,
  toSats,
  fromSats,
  callBitcoinRpc,
  verifyBtcDeposit,
  sendBtcPayout,
};
