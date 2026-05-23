'use strict';

const mineflayer     = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const EventEmitter   = require('events');

const config                  = require('./config');
const StateMachine            = require('./stateMachine');
const Observer                = require('./observer');
const LLMRouter               = require('./ai/llmRouter');
const IntentParser            = require('./ai/intentParser');
const Dialogue                = require('./ai/dialogue');
const Monologue               = require('./ai/monologue');
const { CharacterProfile }    = require('./ai/characterProfile');
const { StalenessConfig }     = require('./memory/stalenessConfig');
const WorldMemory             = require('./memory/worldMemory');
const MemoryParser            = require('./memory/memoryParser');
const { PermissionManager }   = require('./permissions/permissionManager');
const { ResourceManager }     = require('./system/resourceManager');
const WorkerManager           = require('./workers/workerManager');

const delay = ms => new Promise(r => setTimeout(r, ms));

class BotManager extends EventEmitter {
  constructor(overrideConfig = {}) {
    super();
    try {
      this.cfg = config.merge
        ? config.merge(config, overrideConfig)
        : { ...config, ...overrideConfig };
    } catch {
      this.cfg = { ...config };
    }

    this.bot       = null;
    this.connected = false;
    this.status    = 'disconnected';
    this._reconnectTimer = null;
    this._greetedAt      = 0;

    // ── Persistent subsystems ─────────────────────────────────────────────
    this.character   = new CharacterProfile();
    this.staleness   = new StalenessConfig();
    this.memory      = new WorldMemory(this.staleness, this);
    this.permissions = new PermissionManager(this.memory);
    this.resources   = new ResourceManager(this.cfg.resources || {});

    // ── Shared LLM router — passed into all AI components ────────────────
    this.router = new LLMRouter(this.cfg);

    // Forward router stats to UI
    this.router.on('router:used',             e => this.emit('llm:used',         e));
    this.router.on('router:fallback',         e => this.emit('llm:fallback',      e));
    this.router.on('router:openai-auth-error',  () => this.emit('llm:openai-error', 'Invalid API key'));
    this.router.on('router:openai-rate-limited',() => this.emit('llm:openai-error', 'Rate limited'));
    this.router.on('router:claude-auth-error',  () => this.emit('llm:openai-error', 'Claude: Invalid API key'));

    // Internal monologue
    this.monologue = new Monologue(this.cfg, this.router);
    this.monologue.on('monologue:thought', ({ thought }) => this.emit('log', `[inner] ${thought}`));
    this.monologue.on('monologue:adjust',  ({ adjustment }) => this.emit('log', `[adjust] ${adjustment}`));

    // Cross-system wiring
    this.resources.on('profile:changed', ({ profile }) => {
      this.memory.setProfile(profile);
      this.observer?.applyProfile(profile);
      this.emit('profile', { profile });
    });
    this.resources.on('metrics',             m => this.emit('resources',    m));
    this.memory.on('memory:changed',         e => this.emit('memory',       e));
    this.permissions.on('trust:changed',     e => this.emit('permissions',  e));
    this.staleness.on('staleness:changed',   e => this.emit('staleness',    e));
    this.character.on('character:changed',   p => {
      if (p?.name) this.cfg.companion = { ...(this.cfg.companion || {}), name: p.name };
      this.emit('character', p);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connect() {
    if (this.connected) return;
    this._clearReconnect();
    this._setStatus('connecting');

    const username = this.cfg.bot?.username || this.character.getName() || 'Bud';

    try {
      this.bot = mineflayer.createBot({
        host:    this.cfg.bot?.host    || 'localhost',
        port:    this.cfg.bot?.port    || 25565,
        username,
        version: this.cfg.bot?.version || '1.21.1',
        auth:    'offline',
      });
    } catch (err) {
      this.emit('error', `createBot failed: ${err.message}`);
      this._setStatus('error');
      this._scheduleReconnect();
      return;
    }

    try { this.bot.loadPlugin(pathfinder); }
    catch (err) { console.error('[BotManager] pathfinder load failed:', err.message); }

    this.bot.once('spawn',  () => this._onSpawn());
    this.bot.on('chat',     (u, m) => this._onChat(u, m).catch(e => console.error('[BotManager] chat error:', e.message)));
    this.bot.on('error',    e  => { this.emit('error', e.message); });
    this.bot.on('end',      r  => this._onEnd(r));
    this.bot.on('kicked',   r  => { this.emit('log', `Kicked: ${r}`); this._onEnd(r); });
  }

  disconnect() {
    this._clearReconnect();
    this.monologue?.stop();
    this.workers?.destroy();
    this.observer?.stop();
    this.stateMachine?.destroy();
    if (this.bot) { try { this.bot.quit('Disconnecting'); } catch {} this.bot = null; }
    this._setStatus('disconnected');
    this.connected = false;
  }

  sendChat(message) {
    if (!message?.trim()) return;
    if (!this.connected || !this.bot) {
      this.emit('chat', { from: 'system', message: 'Not connected.' }); return;
    }
    try {
      this.bot.chat(message.slice(0, 256));
      this.emit('chat', { from: 'bot', message });
      this.memory.logAction({ type: 'chat_sent', message });
    } catch (err) {
      this.emit('chat', { from: 'system', message: `Send failed: ${err.message}` });
    }
  }

  addMemory(locationData) {
    try {
      const loc = this.memory.save(locationData);
      this.emit('memory', { type: 'memory_created', payload: loc });
      return { ok: true, location: loc };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async refreshLocation(locationId) {
    const loc = this.memory.findById(locationId);
    if (!loc) return { ok: false, reason: 'Location not found' };

    if (!this.connected || !this.bot?.entity) {
      this.memory.invalidate(locationId);
      return { ok: true, reason: 'Marked stale (offline)' };
    }

    try {
      const d = this.bot.entity.position.distanceTo(loc.coordinates || {x:0,y:0,z:0});
      if (d < 32 && this.observer) {
        const desc = await this.observer.describeEnvironment();
        this.memory.cacheState(locationId, { lastObservation: desc });
        this.memory.logAction({ type: 'manual_refresh', locationId, desc });
        return { ok: true, reason: 'Scanned live', desc };
      }
      this.memory.invalidate(locationId);
      return { ok: true, reason: `Marked stale (${Math.round(d)}m away)` };
    } catch (err) {
      this.memory.invalidate(locationId);
      return { ok: false, reason: err.message };
    }
  }

  /** Update LLM config at runtime (from UI settings save). */
  updateLLMConfig(patch) {
    if (!patch) return;
    if (patch.ollama)    Object.assign(this.cfg.ollama,    patch.ollama);
    if (patch.openai)    Object.assign(this.cfg.openai,    patch.openai);
    if (patch.claude)    Object.assign(this.cfg.claude,    patch.claude);
    if (patch.hybrid)    Object.assign(this.cfg.hybrid,    patch.hybrid);
    if (patch.routing) {
      this.cfg.routing = this.cfg.routing || {};
      if (patch.routing.taskMap)      Object.assign(this.cfg.routing.taskMap || {}, patch.routing.taskMap);
      if (patch.routing.fallbackOrder) this.cfg.routing.fallbackOrder = patch.routing.fallbackOrder;
    }
    if (patch.monologue) {
      Object.assign(this.cfg.monologue, patch.monologue);
      this.monologue?.updateConfig(this.cfg);
    }
    this.cfg.openai.enabled = !!(this.cfg.openai?.apiKey);
    this.cfg.claude.enabled = !!(this.cfg.claude?.apiKey);
    this.router.updateConfig(this.cfg);
    this.emit('llm:config-updated', {
      openAiEnabled: this.cfg.openai.enabled,
      claudeEnabled: this.cfg.claude.enabled,
      strategy:      this.cfg.hybrid.strategy,
    });
  }

  getLLMStats() {
    return {
      ...this.router.getStats(),
      openAiCallsThisHour: this.router.openAiCallsThisHour(),
      openAiAvailable:     this.router.openAiAvailable(),
      ollamaAvailable:     this.router.ollamaAvailable(),
      claudeAvailable:     this.router.claudeAvailable(),
      hourlyLimit:         this.cfg.hybrid?.openAiHourlyLimit ?? 30,
    };
  }

  destroy() {
    this.disconnect();
    this.memory.destroy();
    this.resources.destroy();
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────

  _onSpawn() {
    this.connected = true;
    this._setStatus('idle');

    // All AI components share the same router instance
    this.intentParser = new IntentParser(this.cfg, this.router);
    this.memoryParser = new MemoryParser(this.cfg, this.router);
    this.dialogue     = new Dialogue(this.cfg, this.character, this.router);
    this.observer     = new Observer(this.bot, this.cfg);
    this.stateMachine = new StateMachine(this.bot, this.cfg);
    this.workers      = new WorkerManager(this.bot, this.cfg, this.memory, this.permissions);

    // Forward worker events to UI
    this.workers.on('worker:start',    e => { this._setStatus(e.label); this.emit('worker:start', e); });
    this.workers.on('worker:done',     e => { this._setStatus('idle');  this.emit('worker:done', e); this.stateMachine.setState('WAITING'); });
    this.workers.on('worker:error',    e => { this._setStatus('idle');  this.emit('worker:error', e); this.stateMachine.setState('WAITING'); });
    this.workers.on('worker:progress', e => this.emit('worker:progress', e));
    this.workers.on('worker:threat',   e => this.emit('worker:threat', e));

    this.stateMachine.setState(this.character.get().defaultBehaviorMode || 'WAITING');
    this.observer.start(this.stateMachine);
    this._stateChangedAt = Date.now();
    this.monologue.start(() => ({
      state:        this.stateMachine?.state || 'UNKNOWN',
      task:         this.workers?.currentTask?.type || null,
      stateTimeSec: Math.round((Date.now() - (this._stateChangedAt || Date.now())) / 1000),
      recentEvent:  this._lastMonologueEvent || null,
    }));

    this.emit('log', `Connected as ${this.bot.username}`);

    // First greeting with slight delay — use OpenAI if available (important moment)
    setTimeout(async () => {
      if (!this.connected || !this.bot) return;
      const name = this.character.getName();
      const greeting = await this.dialogue.generate(
        `You just joined the player's Minecraft world for the first time today. Give a short, natural greeting as ${name}.`,
        { state: 'joining', isImportant: true, isDirectAddress: false }
      ).catch(() => null);
      this._safeChat(greeting || `*${name} has arrived*`);
      this._greetedAt = Date.now();
    }, 2500);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  async _onChat(username, message) {
    if (!username || !message) return;
    if (username === this.bot?.username) return;

    this.emit('chat', { from: username, message });

    if (this.permissions.resolveApproval(message)) return;

    const permResult = this.permissions.parseChat(message);
    if (permResult.handled) {
      if (permResult.reply) { await delay(800); this._safeChat(permResult.reply); }
      this.memory.logAction({ type: 'permission_cmd', message });
      return;
    }

    // Detect message characteristics for quality routing
    const isDirectAddress = this._isAddressed(message, username);
    const isQuestion      = message.trim().endsWith('?');

    // Parallel classification
    const [intentResult, memIntentResult] = await Promise.allSettled([
      this.intentParser.parse(message, username, this.stateMachine?.currentState),
      this.memoryParser.parse(message, username),
    ]);

    if (memIntentResult.status === 'fulfilled' && memIntentResult.value) {
      await this._handleMemoryIntent(memIntentResult.value, username).catch(e => console.error('[BotManager] mem intent:', e.message));
    }

    if (intentResult.status === 'fulfilled' && intentResult.value) {
      await this._handleIntent(intentResult.value, username, message, { isDirectAddress, isQuestion }).catch(e => console.error('[BotManager] intent:', e.message));
    }
  }

  // ── Memory intent ─────────────────────────────────────────────────────────

  async _handleMemoryIntent(mi, username) {
    const pos = this.bot?.entity?.position;
    const rd  = this.cfg.companion?.responseDelayMs || 1500;

    switch (mi.action) {
      case 'save': {
        if (!mi.useCurrentPosition || !pos) break;
        let loc;
        try {
          loc = this.memory.save({
            name:        mi.name, type: mi.type || 'poi',
            owner:       mi.owner || 'player',
            coordinates: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            notes:       mi.notes ? [mi.notes] : [],
          });
        } catch (err) { console.error('[BotManager] memory.save:', err.message); break; }
        await delay(rd);
        this._safeChat(`I'll remember this as ${loc.name}.`);
        this.memory.logAction({ type: 'memory_saved', name: loc.name, by: username });
        break;
      }
      case 'forget': {
        const ok = mi.name && this.memory.forget(mi.name);
        await delay(rd);
        this._safeChat(ok ? `Forgotten: ${mi.name}.` : `I don't have a memory called "${mi.name || '?'}".`);
        break;
      }
      case 'rename': {
        const ok = mi.name && mi.renameTo && this.memory.update(mi.name, { name: mi.renameTo });
        await delay(rd);
        this._safeChat(ok ? `Renamed to ${mi.renameTo}.` : `Couldn't find "${mi.name || '?'}".`);
        break;
      }
      case 'update': {
        const ok = mi.name && this.memory.update(mi.name, { notes: mi.notes ? [mi.notes] : [] });
        await delay(rd);
        this._safeChat(ok ? `Updated what I know about ${mi.name}.` : `I don't know that place yet.`);
        break;
      }
    }
  }

  // ── Behaviour intent ──────────────────────────────────────────────────────

  async _handleIntent(intent, username, rawMessage, flags = {}) {
    const { action, shouldRespond, responsePrompt } = intent;
    const rd  = this.cfg.companion?.responseDelayMs || 1500;
    const ctx = this._buildContext(username, flags);

    if (shouldRespond) await delay(rd + Math.random() * 800);

    switch (action) {
      case 'FOLLOW':
        this.workers?.stop().then(() => this.stateMachine?.setState('FOLLOWING', { targetUsername: username }));
        this._setStatus(`following ${username}`);
        if (shouldRespond) this._safeChat('On my way.');
        break;

      case 'WAIT':
        this.workers?.stop().then(() => this.stateMachine?.setState('WAITING'));
        this._setStatus('waiting');
        if (shouldRespond) this._safeChat("I'll wait here.");
        break;

      case 'LOITER':
        this.workers?.stop().then(() => this.stateMachine?.setState('LOITERING'));
        this._setStatus('loitering');
        if (shouldRespond) this._safeChat("I'll wander around a bit.");
        break;

      case 'WORK_FARM': {
        const perm = this.permissions.check('harvest_crops', { coords: this.bot?.entity?.position });
        if (!perm.allowed) { this._safeChat(`I can't do that — ${perm.reason}`); break; }
        this.stateMachine?.setState('WORKING');
        const locationName = responsePrompt || null;
        await this.workers.start('farm', { locationName });
        break;
      }

      case 'WORK_PATROL': {
        const perm = this.permissions.check('follow', {});
        if (!perm.allowed) { this._safeChat(`I can't patrol — ${perm.reason}`); break; }
        this.stateMachine?.setState('WORKING');
        await this.workers.start('patrol', { locationName: responsePrompt || null });
        break;
      }

      case 'WORK_COLLECT': {
        const perm = this.permissions.check('collect_drops', { coords: this.bot?.entity?.position });
        if (!perm.allowed) { this._safeChat(`I can't collect — ${perm.reason}`); break; }
        this.stateMachine?.setState('WORKING');
        await this.workers.start('collect', { locationName: responsePrompt || null });
        break;
      }

      case 'WORK_STOP':
        await this.workers?.stop();
        this.stateMachine?.setState('WAITING');
        if (shouldRespond) this._safeChat("Stopping what I was doing.");
        break;

      case 'GO_TO': {
        const dest = this.memory.resolve(responsePrompt || rawMessage);
        dest ? this._goToLocation(dest) : this._safeChat("I'm not sure where that is.");
        break;
      }

      case 'OBSERVE': {
        const desc = await this.observer?.describeEnvironment() || 'nothing notable';
        const area = this.bot?.entity?.position
          ? this.memory.enclosing(this.bot.entity.position)[0] : null;
        const response = await this.dialogue.generate(
          `Describe your surroundings naturally. Raw scan: "${desc}".${area ? ` You are near ${area.name}.` : ''}`,
          { ...ctx, isDirectAddress: true }
        ) || desc;
        await delay(rd);
        this._safeChat(response);
        if (area) this.memory.cacheState(area.id, { lastObservation: desc });
        break;
      }

      case 'MEMORY_QUERY': {
        const loc = this.memory.resolve(responsePrompt || rawMessage);
        if (!loc) { await delay(rd); this._safeChat("I don't have a memory for that yet."); break; }
        const phrase = this.memory.freshnessPhrase(loc.id) || '';
        const c = loc.coordinates;
        await delay(rd);
        this._safeChat(`I remember ${loc.name} at ${c.x}, ${c.y}, ${c.z}. ${phrase}`.trim());
        break;
      }

      case 'BE_TALKATIVE':
        this.stateMachine?.setTalkative(true);
        if (shouldRespond) this._safeChat("I'll speak my mind more.");
        break;

      case 'BE_QUIET':
        this.stateMachine?.setTalkative(false);
        if (shouldRespond) this._safeChat("I'll keep quiet.");
        break;

      case 'RESPOND': {
        if (!responsePrompt) break;
        const resp = await this.dialogue.generate(responsePrompt, { ...ctx, isDirectAddress: true, isQuestion: flags.isQuestion });
        if (resp) { await delay(rd + Math.random() * 600); this._safeChat(resp); }
        break;
      }

      case 'IGNORE': break;
      default: console.warn('[BotManager] Unhandled action:', action);
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  _goToLocation(location) {
    try {
      const { GoalNear } = require('mineflayer-pathfinder').goals;
      const { Movements } = require('mineflayer-pathfinder');
      const mvmt = new Movements(this.bot);
      this.bot.pathfinder.setMovements(mvmt);
      this.bot.pathfinder.setGoal(
        new GoalNear(location.coordinates.x, location.coordinates.y, location.coordinates.z, 3), false
      );
      this._safeChat(`Heading to ${location.name}.`);
      this._setStatus(`going to ${location.name}`);
      this.memory.markVisited(location.id);
    } catch (err) {
      console.error('[BotManager] Navigation error:', err.message);
      this._safeChat("I had trouble navigating there.");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _isAddressed(message, username) {
    const name = this.character.getName().toLowerCase();
    const m    = message.toLowerCase();
    return m.includes(name) || /\b(you|hey|bud)\b/.test(m);
  }

  _safeChat(text) {
    if (!this.connected || !this.bot || !text) return;
    try { this.bot.chat(String(text).slice(0, 256)); }
    catch (err) { console.warn('[BotManager] chat error:', err.message); }
  }

  _buildContext(username, flags = {}) {
    return {
      state:       this.stateMachine?.currentState || 'idle',
      environment: this.observer?.lastObservation  || 'a quiet area',
      username:    username || 'the player',
      nearbyArea:  this.memory.enclosing(this.bot?.entity?.position || {x:0,y:0,z:0})[0]?.name || null,
      ...flags,
    };
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  _onEnd(reason) {
    const was    = this.connected;
    this.connected = false;
    this.workers?.destroy();
    this.observer?.stop();
    this.stateMachine?.destroy();
    this._setStatus('disconnected');
    if (was) this.emit('log', `Disconnected: ${reason || 'unknown'}`);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this._clearReconnect();
    this._setStatus('reconnecting…');
    this._reconnectTimer = setTimeout(() => {
      if (!this.connected) { this.emit('log', 'Reconnecting…'); this.connect(); }
    }, 8_000);
  }

  _clearReconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }
}

module.exports = BotManager;
