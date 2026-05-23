'use strict';

const path = require('path');
const fs = require('fs');

function appRoot() {
  return process.env.COMPANION_APP_ROOT || path.resolve(__dirname, '..');
}

function dataDir() {
  const dir = process.env.COMPANION_DATA_DIR || path.join(appRoot(), 'data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function envFile() {
  return process.env.COMPANION_ENV_FILE || path.join(appRoot(), '.env');
}

function resolveDataFile(name) {
  return path.join(dataDir(), name);
}

module.exports = { appRoot, dataDir, envFile, resolveDataFile };
