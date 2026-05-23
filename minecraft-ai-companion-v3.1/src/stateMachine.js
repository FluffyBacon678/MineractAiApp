'use strict';

const STATES = {
  FOLLOWING: 'FOLLOWING',
  WAITING:   'WAITING',
  LOITERING: 'LOITERING',
  OBSERVING: 'OBSERVING',
  WORKING:   'WORKING',
};

class StateMachine {
  constructor(bot, config) {
    this.bot          = bot;
    this.config       = config;
    this.currentState = null;
    this.stateParams  = {};
    this.isTalkative  = true;

    this._loiterTimer = null;
    this._followTimer = null;
    this._idleTimer   = null;
  }

  setState(state, params = {}) {
    if (!STATES[state]) {
      console.warn(`[StateMachine] Unknown state "${state}" — ignoring`);
      return;
    }
    this._clearAll();
    const prev = this.currentState;
    this.currentState = state;
    this.stateParams  = params;
    console.log(`[StateMachine] ${prev || 'null'} → ${state}`);

    try {
      switch (state) {
        case STATES.FOLLOWING: this._startFollowing(params.targetUsername); break;
        case STATES.WAITING:   this._startWaiting();   break;
        case STATES.LOITERING: this._startLoitering(); break;
        case STATES.WORKING:   break; // WorkerManager takes over movement
        case STATES.OBSERVING: break; // Observer handles this passively
      }
    } catch (err) {
      console.error(`[StateMachine] Failed to enter ${state}:`, err.message);
    }
  }

  setTalkative(value) { this.isTalkative = !!value; }
  destroy()           { this._clearAll(); }

  // ── Private ───────────────────────────────────────────────────────────────

  _clearAll() {
    clearInterval(this._loiterTimer);
    clearInterval(this._followTimer);
    clearInterval(this._idleTimer);
    this._loiterTimer = this._followTimer = this._idleTimer = null;
    try { this.bot.pathfinder?.stop(); } catch {}
  }

  _startFollowing(targetUsername) {
    if (!targetUsername) { console.warn('[StateMachine] FOLLOWING: no target username'); return; }

    let GoalFollow, Movements;
    try {
      ({ Movements } = require('mineflayer-pathfinder'));
      ({ GoalFollow } = require('mineflayer-pathfinder').goals);
    } catch (err) {
      console.error('[StateMachine] pathfinder unavailable:', err.message); return;
    }

    const movements = new Movements(this.bot);
    movements.allowSprinting = false;
    this.bot.pathfinder.setMovements(movements);

    this._followTimer = setInterval(() => {
      if (this.currentState !== STATES.FOLLOWING) return;
      const player = this.bot.players[targetUsername];
      if (!player?.entity) return;
      try {
        const dist = this.bot.entity.position.distanceTo(player.entity.position);
        if (dist > this.config.companion.followDistance + 0.5) {
          this.bot.pathfinder.setGoal(new GoalFollow(player.entity, this.config.companion.followDistance), true);
        } else {
          this.bot.pathfinder.stop();
          this.bot.lookAt(player.entity.position.offset(0, 1.6, 0)).catch(() => {});
        }
      } catch (err) {
        console.warn('[StateMachine] Follow tick error:', err.message);
      }
    }, 800);
  }

  _startWaiting() {
    this._idleTimer = setInterval(() => {
      if (this.currentState !== STATES.WAITING) return;
      try {
        this.bot.look((Math.random() - 0.5) * Math.PI * 1.5, (Math.random() - 0.5) * 0.5, false).catch(() => {});
      } catch {}
    }, 7000 + Math.random() * 5000);
  }

  _startLoitering() {
    let GoalNear, Movements;
    try {
      ({ Movements } = require('mineflayer-pathfinder'));
      ({ GoalNear } = require('mineflayer-pathfinder').goals);
    } catch (err) {
      console.error('[StateMachine] pathfinder unavailable:', err.message); return;
    }

    const movements = new Movements(this.bot);
    movements.allowSprinting = false;
    this.bot.pathfinder.setMovements(movements);

    const basePos = this.bot.entity.position.clone();
    const r       = this.config.companion.loiterRadius;

    const wander = () => {
      if (this.currentState !== STATES.LOITERING) return;
      try {
        const x = basePos.x + (Math.random() - 0.5) * r * 2;
        const z = basePos.z + (Math.random() - 0.5) * r * 2;
        this.bot.pathfinder.setGoal(new GoalNear(x, basePos.y, z, 1.5), true);
      } catch (err) {
        console.warn('[StateMachine] Loiter wander error:', err.message);
      }
    };

    wander();
    this._loiterTimer = setInterval(wander, 9000 + Math.random() * 7000);
  }
}

module.exports = StateMachine;
