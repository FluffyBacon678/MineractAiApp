'use strict';

/**
 * LLMRouter — routes LLM calls between Ollama, OpenAI, and Claude.
 *
 * Strategies (config.hybrid.strategy):
 *   quality_routing — default: structured/frequent → Ollama; direct dialogue →
 *                     best cloud; planning/reflection → Claude if available
 *   local_first     — always Ollama, never cloud
 *   cheapest        — Ollama for everything except planning/reflection
 *   fastest         — always Ollama (local is fastest)
 *   best_quality    — best available cloud provider, Ollama as fallback
 *   openai_primary  — OpenAI first, Ollama fallback
 *   ollama_primary  — Ollama first, cloud fallback
 *
 * Per-task overrides (config.routing.taskMap):
 *   Maps each callType to 'auto' | 'ollama' | 'openai' | 'claude'
 *   'auto' defers to the global strategy above.
 *
 * Call types:
 *   'intent'        — classify player chat (fast, structured)
 *   'memory'        — detect location definitions (structured)
 *   'ambient'       — spontaneous comments (frequent, low-stakes)
 *   'observe'       — environment description
 *   'worker'        — task/worker instructions
 *   'dialogue'      — response to direct player message
 *   'planning'      — complex multi-step task planning
 *   'reflection'    — long-term world reflection / analysis
 *   'summarization' — summarise memory or events
 *   'monologue'     — internal monologue self-check
 *
 * Fallback chain respects config.routing.fallbackOrder.
 */

const EventEmitter = require('events');

// Task types that default to local-only even in quality_routing mode
const DEFAULT_LOCAL = new Set(['intent', 'memory', 'ambient', 'observe', 'worker', 'monologue']);

// Task types that default to best-quality cloud in quality_routing mode
const DEFAULT_QUALITY = new Set(['planning', 'reflection']);

class LLMRouter extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this._roundRobinTurn = 0;

    // OpenAI rate-limit tracking
    this._openAiCalls    = [];
    this._hourlyLimit    = config.hybrid?.openAiHourlyLimit ?? 30;

    // Circuit breakers
    this._ollamaFails    = 0;  this._ollamaFailedAt    = 0;
    this._openAiFails    = 0;  this._openAiFailedAt    = 0;
    this._claudeFails    = 0;  this._claudeFailedAt    = 0;

    // Usage counters
    this.stats = { ollama: 0, openai: 0, claude: 0, fallbacks: 0, errors: 0 };
  }

  // ── Public ────────────────────────────────────────────────────────────────

  async complete(callType, messages, opts = {}, context = {}) {
    const primary = this._selectProvider(callType, context);
    const text    = await this._call(primary, messages, opts);
    if (text !== null) return text;

    // Primary failed — work through the fallback order
    const order = this.config.routing?.fallbackOrder || ['ollama', 'openai', 'claude'];
    for (const p of order) {
      if (p === primary) continue;
      const t = await this._call(p, messages, opts);
      if (t !== null) {
        this.stats.fallbacks++;
        this.emit('router:fallback', { from: primary, to: p, callType });
        return t;
      }
    }
    return null;
  }

  openAiAvailable() {
    return !!(this.config.openai?.enabled && this.config.openai?.apiKey) &&
           !this._openAiCircuitOpen() &&
           !this._overHourlyLimit();
  }

  ollamaAvailable()  { return !this._ollamaCircuitOpen(); }
  claudeAvailable()  {
    return !!(this.config.claude?.enabled && this.config.claude?.apiKey) &&
           !this._claudeCircuitOpen();
  }

  getStats() { return { ...this.stats }; }

  updateConfig(cfg) {
    this.config = cfg;
    this._hourlyLimit = cfg.hybrid?.openAiHourlyLimit ?? 30;
    this.emit('router:config-updated');
  }

  openAiCallsThisHour() {
    const oneHourAgo = Date.now() - 3_600_000;
    this._openAiCalls = this._openAiCalls.filter(t => t > oneHourAgo);
    return this._openAiCalls.length;
  }

  // ── Provider selection ─────────────────────────────────────────────────────

  _selectProvider(callType, context = {}) {
    const taskMap  = this.config.routing?.taskMap || {};
    const override = taskMap[callType];

    // Explicit per-task override — try the named provider, fall through if unavailable
    if (override && override !== 'auto') {
      if (override === 'ollama')                            return 'ollama';
      if (override === 'openai' && this.openAiAvailable()) return 'openai';
      if (override === 'claude' && this.claudeAvailable()) return 'claude';
      // Requested provider unavailable — fall through to strategy
    }

    const strategy = this.config.hybrid?.strategy || 'quality_routing';

    switch (strategy) {
      case 'local_first':
      case 'fastest':
      case 'ollama_primary':
        return 'ollama';

      case 'cheapest': {
        if (DEFAULT_QUALITY.has(callType)) return this._bestCloudProvider() || 'ollama';
        return 'ollama';
      }

      case 'best_quality':
        return this._bestCloudProvider() || 'ollama';

      case 'openai_primary':
        return this.openAiAvailable() ? 'openai' : 'ollama';

      case 'quality_routing':
      default:
        return this._qualityRoute(callType, context);
    }
  }

  _qualityRoute(callType, context = {}) {
    // Structured/frequent calls always stay local
    if (DEFAULT_LOCAL.has(callType)) return 'ollama';

    // Planning / reflection → best available cloud
    if (DEFAULT_QUALITY.has(callType)) return this._bestCloudProvider() || 'ollama';

    // Dialogue — use cloud when it matters
    if (!this.openAiAvailable() && !this.claudeAvailable()) return 'ollama';

    if (context.isImportant || context.isDirectAddress || context.isQuestion) {
      return this._bestCloudProvider() || 'ollama';
    }
    return 'ollama';
  }

  _bestCloudProvider() {
    // Prefer Claude for quality, OpenAI as secondary
    if (this.claudeAvailable()) return 'claude';
    if (this.openAiAvailable()) return 'openai';
    return null;
  }

  // ── Tier-based routing ────────────────────────────────────────────────────

  /**
   * Route by complexity tier rather than call-type strategy.
   * Returns { text, provider, model } so callers can log which tier was used.
   */
  async completeByTier(tier, messages, extraOpts = {}) {
    const { provider, model } = this._providerForTier(tier);
    const opts  = { ...extraOpts, model };
    const text  = await this._call(provider, messages, opts);
    if (text !== null) return { text, provider, model };

    // Fallback: try the next tier down
    const fallbackTier = tier === 'deep' ? 'standard' : 'quick';
    if (fallbackTier !== tier) {
      const fb = this._providerForTier(fallbackTier);
      const ft = await this._call(fb.provider, messages, { ...opts, model: fb.model });
      if (ft !== null) {
        this.stats.fallbacks++;
        return { text: ft, provider: fb.provider, model: fb.model };
      }
    }
    return { text: null, provider, model };
  }

  _providerForTier(tier) {
    switch (tier) {
      case 'quick':
        // Always local — never burn cloud tokens on greetings/acks
        return {
          provider: 'ollama',
          model: this.config.ollama?.quickModel || this.config.ollama?.model || 'llama3.2',
        };

      case 'standard':
        if (this.ollamaAvailable()) return {
          provider: 'ollama',
          model: this.config.ollama?.dialogueModel || this.config.ollama?.model,
        };
        if (this.openAiAvailable()) return {
          provider: 'openai',
          model: this.config.openai?.model || 'gpt-4o-mini',
        };
        return { provider: 'ollama', model: this.config.ollama?.model };

      case 'deep':
        // Cloud-first: best reasoning quality matters here
        if (this.claudeAvailable()) return {
          provider: 'claude',
          model: this.config.claude?.model || 'claude-haiku-4-5-20251001',
        };
        if (this.openAiAvailable()) return {
          provider: 'openai',
          model: this.config.openai?.model || 'gpt-4o-mini',
        };
        return {
          provider: 'ollama',
          model: this.config.ollama?.dialogueModel || this.config.ollama?.model,
        };

      default:
        return { provider: 'ollama', model: this.config.ollama?.model };
    }
  }

  // ── Provider calls ─────────────────────────────────────────────────────────

  async _call(provider, messages, opts) {
    if (provider === 'openai') {
      if (!this.openAiAvailable()) return null;
      return this._callOpenAI(messages, opts);
    }
    if (provider === 'claude') {
      if (!this.claudeAvailable()) return null;
      return this._callClaude(messages, opts);
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
          options:  { temperature: opts.temperature ?? 0.75, num_predict: opts.maxTokens ?? 90 },
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
      const firstFail = this._ollamaFails === 1;
      if (err.name === 'TimeoutError') {
        console.warn(`[LLMRouter] Ollama timed out (${this.config.ollama?.timeoutMs}ms)`);
        if (firstFail) this.emit('router:ollama-error', 'Timed out — is Ollama running?');
      } else {
        console.error('[LLMRouter] Ollama error:', err.message);
        if (firstFail) this.emit('router:ollama-error', err.message);
      }
      if (this._ollamaFails >= 5) this.emit('router:ollama-circuit-open');
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.8, max_tokens: opts.maxTokens ?? 120 }),
        signal:  AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401) { this._openAiFails = 99; this.emit('router:openai-auth-error'); return null; }
      if (res.status === 429) { this._openAiFails++; this._openAiFailedAt = Date.now(); this.emit('router:openai-rate-limited'); return null; }
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || null;
      if (!text) throw new Error('Empty OpenAI response');

      this._openAiCalls.push(Date.now());
      this._openAiFails = 0;
      this.stats.openai++;
      this.emit('router:used', { provider: 'openai', model });
      return text;

    } catch (err) {
      this._openAiFails++;
      this._openAiFailedAt = Date.now();
      this.stats.errors++;
      if (err.name === 'TimeoutError') console.warn('[LLMRouter] OpenAI timed out');
      else console.error('[LLMRouter] OpenAI error:', err.message);
      return null;
    }
  }

  async _callClaude(messages, opts = {}) {
    if (this._claudeCircuitOpen()) return null;

    const apiKey    = this.config.claude?.apiKey;
    const model     = opts.model || this.config.claude?.model || 'claude-haiku-4-5-20251001';
    const timeoutMs = this.config.claude?.timeoutMs || 30_000;
    if (!apiKey) return null;

    // Anthropic API: system prompt is a separate top-level field
    const systemMsg  = messages.find(m => m.role === 'system');
    const chatMsgs   = messages.filter(m => m.role !== 'system');

    try {
      const body = {
        model,
        max_tokens: opts.maxTokens ?? 120,
        messages:   chatMsgs,
      };
      if (systemMsg?.content) body.system = systemMsg.content;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'content-type':       'application/json',
          'x-api-key':          apiKey,
          'anthropic-version':  '2023-06-01',
        },
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401) { this._claudeFails = 99; this.emit('router:claude-auth-error'); return null; }
      if (res.status === 429) { this._claudeFails++; this._claudeFailedAt = Date.now(); return null; }
      if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);

      const data = await res.json();
      const text = data?.content?.[0]?.text?.trim() || null;
      if (!text) throw new Error('Empty Claude response');

      this._claudeFails = 0;
      this.stats.claude++;
      this.emit('router:used', { provider: 'claude', model });
      return text;

    } catch (err) {
      this._claudeFails++;
      this._claudeFailedAt = Date.now();
      this.stats.errors++;
      if (err.name === 'TimeoutError') console.warn('[LLMRouter] Claude timed out');
      else console.error('[LLMRouter] Claude error:', err.message);
      return null;
    }
  }

  // ── Circuit breakers & rate limits ─────────────────────────────────────────

  _ollamaCircuitOpen() {
    if (this._ollamaFails < 5) return false;
    const open = (Date.now() - this._ollamaFailedAt) < 60_000;
    if (!open) this._ollamaFails = 0;
    return open;
  }

  _openAiCircuitOpen() {
    if (this._openAiFails < 3) return false;
    const open = (Date.now() - this._openAiFailedAt) < 120_000;
    if (!open) this._openAiFails = 0;
    return open;
  }

  _claudeCircuitOpen() {
    if (this._claudeFails < 3) return false;
    const open = (Date.now() - this._claudeFailedAt) < 120_000;
    if (!open) this._claudeFails = 0;
    return open;
  }

  _overHourlyLimit() {
    const oneHourAgo = Date.now() - 3_600_000;
    this._openAiCalls = this._openAiCalls.filter(t => t > oneHourAgo);
    return this._openAiCalls.length >= this._hourlyLimit;
  }
}

module.exports = LLMRouter;
