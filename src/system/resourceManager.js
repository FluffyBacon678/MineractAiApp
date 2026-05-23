'use strict';

/**
 * ResourceManager — CPU/RAM monitoring, profiles, dynamic mode.
 */

const os           = require('os');
const EventEmitter = require('events');

const PROFILES = {
  lightweight: { label:'Lightweight', scanIntervalMs:60_000, talkativeIntervalMs:120_000, llmEnabled:false, backgroundScans:false, maxLlmConcurrent:0 },
  normal:      { label:'Normal',      scanIntervalMs:15_000, talkativeIntervalMs:45_000,  llmEnabled:true,  backgroundScans:false, maxLlmConcurrent:1 },
  heavy:       { label:'Heavy',       scanIntervalMs:8_000,  talkativeIntervalMs:25_000,  llmEnabled:true,  backgroundScans:true,  maxLlmConcurrent:2 },
};

class ResourceManager extends EventEmitter {
  constructor(limits = {}) {
    super();
    this.limits = {
      cpuPercent:  Math.max(5, Math.min(95, limits.cpuPercent ?? 25)),
      ramGb:       Math.max(0.5, limits.ramGb ?? 2),
      dynamicMode: limits.dynamicMode ?? true,
    };
    this._currentProfile  = 'normal';
    this._playerActive    = true;
    this._lastCpuTimes    = null;
    this._metrics         = { cpu:0, ram:0, ramPct:0, totalRam:8, profile:'normal' };

    this._monitorInterval = setInterval(() => this._sample(), 5_000);
    this._sample();
  }

  getProfile()     { return { ...PROFILES[this._currentProfile] }; }
  getProfileName() { return this._currentProfile; }
  getMetrics()     { return { ...this._metrics }; }
  getLimits()      { return { ...this.limits }; }
  isLlmEnabled()   { return this.getProfile().llmEnabled; }

  setLimits(newLimits) {
    if (!newLimits || typeof newLimits !== 'object') return;
    if (typeof newLimits.cpuPercent === 'number') {
      this.limits.cpuPercent = Math.max(5, Math.min(95, newLimits.cpuPercent));
    }
    if (typeof newLimits.ramGb === 'number') {
      this.limits.ramGb = Math.max(0.5, newLimits.ramGb);
    }
    if (typeof newLimits.dynamicMode === 'boolean') {
      this.limits.dynamicMode = newLimits.dynamicMode;
    }
    this.emit('limits:changed', this.limits);
  }

  setProfile(name) {
    if (!PROFILES[name]) { console.warn(`[ResourceManager] Unknown profile: "${name}"`); return; }
    this._currentProfile = name;
    this._metrics.profile = name;
    this.emit('profile:changed', { profile: name, settings: PROFILES[name] });
  }

  setPlayerActive(active) {
    const changed       = this._playerActive !== !!active;
    this._playerActive  = !!active;
    if (changed) this._applyDynamic();
  }

  destroy() {
    clearInterval(this._monitorInterval);
    this._monitorInterval = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _sample() {
    try {
      const cpu       = this._cpuUsage();
      const totalRam  = os.totalmem();
      const freeRam   = os.freemem();
      const usedGb    = (totalRam - freeRam) / 1_073_741_824;

      this._metrics = {
        cpu:      Math.round(cpu),
        ram:      Math.round(usedGb * 10) / 10,
        ramPct:   Math.round((usedGb / (totalRam / 1_073_741_824)) * 100),
        totalRam: Math.round(totalRam / 1_073_741_824),
        profile:  this._currentProfile,
      };

      this.emit('metrics', this._metrics);
      if (this.limits.dynamicMode) this._applyDynamic();

    } catch (err) {
      console.warn('[ResourceManager] Sample error:', err.message);
    }
  }

  _cpuUsage() {
    const cpus    = os.cpus();
    const current = cpus.map(c => ({ ...c.times }));

    if (!this._lastCpuTimes || this._lastCpuTimes.length !== cpus.length) {
      this._lastCpuTimes = current;
      return 0;
    }

    let idleDelta = 0, totalDelta = 0;
    for (let i = 0; i < cpus.length; i++) {
      const prev = this._lastCpuTimes[i];
      const cur  = current[i];
      for (const k of Object.keys(cur)) totalDelta += cur[k] - prev[k];
      idleDelta += cur.idle - prev.idle;
    }
    this._lastCpuTimes = current;
    return totalDelta === 0 ? 0 : 100 * (1 - idleDelta / totalDelta);
  }

  _applyDynamic() {
    const { cpu, ramPct, totalRam } = this._metrics;
    const cpuLimit = this.limits.cpuPercent;
    const ramLimit = (this.limits.ramGb / Math.max(totalRam, 1)) * 100;

    let proposed;
    if (this._playerActive) {
      proposed = (cpu < cpuLimit * 0.5 && ramPct < ramLimit * 0.6) ? 'normal' : 'lightweight';
    } else {
      proposed = (cpu < cpuLimit * 0.4 && ramPct < ramLimit * 0.5) ? 'heavy'
        : (cpu < cpuLimit * 0.7) ? 'normal' : 'lightweight';
    }

    if (proposed !== this._currentProfile) this.setProfile(proposed);
  }
}

module.exports = { ResourceManager, PROFILES };
