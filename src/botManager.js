'use strict';

const log            = require('./logger');
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
const SocialEnergy            = require('./ai/socialEnergy');
const ConversationBuffer      = require('./ai/conversationBuffer');
const PlanExecutor            = require('./ai/planExecutor');
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
    this._reconnectTimer  = null;
    this._greetedAt       = 0;
    this._bgEvents        = [];   // ring buffer — max 250
    this._bgEventSeq      = 0;

    // ── Persistent subsystems ─────────────────────────────────────────────
    this.character   = new CharacterProfile();
    this.staleness   = new StalenessConfig();
    this.memory      = new WorldMemory(this.staleness, this);
    this.permissions = new PermissionManager(this.memory);
    this.resources   = new ResourceManager(this.cfg.resources || {});
    this.social      = new SocialEnergy(this.cfg.social || {});
    this.social.on('social:changed', e => this.emit('social:changed', e));

    // Conversation continuity — persists across reconnects
    const companionName = this.cfg.companion?.name || this.character.getName() || 'Bud';
    this.convBuffer  = new ConversationBuffer(this.cfg.conversation?.maxTurns ?? 20, companionName);

    // Plan executor — executes deep-tier multi-step plans
    this.planExec    = new PlanExecutor(this.cfg.planning || {});
    this._wirePlanExecutor();

    // ── Shared LLM router — passed into all AI components ────────────────
    this.router = new LLMRouter(this.cfg);

    // Forward router stats to UI
    this.router.on('router:used',             e => this.emit('llm:used',         e));
    this.router.on('router:fallback',         e => {
      this.emit('llm:fallback', e);
      this._bgEvent('llm', 'warn', `Fallback: ${e.from} → ${e.to}`, `call type: ${e.callType}`);
    });
    this.router.on('router:openai-auth-error',  () => {
      this.emit('llm:openai-error', 'Invalid API key');
      this._bgEvent('llm', 'error', 'OpenAI API key is invalid', 'Check AI & Models settings');
    });
    this.router.on('router:openai-rate-limited',() => {
      this.emit('llm:openai-error', 'Rate limited');
      this._bgEvent('llm', 'warn', 'OpenAI rate limited', 'Will retry after cooldown');
    });
    this.router.on('router:claude-auth-error',  () => {
      this.emit('llm:openai-error', 'Claude: Invalid API key');
      this._bgEvent('llm', 'error', 'Claude API key is invalid', 'Check AI & Models settings');
    });
    this.router.on('router:ollama-error',       (msg) => {
      this._bgEvent('llm', 'warn', `Ollama is not responding`, msg);
    });
    this.router.on('router:ollama-circuit-open', () => {
      this._bgEvent('llm', 'error', 'Ollama circuit open — pausing for 60s', 'Check that Ollama is running on the configured URL');
    });

    // Internal monologue
    this.monologue = new Monologue(this.cfg, this.router);
    this.monologue.on('monologue:thought', ({ thought }) => {
      this.emit('log', `[inner] ${thought}`);
      this._bgEvent('state', 'info', `[inner] ${thought}`);
    });
    this.monologue.on('monologue:adjust',  ({ adjustment }) => {
      this.emit('log', `[adjust] ${adjustment}`);
      log.bot('BotManager', `Monologue adjustment: ${adjustment}`);
      this._bgEvent('state', 'warn', `Monologue: ${adjustment}`);
      // Act on common adjustment types
      const a = adjustment.toLowerCase();
      if (/quiet|less talk|stop talk|silent/.test(a))       this.stateMachine?.setTalkative(false);
      else if (/talk|chatty|more expressive|speak/.test(a)) this.stateMachine?.setTalkative(true);
      else if (/wait|stay|stop moving/.test(a))             this.stateMachine?.setState('WAITING');
      else if (/wander|loiter|explore/.test(a))             this.stateMachine?.setState('LOITERING');
    });

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

  // ── Background Knowledge ──────────────────────────────────────────────────

  _bgEvent(cat, level, msg, detail = null) {
    const entry = { id: ++this._bgEventSeq, at: Date.now(), cat, level, msg, detail };
    this._bgEvents.push(entry);
    if (this._bgEvents.length > 250) this._bgEvents.shift();
    this.emit('bgevent', entry);
  }

  getBgEvents()   { return [...this._bgEvents].reverse(); }
  clearBgEvents() { this._bgEvents = []; this._bgEventSeq = 0; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connect() {
    if (this.connected) return;
    this._clearReconnect();
    this._setStatus('connecting');

    const username = this.cfg.bot?.username || this.character.getName() || 'Bud';
    const host     = this.cfg.bot?.host || 'localhost';
    const port     = this.cfg.bot?.port || 25565;
    const version  = this.cfg.bot?.version || '1.21.1';

    log.bot('BotManager', `Connecting → ${host}:${port} as ${username} (MC ${version})`);
    this._bgEvent('connection', 'info', `Connecting to ${host}:${port} as ${username}`);

    try {
      this.bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
    } catch (err) {
      log.exception('BotManager', 'mineflayer.createBot threw', err);
      this.emit('error', `createBot failed: ${err.message}`);
      this._bgEvent('connection', 'error', `Cannot create bot: ${err.message}`);
      this._setStatus('error');
      this._scheduleReconnect();
      return;
    }

    try { this.bot.loadPlugin(pathfinder); }
    catch (err) { log.error('BotManager', 'pathfinder plugin load failed', err.message); }

    this.bot.once('spawn',  () => this._onSpawn());
    this.bot.on('chat',     (u, m) => this._onChat(u, m).catch(e => {
      log.error('BotManager', `Chat handler threw for message from ${u}`, e.message);
    }));
    this.bot.on('error',    e  => {
      // e.message is often empty for socket errors; the detail is in e.code/address/port
      const errMsg = e?.message
        || (e?.code && e?.address ? `${e.code} ${e.address}:${e.port}` : null)
        || e?.code
        || String(e);
      log.error('BotManager', `Mineflayer error: ${errMsg}`);
      this.emit('error', errMsg);
      this._bgEvent('connection', 'error', `Connection error: ${errMsg}`);
    });
    this.bot.on('end',      r  => this._onEnd(r));
    this.bot.on('kicked',   r  => {
      log.warn('BotManager', `Kicked from server: ${r}`);
      this.emit('log', `Kicked: ${r}`);
      this._bgEvent('connection', 'error', `Kicked from server`, String(r));
      this._onEnd(r);
    });
  }

  disconnect() {
    log.bot('BotManager', 'Disconnecting (user-requested)');
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
    if (patch.social) {
      this.cfg.social = this.cfg.social || {};
      Object.assign(this.cfg.social, patch.social);
      this.social?.updateConfig(this.cfg.social);
    }
    if (patch.conversation) {
      this.cfg.conversation = this.cfg.conversation || {};
      Object.assign(this.cfg.conversation, patch.conversation);
      this.convBuffer?.updateMaxTurns(this.cfg.conversation.maxTurns ?? 20);
    }
    if (patch.planning) {
      this.cfg.planning = this.cfg.planning || {};
      Object.assign(this.cfg.planning, patch.planning);
      this.planExec?.updateConfig(this.cfg.planning);
    }
    this.cfg.openai.enabled = !!(this.cfg.openai?.apiKey);
    this.cfg.claude.enabled = !!(this.cfg.claude?.apiKey);
    this.router.updateConfig(this.cfg);
    this._bgEvent('llm', 'info',
      `AI settings updated — strategy: ${this.cfg.hybrid.strategy}`,
      `Ollama on · OpenAI ${this.cfg.openai.enabled ? 'on' : 'off'} · Claude ${this.cfg.claude.enabled ? 'on' : 'off'}`
    );
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

  getSocialState()        { return { level: this.social?.level ?? 100, config: this.social?.getConfig() ?? {} }; }
  updateSocialConfig(cfg) { this.social?.updateConfig(cfg); }

  destroy() {
    this.disconnect();
    this.memory.destroy();
    this.resources.destroy();
    this.social?.destroy();
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────

  _onSpawn() {
    this.connected = true;
    log.bot('BotManager', `Spawned in world as ${this.bot?.username}`);
    this._setStatus('idle');

    // All AI components share the same router instance
    this.intentParser = new IntentParser(this.cfg, this.router);
    this.memoryParser = new MemoryParser(this.cfg, this.router);
    this.dialogue     = new Dialogue(this.cfg, this.character, this.router, this.convBuffer);
    this.dialogue.on('dialogue:used', ({ tier, provider, model, tokens }) => {
      this._bgEvent('llm', 'info',
        `Dialogue [${tier}] → ${provider}:${model}`,
        `${tokens} token budget`
      );
    });
    this.observer     = new Observer(this.bot, this.cfg, this.memory, this.dialogue);  // pass memory + dialogue
    this.stateMachine = new StateMachine(this.bot, this.cfg);
    this.workers      = new WorkerManager(this.bot, this.cfg, this.memory, this.permissions);

    // Forward worker events to UI
    this.workers.on('worker:start',    e => {
      this._setStatus(e.label);
      this.emit('worker:start', e);
      this._bgEvent('state', 'info', `Task started: ${e.label || e.type}`);
    });
    this.workers.on('worker:done',     e => {
      this._setStatus('idle');
      this.emit('worker:done', e);
      this.stateMachine.setState('WAITING');
      this._bgEvent('state', 'ok', `Task finished: ${e.label || e.type || 'task'}`);
    });
    this.workers.on('worker:error',    e => {
      this._setStatus('idle');
      this.emit('worker:error', e);
      this.stateMachine.setState('WAITING');
      this._bgEvent('state', 'error', `Task failed: ${e.label || e.type || 'task'}`, e.error || null);
    });
    this.workers.on('worker:progress', e => this.emit('worker:progress', e));
    this.workers.on('worker:stop',     e => {
      this._setStatus('idle');
      this.emit('worker:stop', e);
      this.stateMachine?.setState('WAITING');
      this._bgEvent('state', 'info', `Task stopped: ${e.label || 'task'}`);
    });
    this.workers.on('worker:threat',   e => {
      this.emit('worker:threat', e);
      this._bgEvent('state', 'warn', `Threat detected near ${e.location || 'task area'}`);
    });

    const defaultMode = this.character.get().defaultBehaviorMode || 'WAITING';
    this.stateMachine.setState(defaultMode);
    this.observer.start(this.stateMachine);
    this._bgEvent('state', 'info', `Mode activated: ${defaultMode}`);
    this._stateChangedAt = Date.now();
    this.monologue.start(() => ({
      state:        this.stateMachine?.currentState || 'UNKNOWN',
      task:         this.workers?.currentTask?.type || null,
      stateTimeSec: Math.round((Date.now() - (this._stateChangedAt || Date.now())) / 1000),
      recentEvent:  this._lastMonologueEvent || null,
    }));

    this._bgEvent('connection', 'ok', `Joined world as ${this.bot.username}`);
    this.emit('social:changed', { level: this.social?.level ?? 100 });
    this.emit('log', `Connected as ${this.bot.username}`);

    // First greeting with slight delay — use OpenAI if available (important moment)
    setTimeout(async () => {
      if (!this.connected || !this.bot) return;
      const name = this.character.getName();
      const { text: greeting } = await this.dialogue.generate(
        `You just joined the player's Minecraft world for the first time today. Give a short, natural greeting as ${name}.`,
        { state: 'joining', isImportant: true, isDirectAddress: false },
        null, 'quick'   // greeting is always quick tier
      ).catch(() => ({ text: null }));
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

    // Social battery drain + player-active signal
    this.social.onInteraction(isDirectAddress);
    this.resources.setPlayerActive(true);

    // Parallel classification
    const [intentResult, memIntentResult] = await Promise.allSettled([
      this.intentParser.parse(message, username, this.stateMachine?.currentState),
      this.memoryParser.parse(message, username),
    ]);

    if (memIntentResult.status === 'fulfilled' && memIntentResult.value) {
      await this._handleMemoryIntent(memIntentResult.value, username).catch(e => {
        log.error('BotManager', `Memory intent handler threw for "${message.slice(0,60)}"`, e.message);
      });
    }

    if (intentResult.status === 'fulfilled' && intentResult.value) {
      // Push raw player message into conversation buffer so the assistant has
      // proper context — but only for actions we'll actually respond to.
      if (intentResult.value.action !== 'IGNORE') {
        this.convBuffer?.push('user', message);
      }
      log.debug('BotManager', `Intent: ${intentResult.value.action} from ${username}`, `shouldRespond:${intentResult.value.shouldRespond} msg:"${message.slice(0,80)}"`);
      await this._handleIntent(intentResult.value, username, message, { isDirectAddress, isQuestion }).catch(e => {
        log.error('BotManager', `Intent handler threw for action ${intentResult.value?.action}`, e.message);
      });
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
        } catch (err) { log.error('BotManager', `memory.save: ${err.message}`); break; }
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
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} asked you to follow them. Say you will in one very short phrase.`, ctx);
          this._safeChat(ackText || 'On my way.');
        }
        break;

      case 'WAIT':
        this.workers?.stop().then(() => this.stateMachine?.setState('WAITING'));
        this._setStatus('waiting');
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} asked you to wait/stop. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll wait here.");
        }
        break;

      case 'LOITER':
        this.workers?.stop().then(() => this.stateMachine?.setState('LOITERING'));
        this._setStatus('loitering');
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} told you to wander around. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll wander around a bit.");
        }
        break;

      case 'WORK_FARM': {
        const perm = this.permissions.check('harvest_crops', { coords: this.bot?.entity?.position });
        if (!perm.allowed) { this._safeChat(`I can't do that — ${perm.reason}`); break; }
        this.stateMachine?.setState('WORKING');
        const locationName = responsePrompt || null;
        await this.workers.start('farm', { locationName });
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} asked you to start farming. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll get to farming.");
        }
        break;
      }

      case 'WORK_PATROL': {
        const perm = this.permissions.check('follow', {});
        if (!perm.allowed) { this._safeChat(`I can't patrol — ${perm.reason}`); break; }
        this.stateMachine?.setState('WORKING');
        await this.workers.start('patrol', { locationName: responsePrompt || null });
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} asked you to patrol. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll patrol the area.");
        }
        break;
      }

      case 'WORK_COLLECT': {
        const perm = this.permissions.check('collect_drops', { coords: this.bot?.entity?.position });
        if (!perm.allowed) { this._safeChat(`I can't collect — ${perm.reason}`); break; }
        this.stateMachine?.setState('WORKING');
        await this.workers.start('collect', { locationName: responsePrompt || null });
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} asked you to collect nearby items. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll collect what's nearby.");
        }
        break;
      }

      case 'WORK_STOP':
        await this.workers?.stop();
        this.stateMachine?.setState('WAITING');
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} asked you to stop working. Confirm briefly.`, ctx);
          this._safeChat(ackText || "Stopping what I was doing.");
        }
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
        const { text: obsText } = await this.dialogue.generate(
          `Describe your surroundings naturally. Raw scan: "${desc}".${area ? ` You are near ${area.name}.` : ''}`,
          { ...ctx, isDirectAddress: true }, 'OBSERVE', 'standard'
        );
        await delay(rd);
        this._safeChat(obsText || desc);
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
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} wants you to be more talkative and expressive. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll speak my mind more.");
        }
        break;

      case 'BE_QUIET':
        this.stateMachine?.setTalkative(false);
        if (shouldRespond) {
          const { text: ackText } = await this.dialogue.acknowledge(
            `${username} wants you to be quieter and less chatty. Confirm briefly.`, ctx);
          this._safeChat(ackText || "I'll keep quiet.");
        }
        break;

      case 'RESPOND': {
        if (!responsePrompt) break;
        const { text: respText, tier } = await this.dialogue.generate(
          responsePrompt, { ...ctx, isDirectAddress: true, isQuestion: flags.isQuestion },
          'RESPOND'
        );
        if (respText) {
          await delay(rd + Math.random() * 600);
          this._safeChat(respText);
          // If deep tier returned a plan and auto-execute is on, run it
          if (tier === 'deep' && this.cfg.planning?.autoExecute && PlanExecutor.isPlan(respText)) {
            const steps = PlanExecutor.parseSteps(respText);
            if (steps.length > 0) {
              const confirmFn = this.cfg.planning?.requireConfirmation
                ? this._makePlanConfirmFn(username)
                : null;
              this.planExec.execute(steps, confirmFn).catch(e =>
                log.error('BotManager', `Plan execution error: ${e.message}`)
              );
            }
          }
        }
        break;
      }

      case 'IGNORE': break;
      default: log.warn('BotManager', `Unhandled action: ${action}`);
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
      log.error('BotManager', `Navigation error: ${err.message}`);
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
    catch (err) { log.warn('BotManager', `chat error: ${err.message}`); }
  }

  _buildContext(username, flags = {}) {
    const pos = this.bot?.entity?.position || null;
    return {
      state:           this.stateMachine?.currentState || 'idle',
      environment:     this.observer?.lastObservation  || 'a quiet area',
      username:        username || 'the player',
      nearbyArea:      pos ? this.memory.enclosing(pos)[0]?.name || null : null,
      spatialCtx:      this._buildSpatialContext(pos),
      inventoryCtx:    this._buildInventoryCtx(),
      playerProximity: this._getPlayerProximity(username),
      socialEnergy:    this.social?.level ?? 100,
      ...flags,
    };
  }

  _buildInventoryCtx() {
    if (!this.bot) return null;
    try {
      const items = this.bot.inventory.items();
      if (!items.length) return 'empty inventory';
      const counts = {};
      for (const item of items) counts[item.name] = (counts[item.name] || 0) + item.count;
      const top = Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([name, count]) => `${count}× ${name.replace(/_/g, ' ')}`);
      const overflow = Object.keys(counts).length > 8 ? ', +more' : '';
      return top.join(', ') + overflow;
    } catch { return null; }
  }

  _getPlayerProximity(username) {
    if (!this.bot || !username) return null;
    try {
      const player = this.bot.players[username];
      if (!player?.entity) return null;  // outside render distance
      const bPos  = this.bot.entity.position;
      const pPos  = player.entity.position;
      const dx    = pPos.x - bPos.x;
      const dz    = pPos.z - bPos.z;
      const dist  = Math.round(Math.sqrt(dx * dx + dz * dz));
      const angle = Math.atan2(dx, -dz) * 180 / Math.PI;
      const dirs  = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
      const dir   = dirs[Math.round(((angle % 360) + 360) % 360 / 45) % 8];
      return { distance: dist, direction: dir };
    } catch { return null; }
  }

  _buildSpatialContext(pos) {
    try {
      return {
        bed:        this.memory.getBed(),
        crafting:   this.memory.getNearestWorkstation('crafting_table',   pos),
        furnace:    this.memory.getNearestWorkstation('furnace',           pos),
        enchanting: this.memory.getNearestWorkstation('enchanting_table',  pos),
        anvil:      this.memory.getNearestWorkstation('anvil',             pos),
      };
    } catch { return null; }
  }

  /** Wire plan executor events → state machine + bgEvents */
  _wirePlanExecutor() {
    this.planExec.on('plan:step', ({ index, total, description, action, locationHint }) => {
      this._bgEvent('state', 'info', `Plan step ${index}/${total}: ${description}`);
      // Execute the step
      if (!this.connected || !this.bot) return;
      switch (action) {
        case 'WORK_FARM':    this.stateMachine?.setState('WORKING'); this.workers?.start('farm',    { locationName: locationHint }); break;
        case 'WORK_PATROL':  this.stateMachine?.setState('WORKING'); this.workers?.start('patrol',  { locationName: locationHint }); break;
        case 'WORK_COLLECT': this.stateMachine?.setState('WORKING'); this.workers?.start('collect', { locationName: locationHint }); break;
        case 'WAIT':         this.workers?.stop().then(() => this.stateMachine?.setState('WAITING')); break;
        case 'WORK_STOP':    this.workers?.stop(); break;
        case 'GO_TO': {
          if (locationHint) {
            const loc = this.memory.resolve(locationHint);
            if (loc) this._goToLocation(loc);
          }
          break;
        }
        case 'CHAT':
          // Unrecognised step — just say it
          this._safeChat(description);
          break;
      }
    });
    this.planExec.on('plan:done',    ({ stepsCompleted }) => {
      this._bgEvent('state', 'ok', `Plan completed — ${stepsCompleted} step(s) done`);
    });
    this.planExec.on('plan:stopped', () => {
      this._bgEvent('state', 'warn', 'Plan stopped');
    });
  }

  /** Returns a confirmation function that asks the player in chat and awaits yes/no */
  _makePlanConfirmFn(username) {
    return (description, step, total) => new Promise(resolve => {
      this._safeChat(`Step ${step}/${total}: ${description} — ok? (yes/no)`);
      const timeout = setTimeout(() => {
        off();
        resolve(false);
      }, 25_000);
      const handler = (u, msg) => {
        if (u !== username) return;
        const lower = msg.toLowerCase().trim();
        if (/^(yes|y|ok|sure|go|do it)/.test(lower)) { off(); resolve(true); }
        if (/^(no|n|stop|cancel|skip)/.test(lower))  { off(); resolve(false); }
      };
      const off = () => { clearTimeout(timeout); this.bot?.removeListener('chat', handler); };
      this.bot?.on('chat', handler);
    });
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  _onEnd(reason) {
    const was    = this.connected;
    this.connected = false;
    this.monologue?.stop();
    this.workers?.destroy();
    this.observer?.stop();
    this.stateMachine?.destroy();
    this._setStatus('disconnected');
    if (was) {
      log.bot('BotManager', `Disconnected: ${reason || 'unknown'}`);
      this.emit('log', `Disconnected: ${reason || 'unknown'}`);
      this._bgEvent('connection', 'warn', `Disconnected`, String(reason || 'connection closed'));
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this._clearReconnect();
    this._setStatus('reconnecting…');
    log.bot('BotManager', 'Scheduling reconnect in 8s');
    this._bgEvent('connection', 'info', 'Will reconnect in 8s');
    this._reconnectTimer = setTimeout(() => {
      if (!this.connected) { this.emit('log', 'Reconnecting…'); this.connect(); }
    }, 8_000);
  }

  _clearReconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }
}

module.exports = BotManager;
