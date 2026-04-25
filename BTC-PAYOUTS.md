# BTC Payouts Setup Guide

This guide explains how to set up Bitcoin payouts for NOM-GAMEZ using `btcwallet` or a managed payout service.

## Prerequisites
- Bitcoin Core node (for `btcwallet` setup)
- Or a managed service like BlockCypher, BitPay, or similar

## Option 1: Self-Hosted with Bitcoin Core + btcwallet

### 1. Install Bitcoin Core
Follow the [official installation guide](https://bitcoin.org/en/full-node#installation) for your OS.

Configure `bitcoin.conf`:
```ini
server=1
rpcuser=your_rpc_user
rpcpassword=your_secure_password
rpcport=8332
txindex=1
```

### 2. Start Bitcoin Core
```bash
bitcoind -daemon
# Wait for full sync (can take hours/days)
```

### 3. Configure NOM-GAMEZ
Update `nomgamez-backend/.env`:
```env
BTC_RPC_URL=http://127.0.0.1:8332
BTC_RPC_USER=your_rpc_user
BTC_RPC_PASSWORD=your_secure_password
BTC_WALLET_RPC_URL=http://127.0.0.1:8332/wallet/nom-gamez
BTC_DEPOSIT_ADDRESS=bc1qyour_deposit_address_here
```

### 4. Create a dedicated wallet
```bash
# Create wallet via RPC
curl --user your_rpc_user:your_secure_password \
  --data-binary '{"jsonrpc": "1.0", "id": "1", "method": "createwallet", "params": ["nom-gamez"]}' \
  -H 'content-type: text/plain;' http://127.0.0.1:8332/
```

## Option 2: Managed Payout Service

For smaller deployments, use a managed service:
1. Sign up for [BlockCypher](https://www.blockcypher.com/) or similar
2. Get API key and configure `BTC_RPC_URL` to use their API
3. Set `BTC_DEPOSIT_ADDRESS` to your managed wallet address

## Verify Setup
```bash
cd nomgamez-backend
node -e "const { checkBtcConnection } = require('./btc'); checkBtcConnection().then(r => console.log('BTC Connection:', r));"
```

## Security Notes
- Never expose RPC credentials in `.env` (added to .gitignore)
- Use strong passwords for RPC access
- Restrict RPC access to localhost only in firewall
- Regularly backup your Bitcoin wallet
