'use strict';
const { envFile } = require('./paths');
require('dotenv').config({ path: envFile() });

const defaults = {
  bot: {
    host:     process.env.MC_HOST      || 'localhost',
    port:     parseInt(process.env.MC_PORT, 10) || 25565,
    username: process.env.BOT_USERNAME || 'Bud',
    version:  process.env.MC_VERSION   || '1.21.1',
    auth:     'offline',
  },

  ollama: {
    baseUrl:       process.env.OLLAMA_URL          || 'http://localhost:11434',
    model:         process.env.OLLAMA_MODEL         || 'llama3.2',
    quickModel:    process.env.OLLAMA_QUICK_MODEL   || '',  // tier-1 small model (e.g. llama3.2:1b)
    dialogueModel: process.env.OLLAMA_DIALOGUE_MODEL|| '',  // tier-2 medium model (e.g. llama3.1:8b)
    timeoutMs:     parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 20_000,
  },

  openai: {
    apiKey:    process.env.OPENAI_API_KEY  || '',
    model:     process.env.OPENAI_MODEL    || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS, 10) || 15_000,
    enabled:   !!(process.env.OPENAI_API_KEY),
  },

  claude: {
    apiKey:    process.env.CLAUDE_API_KEY   || '',
    model:     process.env.CLAUDE_MODEL     || 'claude-haiku-4-5-20251001',
    timeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 30_000,
    enabled:   !!(process.env.CLAUDE_API_KEY),
  },

  hybrid: {
    // 'ollama' | 'openai' | 'hybrid'
    dialogueProvider: process.env.DIALOGUE_PROVIDER || 'hybrid',
    // 'ollama' | 'openai'  (keep ollama for speed/cost)
    intentProvider:   process.env.INTENT_PROVIDER   || 'ollama',
    // 'quality_routing' | 'local_first' | 'cheapest' | 'best_quality' | 'openai_primary' | 'ollama_primary'
    strategy:         process.env.HYBRID_STRATEGY   || 'quality_routing',
    // max OpenAI calls per hour
    openAiHourlyLimit:parseInt(process.env.OPENAI_HOURLY_LIMIT, 10) || 30,
  },

  // Per-task provider overrides. 'auto' defers to global strategy.
  // Values: 'auto' | 'ollama' | 'openai' | 'claude'
  routing: {
    taskMap: {
      intent:        'ollama',
      memory:        'ollama',
      ambient:       'ollama',
      observe:       'ollama',
      worker:        'ollama',
      monologue:     'ollama',
      dialogue:      'auto',
      summarization: 'auto',
      planning:      'auto',
      reflection:    'auto',
    },
    fallbackOrder: ['ollama', 'openai', 'claude'],
  },

  // Internal monologue — background self-reflection loop
  monologue: {
    enabled:     false,
    intervalMs:  60_000,
    neuroticism: 5,      // 1-10: how often the monologue fires per tick
    provider:    'ollama',
  },

  // Conversation memory buffer
  conversation: {
    maxTurns: 20,  // rolling history size (4-40); summarised when exceeded
  },

  // Plan executor — controls auto-execution of deep-tier multi-step plans
  planning: {
    autoExecute:          false, // auto-run plan steps when detected
    requireConfirmation:  true,  // ask player before each step (if autoExecute)
    maxSteps:             5,     // safety cap on auto-executed steps
  },

  // Social battery — governs proactive speech and conversation willingness
  social: {
    enabled:          true,
    drainPerExchange: 8,   // points lost per direct chat exchange (1-30)
    chargePerMinute:  5,   // points gained per minute of quiet (1-30)
  },

  companion: {
    name:                process.env.COMPANION_NAME          || 'Bud',
    observeIntervalMs:   parseInt(process.env.OBSERVE_INTERVAL_MS, 10)    || 10_000,
    talkativeIntervalMs: parseInt(process.env.TALKATIVE_INTERVAL_MS, 10)  || 45_000,
    followDistance:      parseInt(process.env.FOLLOW_DISTANCE, 10)         || 3,
    loiterRadius:        parseInt(process.env.LOITER_RADIUS, 10)           || 8,
    responseDelayMs:     parseInt(process.env.RESPONSE_DELAY_MS, 10)       || 1_500,
  },

  resources: {
    cpuPercent:  25,
    ramGb:       2,
    dynamicMode: true,
  },
};

function merge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    result[k] = (v && typeof v === 'object' && !Array.isArray(v))
      ? merge(base[k] || {}, v)
      : v;
  }
  return result;
}

module.exports = { ...defaults, merge };
