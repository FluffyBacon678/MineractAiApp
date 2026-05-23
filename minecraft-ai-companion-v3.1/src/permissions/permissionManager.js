'use strict';

/**
 * PermissionManager — safety layer between AI decisions and world actions.
 * The bot is READ-ONLY by default. Every world-modifying action must pass here.
 */

const EventEmitter = require('events');

const TRUST = { OBSERVER:0, COMPANION:1, WORKER:2, AUTONOMOUS:3 };

const ACTION_GROUPS = {
  movement:    ['follow','wait','loiter','pathfind'],
  observation: ['scan_area','read_chat','inspect_block','check_inventory'],
  harvest:     ['harvest_crops','replant_crops','collect_drops'],
  storage:     ['open_chest','take_items','deposit_items','sort_storage'],
  farming:     ['till_soil','plant_seeds','use_water','use_bonemeal'],
  building:    ['place_blocks','break_blocks','terraform'],
  combat:      ['attack_hostile','attack_passive','use_weapons'],
  mechanisms:  ['use_redstone','use_furnace','use_crafting','use_anvil'],
  dangerous:   ['use_lava','use_fire','use_tnt','mass_destruction'],
};

// Never allowed regardless of trust level or explicit grants
const HARD_FORBIDDEN = new Set(['use_lava','use_fire','use_tnt','mass_destruction','attack_passive']);

const GROUP_MIN_TRUST = {
  movement:    TRUST.COMPANION,
  observation: TRUST.COMPANION,
  harvest:     TRUST.WORKER,
  storage:     TRUST.WORKER,
  farming:     TRUST.WORKER,
  building:    TRUST.AUTONOMOUS,
  combat:      TRUST.WORKER,
  mechanisms:  TRUST.WORKER,
  dangerous:   Infinity,
};

class PermissionManager extends EventEmitter {
  constructor(memory) {
    super();
    this.memory     = memory;
    this.trustLevel = TRUST.COMPANION;
    this._granted   = new Map();   // action → { areaId, expiresAt }
    this._revoked   = new Set();
    this._pending   = new Map();   // action → { resolve, timeout }
  }

  // ── Check ─────────────────────────────────────────────────────────────────

  check(action, context = {}) {
    if (!action || typeof action !== 'string') {
      return { allowed: false, reason: 'Invalid action name.' };
    }
    if (HARD_FORBIDDEN.has(action)) {
      return { allowed: false, reason: `"${action}" is permanently forbidden.` };
    }
    if (this._revoked.has(action)) {
      return { allowed: false, reason: `"${action}" has been revoked.` };
    }

    // Check explicit grants (may be expired)
    const grant = this._granted.get(action);
    if (grant) {
      if (grant.expiresAt && Date.now() > grant.expiresAt) {
        this._granted.delete(action);
      } else {
        if (grant.areaId && context.coords && this.memory) {
          const area = this.memory.findById(grant.areaId);
          if (area) {
            const loc  = area.coordinates;
            const pos  = context.coords;
            const dist = Math.sqrt((pos.x-loc.x)**2 + (pos.y-loc.y)**2 + (pos.z-loc.z)**2);
            if (dist > area.radius) {
              return { allowed: false, reason: `"${action}" only allowed inside ${area.name}.` };
            }
          }
        }
        return { allowed: true, reason: 'explicitly granted' };
      }
    }

    const group    = this._groupOf(action);
    const minTrust = GROUP_MIN_TRUST[group] ?? Infinity;
    if (this.trustLevel < minTrust) {
      return { allowed: false, reason: `Trust level "${this._trustName()}" cannot perform "${action}".` };
    }

    return { allowed: true, reason: 'trust level' };
  }

  requestApproval(bot, action, description) {
    if (!bot || !action) return Promise.resolve(false);
    return new Promise(resolve => {
      try { bot.chat(`May I ${description}? (yes/no)`); }
      catch (err) { console.warn('[PermissionManager] chat failed:', err.message); resolve(false); return; }

      const timeout = setTimeout(() => {
        this._pending.delete(action);
        console.log(`[PermissionManager] Approval for "${action}" timed out`);
        resolve(false);
      }, 30_000);

      this._pending.set(action, { resolve, timeout });
      this.emit('approval:requested', { action, description });
    });
  }

  resolveApproval(message) {
    if (!message || this._pending.size === 0) return false;
    const lower  = message.toLowerCase().trim();
    const isYes  = /^(yes|y|ok|sure|go ahead|do it)/.test(lower);
    const isNo   = /^(no|n|stop|don.t|cancel|nope)/.test(lower);
    if (!isYes && !isNo) return false;

    const [key, pending] = [...this._pending.entries()].at(-1) || [];
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this._pending.delete(key);
    pending.resolve(isYes);
    this.emit('approval:resolved', { action: key, granted: isYes });
    return true;
  }

  // ── Grant / revoke ────────────────────────────────────────────────────────

  grant(action, options = {}) {
    if (!action) return;
    if (HARD_FORBIDDEN.has(action)) {
      console.warn(`[PermissionManager] Cannot grant hard-forbidden action: "${action}"`);
      return;
    }
    let areaId = null;
    if (options.areaName && this.memory) {
      const area = this.memory.resolve(options.areaName);
      if (area) areaId = area.id;
    }
    this._granted.set(action, {
      areaId,
      expiresAt: options.durationMs ? Date.now() + options.durationMs : null,
    });
    this._revoked.delete(action);
    this.emit('permission:granted', { action, options });
  }

  revoke(action) {
    if (!action) return;
    this._granted.delete(action);
    this._revoked.add(action);
    this.emit('permission:revoked', { action });
  }

  setTrustLevel(level) {
    const val = typeof level === 'string'
      ? TRUST[level.toUpperCase()]
      : level;
    if (val === undefined || !Number.isFinite(val)) {
      console.warn(`[PermissionManager] Invalid trust level: "${level}"`);
      return;
    }
    this.trustLevel = val;
    this.emit('trust:changed', { level: this._trustName() });
  }

  setReadOnly() {
    this.trustLevel = TRUST.OBSERVER;
    this._granted.clear();
    this.emit('trust:changed', { level: 'OBSERVER' });
  }

  getState() {
    // Clean up expired grants before reporting
    for (const [action, grant] of this._granted) {
      if (grant.expiresAt && Date.now() > grant.expiresAt) this._granted.delete(action);
    }
    return {
      trustLevel:   this._trustName(),
      granted:      [...this._granted.entries()].map(([a, v]) => ({ action: a, ...v })),
      revoked:      [...this._revoked],
      pendingCount: this._pending.size,
    };
  }

  parseChat(message) {
    if (!message) return { handled: false };
    const m = message.toLowerCase();

    if (this._pending.size > 0 && this.resolveApproval(message)) return { handled: true };

    if (/read.?only|observer mode/.test(m)) {
      this.setReadOnly();
      return { handled: true, reply: "I'll stay in observer mode — no world interaction." };
    }
    if (/worker mode/.test(m)) {
      this.setTrustLevel('WORKER');
      return { handled: true, reply: 'Switching to worker mode.' };
    }
    if (/autonomous mode/.test(m)) {
      this.setTrustLevel('AUTONOMOUS');
      return { handled: true, reply: 'Autonomous mode enabled.' };
    }

    const grantMatch = m.match(/you (can|may|are allowed to) (.+?)(\.|$)/);
    if (grantMatch) {
      const action = this._inferAction(grantMatch[2]);
      if (action) {
        this.grant(action);
        return { handled: true, reply: `Understood. I'm allowed to ${grantMatch[2].trim()}.` };
      }
    }

    const revokeMatch = m.match(/(do not|never|stop|no longer|don.t) (.+?)(\.|$)/);
    if (revokeMatch) {
      const action = this._inferAction(revokeMatch[2]);
      if (action) {
        this.revoke(action);
        return { handled: true, reply: `Understood. I won't ${revokeMatch[2].trim()}.` };
      }
    }

    return { handled: false };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _groupOf(action) {
    for (const [group, actions] of Object.entries(ACTION_GROUPS)) {
      if (actions.includes(action)) return group;
    }
    return 'observation';
  }

  _trustName() {
    return Object.keys(TRUST).find(k => TRUST[k] === this.trustLevel) || 'UNKNOWN';
  }

  _inferAction(text) {
    const t = text.toLowerCase();
    if (/harvest|crop|replant/.test(t))  return 'harvest_crops';
    if (/chest|storage|item/.test(t))    return 'open_chest';
    if (/build|place|break block/.test(t)) return 'place_blocks';
    if (/redstone|lever|button/.test(t)) return 'use_redstone';
    if (/furnace/.test(t))               return 'use_furnace';
    if (/attack|fight|mob/.test(t))      return 'attack_hostile';
    if (/plant|seed/.test(t))            return 'plant_seeds';
    if (/farm/.test(t))                  return 'harvest_crops';
    return null;
  }
}

module.exports = { PermissionManager, TRUST, ACTION_GROUPS };
