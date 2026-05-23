'use strict';

/**
 * ComplexityAssessor — instant zero-cost heuristic that assigns an LLM tier.
 *
 * Tiers:
 *   'quick'    Ollama small model · 65 tokens  · greetings, acks, movement confirms
 *   'standard' Ollama medium / GPT-4o-mini     · 150 tokens · general dialogue
 *   'deep'     Claude / GPT-4o                 · 500 tokens · planning, reasoning
 *
 * Social energy penalty (0-100):
 *   energy < 30 → drop one tier   (deep→standard, standard→quick)
 *   energy < 10 → force quick     (bot is too drained to think hard)
 */

// Keywords that imply multi-step reasoning or planning
const DEEP_RE = /\b(plan|how (do|can|should|would|to)|should i|help me|what if|step[\s-]by[\s-]step|build|create|solve|explain|why (is|are|do|did|would|should)|figure out|strategy|best way|recommend|suggest|analyze|compare|pros? (and|or) cons?|what would happen|in order to|because of|therefore|since you|can you think|walk me through)\b/i;

// Single-word reactions / greetings that only need a reflex response
const QUICK_RE = /^(hi|hey|hello|yo|ok|okay|k|yeah|yep|yup|no|nope|yes|uh|ah|oh|hmm|sure|alright|fine|cool|wow|nice|lol|haha|heh|thanks|ty|thx|np|gg|brb|afk|wb|good|bad|great|awesome|damn|whoa|oops|sorry|my bad|got it|understood|makes sense|interesting|fair enough)\b/i;

// Intent action types that always map to a specific tier
const ALWAYS_QUICK = new Set([
  'FOLLOW', 'WAIT', 'LOITER', 'WORK_STOP', 'WORK_FARM', 'WORK_PATROL',
  'WORK_COLLECT', 'BE_TALKATIVE', 'BE_QUIET', 'GO_TO', 'MEMORY_QUERY',
]);
const ALWAYS_DEEP  = new Set(['planning', 'reflection']);

/**
 * Assess the complexity tier for a given player message + intent action.
 *
 * @param {string} message       raw player message
 * @param {string} action        intent action (e.g. 'RESPOND', 'FOLLOW', 'planning')
 * @param {object} context       { isDirectAddress, isImportant, isQuestion }
 * @param {number} socialEnergy  current social energy 0-100
 * @returns {'quick'|'standard'|'deep'}
 */
function assess(message = '', action = null, context = {}, socialEnergy = 100) {
  // Hard overrides by action type
  if (action && ALWAYS_DEEP.has(action))  return penalise('deep',     socialEnergy);
  if (action && ALWAYS_QUICK.has(action)) return penalise('quick',    socialEnergy);

  const m     = message.trim().toLowerCase();
  const words = m.split(/\s+/).filter(Boolean);

  // Very short or greeting reaction → quick
  if (words.length <= 3)       return penalise('quick',    socialEnergy);
  if (QUICK_RE.test(m))        return penalise('quick',    socialEnergy);

  // Planning/reasoning keywords → deep
  if (DEEP_RE.test(m))         return penalise('deep',     socialEnergy);

  // Multi-part question (contains "and" + ends "?") → deep
  if (m.endsWith('?') && /\band\b/.test(m)) return penalise('deep', socialEnergy);

  // Single question → standard
  if (message.trim().endsWith('?')) return penalise('standard', socialEnergy);

  // Addressed directly / important → at least standard
  if (context.isDirectAddress || context.isImportant) return penalise('standard', socialEnergy);

  return penalise('standard', socialEnergy);
}

function penalise(tier, energy) {
  if (energy < 10) return 'quick';
  if (energy < 30) {
    if (tier === 'deep')     return 'standard';
    if (tier === 'standard') return 'quick';
  }
  return tier;
}

/** Token budget and temperature per tier */
const TIER_OPTS = {
  quick:    { maxTokens: 65,  temperature: 0.75 },
  standard: { maxTokens: 150, temperature: 0.80 },
  deep:     { maxTokens: 500, temperature: 0.85 },
};

/** How many recent conversation turns to inject per tier */
const TIER_HISTORY = {
  quick:    6,
  standard: 12,
  deep:     9999, // inject the full buffer
};

module.exports = { assess, TIER_OPTS, TIER_HISTORY };
