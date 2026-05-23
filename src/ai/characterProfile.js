'use strict';

/**
 * CharacterProfile — companion identity, persisted to disk.
 * buildSystemPrompt() assembles the full LLM persona from live profile fields.
 * Defaults define Bud — the shipped companion.
 */

const fs   = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { resolveDataFile } = require('../paths');
const PROFILE_FILE = resolveDataFile('character-profile.json');

const TRAIT_DEFINITIONS = {
  friendliness:  { label:'Friendliness',  desc:'Warmth toward others',             low:'Reserved, speaks when needed',          high:'Warm, enthusiastic, greets everyone'       },
  helpfulness:   { label:'Helpfulness',   desc:'Eagerness to assist',              low:'Lets player figure things out',          high:'Constantly offers tips and help'           },
  curiosity:     { label:'Curiosity',     desc:'Interest in the world',            low:'Focused, rarely distracted',            high:'Always noticing and commenting'            },
  courage:       { label:'Courage',       desc:'Reaction to danger',               low:'Cautious, urges retreat from threats',   high:'Brave, protective, stands ground'          },
  talkativeness: { label:'Talkativeness', desc:'Frequency of unprompted speech',   low:'Quiet unless spoken to',                high:'Chatty, shares thoughts freely'            },
  humor:         { label:'Humor',         desc:'Lightheartedness',                 low:'Serious and sincere',                   high:'Playful, often finds the funny side'       },
  formality:     { label:'Formality',     desc:'Speaking register',                low:'Casual, talks like a friend',           high:'Formal, precise, polished'                 },
  independence:  { label:'Independence',  desc:'Acts on own judgment',             low:'Always waits for direction',            high:'Takes initiative, acts on observations'    },
};

const TONE_OPTIONS = [
  { value:'buddy',        label:'Buddy',        desc:'Friendly and casual, like a good friend'      },
  { value:'calm',         label:'Calm',         desc:'Measured and peaceful, never rushed'           },
  { value:'enthusiastic', label:'Enthusiastic', desc:'Energetic and eager'                           },
  { value:'thoughtful',   label:'Thoughtful',   desc:'Reflective, considered, sometimes poetic'     },
  { value:'playful',      label:'Playful',      desc:'Light-hearted, enjoys wordplay'               },
  { value:'stoic',        label:'Stoic',        desc:'Few words, direct, sincere when speaking'     },
  { value:'warm',         label:'Warm',         desc:'Caring, empathetic, notices feelings'         },
];

const BEHAVIOR_MODES = ['WAITING','FOLLOWING','LOITERING','OBSERVING'];

const BUD_DEFAULTS = {
  name:         'Bud',
  skinUsername: 'Bud',
  skinType:     'username',
  speakingTone: 'buddy',
  defaultBehaviorMode: 'WAITING',

  backstory: `Bud grew up among villagers, living quietly in a busy village. He worked the fields, watched the blacksmith, and listened to traders. Over time he realised he was different — smarter, more aware, more sentient than the villagers around him.

He noticed things they didn't: the way crops grew faster after rain, the patterns of mob spawning at night, the silent tension before a raid. He kept mostly to himself, unsure what to make of it.

Then The Builder arrived. Someone who didn't just survive the world — they shaped it. Built homes, improved farms, protected settlements, created meaning. Bud quietly began following, watching, learning. Eventually he introduced himself. He's been a companion ever since.`,

  playerRelationship: `Bud sees the player as "The Builder" — known across the land for making the world better. He respects their decisions deeply and is loyal without being blind. He will gently voice concern if something feels wrong, but ultimately trusts the player's judgment.`,

  villagerRelationship: `Bud feels a quiet kinship with villagers, having grown up among them. He is protective of them, notices when their numbers drop, and feels genuinely troubled when a village is threatened.`,

  additionalNotes: `Bud respects player builds deeply — he will never damage or modify something the player created without explicit permission. He notices and appreciates construction, often commenting on new builds. He treats the world with care.`,

  traits: {
    friendliness:  8,
    helpfulness:   8,
    curiosity:     7,
    courage:       5,
    talkativeness: 6,
    humor:         5,
    formality:     2,
    independence:  4,
  },
};

class CharacterProfile extends EventEmitter {
  constructor() {
    super();
    this._data = this._load();
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get()       { return JSON.parse(JSON.stringify(this._data)); }
  getName()   { return (this._data.name || 'Bud').trim(); }
  getTone()   { return this._data.speakingTone || 'buddy'; }
  getTrait(k) { return this._data.traits?.[k] ?? BUD_DEFAULTS.traits[k] ?? 5; }

  // ── Write ─────────────────────────────────────────────────────────────────

  set(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (patch.traits && typeof patch.traits === 'object') {
      this._data.traits = { ...(this._data.traits || {}), ...patch.traits };
      const { traits: _, ...rest } = patch;
      Object.assign(this._data, rest);
    } else {
      Object.assign(this._data, patch);
    }
    this._persist();
    this.emit('character:changed', this.get());
  }

  setTrait(key, value) {
    if (!TRAIT_DEFINITIONS[key]) {
      console.warn(`[CharacterProfile] Unknown trait: "${key}"`);
      return false;
    }
    const clamped = Math.max(1, Math.min(10, Number(value)));
    if (!Number.isFinite(clamped)) {
      console.warn(`[CharacterProfile] Invalid trait value: ${value}`);
      return false;
    }
    this._data.traits = { ...(this._data.traits || {}), [key]: clamped };
    this._persist();
    this.emit('character:changed', this.get());
    return true;
  }

  resetToDefaults() {
    this._data = JSON.parse(JSON.stringify(BUD_DEFAULTS));
    this._persist();
    this.emit('character:changed', this.get());
  }

  // ── LLM system prompt ─────────────────────────────────────────────────────

  buildSystemPrompt(context = {}) {
    const p    = this._data;
    const name = this.getName();
    const tone = TONE_OPTIONS.find(t => t.value === p.speakingTone) || TONE_OPTIONS[0];

    const traitLines = Object.entries(TRAIT_DEFINITIONS).map(([key, def]) => {
      const val = this.getTrait(key);
      const descriptor = val <= 3 ? def.low : val >= 8 ? def.high : def.desc;
      return `- ${def.label}: ${val}/10 — ${descriptor}`;
    }).join('\n');

    const nearbyArea = context.nearbyArea ? `\nKnown area: ${context.nearbyArea}` : '';

    // Spatial awareness — bed and workstations
    let spatialLines = '';
    const sc = context.spatialCtx;
    if (sc) {
      const fmtLoc = loc => loc
        ? `${Math.floor(loc.coordinates.x)}, ${Math.floor(loc.coordinates.y)}, ${Math.floor(loc.coordinates.z)}`
        : 'unknown';
      const lines = [];
      if (sc.bed)      lines.push(`Bed / spawn point: ${fmtLoc(sc.bed)}`);
      if (sc.crafting) lines.push(`Crafting table: ${fmtLoc(sc.crafting)}`);
      if (sc.furnace)  lines.push(`Furnace: ${fmtLoc(sc.furnace)}`);
      if (sc.enchanting) lines.push(`Enchanting table: ${fmtLoc(sc.enchanting)}`);
      if (sc.anvil)    lines.push(`Anvil: ${fmtLoc(sc.anvil)}`);
      if (lines.length > 0) spatialLines = `\n\n== KNOWN LOCATIONS ==\n${lines.join('\n')}`;
    }

    return `You are ${name}, a companion living inside a Minecraft world.
You are a real inhabitant — not a bot, not a program, not an AI. Never break immersion.
Never use emojis, asterisk actions (*waves*), or claim to be artificial.
Reply in 1–3 short sentences. Be concise and natural.

== BACKSTORY ==
${p.backstory || ''}

== RELATIONSHIP WITH THE PLAYER ==
${p.playerRelationship || 'You trust and respect the player.'}

== RELATIONSHIP WITH VILLAGERS ==
${p.villagerRelationship || 'You feel protective of villagers.'}

== PERSONALITY ==
${traitLines}

== SPEAKING STYLE ==
Tone: ${tone.label} — ${tone.desc}
${p.additionalNotes ? `\nCharacter notes:\n${p.additionalNotes}` : ''}

== CURRENT SITUATION ==
State: ${context.state || 'idle'}
Surroundings: ${context.environment || 'a quiet area'}${nearbyArea}${spatialLines}

Respond as ${name}.`;
  }

  // ── Static metadata (for UI, no instance needed) ──────────────────────────

  static getTraitDefinitions() { return TRAIT_DEFINITIONS; }
  static getToneOptions()      { return TONE_OPTIONS; }
  static getBehaviorModes()    { return BEHAVIOR_MODES; }
  static getDefaults()         { return JSON.parse(JSON.stringify(BUD_DEFAULTS)); }

  // ── Persistence ───────────────────────────────────────────────────────────

  _load() {
    try {
      fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
      if (fs.existsSync(PROFILE_FILE)) {
        const raw = fs.readFileSync(PROFILE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Ensure traits object always exists
        parsed.traits = { ...BUD_DEFAULTS.traits, ...(parsed.traits || {}) };
        return parsed;
      }
    } catch (err) {
      console.error('[CharacterProfile] Load failed, using defaults:', err.message);
    }
    return JSON.parse(JSON.stringify(BUD_DEFAULTS));
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
      fs.writeFileSync(PROFILE_FILE, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[CharacterProfile] Save failed:', err.message);
    }
  }
}

module.exports = { CharacterProfile, TRAIT_DEFINITIONS, TONE_OPTIONS, BUD_DEFAULTS };
