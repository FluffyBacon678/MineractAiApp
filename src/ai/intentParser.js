'use strict';

const log = require('../logger');

/**
 * IntentParser — classifies player chat into a structured intent.
 * Always uses Ollama (fast, structured output, no need for cloud quality).
 * Falls back to OpenAI if Ollama is unavailable.
 */

const VALID_ACTIONS = new Set([
  'FOLLOW','WAIT','LOITER','OBSERVE','BE_TALKATIVE','BE_QUIET',
  'GO_TO','MEMORY_QUERY','WORK_FARM','WORK_PATROL','WORK_COLLECT',
  'WORK_STOP','RESPOND','IGNORE',
]);

const SYSTEM = `You are the command interpreter for a Minecraft AI companion named {NAME}.
Current state: {STATE}

Classify the player's message into exactly one action:
  FOLLOW        - follow the player
  WAIT          - stop and stay put
  LOITER        - wander nearby casually
  OBSERVE       - describe surroundings
  BE_TALKATIVE  - enable spontaneous comments
  BE_QUIET      - suppress spontaneous comments
  GO_TO         - navigate to a named place
  MEMORY_QUERY  - question about a remembered location or fact
  WORK_FARM     - harvest/tend crops at a farm
  WORK_PATROL   - guard or patrol an area
  WORK_COLLECT  - collect nearby dropped items
  WORK_STOP     - stop current task/work
  RESPOND       - conversational reply (player directly addressed companion)
  IGNORE        - not directed at companion

Rules:
- confidence: 0.0 to 1.0
- shouldRespond: true only when player clearly addressed the companion
- responsePrompt: brief gist for RESPOND/GO_TO/MEMORY_QUERY/WORK_* (null otherwise)

Respond ONLY with valid JSON, no markdown:
{"action":"ACTION","confidence":0.85,"shouldRespond":true,"responsePrompt":null}`;

class IntentParser {
  constructor(config, llmRouter = null) {
    this.config = config;
    this.router = llmRouter;
  }

  async parse(message, username, currentState) {
    if (!message?.trim() || !this.router) return null;

    const system = SYSTEM
      .replace('{NAME}',  this.config.companion?.name || 'Bud')
      .replace('{STATE}', currentState || 'WAITING');

    const raw = await this.router.complete(
      'intent',
      [
        { role: 'system', content: system },
        { role: 'user',   content: `${username} says: "${message}"` },
      ],
      { temperature: 0.1, maxTokens: 60 }
    );

    if (!raw) return null;

    try {
      const clean  = raw.replace(/```json|```/g, '').trim();
      const intent = JSON.parse(clean);

      if (!VALID_ACTIONS.has(intent.action)) {
        log.warn('IntentParser', `Unknown action "${intent.action}" — ignoring`);
        return null;
      }

      const confidence = Number(intent.confidence) || 0;
      if (confidence < 0.4) return null;

      log.debug('IntentParser', `"${message.slice(0,60)}" → ${intent.action} (${confidence.toFixed(2)})`);
      return intent;

    } catch (err) {
      log.warn('IntentParser', `JSON parse failed: ${err.message}`, raw?.slice(0, 80));
      return null;
    }
  }
}

module.exports = IntentParser;
