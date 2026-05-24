'use strict';

/**
 * FarmWorker — harvests ripe crops near a saved farm location and replants.
 *
 * Supported crops: wheat, carrots, potatoes, beetroot.
 * Respects permission check for 'harvest_crops' and 'plant_seeds'.
 * Reports counts to chat and memory.
 */

const log        = require('../logger');
const WorkerBase = require('./workerBase');

// Crop metadata: block name, ripe age, seed item, replant item
const CROPS = {
  wheat:    { ripAge: 7,  seed: 'wheat_seeds',    replant: 'wheat_seeds'    },
  carrots:  { ripAge: 7,  seed: 'carrot',          replant: 'carrot'         },
  potatoes: { ripAge: 7,  seed: 'potato',          replant: 'potato'         },
  beetroots:{ ripAge: 3,  seed: 'beetroot_seeds',  replant: 'beetroot_seeds' },
};

const HARVEST_RADIUS   = 20; // blocks around farm centre to scan
const PAUSE_BETWEEN_MS = 350; // ms between each block interaction (natural pace)

class FarmWorker extends WorkerBase {
  /**
   * @param {object}      bot
   * @param {object}      config
   * @param {object}      memory
   * @param {object}      perms
   * @param {object|null} farmLocation  - WorldMemory location object (or null = near bot)
   */
  constructor(bot, config, memory, perms, farmLocation = null) {
    super(bot, config, memory, perms);
    this.label        = farmLocation ? `Farming ${farmLocation.name}` : 'Farming nearby';
    this.farmLocation = farmLocation;
  }

  async run() {
    // Permission check
    const permH = this.checkPerm('harvest_crops', {
      coords: this.bot.entity?.position,
      areaId: this.farmLocation?.id,
    });
    if (!permH.allowed) {
      this.say(`I don't have permission to harvest. ${permH.reason}`);
      return;
    }

    this.say(this.farmLocation
      ? `Starting farm work at ${this.farmLocation.name}.`
      : 'Starting farm work nearby.'
    );

    const centre = this.farmLocation?.coordinates || this.bot.entity?.position;
    if (!centre) { this.say("I can't find the farm location."); return; }

    const harvested = {};
    const replanted = {};
    let totalHarvested = 0;
    let totalReplanted = 0;
    let failed = 0;

    // Navigate to farm area first if far away
    const dist = this.bot.entity.position.distanceTo(centre);
    if (dist > HARVEST_RADIUS) {
      this.say(`Heading to the farm…`);
      await this._navigateTo(centre);
      if (this._stopFlag) return;
    }

    // Find all ripe crop blocks within radius
    const ripeCrops = this._findRipeCrops(centre, HARVEST_RADIUS);

    if (ripeCrops.length === 0) {
      this.say("The crops aren't ready yet.");
      this._updateMemory({ state: 'not ready', harvested: 0, checkedAt: Date.now() });
      return;
    }

    this.say(`I see ${ripeCrops.length} ripe crop(s) to harvest.`);
    this.emit('worker:progress', { label: this.label, total: ripeCrops.length, done: 0 });

    for (let i = 0; i < ripeCrops.length; i++) {
      if (this._stopFlag) break;

      const block = ripeCrops[i];
      const cropName = block.name;
      const meta = CROPS[cropName];

      try {
        // Walk to the block
        await this._moveTo(block.position);
        if (this._stopFlag) break;

        this.lookAt(block.position);
        await this.wait(120);

        // Dig (harvest)
        await this.bot.dig(block);
        harvested[cropName] = (harvested[cropName] || 0) + 1;
        totalHarvested++;

        await this.wait(PAUSE_BETWEEN_MS);
        if (this._stopFlag) break;

        // Replant if we have seeds and permission
        const permP = this.checkPerm('plant_seeds', { coords: block.position });
        if (permP.allowed && meta?.seed) {
          const seeded = await this._tryReplant(block.position, meta.seed);
          if (seeded) {
            replanted[cropName] = (replanted[cropName] || 0) + 1;
            totalReplanted++;
          }
        }

        this.emit('worker:progress', { label: this.label, total: ripeCrops.length, done: i + 1 });

      } catch (err) {
        failed++;
        log.warn('FarmWorker', `Block error at ${block.position}: ${err.message}`);
        // Continue to next block rather than aborting
      }

      if (!await this.wait(PAUSE_BETWEEN_MS)) break;
    }

    // Summary
    const harvestStr = Object.entries(harvested).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
    const replantStr = totalReplanted > 0 ? ` Replanted ${totalReplanted}.` : '';
    const failStr    = failed > 0 ? ` (${failed} blocks skipped)` : '';

    this.say(`Done. Harvested: ${harvestStr}.${replantStr}${failStr}`);

    this.result = { harvested, replanted, totalHarvested, totalReplanted, failed };
    this._updateMemory({
      state: 'harvested',
      harvested: totalHarvested,
      replanted: totalReplanted,
      checkedAt: Date.now(),
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _findRipeCrops(centre, radius) {
    const ripe = [];
    try {
      for (const [cropName, meta] of Object.entries(CROPS)) {
        const positions = this.bot.findBlocks({
          matching:    b => b.name === cropName && (b.getProperties?.().age ?? 0) >= meta.ripAge,
          maxDistance: radius,
          count:       200,
        });
        for (const pos of positions) {
          const block = this.bot.blockAt(pos);
          if (block) ripe.push(block);
        }
      }
    } catch (err) {
      log.warn('FarmWorker', `findBlocks error: ${err.message}`);
    }
    return ripe;
  }

  async _navigateTo(pos) {
    try {
      const { GoalNear } = require('mineflayer-pathfinder').goals;
      const { Movements } = require('mineflayer-pathfinder');
      const mvmt = new Movements(this.bot);
      mvmt.allowSprinting = false;
      this.bot.pathfinder.setMovements(mvmt);
      this.bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 3));
      // Wait until close enough or stop
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (this._stopFlag) { clearInterval(check); resolve(); return; }
          const d = this.bot.entity.position.distanceTo(pos);
          if (d < 4) { clearInterval(check); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 20_000); // 20s timeout
      });
    } catch (err) {
      log.warn('FarmWorker', `Navigation error: ${err.message}`);
    }
  }

  async _moveTo(pos) {
    try {
      const { GoalNear } = require('mineflayer-pathfinder').goals;
      const { Movements } = require('mineflayer-pathfinder');
      const mvmt = new Movements(this.bot);
      this.bot.pathfinder.setMovements(mvmt);
      this.bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 2));
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (this._stopFlag) { clearInterval(check); resolve(); return; }
          const d = this.bot.entity.position.distanceTo(pos);
          if (d < 2.5) { clearInterval(check); resolve(); }
        }, 300);
        setTimeout(() => { clearInterval(check); resolve(); }, 8_000);
      });
    } catch {}
  }

  async _tryReplant(pos, seedItem) {
    try {
      const item = this.bot.inventory.items().find(i =>
        i.name === seedItem || i.name === seedItem.replace('_seeds','') + '_seeds'
      );
      if (!item) return false;

      await this.bot.equip(item, 'hand');
      const groundBlock = this.bot.blockAt(pos.offset(0, -1, 0));
      if (!groundBlock) return false;

      // Face vector must be a unit vector pointing to the face we're placing on.
      // We're placing on the TOP face of the farmland block → (0, 1, 0).
      const Vec3 = require('vec3');
      await this.bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
      return true;
    } catch {
      return false; // placeBlock can throw if position is occupied/wrong — just skip
    }
  }

  _updateMemory(state) {
    if (!this.farmLocation || !this.memory) return;
    try { this.memory.cacheState(this.farmLocation.id, state); } catch {}
  }
}

module.exports = FarmWorker;
