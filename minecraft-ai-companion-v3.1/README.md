# Minecraft AI Companion v0.3

A desktop application that joins your Minecraft Java Edition world as a real bot player, providing an immersive companion with spatial world memory, configurable personality, permission-gated world interaction, and resource-aware AI — all running locally.

---

## Quick Start

```bash
npm install
npm start          # opens the Electron desktop app

# Headless (no UI, useful on secondary machine):
npm run bot-only
```

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 18 or newer | https://nodejs.org |
| Ollama | latest | https://ollama.com |
| Minecraft Java | 1.21.x | Open to LAN or dedicated server |

**Pull a model before starting:**
```bash
ollama pull llama3.2          # recommended
ollama pull qwen2.5:3b        # faster on weaker hardware
ollama pull mistral           # good quality alternative
```

---

## How to Connect to Your World

### LAN world (easiest)
1. Launch Minecraft and open your world
2. Press **Escape → Open to LAN → Start LAN World**
3. Note the port shown in chat (e.g. `19132`)
4. In the Companion app: set Host = `localhost`, Port = that number
5. Click **Join World**

### Dedicated server
- Set `online-mode=false` in `server.properties`
- Add the bot username (`Bud` by default) to the whitelist
- Set Host/Port in Settings to match your server

---

## File Structure

```
companion/
├── electron/
│   ├── main.js              ← Electron main process + all IPC handlers
│   ├── preload.js           ← Secure context bridge to renderer
│   └── ui/index.html        ← Full desktop control panel (9 panels)
├── src/
│   ├── botManager.js        ← Core controller, wires all subsystems
│   ├── botManager-cli.js    ← Headless CLI mode (no Electron)
│   ├── config.js            ← Settings, .env loading, deep merge
│   ├── stateMachine.js      ← Deterministic behaviour: FOLLOW/WAIT/LOITER/OBSERVE
│   ├── observer.js          ← World scanning, ambient comments, profile-reactive timers
│   ├── ai/
│   │   ├── characterProfile.js  ← Bud's identity, traits, LLM system prompt builder
│   │   ├── dialogue.js          ← LLM speech generation with circuit-breaker
│   │   └── intentParser.js      ← LLM chat → structured intent JSON
│   ├── memory/
│   │   ├── worldMemory.js       ← Spatial memory store (JSON-backed, enriched staleness)
│   │   ├── stalenessConfig.js   ← Per-category configurable cache intervals
│   │   └── memoryParser.js      ← LLM: detects location definition commands
│   ├── permissions/
│   │   └── permissionManager.js ← Trust levels, action gating, approval flow
│   └── system/
│       └── resourceManager.js   ← CPU/RAM monitoring, profiles, dynamic scaling
└── data/                    ← Auto-created on first run
    ├── world-memory.json        ← Saved locations, events, action log
    ├── character-profile.json   ← Bud's identity (name, traits, backstory…)
    ├── staleness-config.json    ← Per-category cache intervals
    └── activity-log.json        ← Persisted UI activity log
```

---

## In-Game Commands (Minecraft chat)

Everything below is understood by natural language — you don't need exact phrasing.

**Movement**
```
follow me           → bot pathfinds toward you (natural pace)
wait here / stay    → bot stops and idles with head movement
loiter here         → bot wanders a small radius casually
go to my house      → navigates to saved player house
go home             → navigates to saved AI home
```

**Observation**
```
what do you see?    → describes nearby entities, weather, crops
note your surroundings
```

**Personality**
```
be talkative        → enables spontaneous ambient comments
be quiet            → only speaks when addressed
```

**Memory** (bot saves your current position)
```
this is my house    → saves as player house at current coords
this is your house  → saves as AI home
this is the tomato farm → saves as farm type
forget the village  → removes that memory
rename this to Main Base
this village is abandoned now → updates notes
```

**Memory queries**
```
do you remember my house?
where is the tomato farm?
how many villagers are there?
```

**Permissions**
```
you can harvest crops
you may open chests
do not touch storage
read-only mode
worker mode / autonomous mode
yes / no            → approve or deny a pending action request
```

---

## Desktop App Panels

| Panel | Purpose |
|---|---|
| **Dashboard** | Live status, resource meters, recent chat, quick action buttons |
| **Chat** | Talk to the companion — works offline (routes directly to Ollama) |
| **Character** | Edit Bud's identity, personality traits, backstory, tone |
| **Memory** | View/add/delete saved world locations with freshness indicators |
| **Cache Timing** | Configure per-category staleness intervals and global cache behaviour |
| **Permissions** | Set trust level, grant/revoke action categories |
| **Resources** | Set CPU/RAM limits, enable Dynamic Mode, switch profiles |
| **Settings** | Server connection, Ollama URL, behaviour tuning |
| **Activity Log** | Persistent log of bot actions, memory changes, errors |

---

## Spatial Memory

The companion builds a world model in `data/world-memory.json`. Every location stores coordinates, type, owner, confidence, cached state, and a staleness timestamp.

**Staleness system** — each memory type has its own configurable refresh interval:
- House/base: 24h by default
- Farm/crops: 10 min
- Chest contents: 3 min
- Hostile mob positions: 30 sec
- Waypoints: 7 days
- All configurable from the **Cache Timing** panel

The bot answers from cache first and notes freshness:
> *"I remember the tomato farm at 120, 64, -340. Last checked 6 minutes ago."*
> *"I counted 8 villagers 2 hours ago — may be outdated (updates every 15m)."*

---

## Permission System

The bot is **read-only by default**. Four trust levels:

| Level | Can do |
|---|---|
| Observer | Movement, chat, observation only |
| Companion | + harmless interactions |
| Worker | + explicitly granted action categories |
| Autonomous | + broad permissions within player limits |

**Hard-forbidden forever**, regardless of trust level or explicit grants:
`use_lava`, `use_tnt`, `use_fire`, `mass_destruction`, `attack_passive`

---

## Resource Profiles

| Profile | LLM | Scan interval | Talk interval | Background |
|---|---|---|---|---|
| Lightweight | Off | 60 s | Off | No |
| Normal | On | 15 s | 45 s | No |
| Heavy | On | 8 s | 25 s | Yes |

**Dynamic Mode** (default on): monitors CPU/RAM every 5 s and switches profiles automatically. While you're actively playing, it stays conservative. When you're AFK it can escalate to heavy.

---

## Distributed Setup (Gaming PC + Secondary Machine)

Run Ollama on the secondary machine (Dell laptop or other):
```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

In the Companion app Settings, set Ollama URL to the secondary machine's LAN IP:
```
http://192.168.1.XX:11434
```

The bot process and Minecraft run on your gaming PC; all LLM processing is offloaded to the secondary machine.

---

## Troubleshooting

**Bot connects then immediately disconnects**
- Check that `MC_VERSION` in `.env` (or Settings) exactly matches your server version string, e.g. `1.21.1` not `1.21`
- Run `node -e "console.log(require('minecraft-data').versions.pc.map(v=>v.minecraftVersion))"` after `npm install` to see valid version strings

**LLM calls time out**
- Ollama loads the model on first call — this can take 10–30 s. Retry after the model is warm
- Try a smaller model: `ollama pull qwen2.5:3b`
- Increase timeout: set `OLLAMA_TIMEOUT_MS=30000` in `.env`

**Bot doesn't respond to chat**
- Ensure the bot username (`Bud`) is different from your player username — the bot ignores its own messages
- Check the Activity Log panel for errors

**"Bot not running" when saving memory from the app**
- You can only add memories from the app while the bot is connected. When offline, add them in-game with natural language ("this is my house") or pre-populate by adding entries in the Memory panel after connecting

**pathfinder errors / bot won't move**
- Ensure the bot spawns on solid ground. It cannot pathfind if stuck inside a block
- The bot retries navigation with try/catch — check the Activity Log for navigation errors

**Electron won't start / white screen**
- Run `npm install` again — missing `node_modules` is the most common cause
- Ensure Node.js 18+: `node --version`
- Check the terminal for any startup error messages

**Skin preview doesn't load in Character panel**
- The avatar fetches from `crafatar.com` — requires an internet connection
- If offline, it falls back to an emoji placeholder automatically

---

## CLI Mode (no Electron)

Useful on the secondary Dell laptop or for testing:

```bash
node src/botManager-cli.js
```

Commands in the CLI REPL:
```
/status                           show bot status and memory stats
/mem <name> <type> <x> <y> <z>   add a memory location
/forget <name>                    remove a memory
/profile <lightweight|normal|heavy>  change resource profile
/quit                             exit cleanly
<anything else>                   send as bot chat
```

---

## Character Customisation

Edit `data/character-profile.json` directly or use the Character panel. Fields:

- **name** — displayed in titlebar and used in LLM prompts
- **skinUsername** — Minecraft username whose skin to fetch for the portrait
- **speakingTone** — buddy / calm / enthusiastic / thoughtful / playful / stoic / warm
- **defaultBehaviorMode** — initial state when joining a world
- **backstory** — injected verbatim into the LLM system prompt
- **playerRelationship / villagerRelationship** — shapes how the companion talks about others
- **traits** — 8 sliders (1–10): friendliness, helpfulness, curiosity, courage, talkativeness, humor, formality, independence
- **additionalNotes** — extra character rules or quirks

All trait values directly influence the LLM temperature and system prompt wording. Changes take effect immediately without restarting.

---

## Data Files

All persistent data lives in `data/` (auto-created):

| File | Contains |
|---|---|
| `world-memory.json` | All saved locations, cached states, action log |
| `character-profile.json` | Bud's full identity and personality settings |
| `staleness-config.json` | Per-category cache intervals and global settings |
| `activity-log.json` | Persisted UI activity log (last 500 entries) |

Back these up to preserve your companion's world knowledge between reinstalls.

---

## Windows app / no-CMD launch

This repo now includes Windows helper launchers:

- `Install_And_Run.bat` — first-time setup: checks Node.js, creates `.env`, installs dependencies, then opens the app.
- `Start_Companion.bat` — normal double-click launcher after setup.
- `Build_Windows_Installer.bat` — builds the real Windows installer and portable EXE into `dist/`.

Developer run:

```bash
npm install
npm start
```

Project validation:

```bash
npm run check
```

Build installer:

```bash
npm run dist:win
```

The packaged app stores persistent data in Electron's userData directory instead of the install folder, so reinstalling/updating the app should not erase Bud's memories, character profile, UI preferences, or activity log. Use **Settings → Open Data Folder** in the app to see the active data folder.

## GitHub Actions build

A Windows build workflow is included at:

```text
.github/workflows/build-windows.yml
```

After pushing the repo to GitHub, open **Actions → Build Windows app → Run workflow**. GitHub will upload the built installer/portable app as an artifact.

See `GITHUB_SETUP.md` for first-push commands.
