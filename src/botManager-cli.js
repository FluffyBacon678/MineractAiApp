'use strict';

/**
 * CLI entry point — runs the bot without Electron.
 * Useful on the secondary Dell laptop or for quick testing.
 * Usage:  node src/botManager-cli.js
 */

require('dotenv').config();
const readline   = require('readline');
const BotManager = require('./botManager');

const bot = new BotManager();

bot.on('status',    s  => console.log(`\n[Status] ${s}`));
bot.on('chat',      c  => console.log(`[Chat] ${c.from}: ${c.message}`));
bot.on('log',       l  => { if (typeof l === 'string') console.log(`[Log] ${l}`); });
bot.on('error',     e  => console.error(`[Error] ${e}`));
bot.on('resources', r  => process.stdout.write(`\r[CPU ${r.cpu}% · RAM ${r.ram}GB · ${r.profile}]     `));
bot.on('memory',    m  => console.log(`\n[Memory] ${m.type}: ${m.payload?.name || JSON.stringify(m.payload).slice(0,60)}`));

bot.connect();

// ── Simple REPL ───────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

console.log('Companion CLI — type a message to chat, or:');
console.log('  /mem <name> <type> <x> <y> <z>   — add a memory location');
console.log('  /forget <name>                    — remove a memory');
console.log('  /status                           — show current bot status');
console.log('  /profile <lightweight|normal|heavy> — change resource profile');
console.log('  /quit                             — exit\n');

rl.prompt();

rl.on('line', line => {
  const cmd = line.trim();
  if (!cmd) { rl.prompt(); return; }

  if (cmd === '/quit' || cmd === '/exit') {
    console.log('Shutting down…');
    bot.destroy();
    process.exit(0);
  }

  if (cmd === '/status') {
    console.log(`Status: ${bot.status} | Connected: ${bot.connected}`);
    console.log('Memory:', bot.memory.stats());
    rl.prompt(); return;
  }

  if (cmd.startsWith('/profile ')) {
    const profile = cmd.slice(9).trim();
    bot.resources.setProfile(profile);
    console.log(`Profile → ${profile}`);
    rl.prompt(); return;
  }

  if (cmd.startsWith('/mem ')) {
    const parts = cmd.slice(5).trim().split(/\s+/);
    const [name, type, x, y, z] = parts;
    if (!name || isNaN(Number(x))) {
      console.log('Usage: /mem <name> <type> <x> <y> <z>');
      rl.prompt(); return;
    }
    try {
      const result = bot.addMemory({ name, type: type || 'poi',
        coordinates: { x: Number(x), y: Number(y) || 64, z: Number(z) || 0 } });
      console.log(`Memory saved: ${result?.location?.name || '?'}`);
    } catch (err) {
      console.error('Failed:', err.message);
    }
    rl.prompt(); return;
  }

  if (cmd.startsWith('/forget ')) {
    const name = cmd.slice(8).trim();
    const ok = bot.memory.forget(name);
    console.log(ok ? `Forgotten: ${name}` : `Not found: ${name}`);
    rl.prompt(); return;
  }

  if (cmd.startsWith('/')) {
    console.log(`Unknown command: ${cmd}`);
    rl.prompt(); return;
  }

  // Send as chat
  bot.sendChat(cmd);
  rl.prompt();
});

rl.on('close', () => { bot.destroy(); process.exit(0); });

process.on('SIGINT',  () => { bot.destroy(); process.exit(0); });
process.on('SIGTERM', () => { bot.destroy(); process.exit(0); });
process.on('uncaughtException', err => {
  console.error('[Uncaught]', err.message);
  // Don't exit — let the bot keep running
});
