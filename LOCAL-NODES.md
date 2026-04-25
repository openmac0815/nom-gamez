# Running NOM-GAMEZ with Local Nodes (Don't Trust, Verify)

This guide explains how to run NOM-GAMEZ with your **own local Zenon and Bitcoin nodes** instead of trusting external ones.

## Why Run Your Own Nodes?

- **Trustless**: Verify transactions yourself instead of trusting external APIs
- **Privacy**: Your transaction data stays local
- **Reliability**: No dependency on third-party services
- **Philosophy**: "Don't trust, verify" — core crypto principle

---

## Prerequisites

### 1. Zenon Node (znnd)
The easiest way is using Docker:

```bash
docker run -d \
  --name zenon-node \
  -v zenon-data:/root/.znn \
  -p 35998:35998 \
  -p 35999:35999 \
  eove7kj/znnd:latest
```

Wait for the node to sync (~2-3 hours for full sync).

### 2. Bitcoin Node (bitcoind)
Using Docker:

```bash
docker run -d \
  --name bitcoin-node \
  -v bitcoin-data:/bitcoin/.bitcoin \
  -p 8332:8332 \
  -p 8333:8333 \
  kylemanna/bitcoind:latest
```

This will take several days for full sync. You can start using it immediately as deposits come in.

---

## Quick Start with Docker Compose

The easiest way — everything in one command:

```bash
cd nom-gamez
docker-compose up -d
```

This starts:
- `zenon-node` — Local Zenon node
- `bitcoin-node` — Local Bitcoin node  
- `backend` — NOM-GAMEZ API server
- `redis` — Session storage
- `frontend` — Web UI (nginx)

---

## Configuration

### Backend `.env` File

Copy the example and edit:

```bash
cd nomgamez-backend
cp .env.example .env
nano .env
```

**Key settings for local nodes:**

```env
# Zenon Node (local Docker container)
ZNN_NODE_URL=ws://zenon-node:35998
EXPLORER_API=http://zenon-node:35998/api

# Bitcoin Node (local Docker container)
BTC_RPC_URL=http://bitcoin-node:8332
BTC_WALLET_RPC_URL=http://bitcoin-node:8332
BTC_RPC_USER=bitcoinrpc
BTC_RPC_PASS=your_btc_rpc_password_here

# Your Zenon wallet (keep secret!)
PLATFORM_SEED=your_zenon_wallet_seed_here
PLATFORM_ADDRESS=your_zenon_platform_address_here

# Your Bitcoin deposit address
BTC_DEPOSIT_ADDRESS=your_btc_deposit_address_here

# Admin token (generate a strong one)
ADMIN_TOKEN=your_strong_random_admin_token_here
```

---

## Verifying It Works

### 1. Check Zenon Node
```bash
docker exec zenon-node znn-cli getinfo
```

### 2. Check Bitcoin Node
```bash
docker exec bitcoin-node bitcoin-cli getblockchaininfo
```

### 3. Check NOM-GAMEZ Backend
```bash
curl http://localhost:3001/health
```

### 4. Check Logs
```bash
docker-compose logs -f backend
```

---

## Troubleshooting

### Zenon Node Not Syncing
```bash
docker logs zenon-node --tail 50
```

### Bitcoin RPC Connection Failed
Check the Bitcoin node logs:
```bash
docker logs bitcoin-node --tail 50
```

Verify RPC credentials in `bitcoin.conf`:
```bash
docker exec bitcoin-node cat /bitcoin/.bitcoin/bitcoin.conf
```

### Backend Can't Connect to Nodes
Make sure all services are on the same Docker network:
```bash
docker network inspect nom-gamez_default
```

---

## Security Notes

⚠️ **Never commit `.env` to git** — it contains secrets!
⚠️ **Use strong passwords** for BTC RPC and admin token
⚠️ **Rotate secrets** if they were ever exposed

---

## Production Deployment

For production, consider:
1. Using a reverse proxy (nginx/caddy) with TLS
2. Setting up proper firewall rules
3. Using Docker secrets or vault for sensitive data
4. Monitoring node sync status
5. Setting up log rotation

---

**Remember: Don't trust, verify! 🎰**
