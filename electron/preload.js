'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = new Set([
  'bot:status','bot:chat','bot:resources','bot:profile','bot:memory',
  'bot:permissions','bot:staleness','bot:character','bot:log','bot:error',
  'bot:llm','bot:llm-error','bot:llm-config','bot:worker','bot:bgevent',
  'bot:social',
]);

contextBridge.exposeInMainWorld('companion', {
  // Bot
  connect:       cfg       => ipcRenderer.invoke('bot:connect', cfg),
  disconnect:    ()        => ipcRenderer.invoke('bot:disconnect'),
  sendChat:      msg       => ipcRenderer.invoke('bot:chat', msg),
  offlineChat:   (msg,cfg) => ipcRenderer.invoke('bot:offlineChat', msg, cfg),

  // Character
  characterGet:      ()        => ipcRenderer.invoke('character:get'),
  characterSet:      p         => ipcRenderer.invoke('character:set', p),
  characterSetTrait: (k,v)     => ipcRenderer.invoke('character:setTrait', k, v),
  characterReset:    ()        => ipcRenderer.invoke('character:reset'),
  characterMetadata: ()        => ipcRenderer.invoke('character:metadata'),

  // Memory
  memoryAll:       ()  => ipcRenderer.invoke('memory:all'),
  memoryAdd:       d   => ipcRenderer.invoke('memory:add', d),
  memoryDelete:    r   => ipcRenderer.invoke('memory:delete', r),
  memoryRefresh:   id  => ipcRenderer.invoke('memory:refresh', id),
  memoryInvalidate:id  => ipcRenderer.invoke('memory:invalidate', id),
  memoryStats:     ()  => ipcRenderer.invoke('memory:stats'),

  // Staleness
  stalenessGetAll:      ()        => ipcRenderer.invoke('staleness:getAll'),
  stalenessGetGlobals:  ()        => ipcRenderer.invoke('staleness:getGlobals'),
  stalenessSetCategory: (k,p)     => ipcRenderer.invoke('staleness:setCategory', k, p),
  stalenessSetBulk:     cats      => ipcRenderer.invoke('staleness:setBulk', cats),
  stalenessSetGlobals:  p         => ipcRenderer.invoke('staleness:setGlobals', p),
  stalenessReset:       ()        => ipcRenderer.invoke('staleness:reset'),
  stalenessMetadata:    ()        => ipcRenderer.invoke('staleness:metadata'),

  // Permissions
  permState:    ()      => ipcRenderer.invoke('permissions:state'),
  permSetTrust: lv      => ipcRenderer.invoke('permissions:setTrust', lv),
  permGrant:    (a,o)   => ipcRenderer.invoke('permissions:grant', a, o),
  permRevoke:   a       => ipcRenderer.invoke('permissions:revoke', a),

  // Resources
  resGetLimits:  ()  => ipcRenderer.invoke('resources:getLimits'),
  resSetLimits:  l   => ipcRenderer.invoke('resources:setLimits', l),
  resSetProfile: p   => ipcRenderer.invoke('resources:setProfile', p),
  resGetMetrics: ()  => ipcRenderer.invoke('resources:getMetrics'),

  // LLM
  llmGetConfig:  ()       => ipcRenderer.invoke('llm:getConfig'),
  llmSetConfig:  p        => ipcRenderer.invoke('llm:setConfig', p),
  llmGetStats:   ()       => ipcRenderer.invoke('llm:getStats'),
  llmTestOllama: (u,m)    => ipcRenderer.invoke('llm:testOllama', u, m),
  llmTestOpenAI: (k,m)    => ipcRenderer.invoke('llm:testOpenAI', k, m),
  llmTestClaude: (k,m)    => ipcRenderer.invoke('llm:testClaude', k, m),

  // Background Events (system log)
  bgEventsGetAll: () => ipcRenderer.invoke('bgevents:getAll'),
  bgEventsClear:  () => ipcRenderer.invoke('bgevents:clear'),

  // Social energy
  socialGet: ()  => ipcRenderer.invoke('social:get'),
  socialSet: (p) => ipcRenderer.invoke('social:set', p),

  // Log
  logGetAll: ()  => ipcRenderer.invoke('log:getAll'),
  logClear:  ()  => ipcRenderer.invoke('log:clear'),

  // Prefs
  prefsGet: ()   => ipcRenderer.invoke('prefs:get'),
  prefsSet: p    => ipcRenderer.invoke('prefs:set', p),

  // Shell
  openDataFolder: () => ipcRenderer.invoke('shell:openDataFolder'),

  // Events renderer ← main
  on: (channel, cb) => {
    if (!ALLOWED.has(channel)) return () => {};
    const fn = (_, d) => { try { cb(d); } catch(e) { console.error('[preload]', channel, e.message); } };
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
