# Minecraft AI Companion Roadmap

## Product goal
Build a local-first Minecraft Java Edition companion that joins a LAN/server world as a real player-like bot, behaves like an immersive inhabitant, remembers the world, and grows into careful helper behavior over time.

## Non-negotiable rules
- Minecraft performance comes first.
- World safety comes before automation.
- LLMs may interpret intent and produce dialogue, but must not directly execute raw world actions.
- All world-changing actions must pass through deterministic permission checks.
- Default behavior is read-only.
- GitHub is the source of truth; ZIPs are for releases only.

## Milestone 0 — Repository stabilization
- Verify `.gitignore` excludes secrets, runtime data, `node_modules`, and build outputs.
- Verify fresh clone can run with `npm install` and `npm start`.
- Verify `npm run check` passes.
- Add issue templates, PR template, AI handoff docs, release docs, and testing checklist.
- Ensure GitHub Actions can build Windows artifacts.

## Milestone 1 — Real app packaging
- Build Windows portable EXE and installer.
- Add friendly first-run setup.
- Add missing dependency checks.
- Add desktop shortcut flow.
- Make errors readable for non-developers.

## Milestone 2 — Reliable Minecraft connection
- Robust LAN host/port/version settings.
- Clear wrong-port and wrong-version errors.
- Reconnect/disconnect handling.
- Connection status events in the UI.

## Milestone 3 — Core companion behavior
- Follow player.
- Wait here.
- Loiter here.
- Come here.
- Quiet/talkative modes.
- Natural idle head movement.
- No unsafe world edits.

## Milestone 4 — Character and dialogue
- Persistent Bud profile.
- Editable traits, tone, name, skin, backstory, and relationships.
- Ollama/OpenAI provider settings.
- Offline chat.
- Graceful fallback when AI providers fail.

## Milestone 5 — Persistent world memory
- Named places.
- Homes/farms/chests/villagers/animals/danger zones.
- Configurable staleness per memory type.
- Cache-first answers with freshness disclosure.
- Memory CRUD UI.

## Milestone 6 — Permissions and safety hardening
- Permission check before every world-changing action.
- Area/task/temporary permissions.
- Approval prompts and timeout.
- Revocation commands.
- Persistent action log.

## Milestone 7 — Useful workers
- Farm watcher.
- Villager counter.
- Patrol observer.
- Dropped item watcher.
- Chest cache checker.
- Worker actions obey permissions.

## Milestone 8 — Performance and Dynamic Mode
- CPU/RAM/LLM usage controls.
- Lightweight/Normal/Heavy profiles.
- Dynamic Mode.
- Scan throttling.
- Cache-aware observation.

## Milestone 9 — Playtest release
- Portable EXE and installer.
- Known issues list.
- Bug report template.
- Crash/error logs.
- Memory/settings backup and reset.
