'use strict';

/**
 * WorkerBase — base class for all task workers (farm, patrol, collect…).
 *
 * Workers are the implementation of the WORKING behaviour state.
 * They run deterministic Minecraft actions — the LLM is never called
 * directly from a worker. Workers report progress via emit() so the
 * UI and in-game chat stay informed.
 *
 * Lifecycle:
 *   start() → runs the task → emits progress events → resolves when done
 *   stop()  → cancels gracefully mid-task
 */

const EventEmitter = require('events');

class WorkerBase extends EventEmitter {
  /**
   * @param {object} bot       - mineflayer bot instance
   * @param {object} config    - companion config
   * @param {object} memory    - WorldMemory instance
   * @param {object} perms     - PermissionManager instance
   */
  constructor(bot, config, memory, perms) {
    super();
    this.bot    = bot;
    this.config = config;
    this.memory = memory;
    this.perms  = perms;

    this._running  = false;
    this._stopFlag = false;
    this.label     = 'Working';     // shown in status bar
    this.result    = null;          // set on completion
  }

  get isRunning()  { return this._running; }

  /** Override in subclass. Must check this._stopFlag periodically. */
  async run() {
    throw new Error(`${this.constructor.name}.run() not implemented`);
  }

  /** Start the worker. Returns a Promise that resolves when done or stopped. */
  async start() {
    if (this._running) return;
    this._running  = true;
    this._stopFlag = false;

    this.emit('worker:start', { label: this.label });

    try {
      await this.run();
    } catch (err) {
      if (!this._stopFlag) {
        console.error(`[${this.constructor.name}] Error:`, err.message);
        this.emit('worker:error', { label: this.label, error: err.message });
      }
    } finally {
      this._running = false;
      this.emit('worker:done', { label: this.label, result: this.result });
    }
  }

  /** Request graceful stop. The worker finishes its current atomic action first. */
  stop() {
    this._stopFlag = true;
    this._running  = false;
    this.emit('worker:stop', { label: this.label });
  }

  // ── Helpers available to all workers ─────────────────────────────────────

  /** Check permission before any world-modifying action. */
  checkPerm(action, context = {}) {
    if (!this.perms) return { allowed: true, reason: 'no permission manager' };
    return this.perms.check(action, context);
  }

  /** Wait for ms, respecting stop flag. Returns true if still running. */
  async wait(ms) {
    if (this._stopFlag) return false;
    await new Promise(r => setTimeout(r, ms));
    return !this._stopFlag;
  }

  /** Look at a position (fire-and-forget, safe). */
  lookAt(pos) {
    try { this.bot.lookAt(pos); } catch {}
  }

  /** Safe bot.chat wrapper. */
  say(text) {
    if (!text) return;
    try { this.bot.chat(String(text).slice(0, 256)); } catch {}
  }
}

module.exports = WorkerBase;
