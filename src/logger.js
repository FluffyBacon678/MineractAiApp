'use strict';

/**
 * logger — centralized, file-based logging for the Companion app.
 *
 * Usage:
 *   const log = require('./logger');      // or '../logger', '../../logger' etc.
 *   log.info('MyModule',  'Something happened');
 *   log.warn('MyModule',  'Something odd',    'detail string');
 *   log.error('MyModule', 'Something broke',  err.message);
 *   log.llm  ('LLMRouter','ollama:llama3.2 → 42 chars in 820ms');
 *   log.bot  ('BotManager','Connected as Bud');
 *
 * Initialization (call once from main.js / cli entry-point):
 *   log.init(path.join(dataDir, 'logs'));
 *
 * Log files written to <logsDir>/:
 *   app.log    — everything (all levels + llm + bot)
 *   bot.log    — bot lifecycle, connection, chat, state
 *   llm.log    — every LLM call with provider, model, timing, tokens
 *   errors.log — WARN + ERROR only, from any source
 *
 * Files rotate at 2 MB (renamed to .old.log). One .old.log kept per file.
 */

const fs   = require('fs');
const path = require('path');

// ── State ─────────────────────────────────────────────────────────────────────

let _dir          = null;           // resolved logs directory (null until init)
const MAX_BYTES   = 2_000_000;      // 2 MB per file before rotation
const COL_MOD     = 16;             // column width for the module name

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Must be called once before any log writes (usually at process start in main.js).
 * Safe to call multiple times — second call is a no-op.
 */
function init(logsDir) {
  if (_dir) return;           // already initialised
  _dir = logsDir;
  try { fs.mkdirSync(_dir, { recursive: true }); } catch {}

  // Write a visible session separator so log files show where each launch begins
  const ts  = new Date().toISOString();
  const bar = '═'.repeat(72);
  const sep = `\n${bar}\n  SESSION START  ${ts}\n${bar}\n`;
  _write('app.log',    sep);
  _write('bot.log',    sep);
  _write('llm.log',    sep);
  _write('errors.log', sep);

  info('Logger', `Log directory: ${_dir}`);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function _ts() {
  // "2026-05-24 21:45:00.123"
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function _fmt(level, mod, msg, detail) {
  const modCol  = String(mod).slice(0, COL_MOD).padEnd(COL_MOD);
  const detStr  = detail != null
    ? ` | ${String(detail).replace(/\r?\n/g, ' ↵ ').slice(0, 500)}`
    : '';
  return `[${_ts()}] [${level.padEnd(5)}] [${modCol}] ${msg}${detStr}\n`;
}

// ── File I/O ─────────────────────────────────────────────────────────────────

function _write(file, text) {
  if (!_dir) return;
  const p = path.join(_dir, file);
  try {
    // Rotate if file is too large
    try {
      if (fs.statSync(p).size > MAX_BYTES) {
        const op = p.replace('.log', '.old.log');
        try { fs.unlinkSync(op); } catch {}
        fs.renameSync(p, op);
      }
    } catch { /* file may not exist yet — that's fine */ }
    fs.appendFileSync(p, text, 'utf8');
  } catch { /* never throw from logger */ }
}

// ── Core emit ─────────────────────────────────────────────────────────────────

function _emit(level, files, mod, msg, detail) {
  const line = _fmt(level, mod, msg, detail);

  // Console mirror
  if      (level === 'ERROR') console.error(line.trimEnd());
  else if (level === 'WARN')  console.warn (line.trimEnd());
  else                        console.log  (line.trimEnd());

  // File writes
  for (const f of files) _write(f, line);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** General information — written to app.log */
function info(mod, msg, detail) {
  _emit('INFO',  ['app.log'], mod, msg, detail);
}

/** Warning — written to app.log + errors.log */
function warn(mod, msg, detail) {
  _emit('WARN',  ['app.log', 'errors.log'], mod, msg, detail);
}

/** Error — written to app.log + errors.log */
function error(mod, msg, detail) {
  _emit('ERROR', ['app.log', 'errors.log'], mod, msg, detail);
}

/** Debug / verbose — written to app.log only (keep these sparse) */
function debug(mod, msg, detail) {
  _emit('DEBUG', ['app.log'], mod, msg, detail);
}

/**
 * LLM call record — written to app.log + llm.log.
 * Suggested format: "ollama:llama3.2 → 87 chars in 1240ms [standard]"
 */
function llm(mod, msg, detail) {
  _emit('LLM',   ['app.log', 'llm.log'], mod, msg, detail);
}

/**
 * Bot lifecycle event — written to app.log + bot.log.
 * e.g. "Connected as Bud", "Disconnected", "Chat from Player: hello"
 */
function bot(mod, msg, detail) {
  _emit('BOT',   ['app.log', 'bot.log'], mod, msg, detail);
}

/**
 * Convenience: log an Error object with its stack trace.
 * Written to app.log + errors.log.
 */
function exception(mod, msg, err) {
  const detail = err instanceof Error
    ? `${err.message} — ${(err.stack || '').split('\n').slice(1, 4).join(' | ')}`
    : String(err);
  _emit('ERROR', ['app.log', 'errors.log'], mod, msg, detail);
}

/** Returns the resolved log directory path (null before init). */
function logsDir() { return _dir; }

module.exports = { init, info, warn, error, debug, llm, bot, exception, logsDir };
