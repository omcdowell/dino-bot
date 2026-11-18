#!/usr/bin/env node
// Restart guard for a DinoBot bot on Claude Code: a stock PreToolUse hook on Bash (hooks.json next to this file),
// loaded only through the bot's --plugin-dir (claude-code/start-bot.sh), never for workers or the user's own sessions.
// It runs OptChat's matcher (optchat/src/restart-guard.ts, the pi hook's rules) on the command and blocks a restart,
// stop or reload of DinoBot with exit code 2 and the one-line reason on stderr (Claude Code shows it to the model).
// Active only when the bot's PASEO_AGENT_ID is set; that id is its own agent, so reloading another bot stays allowed.
// Fails open: any error here exits 0 and the command runs.
//
// Start-up (measured 18 Nov, Node 24): node alone about 25 ms; loading the TypeScript matcher adds about 60 ms the first
// time and under 10 ms once Node's compile cache holds it (enableCompileCache below). Commands with none of the words
// the matcher could act on exit before it is loaded (the pre-filter only lets through; the matcher decides refusals).
import { existsSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Anything the matcher refuses contains one of these (commands, scripts it reads, kills, interpreters). */
export const MAY_MATTER = /paseo|dinobot|systemctl|launchctl|kill|\/|\.|\bat\b|\bbatch\b|\bsource\b|\bsh\b|bash|zsh|dash|ksh|fish|python|node|perl|ruby|deno|bun|tsx|osascript|tmux|screen|eval/;

const here = dirname(fileURLToPath(import.meta.url));
const MATCHER = [
  join(here, '..', '..', '..', 'node_modules', 'pi-optchat', 'src', 'restart-guard.ts'), // repo and install (link)
  join(here, '..', '..', '..', '..', '..', 'optchat', 'src', 'restart-guard.ts'), // repo checkout without node_modules
];

async function readStdin(ms) {
  let text = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    process.stdin.on('data', (d) => (text += d));
    process.stdin.on('end', () => (clearTimeout(timer), resolve()));
    process.stdin.on('error', () => (clearTimeout(timer), resolve()));
  });
  return text;
}

async function main() {
  const own = process.env.PASEO_AGENT_ID?.trim();
  if (!own) return 0;
  const input = JSON.parse(await readStdin(2000));
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || typeof command !== 'string') return 0;
  if (!MAY_MATTER.test(command)) return 0;
  const path = MATCHER.find((p) => existsSync(p));
  if (!path) return 0;
  try {
    enableCompileCache?.();
  } catch {}
  const m = await import(pathToFileURL(path).href);
  const fixture = process.env.RESTART_GUARD_FIXTURE; // tests only: files, cgroups and processes as JSON
  const io = fixture ? m.fixtureIo(JSON.parse(fixture)) : m.fsIo;
  const reason = m.restartReason(command, typeof input.cwd === 'string' ? input.cwd : process.cwd(), io, own);
  if (!reason) return 0;
  process.stderr.write(`${reason}\n`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
