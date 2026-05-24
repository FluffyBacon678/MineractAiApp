'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveDataFile } = require('../paths');

const ENERGY_FILE = resolveDataFile('social-energy.json');
// Restore energy only if it was saved within the last 4 hours.
// After a long break Bud should start fresh and social.
const RESTORE_WINDOW_MS = 4 * 3_600_000;

/**
 * SocialEnergy — the bot's "social battery".
 *
 * Energy starts at 100 and drains with each chat interaction.
 * It recharges slowly during quiet periods (after 30s of silence).
 *
 * High energy → bot is chatty, initiates conversation freely.
 * Low energy  → bot only responds when directly addressed, stays quiet.
 *
 * Config:
 *   enabled          — if false, willingness is always 1 (fully social)
 *   drainPerExchange — points drained per direct interaction (default 8)
 *   chargePerMinute  — points recharged per minute of quiet (default 5)
 */

const EventEmitter = require('events');

class SocialEnergy extends EventEmitter {
  constructor(config = {}) {
    super();
    this._cfg = {
      enabled:          config.enabled          ?? true,
      drainPerExchange: Math.max(1, config.drainPerExchange ?? 8),
      chargePerMinute:  Math.max(1, config.chargePerMinute  ?? 5),
    };
    this._level           = 100;
    this._lastInteraction = 0;
    // Tick every 15 s → 4 ticks per minute
    this._chargeTimer = setInterval(() => this._tick(), 15_000);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** Current energy level 0–100 (integer). */
  get level() { return Math.round(this._level); }

  /**
   * 0–1 willingness to be social right now.
   * Always 1 when disabled (fully social at all times).
   */
  get willingness() {
    return this._cfg.enabled ? this._level / 100 : 1;
  }

  /**
   * Returns true if the bot should initiate unsolicited speech right now.
   * Combines social energy with the talkativeness trait (1–10).
   * Max ~25% chance at full energy with max talkativeness.
   */
  shouldInitiate(talkativeness = 5) {
    const talkFactor = Math.max(1, Math.min(10, talkativeness)) / 10;
    const prob       = this.willingness * talkFactor * 0.25;
    return Math.random() < prob;
  }

  /**
   * Call on every chat exchange.
   * isDirectAddress = true  → full drain
   * isDirectAddress = false → 35% drain (background chat)
   */
  onInteraction(isDirectAddress = true) {
    if (!this._cfg.enabled) return;
    const drain        = isDirectAddress
      ? this._cfg.drainPerExchange
      : this._cfg.drainPerExchange * 0.35;
    const prev         = this._level;
    this._level        = Math.max(0, this._level - drain);
    this._lastInteraction = Date.now();
    if (Math.floor(prev / 5) !== Math.floor(this._level / 5)) {
      this.emit('social:changed', { level: this.level });
    }
  }

  /** Apply new config at runtime (called from UI settings save). */
  updateConfig(cfg = {}) {
    if (typeof cfg.enabled          === 'boolean') this._cfg.enabled          = cfg.enabled;
    if (typeof cfg.drainPerExchange === 'number')  this._cfg.drainPerExchange = Math.max(1, Math.min(30, cfg.drainPerExchange));
    if (typeof cfg.chargePerMinute  === 'number')  this._cfg.chargePerMinute  = Math.max(1, Math.min(30, cfg.chargePerMinute));
    this.emit('social:changed', { level: this.level });
  }

  getConfig() { return { ...this._cfg }; }

  destroy() {
    clearInterval(this._chargeTimer);
    this._chargeTimer = null;
  }

  /**
   * Persist current energy level to disk.
   * Called when the bot disconnects so the level isn't reset to 100
   * on the next session (within the restore window).
   */
  save() {
    try {
      fs.mkdirSync(path.dirname(ENERGY_FILE), { recursive: true });
      fs.writeFileSync(ENERGY_FILE, JSON.stringify({
        level:   Math.round(this._level),
        savedAt: Date.now(),
      }, null, 2), 'utf-8');
    } catch { /* non-fatal */ }
  }

  /**
   * Restore energy level from disk if the save is recent enough.
   * Call once after constructing the SocialEnergy instance.
   */
  load() {
    try {
      if (!fs.existsSync(ENERGY_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(ENERGY_FILE, 'utf-8'));
      if (!raw?.savedAt) return;
      if (Date.now() - raw.savedAt > RESTORE_WINDOW_MS) return;
      this._level = Math.min(100, Math.max(0, Number(raw.level) || 100));
    } catch { /* non-fatal */ }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _tick() {
    if (!this._cfg.enabled || this._level >= 100) return;
    // Don't recharge until 30 s of quiet
    if (Date.now() - this._lastInteraction < 30_000) return;
    const prev    = this._level;
    // chargePerMinute / 4 because we tick 4× per minute
    this._level   = Math.min(100, this._level + this._cfg.chargePerMinute / 4);
    if (Math.floor(prev / 5) !== Math.floor(this._level / 5)) {
      this.emit('social:changed', { level: this.level });
    }
  }
}

module.exports = SocialEnergy;
