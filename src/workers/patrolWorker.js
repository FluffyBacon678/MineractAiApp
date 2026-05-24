'use strict';

/**
 * PatrolWorker — patrols a named area, reports threats, optionally engages hostiles.
 *
 * Patrol behaviour:
 *   - Walks between randomly chosen waypoints within the area radius
 *   - Scans for hostile mobs at each waypoint
 *   - Reports threats in chat
 *   - If 'attack_hostile' permission granted: engages nearby hostiles
 *   - Runs until stop() is called
 */

const WorkerBase = require('./workerBase');

const HOSTILE_MOBS = new Set([
  'creeper','zombie','skeleton','spider','cave_spider','enderman',
  'witch','pillager','vindicator','phantom','drowned','husk','stray',
  'blaze','ghast','warden','ravager','evoker',
]);

const SCAN_RADIUS    = 16;  // threat detection range (blocks)
const WAYPOINT_COUNT = 6;   // random waypoints to generate per patrol area
const PAUSE_AT_MS    = 4000; // pause at each waypoint before moving on
const ENGAGE_RANGE   = 5;   // attack if hostile within this many blocks

class PatrolWorker extends WorkerBase {
  /**
   * @param {object}      bot
   * @param {object}      config
   * @param {object}      memory
   * @param {object}      perms
   * @param {object|null} areaLocation  - WorldMemory location to patrol (null = near bot)
   */
  constructor(bot, config, memory, perms, areaLocation = null) {
    super(bot, config, memory, perms);
    this.label        = areaLocation ? `Patrolling ${areaLocation.name}` : 'Patrolling';
    this.areaLocation = areaLocation;
    this._reportedMobs = new Set(); // avoid spamming same mob
    this._cycleCount   = 0;
  }

  async run() {
    const centre = this.areaLocation?.coordinates || this.bot.entity?.position;
    if (!centre) { this.say("I don't know where to patrol."); return; }

    const radius = this.areaLocation?.radius || 16;
    const waypoints = this._generateWaypoints(centre, radius, WAYPOINT_COUNT);

    this.say(this.areaLocation
      ? `Starting patrol of ${this.areaLocation.name}.`
      : 'Patrolling the area.'
    );

    let wpIndex = 0;

    while (!this._stopFlag) {
      const wp = waypoints[wpIndex % waypoints.length];
      wpIndex++;

      // Move to waypoint
      await this._moveTo(wp);
      if (this._stopFlag) break;

      // Scan for threats at this position
      const threats = this._scanThreats();

      if (threats.length > 0) {
        await this._handleThreats(threats);
        if (this._stopFlag) break;
      } else {
        // Clear stale reports when area is safe
        this._reportedMobs.clear();
      }

      // Pause at waypoint — look around naturally
      try {
        const lookYaw = (Math.random() - 0.5) * Math.PI * 2;
        await this.bot.look(lookYaw, 0, false);
      } catch {}

      if (!await this.wait(PAUSE_AT_MS)) break;

      // Periodically report "all clear"
      if (++this._cycleCount % (WAYPOINT_COUNT * 3) === 0) {
        this.say('All clear.');
        this._reportedMobs.clear();
      }
    }

    this.say(this.areaLocation
      ? `Patrol of ${this.areaLocation.name} ended.`
      : 'Patrol ended.'
    );
    this.result = { cyclesCompleted: this._cycleCount };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _generateWaypoints(centre, radius, count) {
    const pts = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const r     = radius * (0.4 + Math.random() * 0.6);
      pts.push({
        x: Math.floor(centre.x + Math.cos(angle) * r),
        y: centre.y,
        z: Math.floor(centre.z + Math.sin(angle) * r),
      });
    }
    return pts;
  }

  _scanThreats() {
    const pos = this.bot.entity?.position;
    if (!pos) return [];
    return Object.values(this.bot.entities || {}).filter(e =>
      HOSTILE_MOBS.has(e.name) &&
      e.position?.distanceTo(pos) < SCAN_RADIUS
    );
  }

  async _handleThreats(threats) {
    const nearest = threats.sort((a, b) =>
      a.position.distanceTo(this.bot.entity.position) -
      b.position.distanceTo(this.bot.entity.position)
    )[0];

    const key = `${nearest.name}-${Math.floor(nearest.position.x)}-${Math.floor(nearest.position.z)}`;
    if (!this._reportedMobs.has(key)) {
      this._reportedMobs.add(key);
      this.say(`Threat: ${threats.length} ${threats.length === 1 ? nearest.name : 'hostile mob(s)'} spotted.`);
      this.emit('worker:threat', { mob: nearest.name, count: threats.length, pos: nearest.position });
      // Record in memory if inside a known area
      if (this.areaLocation) {
        this.memory?.logAction?.({
          type:       'threat_detected',
          locationId: this.areaLocation.id,
          mob:        nearest.name,
          count:      threats.length,
        });
      }
    }

    // Engage if permitted and close enough
    const permA = this.checkPerm('attack_hostile', { coords: this.bot.entity?.position });
    if (permA.allowed) {
      const dist = nearest.position.distanceTo(this.bot.entity.position);
      if (dist < ENGAGE_RANGE) {
        await this._engage(nearest);
      } else {
        // Just look at the threat
        try { await this.bot.lookAt(nearest.position); } catch {}
      }
    }
  }

  async _engage(entity) {
    try {
      this.bot.pvp?.attack(entity);  // uses mineflayer-pvp if available
      await this.wait(2000);
    } catch {
      // pvp plugin not loaded — just look at entity
      try { await this.bot.lookAt(entity.position); } catch {}
    }
  }

  async _moveTo(pos) {
    try {
      const { GoalNear } = require('mineflayer-pathfinder').goals;
      const { Movements } = require('mineflayer-pathfinder');
      const mvmt = new Movements(this.bot);
      mvmt.allowSprinting = false;
      this.bot.pathfinder.setMovements(mvmt);
      this.bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 2));
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (this._stopFlag) { clearInterval(check); resolve(); return; }
          try {
            const d = this.bot.entity.position.distanceTo(pos);
            if (d < 3) { clearInterval(check); resolve(); }
          } catch { clearInterval(check); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 15_000);
      });
    } catch (err) {
      console.warn('[PatrolWorker] Move error:', err.message);
    }
  }
}

module.exports = PatrolWorker;
