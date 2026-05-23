# Development Workflow

## Recommended setup

Use GitHub Desktop if you want the easiest workflow.

Daily flow:

1. Pull latest changes.
2. Create a feature branch.
3. Make one focused change.
4. Run checks.
5. Commit.
6. Push.
7. Open a pull request or merge after review.

## Branches

- `main` — stable build only.
- `dev` — active integration branch.
- `feature/*` — one feature per branch.
- `fix/*` — one bugfix per branch.

Examples:

```bash
git checkout -b feature/connection-errors
git checkout -b fix/packaged-data-path
```

## Basic commands

```bash
npm install
npm run check
npm start
npm run dist:portable
npm run dist:win
```

## What not to commit

Never commit:

- `.env`
- OpenAI API keys
- `node_modules/`
- `dist/`
- `release/`
- personal `data/*.json` files
- built EXE/installer files

## Versioning

Use tags for releases:

```bash
git tag v0.3.1
git push origin v0.3.1
```
