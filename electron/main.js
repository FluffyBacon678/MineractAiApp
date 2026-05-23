'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Bootstrap: app root, writable data dir, and .env ──────────────────────────
const APP_ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(APP_ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const ENV_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), '.env')
  : path.join(APP_ROOT, '.env');
const ENV_EXAMPLE = path.join(APP_ROOT, '.env.example');
if (!fs.existsSync(ENV_FILE) && fs.existsSync(ENV_EXAMPLE)) {
  try { fs.copyFileSync(ENV_EXAMPLE, ENV_FILE); console.log('[Main] Created .env'); }
  catch (e) { console.warn('[Main] Could not create .env:', e.message); }
}
process.env.COMPANION_APP_ROOT = APP_ROOT;
process.env.COMPANION_DATA_DIR = DATA_DIR;
process.env.COMPANION_ENV_FILE = ENV_FILE;

const BotManager = require('../src/botManager');

nativeTheme.themeSource = 'dark';

/** Shallow-deep merge: objects are merged one level down, primitives overwritten. */
function _deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

const LOG_FILE   = path.join(DATA_DIR, 'activity-log.json');
const PREFS_FILE = path.join(DATA_DIR, 'ui-prefs.json');

let win;
let bot          = null;
let persistedLog = [];

// ── Log persistence ───────────────────────────────────────────────────────────

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf-8');
      persistedLog = JSON.parse(raw);
      if (!Array.isArray(persistedLog)) persistedLog = [];
    }
  } catch { persistedLog = []; }
}

function saveLog() {
  try {
    if (persistedLog.length > 500) persistedLog = persistedLog.slice(-500);
    fs.writeFileSync(LOG_FILE, JSON.stringify(persistedLog, null, 2));
  } catch {}
}

function appendLog(entry) {
  const record = typeof entry === 'string'
    ? { at: Date.now(), msg: entry }
    : { at: Date.now(), msg: String(entry.msg || entry.message || JSON.stringify(entry)).slice(0,200), ...entry };
  persistedLog.push(record);
  saveLog();
  win?.webContents?.send('bot:log', record);
}

// ── Prefs ─────────────────────────────────────────────────────────────────────

function loadPrefs() {
  try { if (fs.existsSync(PREFS_FILE)) return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); }
  catch {}
  return {};
}

function savePrefs(patch) {
  try {
    const merged = { ...loadPrefs(), ...patch };
    fs.writeFileSync(PREFS_FILE, JSON.stringify(merged, null, 2));
    return merged;
  } catch { return {}; }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const p = loadPrefs();
  win = new BrowserWindow({
    width:    p.width  || 1200,
    height:   p.height || 820,
    minWidth: 940, minHeight: 620,
    x: p.x, y: p.y,
    backgroundColor: '#0f1117',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame:           process.platform !== 'darwin',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('close', () => {
    const [w, h] = win.getSize();
    const [x, y] = win.getPosition();
    savePrefs({ width: w, height: h, x, y });
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => { loadLog(); createWindow(); });
app.on('window-all-closed', () => { bot?.destroy(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });

// ── Bot control ───────────────────────────────────────────────────────────────

ipcMain.handle('bot:connect', (_, cfg) => {
  try {
    if (bot) { bot.destroy(); bot = null; }
    bot = new BotManager(cfg || {});

    const fwd = (ch, d) => win?.webContents?.send(ch, d);
    bot.on('status',        s => fwd('bot:status',      s));
    bot.on('chat',          c => fwd('bot:chat',        c));
    bot.on('resources',     r => fwd('bot:resources',   r));
    bot.on('profile',       p => fwd('bot:profile',     p));
    bot.on('memory',        m => fwd('bot:memory',      m));
    bot.on('permissions',   p => fwd('bot:permissions', p));
    bot.on('staleness',     s => fwd('bot:staleness',   s));
    bot.on('character',     c => fwd('bot:character',   c));
    bot.on('llm:used',      e => fwd('bot:llm',         e));
    bot.on('llm:fallback',  e => fwd('bot:llm',         { ...e, isFallback: true }));
    bot.on('llm:openai-error', e => fwd('bot:llm-error', e));
    bot.on('llm:config-updated', e => fwd('bot:llm-config', e));
    bot.on('worker:start',  e => fwd('bot:worker',      { event: 'start', ...e }));
    bot.on('worker:done',   e => fwd('bot:worker',      { event: 'done', ...e }));
    bot.on('worker:error',  e => fwd('bot:worker',      { event: 'error', ...e }));
    bot.on('worker:progress',e=> fwd('bot:worker',      { event: 'progress', ...e }));
    bot.on('worker:stop',   e => fwd('bot:worker',      { event: 'stop', ...e }));
    bot.on('worker:threat', e => fwd('bot:worker',      { event: 'threat', ...e }));
    bot.on('bgevent',       e => fwd('bot:bgevent',     e));
    bot.on('log',           l => appendLog(l));
    bot.on('error',         e => { appendLog({ type:'error', msg: String(e) }); fwd('bot:error', e); });

    bot.connect();
    appendLog('Bot connect requested');
    return { ok: true };
  } catch (err) {
    appendLog({ type: 'error', msg: `Connect failed: ${err.message}` });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bot:disconnect', () => {
  try { bot?.disconnect(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('bot:chat', (_, msg) => {
  if (!msg?.trim()) return { ok: false, error: 'Empty message' };
  try { bot?.sendChat(msg); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ── Offline AI chat (Ollama + optional OpenAI, no Minecraft needed) ────────────

ipcMain.handle('bot:offlineChat', async (_, msg, cfg) => {
  if (!msg) return { ok: false, reply: null };
  try {
    // Build a minimal router to use offline
    const { default: nodeFetch } = await Promise.resolve().then(() => ({ default: fetch })).catch(() => ({ default: fetch }));

    let system = 'You are Bud, a friendly Minecraft companion. Reply in 1-2 short sentences. Never say you are a bot or AI.';
    if (bot?.character) {
      try { system = bot.character.buildSystemPrompt({ state: 'offline' }); } catch {}
    }

    const ollamaUrl = cfg?.ollamaUrl || 'http://localhost:11434';
    const model     = cfg?.model     || 'llama3.2';

    // Try OpenAI first if key provided
    if (cfg?.openAiKey && cfg.openAiKey.startsWith('sk-')) {
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.openAiKey}` },
          body: JSON.stringify({
            model: cfg.openAiModel || 'gpt-4o-mini',
            messages: [{ role:'system', content: system }, { role:'user', content: msg }],
            temperature: 0.8, max_tokens: 100,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        if (res.ok) {
          const data  = await res.json();
          const reply = data?.choices?.[0]?.message?.content?.trim().replace(/^["'`]+|["'`]+$/g,'');
          if (reply) return { ok: true, reply, provider: 'openai' };
        }
      } catch {}
    }

    // Fall back to Ollama
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role:'system', content: system }, { role:'user', content: msg }],
        stream: false, options: { temperature: 0.75, num_predict: 80 },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return { ok: false, reply: null, error: `Ollama HTTP ${res.status}` };
    const data  = await res.json();
    const reply = (data?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g,'');
    return { ok: !!reply, reply: reply || null, provider: 'ollama' };

  } catch (err) {
    return { ok: false, reply: null, error: err.name === 'TimeoutError' ? 'LLM timed out' : err.message };
  }
});

// ── LLM config ────────────────────────────────────────────────────────────────

ipcMain.handle('llm:getConfig', () => {
  try {
    let src;
    if (bot) {
      src = bot.cfg;
    } else {
      // Merge saved LLM prefs (from previous llmSetConfig calls) over defaults
      const defaults = require('../src/config');
      const saved    = loadPrefs().llmConfig || {};
      src = _deepMerge(defaults, saved);
    }
    return {
      ollama:    src.ollama,
      openai:    { ...src.openai,  apiKey: src.openai?.apiKey  ? '***set***' : '' },
      claude:    { ...src.claude,  apiKey: src.claude?.apiKey  ? '***set***' : '' },
      hybrid:    src.hybrid,
      routing:   src.routing,
      monologue: src.monologue,
    };
  } catch (err) { return {}; }
});

ipcMain.handle('llm:setConfig', (_, patch) => {
  try {
    if (!patch) return { ok: false, error: 'No config patch' };
    if (bot) {
      bot.updateLLMConfig(patch);
    }
    // Also persist to prefs so it survives restart
    savePrefs({ llmConfig: patch });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('llm:getStats', () => {
  try { return bot?.getLLMStats() ?? {}; }
  catch { return {}; }
});

ipcMain.handle('llm:testOllama', async (_, url, model) => {
  try {
    const res = await fetch(`${url || 'http://localhost:11434'}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3.2',
        messages: [{ role: 'user', content: 'Reply with only: ok' }],
        stream: false, options: { num_predict: 5 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, response: data?.message?.content?.trim() || '?' };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Timed out — is Ollama running?' : err.message };
  }
});

ipcMain.handle('llm:testOpenAI', async (_, apiKey, model) => {
  if (!apiKey?.startsWith('sk-')) return { ok: false, error: 'API key must start with sk-' };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with only: ok' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { ok: false, error: 'Invalid API key' };
    if (res.status === 429) return { ok: false, error: 'Rate limited' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, model: data.model, response: data?.choices?.[0]?.message?.content?.trim() };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Timed out' : err.message };
  }
});

ipcMain.handle('llm:testClaude', async (_, apiKey, model) => {
  if (!apiKey?.startsWith('sk-ant-')) return { ok: false, error: 'Claude API key must start with sk-ant-' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model || 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Reply with only: ok' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return { ok: false, error: 'Invalid API key' };
    if (res.status === 429) return { ok: false, error: 'Rate limited' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, model: data.model, response: data?.content?.[0]?.text?.trim() };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Timed out' : err.message };
  }
});

// ── Character ─────────────────────────────────────────────────────────────────

// ── Background Events ─────────────────────────────────────────────────────────

ipcMain.handle('bgevents:getAll', () => bot?.getBgEvents() ?? []);
ipcMain.handle('bgevents:clear',  () => { bot?.clearBgEvents(); return { ok: true }; });

// ── Character ─────────────────────────────────────────────────────────────────

ipcMain.handle('character:get', () => {
  try {
    if (bot?.character) return bot.character.get();
    const { CharacterProfile } = require('../src/ai/characterProfile');
    return new CharacterProfile().get();
  } catch { return null; }
});

ipcMain.handle('character:set', (_, patch) => {
  try {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid patch' };
    if (bot?.character) { bot.character.set(patch); return { ok: true }; }
    const { CharacterProfile } = require('../src/ai/characterProfile');
    new CharacterProfile().set(patch);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('character:setTrait', (_, key, value) => {
  try {
    if (bot?.character) { bot.character.setTrait(key, value); return { ok: true }; }
    const { CharacterProfile } = require('../src/ai/characterProfile');
    new CharacterProfile().setTrait(key, value);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('character:reset', () => {
  try {
    if (bot?.character) { bot.character.resetToDefaults(); return { ok: true }; }
    const { CharacterProfile } = require('../src/ai/characterProfile');
    new CharacterProfile().resetToDefaults();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('character:metadata', () => {
  try {
    const { CharacterProfile } = require('../src/ai/characterProfile');
    return { traits: CharacterProfile.getTraitDefinitions(), tones: CharacterProfile.getToneOptions(), behaviorModes: CharacterProfile.getBehaviorModes(), defaults: CharacterProfile.getDefaults() };
  } catch { return null; }
});

// ── Memory ────────────────────────────────────────────────────────────────────

ipcMain.handle('memory:all',        ()      => { try { return bot?.memory?.allEnriched() ?? []; } catch { return []; } });
ipcMain.handle('memory:add',        (_, d)  => { try { return bot ? bot.addMemory(d) : { ok: false, error: 'Not connected' }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('memory:delete',     (_, r)  => { try { return { ok: bot?.memory?.forget(r) ?? false }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('memory:refresh',    async (_, id) => { try { return await (bot?.refreshLocation(id) ?? { ok: false, reason: 'Not connected' }); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('memory:invalidate', (_, id) => { try { return { ok: bot?.memory?.invalidate(id) ?? false }; } catch { return { ok: false }; } });
ipcMain.handle('memory:stats',      ()      => { try { return bot?.memory?.stats() ?? { total:0, stale:0, byType:{} }; } catch { return {}; } });

// ── Staleness ─────────────────────────────────────────────────────────────────

ipcMain.handle('staleness:getAll', () => {
  try { return bot?.staleness?.getAllCategories() ?? _staticStaleness(); }
  catch { return _staticStaleness(); }
});
ipcMain.handle('staleness:getGlobals', () => {
  try { return bot?.staleness?.getGlobals() ?? { answerFromCacheFirst:true, alwaysVerifyBeforeAction:false, staleWarningThresholdPct:80 }; }
  catch { return {}; }
});
ipcMain.handle('staleness:setCategory', (_, k, p) => {
  try {
    if (bot?.staleness) return { ok: bot.staleness.setCategory(k, p) };
    const { StalenessConfig } = require('../src/memory/stalenessConfig');
    new StalenessConfig().setCategory(k, p);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('staleness:setBulk', (_, cats) => {
  try {
    if (bot?.staleness) { bot.staleness.setBulk(cats); return { ok: true }; }
    const { StalenessConfig } = require('../src/memory/stalenessConfig');
    new StalenessConfig().setBulk(cats);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('staleness:setGlobals', (_, p) => {
  try {
    if (bot?.staleness) { bot.staleness.setGlobals(p); return { ok: true }; }
    const { StalenessConfig } = require('../src/memory/stalenessConfig');
    new StalenessConfig().setGlobals(p);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('staleness:reset', () => {
  try {
    if (bot?.staleness) { bot.staleness.resetToDefaults(); return { ok: true }; }
    const { StalenessConfig } = require('../src/memory/stalenessConfig');
    new StalenessConfig().resetToDefaults();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('staleness:metadata', () => {
  try { const { StalenessConfig } = require('../src/memory/stalenessConfig'); return StalenessConfig.getMetadata(); }
  catch { return {}; }
});

// ── Permissions ───────────────────────────────────────────────────────────────

ipcMain.handle('permissions:state',    ()        => { try { return bot?.permissions?.getState() ?? { trustLevel:'COMPANION', granted:[], revoked:[], pendingCount:0 }; } catch { return {}; } });
ipcMain.handle('permissions:setTrust', (_, lv)   => { try { bot?.permissions?.setTrustLevel(lv); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('permissions:grant',    (_, a, o) => { try { if (!a) return { ok:false,error:'No action' }; bot?.permissions?.grant(a, o||{}); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('permissions:revoke',   (_, a)    => { try { if (!a) return { ok:false,error:'No action' }; bot?.permissions?.revoke(a); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// ── Resources ─────────────────────────────────────────────────────────────────

ipcMain.handle('resources:getLimits',  ()     => { try { return bot?.resources?.getLimits() ?? { cpuPercent:25, ramGb:2, dynamicMode:true }; } catch { return {}; } });
ipcMain.handle('resources:setLimits',  (_, l) => { try { bot?.resources?.setLimits(l); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('resources:setProfile', (_, p) => { try { if (!p) return { ok:false }; bot?.resources?.setProfile(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('resources:getMetrics', ()     => { try { return bot?.resources?.getMetrics() ?? {}; } catch { return {}; } });

// ── Log ───────────────────────────────────────────────────────────────────────

ipcMain.handle('log:getAll', ()  => { try { return [...persistedLog].reverse().slice(0, 500); } catch { return []; } });
ipcMain.handle('log:clear',  ()  => { try { persistedLog = []; saveLog(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// ── Prefs ─────────────────────────────────────────────────────────────────────

ipcMain.handle('prefs:get', ()     => { try { return loadPrefs(); } catch { return {}; } });
ipcMain.handle('prefs:set', (_, p) => { try { return savePrefs(p); } catch { return {}; } });

// ── Shell ─────────────────────────────────────────────────────────────────────

ipcMain.handle('shell:openDataFolder', () => { try { shell.openPath(DATA_DIR); return { ok: true }; } catch { return { ok: false }; } });

// ── Helpers ───────────────────────────────────────────────────────────────────

function _staticStaleness() {
  try { const { StalenessConfig } = require('../src/memory/stalenessConfig'); return new StalenessConfig().getAllCategories(); }
  catch { return []; }
}
