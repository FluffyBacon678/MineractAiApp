'use strict';

/**
 * Dialogue — generates in-character speech via LLMRouter.
 * Supports Ollama, OpenAI, and hybrid mode.
 * The CharacterProfile builds the system prompt; the router picks the provider.
 */

class Dialogue {
  constructor(config, characterProfile = null, llmRouter = null) {
    this.config    = config;
    this.character = characterProfile;
    this.router    = llmRouter;
  }

  /**
   * @param {string} prompt    — what to respond to
   * @param {object} context   — { state, environment, username, nearbyArea,
   *                              isDirectAddress, isImportant, isQuestion }
   * @returns {Promise<string|null>}
   */
  async generate(prompt, context = {}) {
    if (!prompt || typeof prompt !== 'string') return null;
    if (!this.router) return null;

    const system = this.character
      ? this.character.buildSystemPrompt(context)
      : this._fallbackPrompt(context);

    const talkTrait   = this.character?.getTrait('talkativeness') ?? 5;
    const temperature = 0.6 + (talkTrait / 10) * 0.3;

    const messages = [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ];

    let text = await this.router.complete(
      'dialogue',
      messages,
      { temperature, maxTokens: 100 },
      {
        isDirectAddress: context.isDirectAddress ?? true,
        isImportant:     context.isImportant     ?? false,
        isQuestion:      context.isQuestion       ?? false,
      }
    );

    if (!text) return null;

    // Strip wrapping quotes the LLM sometimes adds
    text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    // Minecraft 256-char chat limit
    if (text.length > 256) text = text.slice(0, 253) + '...';

    return text || null;
  }

  /**
   * Ambient/observation text — always routes to Ollama (frequent, low-stakes).
   */
  async ambient(prompt, context = {}) {
    if (!prompt || !this.router) return null;

    const system = this.character
      ? this.character.buildSystemPrompt(context)
      : this._fallbackPrompt(context);

    const text = await this.router.complete(
      'ambient',
      [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      { temperature: 0.8, maxTokens: 60 },
      {}
    );

    if (!text) return null;
    const clean = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    return clean.length > 256 ? clean.slice(0, 253) + '...' : clean || null;
  }

  _fallbackPrompt(context) {
    const name = this.config.companion?.name || 'Bud';
    return `You are ${name}, a companion in a Minecraft world. ` +
      `Reply in 1-2 short sentences. Never say you are a bot or AI. ` +
      `State: ${context.state || 'idle'}. Surroundings: ${context.environment || 'a quiet area'}.`;
  }
}

module.exports = Dialogue;
