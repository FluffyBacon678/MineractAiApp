# AI Collaboration Guide

Use this project through GitHub. Do not pass full ZIPs between assistants during normal development. Use branches, commits, pull requests, and diffs.

## Standard handoff prompt

```text
You are working on the Minecraft AI Companion project.

This is a local-first Electron + Node.js + Mineflayer app. The goal is a safe, immersive Minecraft Java Edition companion bot that joins LAN worlds as a real player-like entity.

Rules:
- Do not remove existing features unless explicitly instructed.
- Preserve deterministic safety boundaries.
- LLMs must not directly execute raw world actions.
- All world-changing behavior must go through the permission system.
- Default mode is read-only.
- Keep the app usable for non-developers.
- GitHub is the source of truth.
- Do not commit .env, API keys, node_modules, dist, release, or personal data files.
- When changing code, explain exactly which files changed and why.
- Add fail cases and readable error messages.
- Prefer small, testable changes.

Current task:
[PASTE ONE TASK HERE]
```

## How to give ChatGPT a change for review

Paste the output of:

```bash
git diff
```

Or, for a committed change:

```bash
git show --stat
git show
```

## How to give Claude/Cursor a task

Give one milestone or one file-level task at a time. Avoid saying “finish everything.” Good examples:

- “Fix the packaged app data path so memory is stored in Electron userData.”
- “Add a friendly error when Mineflayer cannot connect because the LAN port is wrong.”
- “Add tests/checks for permission denial before chest interaction.”

## Review checklist for AI changes

Before accepting changes, check:

- Did it preserve read-only default behavior?
- Did it avoid committing secrets?
- Did it add readable fail cases?
- Did it update docs if behavior changed?
- Does `npm run check` pass?
- Can the app still launch?
