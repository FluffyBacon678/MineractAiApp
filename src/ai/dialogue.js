'use strict';

/**
 * Dialogue — generates in-character speech with tier-based routing.
 *
 * Tier selection (ComplexityAssessor):
 *   quick    → Ollama small model  (greetings, acks, movement confirms)
 *   standard → Ollama medium / GPT-4o-mini  (general conversation)
 *   deep     → Claude / GPT-4o  (planning, reasoning, multi-part questions)
 *
 * Conversation history (ConversationBuffer):
 *   Each tier receives a different depth of history:
 *   quick=6 turns, standard=12 turns, deep=all turns.
 *   Buffer is summarised automatically when it exceeds maxTurns.
 *
 * Returns { text, tier, provider, model } so callers can log tier usage.
 */

const EventEmitter = require('events');
const { assess, TIER_OPTS, TIER_HISTORY } = require('./complexityAssessor');

class Dialogue extends EventEmitter {
  /**
   * @param {object}              config
   * @param {CharacterProfile}    characterProfile
   * @param {LLMRouter}           llmRouter
   * @param {ConversationBuffer}  buffer
   */
  constructor(config, characterProfile = null, llmRouter = null, buffer = null) {
    super();
    this.config    = config;
    this.character = characterProfile;
    this.router    = llmRouter;
    this.buffer    = buffer;
  }

  // ── Main generate ─────────────────────────────────────────────────────────

  /**
   * Generate a response, selecting model tier automatically.
   *
   * @param {string} prompt        what to respond to (player's message / formatted prompt)
   * @param {object} context       { state, environment, username, spatialCtx,
   *                                 inventoryCtx, playerProximity, socialEnergy,
   *                                 isDirectAddress, isImportant, isQuestion }
   * @param {string} [forceAction] intent action — used by assessor (e.g. 'FOLLOW', 'RESPOND')
   * @param {string} [forceTier]   override tier ('quick'|'standard'|'deep')
   * @returns {Promise<{text:string|null, tier:string, provider:string, model:string}>}
   */
  async generate(prompt, context = {}, forceAction = null, forceTier = null) {
    if (!prompt || typeof prompt !== 'string') return this._empty('quick');
    if (!this.router) return this._empty('quick');

    const energy = context.socialEnergy ?? 100;
    const tier   = forceTier ?? assess(prompt, forceAction, context, energy);
    const opts   = TIER_OPTS[tier];
    const histN  = TIER_HISTORY[tier];

    // Build system prompt
    const system = this.character
      ? this.character.buildSystemPrompt(context)
      : this._fallbackPrompt(context);

    // Talkative trait nudges temperature slightly
    const talkTrait   = this.character?.getTrait('talkativeness') ?? 5;
    const temperature = opts.temperature + (talkTrait / 10) * 0.1;

    // Assemble messages: system + conversation history + current prompt
    const historyMsgs = this.buffer ? this.buffer.getMessages(histN) : [];
    const messages = [
      { role: 'system', content: system },
      ...historyMsgs,
      { role: 'user',   content: prompt },
    ];

    const { text, provider, model } = await this.router.completeByTier(tier, messages, {
      temperature,
      maxTokens: opts.maxTokens,
    });

    if (!text) return this._empty(tier);

    const clean = this._clean(text);

    // Push assistant response into buffer AFTER getting a response.
    // The raw player message is pushed by botManager._onChat() so we never
    // store the formatted internal prompt string as a "user" turn.
    if (this.buffer && clean) {
      this.buffer.push('assistant', clean);

      // Trigger summarisation if buffer is full
      if (this.buffer.needsSummarization) {
        this._summariseBuffer().catch(() => {});
      }
    }

    this.emit('dialogue:used', { tier, provider, model, tokens: opts.maxTokens });
    return { text: clean, tier, provider, model };
  }

  /**
   * Ambient/observation — always quick tier, no conversation history needed.
   */
  async ambient(prompt, context = {}) {
    if (!prompt || !this.router) return this._empty('quick');

    const system = this.character
      ? this.character.buildSystemPrompt(context)
      : this._fallbackPrompt(context);

    const { text, provider, model } = await this.router.completeByTier('quick', [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ], { temperature: 0.8, maxTokens: 60 });

    if (!text) return this._empty('quick');
    const clean = this._clean(text);
    // Push ambient speech into buffer as assistant turn (maintains narrative coherence)
    if (this.buffer && clean) this.buffer.push('assistant', clean);
    this.emit('dialogue:used', { tier: 'quick', provider, model, tokens: 60 });
    return { text: clean, tier: 'quick', provider, model };
  }

  /**
   * Quick acknowledgment — one-liner confirm for movement/task commands.
   * Never pulls conversation history (it's just a short ack).
   */
  async acknowledge(prompt, context = {}) {
    if (!prompt || !this.router) return this._empty('quick');

    const system = this.character
      ? this.character.buildSystemPrompt(context)
      : this._fallbackPrompt(context);

    const { text, provider, model } = await this.router.completeByTier('quick', [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ], { temperature: 0.7, maxTokens: 40 });

    if (!text) return this._empty('quick');
    const clean = this._clean(text);
    if (this.buffer && clean) this.buffer.push('assistant', clean);
    this.emit('dialogue:used', { tier: 'quick', provider, model, tokens: 40 });
    return { text: clean, tier: 'quick', provider, model };
  }

  // ── Buffer summarisation ──────────────────────────────────────────────────

  async _summariseBuffer() {
    if (!this.buffer || !this.router) return;
    const excerpt = this.buffer.getOldestHalfText();
    if (!excerpt) return;

    const { text } = await this.router.completeByTier('quick', [
      { role: 'system', content: 'Summarise this Minecraft conversation in 1-2 sentences. Be concise.' },
      { role: 'user',   content: excerpt },
    ], { temperature: 0.3, maxTokens: 80 });

    if (text) this.buffer.applySummary(text.trim());
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _clean(text) {
    let t = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (t.length > 256) t = t.slice(0, 253) + '...';
    return t || null;
  }

  _empty(tier) {
    return { text: null, tier, provider: 'none', model: 'none' };
  }

  _fallbackPrompt(context) {
    const name = this.config.companion?.name || 'Bud';
    return `You are ${name}, a companion in a Minecraft world. ` +
      `Reply in 1-2 short sentences. Never say you are a bot or AI. ` +
      `State: ${context.state || 'idle'}. Surroundings: ${context.environment || 'a quiet area'}.`;
  }
}

module.exports = Dialogue;
