'use strict';

/**
 * CollectWorker — collects dropped item entities near a location.
 * Used after farming, or triggered by "collect dropped items" command.
 */

const WorkerBase = require('./workerBase');

const COLLECT_RADIUS = 24;
const MOVE_PAUSE_MS  = 250;

class CollectWorker extends WorkerBase {
  constructor(bot, config, memory, perms, nearLocation = null) {
    super(bot, config, memory, perms);
    this.label    = 'Collecting drops';
    this.location = nearLocation;
  }

  async run() {
    const perm = this.checkPerm('collect_drops', { coords: this.bot.entity?.position });
    if (!perm.allowed) {
      this.say(`I don't have permission to collect items. ${perm.reason}`);
      return;
    }

    const centre = this.location?.coordinates || this.bot.entity?.position;
    if (!centre) { this.say("Not sure where to collect from."); return; }

    let collected = 0;

    const findDrop = () => Object.values(this.bot.entities || {}).find(e =>
      e.type === 'object' && e.objectType === 'Item' &&
      e.position.distanceTo(centre) < COLLECT_RADIUS
    );

    const startTime = Date.now();
    const timeout   = 30_000; // max 30 s collection run

    let drop = findDrop();
    if (!drop) { this.say("Nothing to collect nearby."); return; }

    this.say("Collecting nearby drops.");

    while (!this._stopFlag && Date.now() - startTime < timeout) {
      drop = findDrop();
      if (!drop) break;

      try {
        const { GoalFollow } = require('mineflayer-pathfinder').goals;
        const { Movements }  = require('mineflayer-pathfinder');
        const mvmt = new Movements(this.bot);
        this.bot.pathfinder.setMovements(mvmt);
        this.bot.pathfinder.setGoal(new GoalFollow(drop, 0), true);
      } catch {}

      // Wait until item is collected (disappears) or we time out per-item
      const itemTimeout = Date.now() + 5000;
      while (!this._stopFlag && Date.now() < itemTimeout) {
        if (!this.bot.entities[drop.id]) { collected++; break; }
        await this.wait(MOVE_PAUSE_MS);
      }
    }

    try { this.bot.pathfinder?.stop(); } catch {}

    if (collected > 0) {
      this.say(`Collected ${collected} item stack${collected === 1 ? '' : 's'}.`);
    } else {
      this.say("Couldn't reach the items.");
    }

    this.result = { collected };
  }
}

module.exports = CollectWorker;
