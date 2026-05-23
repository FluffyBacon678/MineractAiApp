'use strict';

/**
 * Monologue — internal self-reflection loop for the AI companion.
 *
 * Runs at a configurable interval. Each tick it may (depending on neuroticism)
 * call an LLM to reflect on current behaviour. If the LLM response starts with
 * "ADJUST:" it emits a 'monologue:adjust' event that botManager can act on.
 *
 * Config (config.monologue):
 *   enabled      {boolean}  — feature on/off
 *   intervalMs   {number}   — base tick interval (min 15s)
 *   neuroticism  {number}   — 1–10: probability of firing per tick = n/10
 *   provider     {string}   — 'ollama' | 'openai' | 'claude' | 'auto'
 */

const EventEmitter = require('events');

const SYSTEM = `You are the inner voice of a Minecraft AI companion named {NAME}.
You briefly reflect on whether your current behaviour is correct and productive.
Neuroticism level: {NEURO}/10 (higher = more critical and interventionist).

If something should change, reply with exactly: ADJUST: <one clear instruction>
If everything is fine, reply with a short natural inner thought (1 sentence).
Never break character. Never say you are an AI.`;

class Monologue extends EventEmitter {
  constructor(config, llmRouter) {
    super();
    this.config = config;
    this.router = llmRouter;
    this._timer = null;
  }

  /**
   * Start the monologue loop.
   * @param {function} getContext — returns {state, task, stateTimeSec, recentEvent}
   */
  start(getContext) {
    if (this._timer) return;
    const cfg = this.config.monologue || {};
    if (!cfg.enabled) return;

    const interval = Math.max(cfg.intervalMs || 60_000, 15_000);
    this._getContext = getContext;
    this._timer = setInterval(() => this._tick(), interval);
    console.log(`[Monologue] Started — interval ${interval}ms, neuroticism ${cfg.neuroticism ?? 5}/10`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  updateConfig(cfg) {
    this.config = cfg;
    // Restart with new interval if running
    if (this._timer) {
      this.stop();
      this.start(this._getContext);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _tick() {
    const cfg        = this.config.monologue || {};
    const neuroticism = Math.min(10, Math.max(1, cfg.neuroticism ?? 5));

    // Probabilistic firing: neuroticism/10 chance per tick
    if (Math.random() >= neuroticism / 10) return;

    const ctx = this._getContext?.();
    if (!ctx) return;

    const name    = this.config.companion?.name || 'Bud';
    const system  = SYSTEM
      .replace('{NAME}',  name)
      .replace('{NEURO}', neuroticism);

    const userMsg = [
      `State: ${ctx.state}.`,
      ctx.task    ? `Current task: ${ctx.task}.` : 'No active task.',
      `Time in state: ${ctx.stateTimeSec ?? '?'}s.`,
      ctx.recentEvent ? `Recent: ${ctx.recentEvent}.` : '',
    ].filter(Boolean).join(' ');

    // Use the configured provider — override the task routing for 'monologue'
    const savedMap = this.config.routing?.taskMap;
    const override = cfg.provider && cfg.provider !== 'auto' ? cfg.provider : undefined;
    if (override && savedMap) savedMap.monologue = override;

    const response = await this.router.complete(
      'monologue',
      [
        { role: 'system', content: system },
        { role: 'user',   content: userMsg },
      ],
      { temperature: 0.6, maxTokens: 60 }
    );

    if (override && savedMap) savedMap.monologue = this.config.monologue.provider || 'ollama';
    if (!response) return;

    const thought = response.replace(/^["'`]+|["'`]+$/g, '').trim();
    this.emit('monologue:thought', { thought, context: ctx });

    if (thought.startsWith('ADJUST:')) {
      const adjustment = thought.slice(7).trim();
      console.log(`[Monologue] ADJUST: ${adjustment}`);
      this.emit('monologue:adjust', { adjustment, context: ctx });
    } else {
      console.log(`[Monologue] "${thought}"`);
    }
  }
}

module.exports = Monologue;
