# Release Process

## Local release test

```bash
npm install
npm run check
npm start
npm run dist:portable
npm run dist:win
```

## GitHub release

1. Merge stable changes to `main`.
2. Update version in `package.json`.
3. Commit version bump.
4. Tag the release.

```bash
git tag v0.3.1
git push origin main --tags
```

5. GitHub Actions builds the Windows artifact.
6. Download and test the artifact.
7. Create a GitHub Release and attach the installer/portable build.

## Release notes template

```text
## Minecraft AI Companion vX.Y.Z

### Added
-

### Fixed
-

### Changed
-

### Known issues
-

### Test notes
-
```
