'use strict';

/**
 * Observer — scans the Minecraft world and drives ambient comments.
 * Pure read-only. Never triggers movement or world modification.
 *
 * Reacts to resource profile changes: when ResourceManager switches profile
 * the scan and talk intervals are updated live without restarting the bot.
 */

const HOSTILE = new Set([
  'creeper','zombie','skeleton','spider','cave_spider','enderman',
  'witch','pillager','vindicator','phantom','drowned','husk','stray',
  'blaze','ghast','slime','magma_cube','warden','ravager','evoker',
]);

const PASSIVE = new Set([
  'cow','pig','sheep','chicken','horse','donkey','mule','wolf',
  'cat','ocelot','rabbit','fox','bee','axolotl','goat','frog','allay',
]);

// Profile → interval overrides (ms). Null = use config value.
const PROFILE_SCAN_MS  = { lightweight: 60_000, normal: 15_000, heavy:  8_000 };
const PROFILE_TALK_MS  = { lightweight:120_000, normal: 45_000, heavy: 25_000 };

const delay = ms => new Promise(r => setTimeout(r, ms));

// Workstation block names → tag used in WorldMemory
const WORKSTATION_TAGS = {
  crafting_table:   'crafting_table',
  furnace:          'furnace',
  blast_furnace:    'furnace',
  smoker:           'furnace',
  enchanting_table: 'enchanting_table',
  anvil:            'anvil',
  chipped_anvil:    'anvil',
  damaged_anvil:    'anvil',
};

class Observer {
  constructor(bot, config, memory = null) {
    this.bot             = bot;
    this.config          = config;
    this.memory          = memory;   // WorldMemory — optional, for auto-detection
    this.stateMachine    = null;
    this.lastObservation = 'a quiet area';

    this._scanTimer      = null;
    this._talkTimer      = null;
    this._recentComments = [];
    this._isRunning      = false;
    this._currentProfile = 'normal';
  }

  start(stateMachine) {
    if (this._isRunning) return;
    this._isRunning   = true;
    this.stateMachine = stateMachine;
    this._startTimers();
  }

  /**
   * Called by BotManager when ResourceManager emits profile:changed.
   * Restarts timers with the new intervals immediately.
   */
  applyProfile(profile) {
    if (!['lightweight','normal','heavy'].includes(profile)) return;
    if (this._currentProfile === profile) return;
    this._currentProfile = profile;
    if (this._isRunning) {
      console.log(`[Observer] Profile → ${profile}, restarting timers`);
      this._startTimers(); // clears old timers and starts new ones
    }
  }

  stop() {
    clearInterval(this._scanTimer);
    clearInterval(this._talkTimer);
    this._scanTimer = this._talkTimer = null;
    this._isRunning = false;
  }

  async describeEnvironment() {
    try {
      const obs = this._buildObservation();
      this.lastObservation = obs;
      return obs;
    } catch (err) {
      console.warn('[Observer] describeEnvironment error:', err.message);
      return 'I had trouble reading the surroundings.';
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _startTimers() {
    // Clear existing timers first
    clearInterval(this._scanTimer);
    clearInterval(this._talkTimer);

    const scanMs = PROFILE_SCAN_MS[this._currentProfile]
      ?? this.config.companion?.observeIntervalMs
      ?? 15_000;

    const talkMs = PROFILE_TALK_MS[this._currentProfile]
      ?? this.config.companion?.talkativeIntervalMs
      ?? 45_000;

    this._scanTimer = setInterval(() => {
      try {
        this.lastObservation = this._buildObservation();
      } catch (err) {
        console.warn('[Observer] Scan error:', err.message);
      }
    }, scanMs);

    this._talkTimer = setInterval(async () => {
      if (!this.stateMachine?.isTalkative) return;
      if (this.stateMachine?.currentState === 'WORKING') return;
      // Lightweight profile: never spontaneous comments
      if (this._currentProfile === 'lightweight') return;

      try {
        const comment = this._pickComment();
        if (!comment) return;
        await delay(1000 + Math.random() * 2500);
        if (this.bot?.entity && this._isRunning) this.bot.chat(comment);
      } catch (err) {
        console.warn('[Observer] Talk tick error:', err.message);
      }
    }, talkMs);
  }

  _buildObservation() {
    const parts = [];
    const pos   = this.bot?.entity?.position;
    if (!pos) return 'unknown surroundings';

    const t = this.bot.time?.timeOfDay ?? 6000;
    if      (t <  1000) parts.push('early morning');
    else if (t <  6000) parts.push('daytime');
    else if (t < 12000) parts.push('afternoon');
    else if (t < 13800) parts.push('dusk');
    else                parts.push('night');

    if (this.bot.isRaining) parts.push('raining');

    const nearby    = Object.values(this.bot.entities || {}).filter(
      e => e !== this.bot.entity && e.position?.distanceTo(pos) < 24
    );
    const hostiles  = nearby.filter(e => HOSTILE.has(e.name));
    const passives  = nearby.filter(e => PASSIVE.has(e.name));
    const villagers = nearby.filter(e => e.name === 'villager');
    const players   = nearby.filter(e => e.type === 'player');

    if (hostiles.length > 0) {
      const names = [...new Set(hostiles.map(e => e.name))].join(', ');
      parts.push(`${hostiles.length} hostile(s): ${names}`);
    }
    if (villagers.length > 0) parts.push(`${villagers.length} villager(s)`);
    if (passives.length  > 0) parts.push(`${passives.length} animal(s)`);
    if (players.length   > 0) {
      parts.push(`players: ${players.map(e => e.username).filter(Boolean).join(', ')}`);
    }

    const blockNotes = this._scanInterestingBlocks(pos);
    if (blockNotes) parts.push(blockNotes);

    return parts.length > 0 ? parts.join(', ') : 'nothing notable';
  }

  _scanInterestingBlocks(pos) {
    try {
      const notes = [];
      const wheat = this.bot.findBlock({
        matching: b => b.name === 'wheat' && b.getProperties?.().age === 7,
        maxDistance: 16,
      });
      if (wheat) notes.push('wheat ready for harvest');

      const chest = this.bot.findBlock({ matching: b => b.name === 'chest', maxDistance: 10 });
      if (chest) notes.push('a chest nearby');

      // Auto-detect workstations and beds → save to WorldMemory if not already known nearby
      this._detectWorkstations(pos);

      return notes.join(', ') || null;
    } catch {
      return null;
    }
  }

  /** Silently auto-save newly discovered beds / workstations to WorldMemory. */
  _detectWorkstations(pos) {
    if (!this.memory || !pos) return;
    try {
      // Beds
      const bed = this.bot.findBlock({ matching: b => b.name?.endsWith('_bed'), maxDistance: 16 });
      if (bed) this._autoSaveWorkstation('bed', 'bed', bed.position, pos);

      // Workstations
      for (const [blockName, tag] of Object.entries(WORKSTATION_TAGS)) {
        const block = this.bot.findBlock({ matching: b => b.name === blockName, maxDistance: 20 });
        if (block) this._autoSaveWorkstation('workstation', tag, block.position, pos);
      }
    } catch { /* silent */ }
  }

  _autoSaveWorkstation(type, tag, blockPos, botPos) {
    if (!this.memory) return;

    // Dedup: skip if we already know about this type within 8 blocks
    const existing = type === 'bed'
      ? this.memory.findByType('bed')
      : this.memory.all().filter(l => l.type === 'workstation' && l.tags?.includes(tag));

    const tooClose = existing.some(l => {
      const dx = l.coordinates.x - blockPos.x;
      const dz = l.coordinates.z - blockPos.z;
      const dy = l.coordinates.y - blockPos.y;
      return Math.sqrt(dx*dx + dy*dy + dz*dz) < 8;
    });
    if (tooClose) return;

    const label = type === 'bed' ? 'Bed' : tag.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
    const name  = `${label} (${Math.floor(blockPos.x)}, ${Math.floor(blockPos.z)})`;
    try {
      this.memory.save({
        name,
        type,
        tags:        [tag],
        coordinates: { x: Math.floor(blockPos.x), y: Math.floor(blockPos.y), z: Math.floor(blockPos.z) },
        confidence:  0.95,
        radius:      4,
      });
    } catch { /* ignore duplicate-name save errors */ }
  }

  _pickComment() {
    const pos     = this.bot?.entity?.position;
    if (!pos) return null;

    const t       = this.bot.time?.timeOfDay ?? 6000;
    const isNight = t > 13800 && t < 23000;

    const nearby   = Object.values(this.bot.entities || {}).filter(
      e => e !== this.bot.entity && e.position?.distanceTo(pos) < 20
    );
    const hostiles = nearby.filter(e => HOSTILE.has(e.name));

    const pool = [];
    if (hostiles.length > 0) {
      pool.push(`There's a ${hostiles[0].name} nearby.`);
      pool.push(`Watch out — I see a ${hostiles[0].name}.`);
    }
    if (isNight) {
      pool.push("It's dark out. Stay close.");
      pool.push("The night feels long tonight.");
    }
    if (this.bot.isRaining) {
      pool.push("Quite a downpour.");
      pool.push("I don't mind the rain.");
    }

    const fresh = pool.filter(c => !this._recentComments.includes(c));
    if (fresh.length === 0) { this._recentComments = []; return null; }

    const chosen = fresh[Math.floor(Math.random() * fresh.length)];
    this._recentComments.push(chosen);
    if (this._recentComments.length > 4) this._recentComments.shift();
    return chosen;
  }
}

module.exports = Observer;
