/**
 * AI Command Parser
 * Parses natural language commands into executable actions
 * Model-agnostic - supports OpenRouter, OpenAI, local LLMs
 */

const { config } = require('./config');
const { admin } = require('./admin');

/**
 * Supported command types
 */
const COMMAND_TYPES = {
  TOGGLE_GAME: 'toggle_game',
  PATCH_CONFIG: 'patch_config',
  TRIGGER_RESEARCH: 'trigger_research',
  RESOLVE_ALERT: 'resolve_alert',
  RESET_CIRCUIT: 'reset_circuit',
  RECONCILE_TREASURY: 'reconcile_treasury',
  HALT_PAYOUTS: 'halt_payouts',
  RESUME_PAYOUTS: 'resume_payouts',
  REBALANCE_MARKETS: 'rebalance_markets',
  GET_STATUS: 'get_status',
  UNKNOWN: 'unknown',
};

/**
 * Command schema for LLM prompt
 */
const COMMAND_SCHEMA = `
Available commands (JSON output only):
1. toggle_game: { "type": "toggle_game", "gameId": "<dice|slots|shooter|coinflip|roulette|crash>", "active": <true|false> }
2. patch_config: { "type": "patch_config", "path": "<dot.notation.path>", "value": <value> }
3. trigger_research: { "type": "trigger_research" }
4. resolve_alert: { "type": "resolve_alert", "alertType": "<alert_type>" }
5. reset_circuit: { "type": "reset_circuit" }
6. reconcile_treasury: { "type": "reconcile_treasury" }
7. halt_payouts: { "type": "halt_payouts", "scope": "payouts", "active": true }
8. resume_payouts: { "type": "resume_payouts", "scope": "payouts", "active": false }
9. rebalance_markets: { "type": "rebalance_markets" }
10. get_status: { "type": "get_status" }

Output ONLY valid JSON. No markdown, no explanation.
`;

/**
 * Parse natural language command using configured AI model
 * Falls back to rule-based parsing if AI disabled or fails
 */
async function parseCommand(nlCommand) {
  const aiConfig = config.get('ai');

  // Try AI parsing first if enabled
  if (aiConfig.enabled) {
    try {
      const aiResult = await parseWithAI(nlCommand, aiConfig);
      if (aiResult) return aiResult;
    } catch (err) {
      console.warn('[ai-parser] AI parsing failed, falling back to rule-based:', err.message);
    }
  }

  // Fallback to rule-based parsing
  return parseRuleBased(nlCommand);
}

/**
 * Parse command using AI model (model-agnostic)
 */
async function parseWithAI(command, aiConfig) {
  const prompt = `Parse this command into JSON: "${command}"\n\n${COMMAND_SCHEMA}`;

  let response;
  switch (aiConfig.provider) {
    case 'openrouter':
      response = await callOpenRouter(prompt, aiConfig);
      break;
    case 'openai':
      response = await callOpenAI(prompt, aiConfig);
      break;
    case 'local':
      response = await callLocalLLM(prompt, aiConfig);
      break;
    default:
      throw new Error(`Unknown AI provider: ${aiConfig.provider}`);
  }

  const parsed = JSON.parse(response);
  if (!parsed.type) throw new Error('Invalid AI response: missing type');
  return { ...parsed, source: 'ai', confidence: 1.0 };
}

/**
 * Call OpenRouter API
 */
async function callOpenRouter(prompt, cfg) {
  const apiKey = cfg.apiKey || process.env.AI_API_KEY || '';
  if (!apiKey) throw new Error('AI_API_KEY not configured');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

/**
 * Call OpenAI API
 */
async function callOpenAI(prompt, cfg) {
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

/**
 * Call local LLM (Ollama, LM Studio, etc.)
 */
async function callLocalLLM(prompt, cfg) {
  const url = cfg.apiUrl || 'http://localhost:11434/v1/chat/completions';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model || 'llama3',
      messages: [{ role: 'user', content: prompt }],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    }),
  });

  if (!res.ok) throw new Error(`Local LLM error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

/**
 * Rule-based fallback parser
 * Handles common commands without AI
 */
function parseRuleBased(command) {
  const lower = command.toLowerCase().trim();

  // Toggle games
  for (const gameId of ['dice', 'slots', 'shooter', 'coinflip', 'roulette', 'crash']) {
    if (lower.includes(gameId)) {
      const activate = lower.includes('enable') || lower.includes('start') || lower.includes('activate');
      const deactivate = lower.includes('disable') || lower.includes('stop') || lower.includes('pause');
      if (activate || deactivate) {
        return {
          type: COMMAND_TYPES.TOGGLE_GAME,
          gameId,
          active: activate,
          source: 'rule-based',
          confidence: 0.9,
        };
      }
    }
  }

  // Circuit breaker
  if (lower.includes('circuit') && (lower.includes('reset') || lower.includes('close'))) {
    return { type: COMMAND_TYPES.RESET_CIRCUIT, source: 'rule-based', confidence: 0.95 };
  }

  // Research
  if (lower.includes('research') || lower.includes('check price') || lower.includes('update markets')) {
    return { type: COMMAND_TYPES.TRIGGER_RESEARCH, source: 'rule-based', confidence: 0.85 };
  }

  // Treasury
  if (lower.includes('reconcile') || lower.includes('check treasury') || lower.includes('treasury status')) {
    return { type: COMMAND_TYPES.RECONCILE_TREASURY, source: 'rule-based', confidence: 0.9 };
  }

  // Halt/Resume payouts
  if (lower.includes('halt') || lower.includes('stop payout')) {
    return { type: COMMAND_TYPES.HALT_PAYOUTS, scope: 'payouts', active: true, source: 'rule-based', confidence: 0.9 };
  }
  if (lower.includes('resume payout') || lower.includes('restart payout')) {
    return { type: COMMAND_TYPES.RESUME_PAYOUTS, scope: 'payouts', active: false, source: 'rule-based', confidence: 0.9 };
  }

  // Status
  if (lower.includes('status') || lower.includes('how are you') || lower.includes('health')) {
    return { type: COMMAND_TYPES.GET_STATUS, source: 'rule-based', confidence: 0.95 };
  }

  // Rebalance markets
  if (lower.includes('rebalance') || lower.includes('adjust weights')) {
    return { type: COMMAND_TYPES.REBALANCE_MARKETS, source: 'rule-based', confidence: 0.85 };
  }

  return { type: COMMAND_TYPES.UNKNOWN, source: 'rule-based', confidence: 0, original: command };
}

/**
 * Execute a parsed command
 */
async function executeCommand(parsedCommand, deps = {}) {
  const { bot, worker, treasury, adminCtrl, sessions, markets } = deps;

  switch (parsedCommand.type) {
    case COMMAND_TYPES.TOGGLE_GAME:
      config.toggleGame(parsedCommand.gameId, parsedCommand.active, 'ai-command');
      return { success: true, message: `Game ${parsedCommand.gameId} ${parsedCommand.active ? 'enabled' : 'disabled'}` };

    case COMMAND_TYPES.PATCH_CONFIG:
      config.patch(parsedCommand.path, parsedCommand.value, 'ai-command');
      return { success: true, message: `Config ${parsedCommand.path} updated` };

    case COMMAND_TYPES.TRIGGER_RESEARCH:
      if (bot) { await bot.triggerResearch(); }
      return { success: true, message: 'Research triggered' };

    case COMMAND_TYPES.RESOLVE_ALERT:
      adminCtrl.alerts.resolve(parsedCommand.alertType, 'Resolved via AI command');
      return { success: true, message: `Alert ${parsedCommand.alertType} resolved` };

    case COMMAND_TYPES.RESET_CIRCUIT:
      if (worker) worker.forceResetCircuit();
      return { success: true, message: 'Circuit breaker reset' };

    case COMMAND_TYPES.RECONCILE_TREASURY:
      if (treasury) { await treasury.reconcile({ force: true, reason: 'ai-command' }); }
      return { success: true, message: 'Treasury reconciliation triggered' };

    case COMMAND_TYPES.HALT_PAYOUTS:
      if (treasury) { treasury.setHalt('payouts', true, 'AI command', 'ai-command'); }
      return { success: true, message: 'Payouts halted' };

    case COMMAND_TYPES.RESUME_PAYOUTS:
      if (treasury) { treasury.setHalt('payouts', false, 'AI command', 'ai-command'); }
      return { success: true, message: 'Payouts resumed' };

    case COMMAND_TYPES.REBALANCE_MARKETS:
      adminCtrl.rebalanceMarketWeights();
      return { success: true, message: 'Market weights rebalanced' };

    case COMMAND_TYPES.GET_STATUS:
      return { success: true, status: adminCtrl.getFullHealth(sessions, markets) };

    case COMMAND_TYPES.UNKNOWN:
      return { success: false, error: 'Unknown command', original: parsedCommand.original };

    default:
      return { success: false, error: `Unhandled command type: ${parsedCommand.type}` };
  }
}

module.exports = {
  parseCommand,
  executeCommand,
  COMMAND_TYPES,
  COMMAND_SCHEMA,
};
