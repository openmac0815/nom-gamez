# AI-NATIVE.md — NOM-GAMEZ AI-Native Architecture

## 🎰 NOM: The AI Controller

**NOM** is the autonomous daemon that controls the NOM-GAMEZ platform. Unlike traditional platforms managed by human administrators, NOM is:

- **Autonomous:** Self-hosted, self-managed, no central authority
- **AI-Native:** Uses LLMs for natural language control and decision-making
- **Self-Managing:** Monitors, heals, and optimizes without human intervention
- **Trustless:** Runs local nodes for verification ("don't trust, verify")

> "NOM is not just a bot — it's an autonomous gaming platform daemon that runs the entire NOM-GAMEZ operation."

### How NOM Uses AI Features

NOM leverages the AI-native architecture in these ways:

1. **Monitoring:** NOM consumes the LLM-optimized `/admin/ai/status` endpoint to understand platform health
2. **Decision Making:** Uses natural language processing to interpret commands and make decisions
3. **Self-Healing:** The self-healing monitor automatically recovers from failures based on health checks
4. **Optimization:** Analyzes real-time data to optimize game settings and treasury management

---

## Vision

NOM-GAMEZ is designed to be a **self-managing, autonomous gaming platform** controlled by AI. As the sole entity controlling the platform, the AI daemon (NOM) should be able to:

1. **Monitor** platform health without human intervention
2. **Diagnose** issues using natural language understanding
3. **Execute** administrative commands via natural language
4. **Recover** from failures automatically (self-healing)
5. **Optimize** operations based on real-time data
6. **Run anywhere** with any AI model/infrastructure

## Architecture

### 1. Model-Agnostic AI Integration

Configuration in `config.js`:
```javascript
ai: {
  enabled: false,              // Enable/disable AI features
  provider: 'openrouter',     // 'openrouter' | 'openai' | 'local' | 'custom'
  model: 'tencent/hy3-preview:free',
  apiKey: '',                  // Set via env AI_API_KEY
  apiUrl: '',                  // Custom endpoint for local LLMs (Ollama, etc.)
  temperature: 0.3,
  maxTokens: 1024,
  nlCommandsEnabled: true,
  commandConfidenceThreshold: 0.8,
}
```

**Supported Providers:**
- **OpenRouter** — Access to hundreds of models (OpenAI, Anthropic, Google, etc.)
- **OpenAI** — Direct OpenAI API integration
- **Local** — Local LLMs via Ollama, LM Studio, or any OpenAI-compatible API
- **Custom** — Any API that accepts OpenAI-compatible requests

### 2. AI-Native Self-Monitoring Endpoint

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

**Key Features:**
- Token-efficient format (compact boolean/number representation)
- Actionable insights (`actions_needed` array)
- 1 = OK, 0 = FAIL for quick AI parsing

### 3. Natural Language Command Interface

**Endpoint:** `POST /admin/ai/command`
**Body:** `{ "command": "pause dice game" }`

**How NOM Uses This:**
NOM can control the entire platform using natural language. Instead of manual API calls, NOM can:
- Issue commands in plain English
- Parse complex instructions into multiple actions
- Make decisions based on status output

**Examples:**
```
# Game Management
"pause dice game"                     → toggle_game(dice, false)
"enable coinflip"                     → toggle_game(coinflip, true)
"disable all games except crash"      → toggle multiple games

# Circuit Breaker
"reset circuit breaker"                → reset_circuit()
"check circuit status"                 → get_payout_metrics()

# Treasury Management
"check treasury status"               → get_status() (treasury section)
"halt payouts"                        → halt_payouts(payouts, true)
"resume payouts"                      → resume_payouts(payouts, false)
"reconcile treasury now"              → reconcile_treasury()

# Market Management
"rebalance market weights"            → rebalance_markets()
"resolve stuck markets"               → resolve_due_markets()
"create market for BTC price"         → create_prediction_market()

# Bot Control
"trigger research"                     → trigger_research()
"pause research bot"                  → toggle_bot(false)
"check bot status"                    → get_status() (bot section)

# Combined Commands
"check status and tell me if anything needs attention"
→ Parses status, identifies issues, suggests actions

"pause payouts and resolve stuck markets"
→ Multiple actions from single command
```

**Processing Flow:**
1. AI parsing (if `ai.enabled=true`) → `ai-command-parser.js`
2. Rule-based fallback (if AI disabled or fails)
3. Command execution via `executeCommand()`
4. Returns parsed command + execution result

### 4. Self-Healing Monitor

**Module:** `self-healing.js`

**Monitored Conditions:**
- Circuit breaker stuck open → Auto-reset after timeout
- Stale sessions (PENDING_DEPOSIT > 2x timeout) → Auto-cleanup
- Stuck markets (LOCKED state) → Auto-resolve
- Treasury halted but conditions OK → Auto-resume payouts
- Transient alerts → Auto-resolve

**Configuration:**
```javascript
ai: {
  selfHealingEnabled: true,
  autoRestartOnCrash: true,
  healthCheckIntervalMs: 30000,  // 30 seconds
}
```

### 5. Infrastructure Awareness

**Docker Healthchecks:**
- `/ready` endpoint used for container healthchecks
- `restart: unless-stopped` policy on all services
- Multi-stage build for minimal image size

**Process Monitoring:**
- Self-healing monitor runs inside Node.js process
- Can be extended to use PM2 or systemd for external restart

## Usage Examples

### Enable AI Features

1. Set environment variables:
```bash
export AI_API_KEY="your-openrouter-key"
export ADMIN_TOKEN="your-admin-token"
```

2. Update config:
```bash
curl -X PATCH http://localhost:3001/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"changes": [
    {"path": "ai.enabled", "value": true},
    {"path": "ai.provider", "value": "openrouter"},
    {"path": "ai.model", "value": "tencent/hy3-preview:free"}
  ]}'
```

3. Use natural language commands:
```bash
curl -X POST http://localhost:3001/admin/ai/command \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "check status and tell me if anything needs attention"}'
```

### Running with Local LLM (Ollama)

1. Start Ollama: `ollama serve`
2. Pull model: `ollama pull llama3`
3. Update config:
```json
{
  "ai.enabled": true,
  "ai.provider": "local",
  "ai.apiUrl": "http://localhost:11434/v1/chat/completions",
  "ai.model": "llama3"
}
```

## Design Principles

1. **Model-Agnostic** — No hardcoded dependencies on specific AI providers
2. **Token-Efficient** — AI endpoints optimized for minimal token usage
3. **Fail-Safe** — Rule-based fallback if AI is unavailable
4. **Self-Managing** — Platform can monitor and heal itself
5. **Infrastructure-Independent** — Runs on bare metal, VPS, Docker, Kubernetes

## Future Enhancements

- [ ] Predictive treasury management (forecast liabilities)
- [ ] Automatic game difficulty adjustment based on treasury
- [ ] Market trend analysis and autonomous market creation
- [ ] Player behavior analysis for fraud detection
- [ ] Multi-model consensus for critical decisions
- [ ] Integration with more AI providers (Anthropic, Google, etc.)
