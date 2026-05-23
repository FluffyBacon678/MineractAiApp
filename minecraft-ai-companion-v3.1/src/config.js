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
    baseUrl:      process.env.OLLAMA_URL       || 'http://localhost:11434',
    model:        process.env.OLLAMA_MODEL      || 'llama3.2',
    dialogueModel:process.env.OLLAMA_MODEL      || 'llama3.2',
    timeoutMs:    parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 20_000,
  },

  openai: {
    apiKey:    process.env.OPENAI_API_KEY  || '',
    model:     process.env.OPENAI_MODEL    || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS, 10) || 15_000,
    enabled:   !!(process.env.OPENAI_API_KEY),
  },

  hybrid: {
    // 'ollama' | 'openai' | 'hybrid'
    dialogueProvider: process.env.DIALOGUE_PROVIDER || 'hybrid',
    // 'ollama' | 'openai'  (keep ollama for speed/cost)
    intentProvider:   process.env.INTENT_PROVIDER   || 'ollama',
    // 'quality_routing' | 'openai_primary' | 'ollama_primary' | 'round_robin'
    strategy:         process.env.HYBRID_STRATEGY   || 'quality_routing',
    // max OpenAI calls per hour
    openAiHourlyLimit:parseInt(process.env.OPENAI_HOURLY_LIMIT, 10) || 30,
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
