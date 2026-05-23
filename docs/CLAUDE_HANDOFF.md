# Claude Handoff

When Claude has tokens again, start here.

## Current priority
Milestone 0: repository stabilization.

## Task order
1. Inspect `.gitignore` and confirm secrets/runtime data/build outputs are excluded.
2. Run `npm install` from a clean clone.
3. Run `npm run check`.
4. Run `npm start` and verify the Electron app opens.
5. Check `package.json` Electron Builder config.
6. Verify GitHub Actions workflow can build Windows artifacts.
7. Do not add new gameplay features until the repo/build flow is stable.

## Project safety rules
- Default bot behavior is read-only.
- LLMs cannot directly execute world actions.
- All world modifications must pass through permissions.
- Risky behavior must ask approval.
- Hard-forbidden actions stay forbidden unless the human explicitly changes policy.

## Expected output from Claude
For every change, Claude should report:

```text
Files changed:
- path/file.js — why it changed

Commands run:
- npm run check

Result:
- pass/fail

Risks:
- anything that needs human testing
```
