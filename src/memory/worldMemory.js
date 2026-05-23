'use strict';

/**
 * WorldMemory — persistent spatial memory.
 * All staleness intervals come from StalenessConfig at runtime.
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { StalenessConfig } = require('./stalenessConfig');

const { resolveDataFile } = require('../paths');
const DATA_FILE = resolveDataFile('world-memory.json');

const TYPE_META = {
  house:       { defaultOwner:'player'  },
  ai_home:     { defaultOwner:'ai'      },
  farm:        { defaultOwner:'player'  },
  storage:     { defaultOwner:'player'  },
  village:     { defaultOwner:'neutral' },
  danger:      { defaultOwner:'neutral' },
  building:    { defaultOwner:'player'  },
  animal_pen:  { defaultOwner:'player'  },
  waypoint:    { defaultOwner:'neutral' },
  poi:         { defaultOwner:'neutral' },
  // Spatial awareness
  bed:         { defaultOwner:'player'  },
  workstation: { defaultOwner:'player'  },
};

class WorldMemory extends EventEmitter {
  constructor(stalenessConfig, emitter = null) {
    super();
    if (!(stalenessConfig instanceof StalenessConfig)) {
      throw new TypeError('[WorldMemory] stalenessConfig must be a StalenessConfig instance');
    }
    this._staleness  = stalenessConfig;
    this._uiEmitter  = emitter; // optional extra emitter (BotManager)
    this._dirty      = false;
    this._profile    = 'normal';
    this.data        = this._load();
    this._autoSave   = setInterval(() => { if (this._dirty) this._persist(); }, 30_000);
  }

  setProfile(profile) {
    if (!['lightweight','normal','heavy'].includes(profile)) return;
    this._profile = profile;
  }

  destroy() {
    clearInterval(this._autoSave);
    this._persist();
  }

  // ── Create / update ───────────────────────────────────────────────────────

  save({ name, type = 'poi', coordinates, owner, radius = 12,
         dimension = 'overworld', notes = [], tags = [],
         confidence = 0.85, biome = null, emotional = null } = {}) {

    if (!name || typeof name !== 'string') throw new Error('[WorldMemory] save() requires a name');
    if (!coordinates || typeof coordinates.x !== 'number') {
      throw new Error('[WorldMemory] save() requires numeric coordinates {x,y,z}');
    }

    const now      = Date.now();
    const typeMeta = TYPE_META[type] || TYPE_META.poi;
    const existing = this.findByName(name);

    if (existing) {
      Object.assign(existing, { coordinates, radius, dimension, biome,
        confidence: Math.max(0, Math.min(1, confidence)),
        notes: Array.isArray(notes) ? [...notes] : [],
        tags:  Array.isArray(tags)  ? [...tags]  : [],
        lastObserved: now,
        ...(emotional != null && { emotional }),
      });
      this._markDirty('memory_updated', existing);
      return existing;
    }

    const location = {
      id:           uuidv4(),
      name:         name.trim(),
      type,
      owner:        owner || typeMeta.defaultOwner,
      coordinates:  { x: coordinates.x, y: coordinates.y ?? 64, z: coordinates.z },
      dimension,
      radius:       Math.max(1, radius),
      biome,
      confidence:   Math.max(0, Math.min(1, confidence)),
      createdAt:    now,
      lastVisited:  null,
      lastObserved: now,
      notes:        Array.isArray(notes) ? [...notes] : [],
      tags:         Array.isArray(tags)  ? [...tags]  : [],
      emotional,
      cachedState:  {},
      events:       [],
    };

    this.data.locations[location.id] = location;
    this._markDirty('memory_created', location);
    return location;
  }

  update(ref, patch) {
    const loc = this._resolve(ref);
    if (!loc) { console.warn('[WorldMemory] update(): ref not found:', ref); return null; }
    Object.assign(loc, patch, { lastObserved: Date.now() });
    this._markDirty('memory_updated', loc);
    return loc;
  }

  forget(ref) {
    const loc = this._resolve(ref);
    if (!loc) { console.warn('[WorldMemory] forget(): ref not found:', ref); return false; }
    delete this.data.locations[loc.id];
    this._markDirty('memory_deleted', { name: loc.name });
    return true;
  }

  cacheState(ref, stateData) {
    const loc = this._resolve(ref);
    if (!loc) return null;
    loc.cachedState  = { ...(loc.cachedState || {}), ...stateData, _at: Date.now() };
    loc.lastObserved = Date.now();
    this._dirty = true;
    return loc;
  }

  markVisited(ref) {
    const loc = this._resolve(ref);
    if (!loc) return;
    loc.lastVisited = Date.now();
    this._dirty = true;
  }

  invalidate(ref) {
    const loc = this._resolve(ref);
    if (!loc) return false;
    loc.lastObserved = 0;
    this._dirty = true;
    return true;
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  findByName(name) {
    if (!name) return null;
    const n = name.toLowerCase();
    return Object.values(this.data.locations).find(l => l.name.toLowerCase() === n) || null;
  }

  findById(id) {
    if (!id) return null;
    return this.data.locations[id] || null;
  }

  findByType(type) {
    return Object.values(this.data.locations).filter(l => l.type === type);
  }

  enclosing(coords) {
    if (!coords) return [];
    return Object.values(this.data.locations)
      .filter(l => l.coordinates && _dist(coords, l.coordinates) <= (l.radius || 12));
  }

  all()         { return Object.values(this.data.locations); }
  allEnriched() { return this.all().map(l => this._enrich(l)); }

  /**
   * Find the nearest known workstation of a specific subtype (block name tag).
   * @param {'crafting_table'|'furnace'|'blast_furnace'|'smoker'|'enchanting_table'|'anvil'} subtype
   * @param {{x,y,z}} pos — bot's current position
   */
  getNearestWorkstation(subtype, pos) {
    const matches = this.all().filter(l =>
      l.type === 'workstation' && Array.isArray(l.tags) && l.tags.includes(subtype)
    );
    if (!matches.length || !pos) return null;
    return matches.sort((a, b) => _dist(pos, a.coordinates) - _dist(pos, b.coordinates))[0] || null;
  }

  /** Nearest known bed or AI home. */
  getBed() {
    const beds = this.findByType('bed');
    if (beds.length) return beds[0];
    return this.findByType('ai_home')[0] || null;
  }

  resolve(text) {
    if (!text) return null;
    const t = text.toLowerCase().trim();

    const exact = this.findByName(t);
    if (exact) return exact;

    if (/\b(my|player).*(house|home|base)\b/.test(t)) return this.findByType('house')[0] || null;
    if (/\b(your|ai|companion).*(house|home)\b|^home$/.test(t)) return this.findByType('ai_home')[0] || null;
    if (/\bvillage\b/.test(t)) return this.findByType('village')[0] || null;
    if (/\bstorage\b/.test(t)) return this.findByType('storage')[0] || null;

    const farmMatch = t.match(/(\w+)\s+farm/);
    if (farmMatch) {
      const named = Object.values(this.data.locations).find(
        l => l.type === 'farm' && l.name.toLowerCase().includes(farmMatch[1])
      );
      if (named) return named;
    }
    if (/\bfarm\b/.test(t)) return this.findByType('farm')[0] || null;

    return Object.values(this.data.locations)
      .filter(l => l.name.toLowerCase().includes(t) || t.includes(l.name.toLowerCase()))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
  }

  // ── Staleness ─────────────────────────────────────────────────────────────

  isStale(ref) {
    const loc = this._resolve(ref);
    if (!loc) return true;
    if (!loc.lastObserved) return true;
    return (Date.now() - loc.lastObserved) > this._staleness.getIntervalMs(loc.type, this._profile);
  }

  freshnessPhrase(ref) {
    const loc = this._resolve(ref);
    if (!loc) return null;
    if (!loc.lastObserved) return 'I have no record of when I last checked.';
    const ago   = _staleSummary(loc.lastObserved);
    const stale = this.isStale(ref);
    if (!stale) return `Checked ${ago}.`;
    const label = StalenessConfig.formatInterval(this._staleness.getIntervalMs(loc.type, this._profile));
    return `Last checked ${ago} — may be outdated (updates every ${label}).`;
  }

  // ── Events / log ──────────────────────────────────────────────────────────

  logAction(entry) {
    if (!entry || typeof entry !== 'object') return;
    const record = { ...entry, at: Date.now() };
    this.data.actionLog.push(record);
    if (this.data.actionLog.length > 600) this.data.actionLog.shift();
    this._dirty = true;
    this._uiEmitter?.emit('log', record);
  }

  getLog(n = 100) {
    const count = Math.max(1, Math.min(600, n));
    return [...this.data.actionLog].reverse().slice(0, count);
  }

  stats() {
    const locs = this.all();
    return {
      total:  locs.length,
      stale:  locs.filter(l => this.isStale(l.id)).length,
      byType: locs.reduce((a, l) => { a[l.type] = (a[l.type] || 0) + 1; return a; }, {}),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _enrich(loc) {
    const intervalMs       = this._staleness.getIntervalMs(loc.type, this._profile);
    const freshnessPercent = StalenessConfig.freshnessPercent(loc.lastObserved, intervalMs);
    const warnPct          = this._staleness.getGlobals().staleWarningThresholdPct ?? 80;
    const stale            = freshnessPercent >= 100;
    const warning          = !stale && freshnessPercent >= warnPct;
    const category         = StalenessConfig.categoryForType(loc.type);
    const catCfg           = this._staleness.getCategory(category) || {};
    return {
      ...loc,
      category,
      intervalMs,
      intervalLabel:    StalenessConfig.formatInterval(intervalMs),
      freshnessPercent,
      isStale:          stale,
      isWarning:        warning,
      staleSummary:     _staleSummary(loc.lastObserved),
      freshnessBadge:   stale ? 'stale' : warning ? 'warn' : 'fresh',
      autoRefresh:      catCfg.autoRefresh  ?? true,
      alwaysVerify:     catCfg.alwaysVerify ?? false,
    };
  }

  _resolve(ref) {
    if (!ref) return null;
    if (typeof ref === 'object' && ref.id) return this.data.locations[ref.id] || null;
    if (typeof ref === 'string') return this.findById(ref) || this.findByName(ref) || null;
    return null;
  }

  _markDirty(type, payload) {
    this._dirty = true;
    this.emit('memory:changed', { type, payload });
    this._uiEmitter?.emit('memory', { type, payload });
  }

  _load() {
    const empty = { locations: {}, actionLog: [] };
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      if (fs.existsSync(DATA_FILE)) {
        const raw    = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.locations) parsed.locations = {};
        if (!parsed.actionLog) parsed.actionLog = [];
        return parsed;
      }
    } catch (err) {
      console.error('[WorldMemory] Load failed, starting fresh:', err.message);
    }
    return empty;
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
      this._dirty = false;
    } catch (err) {
      console.error('[WorldMemory] Save failed:', err.message);
    }
  }
}

function _dist(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x||0)-(b.x||0), dy = (a.y||0)-(b.y||0), dz = (a.z||0)-(b.z||0);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

function _staleSummary(ts) {
  if (!ts) return 'never';
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins <  1)  return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

module.exports = WorldMemory;
