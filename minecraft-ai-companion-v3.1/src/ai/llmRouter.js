'use strict';

/**
 * LLMRouter — routes LLM calls between Ollama (local) and OpenAI (cloud).
 *
 * Strategies:
 *   ollama_only    — always use Ollama, ignore OpenAI key
 *   openai_only    — always use OpenAI (falls back to Ollama if unavailable)
 *   ollama_primary — use Ollama, fall back to OpenAI only when Ollama fails
 *   openai_primary — use OpenAI, fall back to Ollama when OpenAI fails/limited
 *   quality_routing— smart routing: ambient/intent → Ollama, direct player
 *                    conversation/important moments → OpenAI
 *   round_robin    — alternate between providers each call
 *
 * All strategies respect the hourly OpenAI call limit.
 * All strategies fall back gracefully when a provider is unavailable.
 *
 * Call types used for quality routing:
 *   'intent'    — classify player chat (fast, structured, always Ollama)
 *   'memory'    — detect location definitions (structured, always Ollama)
 *   'ambient'   — spontaneous comments (frequent, low-stakes → Ollama)
 *   'dialogue'  — response to direct player message (important → routes up)
 *   'observe'   — environment description (medium → Ollama)
 */

const EventEmitter = require('events');

// Which call types always stay on Ollama regardless of strategy
const ALWAYS_OLLAMA = new Set(['intent', 'memory', 'ambient', 'observe']);

class LLMRouter extends EventEmitter {
  constructor(config) {
    super();
    this.config   = config;
    this._roundRobinTurn = 0;

    // OpenAI rate-limit tracking
    this._openAiCalls    = [];          // timestamps of recent calls
    this._hourlyLimit    = config.hybrid?.openAiHourlyLimit ?? 30;

    // Circuit breakers
    this._ollamaFails    = 0;
    this._ollamaFailedAt = 0;
    this._openAiFails    = 0;
    this._openAiFailedAt = 0;

    // Usage counters for UI stats
    this.stats = { ollama: 0, openai: 0, fallbacks: 0, errors: 0 };
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Main entry point. Routes a prompt to the right provider.
   *
   * @param {string}  callType  - 'intent' | 'memory' | 'ambient' | 'dialogue' | 'observe'
   * @param {object}  messages  - [{role, content}]  (OpenAI-style)
   * @param {object}  opts      - { temperature, maxTokens, stream }
   * @param {object}  context   - { isDirectAddress, isImportant, isCombat }
   * @returns {Promise<string|null>}
   */
  async complete(callType, messages, opts = {}, context = {}) {
    const provider = this._selectProvider(callType, context);
    const text     = await this._call(provider, messages, opts, callType);

    if (text !== null) return text;

    // Primary failed — try the other provider
    const fallback = provider === 'openai' ? 'ollama' : 'openai';
    this.stats.fallbacks++;
    this.emit('router:fallback', { from: provider, to: fallback, callType });

    return this._call(fallback, messages, opts, callType);
  }

  /**
   * Quick check: is OpenAI usable right now?
   */
  openAiAvailable() {
    return !!(this.config.openai?.enabled && this.config.openai?.apiKey) &&
           !this._openAiCircuitOpen() &&
           !this._overHourlyLimit();
  }

  ollamaAvailable() {
    return !this._ollamaCircuitOpen();
  }

  getStats() { return { ...this.stats }; }

  updateConfig(cfg) {
    this.config = cfg;
    this._hourlyLimit = cfg.hybrid?.openAiHourlyLimit ?? 30;
    this.emit('router:config-updated');
  }

  // ── Provider selection ─────────────────────────────────────────────────────

  _selectProvider(callType, context) {
    // Structured/frequent calls always stay local regardless of strategy
    if (ALWAYS_OLLAMA.has(callType)) return 'ollama';

    const strategy    = this.config.hybrid?.strategy || 'quality_routing';
    const cfgProvider = this.config.hybrid?.dialogueProvider || 'hybrid';

    if (cfgProvider === 'ollama')  return 'ollama';
    if (cfgProvider === 'openai')  return this.openAiAvailable() ? 'openai' : 'ollama';

    // cfgProvider === 'hybrid' — apply strategy
    if (!this.openAiAvailable()) return 'ollama'; // no OpenAI configured

    switch (strategy) {
      case 'openai_primary':  return 'openai';
      case 'ollama_primary':  return 'ollama';
      case 'round_robin':     return this._roundRobin();
      case 'quality_routing': return this._qualityRoute(context);
      default:                return this._qualityRoute(context);
    }
  }

  _roundRobin() {
    const turn = this._roundRobinTurn++ % 2;
    return turn === 0 ? 'openai' : 'ollama';
  }

  /**
   * Quality routing — the default hybrid strategy.
   *
   * Uses OpenAI when the situation calls for higher quality:
   *   - Player directly addressed the companion by name or "you"
   *   - An important/emotional moment (first join, danger, player in trouble)
   *   - Player asks a question (ends with ?)
   *
   * Uses Ollama for:
   *   - Ambient comments and observations
   *   - Follow/wait/loiter confirmations
   *   - Everything when OpenAI is over limit
   */
  _qualityRoute(context = {}) {
    if (context.isImportant || context.isDirectAddress || context.isQuestion) {
      return 'openai';
    }
    // Default to Ollama for routine dialogue
    return 'ollama';
  }

  // ── Provider calls ─────────────────────────────────────────────────────────

  async _call(provider, messages, opts, callType) {
    if (provider === 'openai') {
      if (!this.openAiAvailable()) return null;
      return this._callOpenAI(messages, opts);
    }
    return this._callOllama(messages, opts);
  }

  async _callOllama(messages, opts = {}) {
    if (this._ollamaCircuitOpen()) return null;

    const timeoutMs = this.config.ollama?.timeoutMs || 20_000;

    try {
      const res = await fetch(`${this.config.ollama.baseUrl}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          model:    opts.model || this.config.ollama.dialogueModel || this.config.ollama.model,
          messages,
          stream:   false,
          options:  {
            temperature: opts.temperature ?? 0.75,
            num_predict: opts.maxTokens  ?? 90,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

      const data = await res.json();
      const text = data?.message?.content?.trim() || null;
      if (!text) throw new Error('Empty response');

      this._ollamaFails = 0;
      this.stats.ollama++;
      this.emit('router:used', { provider: 'ollama' });
      return text;

    } catch (err) {
      this._ollamaFails++;
      this._ollamaFailedAt = Date.now();
      this.stats.errors++;

      if (err.name === 'TimeoutError') {
        console.warn(`[LLMRouter] Ollama timed out after ${this.config.ollama?.timeoutMs}ms`);
      } else {
        console.error('[LLMRouter] Ollama error:', err.message);
      }
      return null;
    }
  }

  async _callOpenAI(messages, opts = {}) {
    if (this._openAiCircuitOpen() || this._overHourlyLimit()) return null;

    const apiKey    = this.config.openai?.apiKey;
    const model     = opts.model || this.config.openai?.model || 'gpt-4o-mini';
    const timeoutMs = this.config.openai?.timeoutMs || 15_000;

    if (!apiKey) return null;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.8,
          max_tokens:  opts.maxTokens  ?? 120,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401) {
        console.error('[LLMRouter] OpenAI: invalid API key');
        this._openAiFails = 99; // disable until config updated
        this.emit('router:openai-auth-error');
        return null;
      }

      if (res.status === 429) {
        console.warn('[LLMRouter] OpenAI: rate limited');
        this._openAiFails++;
        this._openAiFailedAt = Date.now();
        this.emit('router:openai-rate-limited');
        return null;
      }

      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || null;
      if (!text) throw new Error('Empty OpenAI response');

      // Record this call for rate tracking
      this._openAiCalls.push(Date.now());
      this._openAiFails = 0;
      this.stats.openai++;
      this.emit('router:used', { provider: 'openai', model });
      return text;

    } catch (err) {
      this._openAiFails++;
      this._openAiFailedAt = Date.now();
      this.stats.errors++;

      if (err.name === 'TimeoutError') {
        console.warn('[LLMRouter] OpenAI timed out');
      } else {
        console.error('[LLMRouter] OpenAI error:', err.message);
      }
      return null;
    }
  }

  // ── Circuit breakers & limits ─────────────────────────────────────────────

  _ollamaCircuitOpen() {
    if (this._ollamaFails < 5) return false;
    // After 5 failures, pause for 60 s
    const open = (Date.now() - this._ollamaFailedAt) < 60_000;
    if (!open) this._ollamaFails = 0; // reset after cooldown
    return open;
  }

  _openAiCircuitOpen() {
    if (this._openAiFails < 3) return false;
    const open = (Date.now() - this._openAiFailedAt) < 120_000; // 2 min cooldown
    if (!open) this._openAiFails = 0;
    return open;
  }

  _overHourlyLimit() {
    const oneHourAgo = Date.now() - 3_600_000;
    this._openAiCalls = this._openAiCalls.filter(t => t > oneHourAgo);
    return this._openAiCalls.length >= this._hourlyLimit;
  }

  openAiCallsThisHour() {
    const oneHourAgo = Date.now() - 3_600_000;
    this._openAiCalls = this._openAiCalls.filter(t => t > oneHourAgo);
    return this._openAiCalls.length;
  }
}

module.exports = LLMRouter;
