'use strict';

/**
 * StalenessConfig — all cache/refresh intervals, fully configurable from the UI.
 * WorldMemory reads from here at runtime; nothing is hardcoded there.
 */

const fs   = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { resolveDataFile } = require('../paths');
const CONFIG_FILE = resolveDataFile('staleness-config.json');

const CATEGORIES = {
  house_base:     { label:'House / Base',         desc:'Player home, AI home, main base',                  defaultMs: 24*60*60*1000,   unit:'hours'   },
  chest_contents: { label:'Chest contents',        desc:'Storage chest and barrel inventories',             defaultMs:  3*60*1000,      unit:'minutes' },
  farm_crops:     { label:'Farm / Crop states',    desc:'Planted crops, growth stage, harvest readiness',   defaultMs: 10*60*1000,      unit:'minutes' },
  villagers:      { label:'Villager count',         desc:'Number of villagers in villages or pens',          defaultMs: 15*60*1000,      unit:'minutes' },
  animals:        { label:'Animal counts',          desc:'Livestock and pets in animal pens',                defaultMs: 15*60*1000,      unit:'minutes' },
  hostile_mobs:   { label:'Hostile mob positions', desc:'Hostile entities near known areas',                defaultMs:    30*1000,      unit:'seconds' },
  dropped_items:  { label:'Dropped items',          desc:'Items on the ground near a location',              defaultMs:    60*1000,      unit:'seconds' },
  mechanisms:     { label:'Doors / Redstone',       desc:'Open doors, lever states, powered redstone',       defaultMs:  5*60*1000,      unit:'minutes' },
  paths_routes:   { label:'Paths / Routes',         desc:'Known safe walking paths',                         defaultMs: 48*60*60*1000,   unit:'hours'   },
  waypoints:      { label:'Waypoints',              desc:'Named coordinate markers',                         defaultMs:  7*24*60*60*1000,unit:'hours'   },
  landmarks:      { label:'Landmarks',              desc:'Mountains, notable terrain features',              defaultMs:  7*24*60*60*1000,unit:'hours'   },
  area_scans:     { label:'General area scans',     desc:'Broad observations of an area',                    defaultMs: 10*60*1000,      unit:'minutes' },
};

const TYPE_TO_CATEGORY = {
  house:'house_base', ai_home:'house_base', building:'house_base',
  farm:'farm_crops', storage:'chest_contents', village:'villagers',
  animal_pen:'animals', danger:'hostile_mobs', waypoint:'waypoints', poi:'landmarks',
};

const PROFILE_MULT = { lightweight: 4.0, normal: 1.0, heavy: 0.5 };
const MIN_MS = 30_000;

class StalenessConfig extends EventEmitter {
  constructor() {
    super();
    this._data = this._load();
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  getAllCategories() {
    return Object.entries(CATEGORIES).map(([key, meta]) => {
      const user = this._data.categories[key] || {};
      return {
        key,
        label:       meta.label,
        desc:        meta.desc,
        defaultMs:   meta.defaultMs,
        unit:        meta.unit,
        intervalMs:  user.intervalMs  ?? meta.defaultMs,
        autoRefresh: user.autoRefresh ?? true,
        alwaysVerify:user.alwaysVerify ?? false,
      };
    });
  }

  getCategory(key) {
    if (!CATEGORIES[key]) return null;
    const meta = CATEGORIES[key];
    const user = this._data.categories[key] || {};
    return {
      key,
      ...meta,
      intervalMs:  user.intervalMs  ?? meta.defaultMs,
      autoRefresh: user.autoRefresh ?? true,
      alwaysVerify:user.alwaysVerify ?? false,
    };
  }

  getIntervalMs(locationType, profile = 'normal') {
    const catKey  = TYPE_TO_CATEGORY[locationType] || 'area_scans';
    const meta    = CATEGORIES[catKey];
    const user    = this._data.categories[catKey] || {};
    const base    = (typeof user.intervalMs === 'number' && user.intervalMs > 0)
      ? user.intervalMs
      : meta.defaultMs;
    const mult    = PROFILE_MULT[profile] ?? 1.0;
    return Math.max(Math.round(base * mult), MIN_MS);
  }

  getGlobals() {
    return { ...this._data.globals };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  setCategory(key, patch) {
    if (!CATEGORIES[key]) {
      console.warn(`[StalenessConfig] Unknown category: "${key}"`);
      return false;
    }
    if (typeof patch.intervalMs === 'number' && (patch.intervalMs < MIN_MS || !Number.isFinite(patch.intervalMs))) {
      console.warn(`[StalenessConfig] intervalMs ${patch.intervalMs} out of range — clamping`);
      patch.intervalMs = Math.max(patch.intervalMs, MIN_MS);
    }
    this._data.categories[key] = { ...(this._data.categories[key] || {}), ...patch };
    this._persist();
    this.emit('staleness:changed', { category: key });
    return true;
  }

  setBulk(categories) {
    if (!categories || typeof categories !== 'object') return;
    for (const [key, patch] of Object.entries(categories)) {
      if (!CATEGORIES[key]) continue;
      this._data.categories[key] = { ...(this._data.categories[key] || {}), ...patch };
    }
    this._persist();
    this.emit('staleness:changed', { bulk: true });
  }

  setGlobals(patch) {
    if (!patch || typeof patch !== 'object') return;
    Object.assign(this._data.globals, patch);
    this._persist();
    this.emit('staleness:changed', { globals: patch });
  }

  resetToDefaults() {
    this._data.categories = {};
    this._persist();
    this.emit('staleness:changed', { reset: true });
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  static getMetadata()        { return CATEGORIES; }
  static categoryForType(t)   { return TYPE_TO_CATEGORY[t] || 'area_scans'; }

  static formatInterval(ms) {
    if (!ms || ms < 0) return '?';
    if (ms < 60_000)      return `${Math.round(ms/1000)}s`;
    if (ms < 3_600_000)   return `${Math.round(ms/60_000)}m`;
    if (ms < 86_400_000)  return `${Math.round(ms/3_600_000)}h`;
    return `${Math.round(ms/86_400_000)}d`;
  }

  static freshnessPercent(lastObservedMs, intervalMs) {
    if (!lastObservedMs || !intervalMs || intervalMs <= 0) return 100;
    return Math.min(Math.round(((Date.now() - lastObservedMs) / intervalMs) * 100), 100);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _load() {
    const defaults = {
      categories: {},
      globals: {
        answerFromCacheFirst:      true,
        alwaysVerifyBeforeAction:  false,
        staleWarningThresholdPct:  80,
      },
    };
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed, globals: { ...defaults.globals, ...(parsed.globals || {}) } };
      }
    } catch (err) {
      console.error('[StalenessConfig] Load failed, using defaults:', err.message);
    }
    return defaults;
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[StalenessConfig] Save failed:', err.message);
    }
  }
}

module.exports = { StalenessConfig, CATEGORIES, TYPE_TO_CATEGORY };
