'use strict';

/**
 * PlanExecutor — parses a multi-step plan from a deep-tier LLM response
 * and executes the steps sequentially via the BotManager action handlers.
 *
 * Plan format detected (any of):
 *   "1. Go to the farm\n2. Harvest the crops\n3. Collect drops"
 *   "- Go to the farm\n- Harvest\n- Return home"
 *
 * Step → action mapping (keyword-based, no extra LLM call needed):
 *   harvest / farm / crop   → WORK_FARM
 *   patrol / guard          → WORK_PATROL
 *   collect / pick up       → WORK_COLLECT
 *   go to / head to / walk  → GO_TO <location>
 *   wait / stay             → WAIT
 *   follow                  → FOLLOW
 *   stop                    → WORK_STOP
 *   (unrecognised)          → say in chat and skip
 */

const EventEmitter = require('events');

// Regex that matches numbered or bulleted list lines
const STEP_LINE = /^(?:\d+[\.\)]\s*|[-*•]\s*)(.+)$/;

class PlanExecutor extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.autoExecute         = cfg.autoExecute         ?? false;
    this.requireConfirmation = cfg.requireConfirmation  ?? true;
    this.maxSteps            = cfg.maxSteps             ?? 5;

    this._steps      = [];
    this._current    = 0;
    this._running    = false;
    this._stopFlag   = false;
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** Returns true if the text looks like a multi-step plan. */
  static isPlan(text = '') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const stepLines = lines.filter(l => STEP_LINE.test(l));
    return stepLines.length >= 2;
  }

  /** Parse a plan text into an array of step strings. */
  static parseSteps(text = '') {
    return text
      .split('\n')
      .map(l => l.trim())
      .filter(l => STEP_LINE.test(l))
      .map(l => l.match(STEP_LINE)[1].trim())
      .slice(0, 10); // safety cap
  }

  updateConfig(cfg = {}) {
    if (typeof cfg.autoExecute         === 'boolean') this.autoExecute         = cfg.autoExecute;
    if (typeof cfg.requireConfirmation === 'boolean') this.requireConfirmation  = cfg.requireConfirmation;
    if (typeof cfg.maxSteps            === 'number')  this.maxSteps             = cfg.maxSteps;
  }

  /**
   * Start executing a plan. The executor emits events for each step;
   * the caller (BotManager) listens and triggers the actual actions.
   *
   * Events:
   *   plan:step   { index, total, description, action, locationHint }
   *   plan:done   { stepsCompleted }
   *   plan:stopped
   */
  async execute(steps, confirmFn = null) {
    if (this._running) this.stop();
    this._steps   = steps.slice(0, this.maxSteps);
    this._current = 0;
    this._running = true;
    this._stopFlag = false;

    const total = this._steps.length;

    for (let i = 0; i < total; i++) {
      if (this._stopFlag) { this.emit('plan:stopped'); return; }

      const description = this._steps[i];
      const { action, locationHint } = this._parseStep(description);

      // Optional per-step confirmation
      if (this.requireConfirmation && confirmFn) {
        const ok = await confirmFn(description, i + 1, total);
        if (!ok || this._stopFlag) { this.emit('plan:stopped'); return; }
      }

      this.emit('plan:step', { index: i + 1, total, description, action, locationHint });

      // Small pause between steps
      await new Promise(r => setTimeout(r, 800));
      this._current = i + 1;
    }

    this._running = false;
    this.emit('plan:done', { stepsCompleted: this._current });
  }

  stop() {
    this._stopFlag = true;
    this._running  = false;
  }

  get isRunning()     { return this._running; }
  get currentStep()   { return this._current; }
  get totalSteps()    { return this._steps.length; }

  // ── Private ────────────────────────────────────────────────────────────────

  _parseStep(text) {
    const t = text.toLowerCase();

    if (/\b(harvest|farm|crop|replant)\b/.test(t))       return { action: 'WORK_FARM',    locationHint: this._extractLocation(text) };
    if (/\b(patrol|guard|watch|defend)\b/.test(t))       return { action: 'WORK_PATROL',  locationHint: this._extractLocation(text) };
    if (/\b(collect|pick up|gather|loot)\b/.test(t))     return { action: 'WORK_COLLECT', locationHint: this._extractLocation(text) };
    if (/\b(go to|head to|walk to|travel|return|go back)\b/.test(t)) return { action: 'GO_TO', locationHint: this._extractLocation(text) };
    if (/\b(wait|stay|remain|hold)\b/.test(t))           return { action: 'WAIT',         locationHint: null };
    if (/\b(follow|come with|stay with)\b/.test(t))      return { action: 'FOLLOW',       locationHint: null };
    if (/\b(stop|cancel|finish|done)\b/.test(t))         return { action: 'WORK_STOP',    locationHint: null };

    return { action: 'CHAT', locationHint: null }; // say it in chat, don't execute
  }

  _extractLocation(text) {
    // "go to the farm" → "farm", "return to base" → "base"
    const m = text.match(/(?:to|at|near|around|the)\s+([a-z _'-]+?)(?:\s|$|,|\.)/i);
    return m ? m[1].trim() : null;
  }
}

module.exports = PlanExecutor;
