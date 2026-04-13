# NOM-GAMEZ Backend

> Zenon Network deposit watcher & payout engine for the NOM-GAMEZ platform.

---

## SETUP

```bash
# 1. Install dependencies
npm install

# NOTE: znn-ts-sdk installs from GitHub (not npm registry) — this is normal
# It pulls directly from github:dexter703/znn-ts-sdk

# 2. Configure environment
cp .env.example .env
nano .env   # fill in your seed + address

# 3. Run
npm start          # production
npm run dev        # dev with auto-reload (nodemon)
npm run start:prod # explicit production start wrapper
```

---

## .env REQUIRED VALUES

```
PLATFORM_SEED=your 24 word mnemonic here
PLATFORM_ADDRESS=z1q...  (first address derived from seed)
ZNN_NODE_URL=wss://my.hc1node.com:35998
EXPLORER_API=https://zenonhub.io/api
PORT=3001
HOST=127.0.0.1
CORS_ORIGIN=https://your-frontend-domain.com
ADMIN_TOKEN=long-random-secret-for-admin-bearer-auth
```

## PHASE 1 SAFETY DEFAULTS

The backend now starts in a locked-down mode by default:

- `/admin/*` requires `Authorization: Bearer <ADMIN_TOKEN>`
- prediction market deposits are disabled unless `ENABLE_UNSAFE_MARKETS=true`
- free play and free-play claims are disabled unless `ENABLE_UNSAFE_FREEPLAY=true`

These switches exist only as temporary compatibility escapes while the unsafe flows are being rebuilt. They should remain `false` in production.

## PHASE 2 DURABILITY

Runtime state now lives in `nomgamez-backend/data/runtime-state.sqlite`.

If an older `runtime-state.json` exists, the backend migrates it into SQLite automatically on first boot.

Core runtime entities are now also persisted into dedicated SQLite tables instead of only a single serialized blob:

- `sessions`
- `seen_hashes`
- `markets`
- `market_positions`
- `market_payout_queue`
- `payout_queue`
- `payout_ledger`

The regular serialized snapshot is now mainly a compatibility layer for the remaining non-core runtime modules. `sessions`, `markets`, and `payoutWorker` are restored primarily from SQLite tables.

Persisted state currently includes:

- sessions and seen deposit hashes
- markets, positions, and pending market payout queue
- free-play usage and pending claims
- runtime config and config history
- admin alerts, bot action log, engagement stats, health checks, and payout metrics
- payout worker retry queue

## PHASE 3 PAYOUT SAFETY

The payout worker now keeps a durable payout ledger per session so it can:

- avoid re-queuing sessions that already have a recorded payout tx
- survive restarts without forgetting queued/retrying payout attempts
- expose payout lifecycle details through `GET /session/:id/payout-status`

This improves idempotency and restart recovery, but it does not yet replace a full treasury reconciliation system or a real database-backed payments ledger.

## PHASE 6 TREASURY + LIVE SAFETY

The backend now includes a treasury manager in front of payouts and bot market creation.

- payout attempts require a fresh wallet reconciliation before funds are sent
- payout attempts are blocked if reserve, liability, or wallet-balance checks fail
- treasury state is persisted together with the rest of runtime state
- treasury ledger entries and reconciliation snapshots are stored in SQLite tables instead of only inside the serialized runtime blob
- the bot can auto-halt market creation when treasury risk is detected
- operators can inspect and control treasury state with:
  - `GET /admin/treasury`
  - `POST /admin/treasury/reconcile`
  - `POST /admin/treasury/halt`

Wallet reconciliation now tries the Zenon node first via the SDK and only falls back to explorer endpoints if the node path fails.

## PHASE 4 MARKET SETTLEMENT

Prediction market positions now follow a two-step lifecycle:

- `PENDING_DEPOSIT` when a position is created
- `OPEN` only after the deposit is confirmed on-chain

Only funded `OPEN` positions are included in pool totals, resolution math, and settlement payouts. Market wins and void refunds are now drained by the payout worker and paid through the same durable retry path as game payouts.

The file is intentionally ignored by git.

## PHASE 5 GAME VERIFICATION

Game result submission is now server-verified instead of trusting a client-reported `won` flag.

- `dice` results are recomputed from the session seed and submitted mode proof
- `slots` results are recomputed from the session seed and submitted reel proof
- `shooter` is intentionally disabled until a replayable proof system exists

---

## API ENDPOINTS

| Method | Path | Description |
|--------|------|-------------|
| GET | `/info` | Platform info, deposit address, valid bets |
| POST | `/session/create` | Start a session, get deposit instructions |
| GET | `/session/:id` | Poll session state |
| POST | `/session/:id/verify-deposit` | Submit tx hash for verification |
| POST | `/session/:id/start` | Mark game as started |
| POST | `/session/:id/result` | Submit win/loss result |
| GET | `/session/:id/payout-status` | Check payout tx hash |
| GET | `/stats` | Server stats |
| GET | `/health` | Health check |
| GET | `/ready` | Readiness check for deploy health probes |

---

## GAME FLOW

```
1. Frontend calls POST /session/create
   → Returns sessionId + deposit instructions

2. Player sends ZNN from their wallet to PLATFORM_ADDRESS

3a. Auto: backend polls explorer every 10s for matching deposit
3b. Manual: player pastes tx hash → POST /session/:id/verify-deposit

4. Session state → DEPOSIT_CONFIRMED
   Frontend starts the game

5. POST /session/:id/start

6. Game plays out client-side

7. POST /session/:id/result { proof: {...} }
   → Server recomputes the deterministic outcome for supported games
   → Win: payout queued, 10x ZNN sent back
   → Loss: funds stay in platform wallet

8. GET /session/:id/payout-status → payoutTxHash when done
```

---

## VALID BET AMOUNTS

Increments of 0.9 ZNN, maximum 9 ZNN:

`0.9 / 1.8 / 2.7 / 3.6 / 4.5 / 5.4 / 6.3 / 7.2 / 8.1 / 9.0`

Win pays **10x** the bet amount.

---

## PUBLIC ZENON NODES

```
wss://my.hc1node.com:35998
wss://node.zenon.fun:35998
wss://node.atsocy.com:35998
```

---

## HOSTING (STEALTH)

```bash
# Hetzner VPS (cheapest, no KYC for crypto payment)
# Ubuntu 22.04, 2GB RAM is fine

# Install Node
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs

# Run with PM2 (keeps alive on crash/reboot)
npm install -g pm2
pm2 start server.js --name nomgamez-backend
pm2 save
pm2 startup

# Nginx reverse proxy (optional, for custom domain + SSL)
# proxy_pass http://localhost:3001;
```

## DEPLOY HEALTHCHECK

```bash
npm run healthcheck
```

This calls `/ready` against `HOST`/`PORT` and exits non-zero if the backend is not ready yet.

---

## SECURITY NOTES

- `.env` is in `.gitignore` — seed phrase **never** enters git
- Payout worker runs server-side only — seed never touches browser
- Tx hashes are tracked to prevent deposit replay attacks
- Sessions expire after `DEPOSIT_TIMEOUT` seconds
- `/admin/*` is protected by a bearer token and disabled entirely if `ADMIN_TOKEN` is missing
- Request body size is limited and sensitive routes are rate limited in-process
- `dice` and `slots` are server-verified; `shooter` stays disabled until its proof system exists
- Prediction market wagering and free play are intentionally disabled by default until durable settlement and abuse resistance are implemented
- Treasury reconciliation can auto-halt payouts and bot market creation when reserve or liability checks fail
