# GitHub Setup

## Easiest method: GitHub Desktop

1. Install GitHub Desktop.
2. Choose **File > Add local repository**.
3. Select this project folder.
4. If prompted, create a repository.
5. Commit all files.
6. Click **Publish repository**.
7. Keep the repo private while testing.

## Command-line method

Create an empty GitHub repo named:

```text
minecraft-ai-companion
```

Then run from this project folder:

```bash
git init
git add .
git commit -m "Initial Minecraft AI Companion project"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/minecraft-ai-companion.git
git push -u origin main
```

## Important

Do not commit:

- `.env`
- OpenAI API keys
- `node_modules/`
- `dist/`
- personal `data/*.json`
- built EXE/installer files

The `.gitignore` is already configured for this.

## After pushing

Open the repo on GitHub and check:

- The Actions tab has the Windows build workflow.
- The docs folder exists.
- The issue templates exist.
- No secrets were uploaded.

## When Claude has tokens again

Send Claude this file first:

```text
docs/CLAUDE_HANDOFF.md
```

Then give it one milestone at a time from:

```text
docs/ROADMAP.md
```
