'use strict';

/**
 * WorkerManager — owns the currently running task worker.
 * Only one worker runs at a time; starting a new one cancels the previous.
 */

const EventEmitter  = require('events');
const log           = require('../logger');
const FarmWorker    = require('./farmWorker');
const PatrolWorker  = require('./patrolWorker');
const CollectWorker = require('./collectWorker');

class WorkerManager extends EventEmitter {
  constructor(bot, config, memory, perms) {
    super();
    this.bot    = bot;
    this.config = config;
    this.memory = memory;
    this.perms  = perms;

    this._active     = null; // currently running worker
    this._label      = null;
    this._activeType = null;
  }

  get isWorking()    { return this._active?.isRunning ?? false; }
  get currentLabel() { return this._label || null; }
  get currentTask()  {
    if (!this._active?.isRunning) return null;
    return { type: this._activeType, label: this._label };
  }

  /** Stop any running worker, then start a new one. */
  async start(workerType, options = {}) {
    await this.stop();

    let worker;
    switch (workerType) {
      case 'farm': {
        const loc = options.locationName
          ? this.memory.resolve(options.locationName)
          : this.memory.findByType('farm')[0] || null;
        worker = new FarmWorker(this.bot, this.config, this.memory, this.perms, loc);
        break;
      }
      case 'patrol': {
        const loc = options.locationName
          ? this.memory.resolve(options.locationName)
          : null;
        worker = new PatrolWorker(this.bot, this.config, this.memory, this.perms, loc);
        break;
      }
      case 'collect': {
        const loc = options.locationName
          ? this.memory.resolve(options.locationName)
          : null;
        worker = new CollectWorker(this.bot, this.config, this.memory, this.perms, loc);
        break;
      }
      default:
        log.warn('WorkerManager', `Unknown worker type: ${workerType}`);
        return false;
    }

    this._activeType = workerType;

    // Forward worker events
    worker.on('worker:start',    e => { this._label = e.label; this.emit('worker:start', e); });
    worker.on('worker:done',     e => { this._active = null; this._label = null; this._activeType = null; this.emit('worker:done', e); });
    worker.on('worker:error',    e => { this._active = null; this._label = null; this._activeType = null; this.emit('worker:error', e); });
    worker.on('worker:stop',     e => { this._active = null; this._label = null; this._activeType = null; this.emit('worker:stop', e); });
    worker.on('worker:progress', e => this.emit('worker:progress', e));
    worker.on('worker:threat',   e => this.emit('worker:threat', e));

    this._active = worker;
    worker.start().catch(err => {
      log.error('WorkerManager', `Unhandled worker error: ${err.message}`);
      this._active = null;
      this._label  = null;
    });

    return true;
  }

  async stop() {
    if (!this._active) return;
    this._active.stop();
    // Give it a moment to clean up
    await new Promise(r => setTimeout(r, 300));
    this._active = null;
    this._label  = null;
  }

  destroy() { this.stop().catch(() => {}); }
}

module.exports = WorkerManager;
