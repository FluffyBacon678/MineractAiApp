'use strict';
// Lightweight test server: serves electron/ui/index.html with a mocked window.companion API injected.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const HTML_FILE = path.resolve(__dirname, '../electron/ui/index.html');
const PORT = 3847;

const MOCK_SCRIPT = `
<script>
// Mock window.companion for browser-based UI testing (replaces Electron preload)
(function(){
  const _listeners = {};
  const _store = {
    status: 'disconnected',
    connected: false,
    character: {
      name:'Bud', skinUsername:'Bud', speakingTone:'buddy', defaultBehaviorMode:'WAITING',
      backstory:'Bud grew up among villagers...', playerRelationship:'Trusted companion.',
      villagerRelationship:'Protective of villagers.', additionalNotes:'Respects player builds.',
      traits:{ friendliness:8, helpfulness:8, curiosity:7, courage:5, talkativeness:6, humor:5, formality:2, independence:4 }
    },
    charMeta: {
      traits:{ friendliness:{label:'Friendliness',desc:'Warmth',low:'Reserved',high:'Warm and enthusiastic'}, helpfulness:{label:'Helpfulness',desc:'Eager to assist',low:'Lets player figure it out',high:'Constantly offers help'}, curiosity:{label:'Curiosity',desc:'Interest in world',low:'Focused',high:'Always noticing things'}, courage:{label:'Courage',desc:'Reaction to danger',low:'Cautious',high:'Brave and protective'}, talkativeness:{label:'Talkativeness',desc:'Unprompted speech',low:'Quiet',high:'Chatty'}, humor:{label:'Humor',desc:'Lightheartedness',low:'Serious',high:'Playful'}, formality:{label:'Formality',desc:'Speaking register',low:'Casual',high:'Formal and precise'}, independence:{label:'Independence',desc:'Own judgment',low:'Waits for direction',high:'Takes initiative'} },
      tones:[ {value:'buddy',label:'Buddy',desc:'Friendly and casual'},{value:'calm',label:'Calm',desc:'Measured and peaceful'},{value:'enthusiastic',label:'Enthusiastic',desc:'Energetic and eager'},{value:'thoughtful',label:'Thoughtful',desc:'Reflective, considered'},{value:'playful',label:'Playful',desc:'Light-hearted'},{value:'stoic',label:'Stoic',desc:'Few words, direct'},{value:'warm',label:'Warm',desc:'Caring, empathetic'} ],
      behaviorModes:['WAITING','FOLLOWING','LOITERING','OBSERVING'],
      defaults:{}
    },
    memory:[
      { id:'m1', name:'Player House', type:'house', owner:'player', coordinates:{x:120,y:64,z:-88}, confidence:0.95, lastObserved: Date.now()-60000*5, freshnessBadge:'fresh', freshnessPercent:10, staleSummary:'5m ago', intervalLabel:'24h', isStale:false, isWarning:false },
      { id:'m2', name:'Tomato Farm', type:'farm', owner:'player', coordinates:{x:200,y:64,z:150}, confidence:0.9, lastObserved: Date.now()-60000*9, freshnessBadge:'warn', freshnessPercent:85, staleSummary:'9m ago', intervalLabel:'10m', isStale:false, isWarning:true },
      { id:'m3', name:'Old Village', type:'village', owner:'neutral', coordinates:{x:-340,y:65,z:220}, confidence:0.8, lastObserved: Date.now()-60000*20, freshnessBadge:'stale', freshnessPercent:100, staleSummary:'20m ago', intervalLabel:'15m', isStale:true, isWarning:false },
    ],
    permissions:{ trustLevel:'COMPANION', granted:[], revoked:[], pendingCount:0 },
    limits:{ cpuPercent:25, ramGb:2, dynamicMode:true },
    metrics:{ cpu:14, ram:5.8, ramPct:36, totalRam:16, profile:'normal' },
    llmConfig:{ ollama:{baseUrl:'http://localhost:11434',model:'llama3.2',timeoutMs:20000}, openai:{apiKey:'',model:'gpt-4o-mini',timeoutMs:15000}, hybrid:{dialogueProvider:'hybrid',intentProvider:'ollama',strategy:'quality_routing',openAiHourlyLimit:30} },
    llmStats:{ ollama:12, openai:3, fallbacks:1, errors:0, openAiCallsThisHour:3, hourlyLimit:30, openAiAvailable:true, ollamaAvailable:true },
    log:[
      {at:Date.now()-5000,  msg:'Connected as Bud'},
      {at:Date.now()-12000, msg:'Memory saved: Player House'},
      {at:Date.now()-30000, msg:'Intent: FOLLOW (0.92)'},
      {at:Date.now()-60000, msg:'Ollama response in 1.2s'},
    ],
    staleness:null,
    prefs:{ width:1200, height:820 },
  };

  // Simulate connect/disconnect toggling
  let _connectTimeout = null;

  window.companion = {
    connect: (cfg) => {
      clearTimeout(_connectTimeout);
      window.companion._emit('bot:status','connecting');
      _connectTimeout = setTimeout(()=>{
        _store.connected = true;
        window.companion._emit('bot:status','idle');
        window.companion._emit('bot:resources',{..._store.metrics});
        window.companion._emit('bot:profile',{profile:'normal'});
        window.companion._emit('bot:character',{..._store.character});
        setTimeout(()=>window.companion._emit('bot:chat',{from:'Bud',message:"Hey! Good to see you again."}), 800);
      }, 1200);
      return Promise.resolve({ok:true});
    },
    disconnect: () => {
      clearTimeout(_connectTimeout);
      _store.connected = false;
      window.companion._emit('bot:status','disconnected');
      return Promise.resolve({ok:true});
    },
    sendChat: (msg) => {
      window.companion._emit('bot:chat',{from:'You',message:msg});
      setTimeout(()=>window.companion._emit('bot:chat',{from:'Bud',message:"Got it — on my way."}), 900);
      return Promise.resolve({ok:true});
    },
    offlineChat: (msg, cfg) => Promise.resolve({ok:true, reply:"Sure, I'm here even when offline.", provider:'ollama'}),

    characterGet:      ()    => Promise.resolve({..._store.character}),
    characterSet:      (p)   => { Object.assign(_store.character,p); return Promise.resolve({ok:true}); },
    characterSetTrait: (k,v) => { _store.character.traits[k]=v; return Promise.resolve({ok:true}); },
    characterReset:    ()    => Promise.resolve({ok:true}),
    characterMetadata: ()    => Promise.resolve({..._store.charMeta}),

    memoryAll:        ()   => Promise.resolve([..._store.memory]),
    memoryAdd:        (d)  => { _store.memory.push({id:'m'+Date.now(),...d,freshnessBadge:'fresh',freshnessPercent:0,staleSummary:'just now',intervalLabel:'10m',isStale:false,isWarning:false,confidence:d.confidence||0.85,lastObserved:Date.now()}); return Promise.resolve({ok:true}); },
    memoryDelete:     (id) => { _store.memory = _store.memory.filter(m=>m.id!==id); return Promise.resolve({ok:true}); },
    memoryRefresh:    (id) => Promise.resolve({ok:true,reason:'Scanned live'}),
    memoryInvalidate: (id) => Promise.resolve({ok:true}),
    memoryStats:      ()   => Promise.resolve({total:_store.memory.length, stale:1, byType:{}}),

    stalenessGetAll:     ()      => Promise.resolve([
      {key:'house_base',    label:'House / Base',      desc:'Player home, AI home, main base',  unit:'hours',   intervalMs:86400000, autoRefresh:true,  alwaysVerify:false},
      {key:'chest_contents',label:'Chest contents',    desc:'Storage chest inventories',         unit:'minutes', intervalMs:180000,   autoRefresh:true,  alwaysVerify:false},
      {key:'farm_crops',    label:'Farm / Crop states',desc:'Crop growth and harvest readiness', unit:'minutes', intervalMs:600000,   autoRefresh:true,  alwaysVerify:false},
      {key:'villagers',     label:'Villager count',    desc:'Number of villagers',               unit:'minutes', intervalMs:900000,   autoRefresh:false, alwaysVerify:false},
      {key:'animals',       label:'Animal counts',     desc:'Livestock and pets',                unit:'minutes', intervalMs:900000,   autoRefresh:false, alwaysVerify:false},
      {key:'hostile_mobs',  label:'Hostile mob positions',desc:'Hostile entities near areas',   unit:'seconds', intervalMs:30000,    autoRefresh:true,  alwaysVerify:true },
      {key:'dropped_items', label:'Dropped items',     desc:'Items on the ground',               unit:'seconds', intervalMs:60000,    autoRefresh:true,  alwaysVerify:false},
      {key:'waypoints',     label:'Waypoints',         desc:'Named coordinate markers',          unit:'hours',   intervalMs:604800000,autoRefresh:false, alwaysVerify:false},
    ]),
    stalenessGetGlobals:  ()     => Promise.resolve({answerFromCacheFirst:true,alwaysVerifyBeforeAction:false,staleWarningThresholdPct:80}),
    stalenessSetCategory: (k,p)  => Promise.resolve({ok:true}),
    stalenessSetBulk:     (cats) => Promise.resolve({ok:true}),
    stalenessSetGlobals:  (p)    => Promise.resolve({ok:true}),
    stalenessReset:       ()     => Promise.resolve({ok:true}),
    stalenessMetadata:    ()     => Promise.resolve({}),

    permState:    ()    => Promise.resolve({..._store.permissions}),
    permSetTrust: (lv)  => { _store.permissions.trustLevel=lv; return Promise.resolve({ok:true}); },
    permGrant:    (a,o) => { _store.permissions.granted.push({action:a,...o}); return Promise.resolve({ok:true}); },
    permRevoke:   (a)   => { _store.permissions.granted=_store.permissions.granted.filter(g=>g.action!==a); return Promise.resolve({ok:true}); },

    resGetLimits:  ()  => Promise.resolve({..._store.limits}),
    resSetLimits:  (l) => { Object.assign(_store.limits,l); return Promise.resolve({ok:true}); },
    resSetProfile: (p) => { window.companion._emit('bot:profile',{profile:p}); return Promise.resolve({ok:true}); },
    resGetMetrics: ()  => Promise.resolve({..._store.metrics}),

    llmGetConfig:  ()     => Promise.resolve({..._store.llmConfig}),
    llmSetConfig:  (p)    => Promise.resolve({ok:true}),
    llmGetStats:   ()     => Promise.resolve({..._store.llmStats}),
    llmTestOllama: (u,m)  => Promise.resolve({ok:true, response:'ok'}),
    llmTestOpenAI: (k,m)  => Promise.resolve({ok:false, error:'No API key in test mode'}),
    llmTestClaude: (k,m)  => Promise.resolve({ok:false, error:'No API key in test mode'}),

    logGetAll: ()  => Promise.resolve([..._store.log].reverse()),
    logClear:  ()  => { _store.log=[]; return Promise.resolve({ok:true}); },

    prefsGet: ()   => Promise.resolve({..._store.prefs}),
    prefsSet: (p)  => { Object.assign(_store.prefs,p); return Promise.resolve({..._store.prefs,...p}); },

    openDataFolder: () => { alert('Would open: data/ folder'); return Promise.resolve({ok:true}); },

    on: (channel, cb) => {
      if (!_listeners[channel]) _listeners[channel] = [];
      _listeners[channel].push(cb);
      return () => { _listeners[channel] = (_listeners[channel]||[]).filter(f=>f!==cb); };
    },

    _emit: (channel, data) => {
      (_listeners[channel]||[]).forEach(cb => { try { cb(data); } catch(e){} });
    },
  };

  // Periodically emit resource metrics while "connected"
  setInterval(()=>{
    if (_store.connected) {
      _store.metrics.cpu = 10 + Math.round(Math.random()*20);
      window.companion._emit('bot:resources',{..._store.metrics});
    }
  }, 3000);
})();
</script>`;

const server = http.createServer((req, res) => {
  let html = fs.readFileSync(HTML_FILE, 'utf8');
  // Inject mock before closing </head>
  html = html.replace('</head>', MOCK_SCRIPT + '\n</head>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('UI test server running on http://127.0.0.1:' + PORT);
});
