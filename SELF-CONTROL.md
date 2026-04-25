# SELF-CONTROL.md — Self-Management Capabilities

## Overview

NOM-GAMEZ is designed to be a **self-managing platform** that can operate autonomously with minimal human intervention. This document describes the self-control mechanisms built into the platform.

## Self-Management Features

### 1. Self-Monitoring

The platform continuously monitors its own health via the AdminController and HealthMonitor.

**Key Metrics Tracked:**
- Service health (Oracle, Explorer, Zenon Node, Payout Worker)
- Treasury balance and liabilities
- Payout queue depth and success rates
- Active alerts (critical/warning/info)
- Session and market statistics

**Endpoints:**
- `GET /health` — Basic health check (for load balancers)
- `GET /ready` — Comprehensive readiness check (for Docker)
- `GET /admin/health` — Full health snapshot
- `GET /admin/ai/status` — LLM-optimized status (for AI consumption)

### 2. Self-Healing

The `SelfHealingMonitor` (`self-healing.js`) automatically recovers from common failures.

**Auto-Recovery Actions:**

| Condition | Action | Config Flag |
|-----------|--------|--------------|
| Circuit breaker stuck open > threshold + 1min | Force reset | `ai.selfHealingEnabled` |
| Sessions stuck in PENDING_DEPOSIT > 2x timeout | Cleanup stale sessions | `ai.selfHealingEnabled` |
| Markets stuck in LOCKED state > 5 | Attempt resolution | `ai.selfHealingEnabled` |
| Treasury halted but balance OK | Resume payouts | `ai.selfHealingEnabled` |
| Transient alerts (oracle_degraded, etc.) | Auto-resolve | `ai.selfHealingEnabled` |

**Configuration:**
```javascript
ai: {
  selfHealingEnabled: true,       // Master switch for self-healing
  healthCheckIntervalMs: 30000,   // How often to check (30s)
  autoRestartOnCrash: true,       // Not yet implemented (needs PM2/systemd)
}
```

**Recovery Log:**
The self-healer maintains a recovery log (last 100 actions) accessible via:
```javascript
selfHealer.getRecoveryLog(20)  // Last 20 recovery actions
```

### 3. Natural Language Control

The platform can be controlled using natural language commands via the AI command parser.

**Endpoint:** `POST /admin/ai/command`

**Examples:**
```bash
# Pause a game
curl -X POST http://localhost:3001/admin/ai/command \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"command": "pause dice game"}'

# Check status
curl -X POST http://localhost:3001/admin/ai/command \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"command": "how are you doing?"}'

# Reset circuit breaker
curl -X POST http://localhost:3001/admin/ai/command \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"command": "reset the circuit breaker"}'
```

**Supported Commands:**
- Toggle games (enable/disable)
- Patch configuration values
- Trigger bot research
- Resolve alerts
- Reset circuit breaker
- Reconcile treasury
- Halt/resume payouts
- Rebalance market weights
- Get status

**Parsing Methods:**
1. **AI Parsing** (if `ai.enabled=true`) — Uses configured LLM to parse commands
2. **Rule-Based Fallback** — Regex patterns for common commands

### 4. Dynamic Configuration

The platform supports live configuration changes without restart via `ConfigStore`.

**Features:**
- Live patching via `PATCH /admin/config`
- Audit log of all changes (last 200)
- Runtime game registration (`POST /admin/games/register`)
- Game toggle without restart (`PATCH /admin/games/:id`)

**Example:**
```bash
curl -X PATCH http://localhost:3001/admin/config \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"changes": [
    {"path": "bot.researchIntervalMs", "value": 7200000},
    {"path": "treasury.minReserveZnn", "value": 50}
  ]}'
```

### 5. Circuit Breaker Pattern

The payout system uses a circuit breaker to prevent cascading failures.

**How it works:**
1. Payout failures are tracked (`consecutiveFails`)
2. When failures >= `circuitBreakerThreshold` (default: 3), circuit opens
3. All payouts are halted
4. After `circuitBreakerResetMs` (default: 5 min), circuit auto-resets
5. Can be manually reset via `POST /admin/circuit-breaker/reset`

**API:**
- Check status: `GET /admin/payouts/metrics`
- Manual reset: `POST /admin/circuit-breaker/reset`
- Self-healing: Auto-reset if stuck too long

### 6. Treasury Management

The `TreasuryManager` monitors platform funds and automatically halts operations if risk thresholds are breached.

**Monitored Metrics:**
- Balance vs. liabilities
- Pending payout obligations
- Reserve threshold (`minReserveZnn`)
- Single payout limit (`maxSinglePayoutZnn`)
- Total liability limit (`maxPendingLiabilityZnn`)

**Auto-Halt Conditions:**
- Balance < `minReserveZnn` → Halt payouts
- Liabilities > `maxPendingLiabilityZnn` → Halt payouts + bot
- Payout failures → Halt payouts (if `haltPayoutsOnRisk=true`)

**Manual Control:**
```bash
# Halt payouts
curl -X POST http://localhost:3001/admin/treasury/halt \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"scope": "payouts", "active": true, "reason": "manual"}'

# Force reconciliation
curl -X POST http://localhost:3001/admin/treasury/reconcile \
  -H "Authorization: Bearer $TOKEN"
```

## Infrastructure Integration

### Docker/Compose

The platform is Docker-ready with:
- Healthchecks on all services
- `restart: unless-stopped` policy
- Volume mounts for persistence
- Dependency ordering (`depends_on`)

**Health Check Endpoint:**
```
GET /ready
Returns 200 if all critical services are operational, 503 otherwise.
```

### Process Management

For production deployments, use:
- **PM2:** `pm2 start server.js --name nom-gamez`
- **systemd:** Create a service file (see example below)
- **Docker:** Healthcheck + restart policy (already configured)

**systemd Example:**
```ini
[Unit]
Description=NOM-GAMEZ Backend
After=network.target

[Service]
Type=simple
User=nodejs
WorkingDirectory=/app
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/app/.env

[Install]
WantedBy=multi-user.target
```

## Autonomous Operation Checklist

For fully autonomous operation:

- [ ] Set `ADMIN_TOKEN` for API security
- [ ] Enable AI features: `ai.enabled=true`
- [ ] Set `AI_API_KEY` for natural language commands
- [ ] Enable self-healing: `ai.selfHealingEnabled=true`
- [ ] Configure treasury thresholds appropriately
- [ ] Set up monitoring/alerting (external)
- [ ] Use Docker/PM2/systemd for auto-restart
- [ ] Review recovery log periodically: `selfHealer.getRecoveryLog()`

## Debugging Self-Management

**Check self-healer status:**
```javascript
console.log(selfHealer.isRunning);  // Is monitor running?
console.log(selfHealer.getRecoveryLog(10));  // Recent recoveries
```

**Check AI command parsing:**
```bash
curl -X POST http://localhost:3001/admin/ai/command \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"command": "debug: parse this command"}'
```

**View audit logs:**
```bash
curl -X GET http://localhost:3001/admin/config/history \
  -H "Authorization: Bearer $TOKEN"

curl -X GET http://localhost:3001/admin/alerts \
  -H "Authorization: Bearer $TOKEN"
```

## Security Considerations

1. **Admin Token** — Always set `ADMIN_TOKEN` in production
2. **AI API Key** — Store securely, use env vars
3. **Self-Healing** — Monitor recovery log for unexpected actions
4. **Natural Language** — Set `commandConfidenceThreshold` appropriately
5. **Config Changes** — Review config history periodically

## Future Enhancements

- [ ] Predictive treasury management (ML-based forecasting)
- [ ] Automated game difficulty adjustment
- [ ] Player behavior analysis for fraud detection
- [ ] Multi-model consensus for critical decisions
- [ ] Integration with external monitoring (Grafana, Prometheus)
- [ ] Automated backup and restore procedures
