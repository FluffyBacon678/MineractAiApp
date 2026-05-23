'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const required = [
  'package.json', '.env.example', 'electron/main.js', 'electron/preload.js',
  'electron/ui/index.html', 'src/botManager.js', 'src/config.js', 'src/paths.js',
  'src/ai/llmRouter.js', 'src/permissions/permissionManager.js',
  'src/memory/worldMemory.js', 'src/memory/stalenessConfig.js'
];

let failed = false;
for (const rel of required) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error('Missing:', rel);
    failed = true;
  }
}

const jsFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
}
walk(root);
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`Syntax error in ${path.relative(root, file)}\n${r.stderr}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Project check passed. ${jsFiles.length} JavaScript files syntax-clean.`);
