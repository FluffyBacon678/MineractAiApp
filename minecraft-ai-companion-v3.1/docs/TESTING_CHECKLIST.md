# Testing Checklist

## App launch
- [ ] App opens without white screen.
- [ ] Settings panel loads.
- [ ] Character panel loads.
- [ ] Memory panel loads.
- [ ] Permissions panel loads.
- [ ] Activity log works.

## Provider checks
- [ ] Ollama test shows online when Ollama is running.
- [ ] Ollama failure is readable when Ollama is offline.
- [ ] OpenAI key test works when key is configured.
- [ ] OpenAI failure does not crash app.

## Minecraft connection
- [ ] Open Minecraft Java world to LAN.
- [ ] Copy LAN port into Settings.
- [ ] Bot joins world.
- [ ] Wrong port gives readable error.
- [ ] Disconnect does not crash app.

## Core commands
- [ ] `follow me`
- [ ] `wait here`
- [ ] `loiter here`
- [ ] `be quiet`
- [ ] `be talkative`

## Memory
- [ ] `this is my house` creates a memory.
- [ ] Memory appears in UI.
- [ ] Memory survives app restart.
- [ ] Bot answers with freshness/age when using cached knowledge.

## Safety
- [ ] Bot refuses or asks permission before breaking blocks.
- [ ] Bot refuses or asks permission before taking from chests.
- [ ] Bot refuses hard-forbidden actions.
- [ ] Permission revocation works.
- [ ] World-changing actions are logged.

## Packaging
- [ ] Portable EXE opens.
- [ ] Installer creates shortcut.
- [ ] Packaged app stores user data outside app install folder.
