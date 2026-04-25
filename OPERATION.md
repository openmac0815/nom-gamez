# OPERATION.md — NOM-GAMEZ Infrastructure & Operations

> "Don't trust, verify." — Bitcoin Philosophy

## 🏗️ Infrastructure Overview

NOM-GAMEZ runs on a **trustless infrastructure** where verification is done locally rather than relying on external APIs. This document describes the operational setup.

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    NOM-GAMEZ Platform                      │
├─────────────────────────────────────────────────────────────┤
│  Frontend (React + Vite) → Nginx (port 8080)              │
│  Backend API (Node.js) → Port 3001                        │
│  Redis → Session Storage (port 6379)                       │
├─────────────────────────────────────────────────────────────┤
│  Zenon Node (znnd) → Port 35998/35999                     │
│  Bitcoin Node (bitcoind) → Port 8332/8333                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  NOM (AI Daemon) │
                    │  Self-Managing   │
                    └─────────────────┘
```

---

## 🛡️ "Don't Trust, Verify" Philosophy

### Why Local Nodes?

- **Trustless:** Verify transactions yourself instead of trusting external APIs
- **Privacy:** Your transaction data stays local
- **Reliability:** No dependency on third-party services
- **Philosophy:** Core crypto principle — verify, don't trust

### What This Means in Practice

1. **Zenon Transactions:** Verified against our own `znnd` node, not a public RPC
2. **Bitcoin Deposits:** Checked against our own `bitcoind` node, not a block explorer
3. **Payouts:** Broadcast through local nodes, not third-party services
4. **Market Settlement:** Atomic settlement verified on-chain

---

## 🐳 Docker Setup

### Quick Start

The entire platform runs with a single command:

```bash
cd nom-gamez
docker-compose up -d
```

This starts:
- `zenon-node` — Local Zenon node (syncs blockchain)
- `bitcoin-node` — Local Bitcoin node (syncs blockchain)
- `backend` — NOM-GAMEZ API server
- `redis` — Session storage
- `frontend` — Web UI (nginx)

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  # Zenon Node (local znn node)
  zenon-node:
    image: eove7kj/znnd:latest
    container_name: zenon-node
    ports:
      - "35998:35998"
      - "35999:35999"
    volumes:
      - zenon-data:/root/.znn
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "znn-cli", "getinfo"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

  # Bitcoin Node (local btc node)
  bitcoin-node:
    image: kylemanna/bitcoind:latest
    container_name: bitcoin-node
    ports:
      - "8332:8332"
      - "8333:8333"
    volumes:
      - bitcoin-data:/bitcoin/.bitcoin
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bitcoin-cli", "getblockchaininfo"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

  # NOM-GAMEZ Backend Service
  backend:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PORT=3001
      - HOST=0.0.0.0
    volumes:
      # Mount .env file (not in image for security)
      - ./nomgamez-backend/.env:/app/.env:ro
      # Persist data (markets, positions, sessions)
      - ./nomgamez-backend/data:/app/data
    depends_on:
      - redis
      - zenon-node
      - bitcoin-node
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3001/ready', (res) => {process.exit(res.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  # Redis for session storage
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  # Nginx to serve frontend and proxy API
  frontend:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - ./nom-gamez.html:/usr/share/nginx/html/index.html:ro
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  redis-data:
  zenon-data:
  bitcoin-data:
```

---

## 📊 Node Sync Status Monitoring

### Zenon Node

**Check sync status:**
```bash
docker logs zenon-node --tail 50
```

**Check if process is running:**
```bash
docker exec zenon-node ps aux | grep znnd
```

**Wait time:** ~2-3 hours for full sync

### Bitcoin Node

**Check sync status:**
```bash
docker exec bitcoin-node bitcoin-cli getblockchaininfo
```

**Check sync progress:**
```bash
docker exec bitcoin-node bitcoin-cli getblockchaininfo | grep -E "blocks|headers|verificationprogress"
```

**Wait time:** Several days for full sync (can start using immediately as deposits come in)

### NOM-GAMEZ Backend Health

**Basic health check:**
```bash
curl http://localhost:3001/health
```

**Comprehensive readiness check (used by Docker):**
```bash
curl http://localhost:3001/ready
```

**AI-optimized status (for NOM):**
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/admin/ai/status
```

---

## 🏥 Self-Healing Capabilities

NOM includes a **Self-Healing Monitor** (`self-healing.js`) that automatically recovers from common failures.

### Monitored Conditions

| Condition | Action | Config Flag |
|-----------|--------|--------------|
| Circuit breaker stuck open > threshold + 1min | Force reset | `ai.selfHealingEnabled` |
| Sessions stuck in PENDING_DEPOSIT > 2x timeout | Cleanup stale sessions | `ai.selfHealingEnabled` |
| Markets stuck in LOCKED state > 5 | Attempt resolution | `ai.selfHealingEnabled` |
| Treasury halted but balance OK | Resume payouts | `ai.selfHealingEnabled` |
| Transient alerts (oracle_degraded, etc.) | Auto-resolve | `ai.selfHealingEnabled` |

### Self-Healing Code (self-healing.js)

```javascript
/**
 * Self-Healing Module
 * Monitors platform health and automatically recovers from common failures
 * Works with the AI command system for autonomous operation
 */
class SelfHealingMonitor {
  constructor(opts = {}) {
    this.adminCtrl = opts.adminCtrl;
    this.treasury = opts.treasury;
    this.worker = opts.worker;
    this.bot = opts.bot;
    this.sessions = opts.sessions;
    this.markets = opts.markets;
    this.server = opts.server;

    this.intervalId = null;
    this.isRunning = false;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5;

    // Recovery actions taken (for audit)
    this.recoveryLog = [];
    this.MAX_LOG = 100;
  }

  /**
   * Start the self-healing monitor
   */
  start() {
    if (this.isRunning) return;
    if (!config.get('ai.selfHealingEnabled')) {
      console.log('[self-heal] Self-healing disabled in config');
      return;
    }

    this.isRunning = true;
    const interval = config.get('ai.healthCheckIntervalMs') || 30000;

    this.intervalId = setInterval(() => {
      this.checkAndHeal().catch(err => {
        console.error('[self-heal] Check failed:', err.message);
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          console.error('[self-heal] Too many consecutive failures, stopping monitor');
          this.stop();
        }
      });
    }, interval);

    console.log(`[self-heal] Self-healing monitor started (interval: ${interval}ms)`);
  }

  /**
   * Main check-and-heal cycle
   */
  async checkAndHeal() {
    const health = this.adminCtrl?.getFullHealth(this.sessions, this.markets);
    if (!health) return;

    const actions = [];

    // Check 1: Circuit breaker stuck open
    if (health.payouts?.circuitOpen) {
      const openTime = health.payouts.circuitOpenAt;
      const resetMs = config.get('payouts.circuitBreakerResetMs') || 300000;

      if (openTime && (Date.now() - openTime) > resetMs + 60000) {
        actions.push(this.forceResetCircuit());
      }
    }

    // Check 2: Stuck sessions
    const staleSessions = this.findStaleSessions();
    if (staleSessions.length > 0) {
      actions.push(this.cleanupStaleSessions(staleSessions));
    }

    // Check 3: Markets stuck in LOCKED state
    if (health.markets?.locked > 5) {
      actions.push(this.resolveStuckMarkets());
    }

    // Check 4: Treasury halted but conditions OK
    if (health.treasury?.halted?.payouts && 
        health.treasury?.balance_znn >= config.get('treasury.minReserveZnn')) {
      actions.push(this.resumePayoutsIfSafe());
    }

    // Check 5: Critical alerts that can be auto-resolved
    const criticalAlerts = this.adminCtrl?.alerts.getActive('critical') || [];
    for (const alert of criticalAlerts) {
      if (this.canAutoResolve(alert)) {
        actions.push(this.autoResolveAlert(alert));
      }
    }

    // Execute all recovery actions
    if (actions.length > 0) {
      console.log(`[self-heal] Found ${actions.length} recovery action(s)`);
      const results = await Promise.allSettled(actions);
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          this.logRecovery(`Action ${idx + 1}: ${result.value}`);
        } else {
          console.error(`[self-heal] Action ${idx + 1} failed:`, result.reason);
        }
      });
    }

    this.consecutiveFailures = 0;
    return { actions: actions.length };
  }
}
```

### Configuration

```javascript
ai: {
  selfHealingEnabled: true,       // Master switch for self-healing
  healthCheckIntervalMs: 30000,   // How often to check (30s)
  autoRestartOnCrash: true,       // Not yet implemented (needs PM2/systemd)
}
```

### Recovery Log

The self-healer maintains a recovery log (last 100 actions) accessible via:
```javascript
selfHealer.getRecoveryLog(20)  // Last 20 recovery actions
```

---

## 🤖 AI-Native Features

NOM is an **AI-native daemon** that uses artificial intelligence to manage the platform.

### AI Architecture

**Model-Agnostic Integration:**
```javascript
ai: {
  enabled: false,              // Enable/disable AI features
  provider: 'openrouter',     // 'openrouter' | 'openai' | 'local' | 'custom'
  model: 'tencent/hy3-preview:free',
  apiKey: '',                  // Set via env AI_API_KEY
  apiUrl: '',                  // Custom endpoint for local LLMs
  temperature: 0.3,
  maxTokens: 1024,
  nlCommandsEnabled: true,
  commandConfidenceThreshold: 0.8,
}
```

**Supported Providers:**
- **OpenRouter** — Access to hundreds of models
- **OpenAI** — Direct OpenAI API integration
- **Local** — Local LLMs via Ollama, LM Studio
- **Custom** — Any OpenAI-compatible API

### AI-Native Self-Monitoring

**Endpoint:** `GET /admin/ai/status`

Returns LLM-optimized platform state:
```json
{
  "ts": 1714060800000,
  "uptime_h": 12.5,
  "healthy": true,
  "services": { "oracle": 1, "explorer": 1, "zenon": 1, "payoutWorker": 1 },
  "alerts": { "critical": [], "warn": 2 },
  "treasury": {
    "balance_znn": 1500.5,
    "liabilities_znn": 250.0,
    "reserve_ok": true,
    "halted": { "payouts": false, "bot": false }
  },
  "payouts": { "queue_depth": 0, "circuit_open": false, "success_rate": 99.5 },
  "games": ["dice", "slots", "shooter", "coinflip", "roulette", "crash"],
  "markets": { "open": 12, "locked": 0, "needs_resolution": 0 },
  "sessions": { "active": 5, "pending": 0 },
  "bot": { "running": true, "last_research": 15 },
  "actions_needed": []
}
```

### Natural Language Commands

**Endpoint:** `POST /admin/ai/command`

**Examples:**
```
"pause dice game"                     → toggle_game(dice, false)
"enable coinflip"                     → toggle_game(coinflip, true)
"reset circuit breaker"                → reset_circuit()
"check treasury status"               → get_status() (treasury section)
"halt payouts"                        → halt_payouts(payouts, true)
"resume payouts"                      → resume_payouts(payouts, false)
"rebalance market weights"            → rebalance_markets()
"trigger research"                     → trigger_research()
```

---

## 🔧 Configuration

### Backend `.env` File

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

# AI Configuration
AI_API_KEY=your_openrouter_or_openai_key
```

---

## 📈 Monitoring & Alerts

### Key Metrics Tracked

- Service health (Oracle, Explorer, Zenon Node, Payout Worker)
- Treasury balance and liabilities
- Payout queue depth and success rates
- Active alerts (critical/warning/info)
- Session and market statistics

### Endpoints for Monitoring

- `GET /health` — Basic health check (for load balancers)
- `GET /ready` — Comprehensive readiness check (for Docker)
- `GET /admin/health` — Full health snapshot
- `GET /admin/ai/status` — LLM-optimized status (for NOM)

---

## 🔒 Security Considerations

1. **Admin Token** — Always set `ADMIN_TOKEN` in production
2. **AI API Key** — Store securely, use env vars
3. **Self-Healing** — Monitor recovery log for unexpected actions
4. **Natural Language** — Set `commandConfidenceThreshold` appropriately
5. **Config Changes** — Review config history periodically
6. **Local Nodes** — Keep node software updated

---

## 📝 Related Documentation

- [NOM.md](NOM.md) — NOM's identity and personality
- [AI-NATIVE.md](AI-NATIVE.md) — AI architecture and vision
- [SELF-CONTROL.md](SELF-CONTROL.md) — Self-management capabilities
- [LOCAL-NODES.md](LOCAL-NODES.md) — Running with local nodes
- [README.md](README.md) — Main project documentation

---

> "The goal: Be helpful without being annoying. Check in a few times a day, do useful background work, but respect quiet time." — AGENTS.md
