/**
 * Restart guard: a bot must not restart, stop or reload DinoBot (the Paseo daemon, its plugins or bot agents) from its
 * own session; that cuts off its own reply and other bots' replies (9 Oct, 6 Nov, 15 Nov twice). The one route is a
 * herdr worker that runs `bot-restart` (plugins/bots/bin/bot-restart.mjs), which waits until no bot is mid-turn.
 *
 * Installed only in a bot's own session (PASEO_AGENT_ID set: Paseo starts every agent with it). Workers and terminals
 * do not have it, so they are never blocked. The check reads the shell command as a shell would, closely enough:
 * it splits it into simple commands, unwraps `bash -c`, `systemd-run`, `nohup`, `setsid`, `env`, `timeout`, `sudo`,
 * `at`/`batch` fed by echo or a here-document, `$(…)`, scripts it runs (`bash x.sh`, `./x.sh`, `. x.sh`, at most
 * 3 deep), and matches what is left. Inline code for other interpreters (`node -e`, `python -c`) and scripts in those
 * languages get a looser text match.
 *
 * Not caught: commands built at run time (variables, base64, `eval "$x"`), restarts done from a program's own code
 * other than the text match, a worker the bot tells to restart directly, and anything not run through the bash tool.
 * Any error inside the check lets the command through (fail open).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const REFUSAL =
  'Refused: a bot must not restart or reload DinoBot from its own session (it cuts off replies). Start a herdr worker that runs `bot-restart`.';

export type GuardIo = {
  /** Text of a small file, or null. */
  readFile(path: string): string | null;
  /** /proc/<pid>/cgroup text, or null. */
  cgroupOf(pid: number): string | null;
  /** Pids `pgrep` finds for a pattern (full: match the whole command line). */
  pgrep(pattern: string, full: boolean): number[];
};

const MAX_SCRIPT = 256 * 1024;
export const fsIo: GuardIo = {
  readFile(path) {
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > MAX_SCRIPT) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  cgroupOf(pid) {
    try {
      return readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    } catch {
      return null;
    }
  },
  pgrep(pattern, full) {
    const r = spawnSync('pgrep', [...(full ? ['-f'] : []), '--', pattern], { encoding: 'utf8', timeout: 1000 });
    return (r.stdout ?? '').split('\n').map(Number).filter(n => n > 0);
  },
};

const SERVICE = /^(paseo|dinobot)(\.service)?$|^(paseo|dinobot)[*@.]|^app\.dinobot/;
const DAEMON_CGROUP = /\/(paseo|dinobot)\.service(\/|$)/m;
const SYSTEMCTL_VERBS = new Set([
  'restart',
  'stop',
  'kill',
  'try-restart',
  'reload-or-restart',
  'try-reload-or-restart',
  'condrestart',
  'reload',
  'force-reload',
  'disable',
  'mask',
  'freeze',
  'clean',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'deno', 'bun', 'tsx', 'osascript']);
/** Prefixes that run the rest of the line as a command, with how many option arguments take a value. */
const PASS_THROUGH = new Set(['nohup', 'setsid', 'exec', 'command', 'builtin', 'time', 'nice', 'ionice', 'stdbuf', 'chrt', 'taskset', 'unbuffer', 'sudo', 'doas', 'caffeinate', 'xargs', 'flock', 'timeout', 'env', 'systemd-run', 'systemd-inhibit', 'daemonize', 'disown', 'watch', 'nocorrect', 'noglob']);
const VALUE_OPTS: Record<string, Set<string>> = {
  'systemd-run': new Set(['-p', '--property', '-E', '--setenv', '-u', '--unit', '--description', '--slice', '--uid', '--gid', '-M', '--machine', '-H', '--host', '--working-directory', '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--timer-property', '--path-property', '--socket-property', '--nice', '--expand-environment', '-G']),
  'systemd-inhibit': new Set(['--what', '--who', '--why', '--mode']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  flock: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a']),
  watch: new Set(['-n', '--interval', '-d']),
  chrt: new Set(['-p']),
  taskset: new Set(['-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
/** Pass-through prefixes that take positional arguments before the command. */
const LEADING_ARGS: Record<string, number> = { timeout: 1, flock: 1, taskset: 1, chrt: 1 };

type Simple = { argv: string[]; heredoc?: string };
/** ownId: this session's PASEO_AGENT_ID (a reload of another, named agent is allowed). */
type Ctx = { cwd: string; io: GuardIo; depth: number; ownId?: string };

/** Why a command must be refused (one line), or null. Never throws: an error lets the command through. */
export function restartReason(command: string, cwd: string, io: GuardIo = fsIo, ownId?: string): string | null {
  try {
    return scan(command, { cwd, io, depth: 0, ownId: ownId?.trim() || undefined }) ? REFUSAL : null;
  } catch {
    return null;
  }
}

function scan(text: string, ctx: Ctx): boolean {
  if (ctx.depth > 3 || text.length > MAX_SCRIPT) return false;
  const { pipelines, subs } = parse(text);
  for (const sub of subs) if (scan(sub, { ...ctx, depth: ctx.depth + 1 })) return true;
  let cwd = ctx.cwd;
  for (const pipeline of pipelines) {
    for (let i = 0; i < pipeline.length; i++) {
      const simple = pipeline[i]!;
      const argv = simple.argv;
      const name = base(argv[0] ?? '');
      if (name === 'cd' && argv[1]) cwd = abs(argv[1], cwd);
      if (checkSimple(simple, { ...ctx, cwd })) return true;
      // `echo 'cmd' | at now + 2 min`, `printf … | bash`: the text fed to a shell or a scheduler is a command.
      if (i > 0 && runsStdin(pipeline[i]!.argv)) {
        const feeder = pipeline[i - 1]!;
        const fed = feeder.heredoc ?? (['echo', 'printf'].includes(base(feeder.argv[0] ?? '')) ? feeder.argv.slice(1).join(' ') : null);
        if (fed !== null && scan(fed, { ...ctx, cwd, depth: ctx.depth + 1 })) return true;
        if (['cat'].includes(base(feeder.argv[0] ?? '')))
          for (const f of feeder.argv.slice(1)) if (scanFile(f, { ...ctx, cwd })) return true;
      }
    }
  }
  return false;
}

const base = (s: string) => s.slice(s.lastIndexOf('/') + 1);
const abs = (p: string, cwd: string) => (p.startsWith('~/') ? join(process.env.HOME ?? '~', p.slice(2)) : isAbsolute(p) ? p : resolve(cwd, p));

function runsStdin(argv: string[]): boolean {
  const name = base(argv[0] ?? '');
  if (name === 'at' || name === 'batch') return !argv.includes('-f');
  if (SHELLS.has(name)) return !argv.slice(1).some(a => !a.startsWith('-'));
  return false;
}

function scanFile(path: string, ctx: Ctx): boolean {
  const text = ctx.io.readFile(abs(path, ctx.cwd));
  if (text === null) return false;
  return scan(text, { ...ctx, depth: ctx.depth + 1 }) || loose(text);
}

/** Looser match for code in other languages (and as a second look at scripts). */
function loose(text: string): boolean {
  if (!/subprocess|child_process|os\.system|exec|spawn|Popen|system\(|do shell script|\bsystemctl\b\s|^\s*paseo\s/m.test(text)) return false;
  return (
    /systemctl\b[^\n;]{0,80}?\b(restart|stop|kill|try-restart|reload-or-restart)\b[^\n;]{0,80}?\b(paseo|dinobot)\b/.test(text) ||
    /\bpaseo\b["',\s]{1,6}(daemon["',\s]{1,6}(restart|stop)|plugin["',\s]{1,6}reload|agent["',\s]{1,6}reload)\b/.test(text) ||
    /launchctl\b[^\n;]{0,60}?\b(kickstart|bootout|stop|kill|unload)\b[^\n;]{0,80}?app\.dinobot/.test(text) ||
    /\b(pkill|killall)\b[^\n;]{0,40}?\b(paseo|dinobot)\b/.test(text)
  );
}

function checkSimple(simple: Simple, ctx: Ctx): boolean {
  let argv = simple.argv.filter(a => a !== '');
  // Leading assignments (FOO=1 cmd) and pass-through prefixes.
  for (let guard = 0; guard < 20 && argv.length; guard++) {
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv = argv.slice(1);
    const name = base(argv[0] ?? '');
    if (name === 'sleep' && argv.length <= 2) return false;
    if (!PASS_THROUGH.has(name)) break;
    const opts = VALUE_OPTS[name] ?? new Set<string>();
    let i = 1;
    while (i < argv.length) {
      const a = argv[i]!;
      if (a === '--') {
        i++;
        break;
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        i++;
        continue;
      }
      if (!a.startsWith('-') || a === '-') break;
      if (name === 'flock' && (a === '-c' || a === '--command')) return scan(argv[i + 1] ?? '', { ...ctx, depth: ctx.depth + 1 });
      i += opts.has(a) ? 2 : 1;
    }
    i += LEADING_ARGS[name] ?? 0;
    if (name === 'watch') return scan(argv.slice(i).join(' '), { ...ctx, depth: ctx.depth + 1 });
    argv = argv.slice(i);
  }
  if (!argv.length) return false;
  const name = base(argv[0]!);
  const args = argv.slice(1);
  const words = args.filter(a => !a.startsWith('-'));

  if (SHELLS.has(name)) {
    const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c >= 0) return scan(args[c + 1] ?? '', { ...ctx, depth: ctx.depth + 1 });
    if (words[0]) return scanFile(words[0], ctx);
    return simple.heredoc !== undefined && scan(simple.heredoc, { ...ctx, depth: ctx.depth + 1 });
  }
  if (name === 'source' || name === '.') return words[0] ? scanFile(words[0], ctx) : false;
  if ((name === 'at' || name === 'batch') && args.includes('-f')) {
    const f = args[args.indexOf('-f') + 1];
    return f ? scanFile(f, ctx) : false;
  }
  if ((name === 'at' || name === 'batch' || name === 'ssh') && simple.heredoc !== undefined)
    return scan(simple.heredoc, { ...ctx, depth: ctx.depth + 1 });
  if (INTERPRETERS.has(name)) {
    const c = args.findIndex(a => ['-e', '-c', '--eval', '-p', '--print'].includes(a));
    if (c >= 0) return loose(args[c + 1] ?? '');
    if (simple.heredoc !== undefined) return loose(simple.heredoc);
    return words[0] ? loose(ctx.io.readFile(abs(words[0], ctx.cwd)) ?? '') : false;
  }
  if (name === 'tmux' || name === 'screen') return scan(words.slice(1).join(' '), { ...ctx, depth: ctx.depth + 1 });
  if (name === 'systemctl') {
    const verb = words[0];
    return verb !== undefined && SYSTEMCTL_VERBS.has(verb) && words.slice(1).some(w => SERVICE.test(w));
  }
  if (name === 'launchctl') return ['kickstart', 'bootout', 'stop', 'kill', 'unload', 'remove'].includes(words[0] ?? '') && args.some(a => /app\.dinobot|paseo/.test(a));
  if (name === 'paseo') {
    // A test daemon of its own (--home elsewhere) and --help are fine.
    const home = args[args.indexOf('--home') + 1];
    if (args.includes('--help') || args.includes('-h') || (args.includes('--home') && home && !/(^|\/)\.paseo\/?$/.test(home))) return false;
    const sub = positionals(args, new Set(['--host', '--home', '-o', '--format']));
    return (sub[0] === 'daemon' && ['restart', 'stop'].includes(sub[1] ?? '')) || (['plugin', 'plugins'].includes(sub[0] ?? '') && sub[1] === 'reload') || (sub[0] === 'agent' && sub[1] === 'reload' && reloadsSelfOrAll(sub.slice(2), ctx.ownId));
  }
  if (name === 'dinobot') return !hasTestHome(simple.argv) && ['stop', 'start', 'update', 'setup', 'uninstall', 'post-update'].includes(words[0] ?? '');
  // Kills: aimed at the daemon when a process they would hit runs in its service (the daemon, its plugins, bots' pi).
  const daemonPid = (pid: number) => DAEMON_CGROUP.test(ctx.io.cgroupOf(pid) ?? '');
  if (name === 'pkill' || name === 'killall') {
    const pattern = positionals(args, new Set(['-u', '-U', '-g', '-G', '-P', '-s', '-t', '--signal', '-F', '--pidfile', '--ns', '--nslist']))[0];
    if (!pattern) return false;
    const full = name === 'pkill' && args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--full');
    return ctx.io.pgrep(name === 'killall' ? `^${pattern}$` : pattern, full).some(daemonPid);
  }
  if (name === 'kill') {
    const text = simple.argv.join(' ');
    if (/MainPID|\.paseo\/paseo\.pid/.test(text)) return true;
    for (const m of text.matchAll(/pgrep\s+((?:-\w+\s+)*)("[^"]*"|'[^']*'|[^\s)]+)/g)) {
      if (ctx.io.pgrep(m[2]!.replace(/^["']|["']$/g, ''), /f/.test(m[1] ?? '')).some(daemonPid)) return true;
    }
    for (const w of args) {
      const pid = /^(\d+)$/.exec(w)?.[1];
      if (pid && daemonPid(Number(pid))) return true;
    }
    return false;
  }
  if (/\.(sh|bash)$/.test(argv[0]!) || argv[0]!.startsWith('./') || argv[0]!.startsWith('/') || argv[0]!.startsWith('~/')) {
    // A script run directly. Ordinary programs on PATH are not read.
    const path = abs(argv[0]!, ctx.cwd);
    if (/\/(usr|bin|sbin|lib|opt|nix)\//.test(path) && !/\.(sh|bash)$/.test(path)) return false;
    return scanFile(argv[0]!, ctx);
  }
  return false;
}

/**
 * `paseo agent reload <ids>`: refused when it would reload this bot's own agent (an id that is a prefix of its own,
 * or its own a prefix of the id) or when no other agent is clearly named (no id, `all`, a variable or substitution).
 * Reloading another, named bot does not cut off this bot's reply (The Fat Controller repairs stuck bots that way).
 */
function reloadsSelfOrAll(ids: string[], ownId: string | undefined): boolean {
  if (!ids.length || !ownId) return true;
  const own = ownId.toLowerCase();
  return ids.some(raw => {
    const id = raw.toLowerCase();
    return id === 'all' || /[$`*?]/.test(id) || own.startsWith(id) || id.startsWith(own);
  });
}

/** `HOME=/tmp/x dinobot …` or `env -i HOME=/tmp/x …`: a test install, not this one. */
function hasTestHome(argv: string[]): boolean {
  const home = argv.find(a => a.startsWith('HOME='))?.slice(5);
  return home !== undefined && home !== process.env.HOME;
}

function positionals(args: string[], valued: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.has(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

/**
 * Splits shell text into pipelines of simple commands (words with quotes removed), and collects `$(…)`, backtick and
 * `<(…)` bodies to scan on their own. Here-document bodies go with the command they feed. Close enough for a guard.
 */
export function parse(text: string): { pipelines: Simple[][]; subs: string[] } {
  const pipelines: Simple[][] = [];
  const subs: string[] = [];
  let pipeline: Simple[] = [];
  let argv: string[] = [];
  let word = '';
  let inWord = false;
  const pendingHeredocs: Array<{ tag: string; simple: Simple | null; strip: boolean }> = [];
  let current: Simple | null = null;
  const endWord = () => {
    if (inWord) argv.push(word);
    word = '';
    inWord = false;
  };
  const endSimple = () => {
    endWord();
    if (argv.length) {
      current = { argv };
      pipeline.push(current);
      for (const h of pendingHeredocs) if (!h.simple) h.simple = current;
    }
    argv = [];
  };
  const endPipeline = () => {
    endSimple();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  /** Index after the matching close paren of a `(` at i-1. */
  const closeParen = (from: number) => {
    let depth = 1;
    let q: string | null = null;
    for (let j = from; j < text.length; j++) {
      const ch = text[j]!;
      if (q) {
        if (ch === q) q = null;
        else if (ch === '\\' && q === '"') j++;
        continue;
      }
      if (ch === "'" || ch === '"') q = ch;
      else if (ch === '\\') j++;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return j;
    }
    return text.length;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word += text[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end < 0 ? text.length : end);
      inWord = true;
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          word += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const end = closeParen(j + 2);
          subs.push(text.slice(j + 2, end));
          word += text.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        if (text[j] === '`') {
          const end = text.indexOf('`', j + 1);
          subs.push(text.slice(j + 1, end < 0 ? text.length : end));
          j = end < 0 ? text.length : end + 1;
          continue;
        }
        word += text[j];
        j++;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if ((ch === '$' || ch === '<' || ch === '>') && text[i + 1] === '(') {
      const end = closeParen(i + 2);
      subs.push(text.slice(i + 2, end));
      word += text.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      subs.push(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 1;
      inWord = true;
      continue;
    }
    if (ch === '(' && !inWord) {
      // Subshell or group: scan its body as its own text.
      const end = closeParen(i + 1);
      subs.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '{' && !inWord && /[\s;]/.test(text[i + 1] ?? ' ')) {
      i++;
      continue;
    }
    if (ch === '}' && !inWord) {
      i++;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      endWord();
      const m = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(text.slice(i));
      if (m) {
        pendingHeredocs.push({ tag: m[3]!, simple: null, strip: m[1] === '-' });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '\n') {
      endPipeline();
      i++;
      // Here-document bodies start on the next line.
      while (pendingHeredocs.length) {
        const h = pendingHeredocs.shift()!;
        const lines: string[] = [];
        while (i < text.length) {
          const nl = text.indexOf('\n', i);
          const line = text.slice(i, nl < 0 ? text.length : nl);
          i = nl < 0 ? text.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag) break;
          lines.push(line);
        }
        if (h.simple) h.simple.heredoc = lines.join('\n');
      }
      continue;
    }
    if (ch === ';' || ch === '&') {
      if (ch === '&' && text[i + 1] === '>') {
        endWord();
        i += 2;
        continue;
      }
      if (ch === '&' && text[i - 1] === '>') {
        i++;
        continue;
      }
      endPipeline();
      i += text[i + 1] === ch ? 2 : 1;
      continue;
    }
    if (ch === '|') {
      if (text[i + 1] === '|') {
        endPipeline();
        i += 2;
        continue;
      }
      endSimple();
      i += text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (ch === ')') {
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      i++;
      continue;
    }
    if ((ch === '>' || ch === '<') && (!inWord || /^\d+$/.test(word))) {
      // Redirection (2>&1, > file): skip the operator and its target word.
      word = '';
      inWord = false;
      let j = i;
      while (text[j] === '>' || text[j] === '<' || text[j] === '&' || text[j] === '|') j++;
      while (/[ \t]/.test(text[j] ?? '')) j++;
      while (j < text.length && !/[\s;&|]/.test(text[j]!)) j++;
      i = j;
      continue;
    }
    if (ch === '#' && !inWord) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  endPipeline();
  // A here-document left open (no closing tag line) has no body: nothing to add.
  return { pipelines, subs };
}

/** The pi hook: block a bash call from a bot's own session that would restart or reload DinoBot. */
export function restartGuard(pi: { on(event: 'tool_call', handler: (event: any, ctx: any) => unknown): unknown }, env: NodeJS.ProcessEnv = process.env) {
  if (!env.PASEO_AGENT_ID?.trim()) return;
  pi.on('tool_call', (event: any, ctx: any) => {
    try {
      if (event?.toolName !== 'bash' || typeof event.input?.command !== 'string') return undefined;
      const reason = restartReason(event.input.command, typeof ctx?.cwd === 'string' ? ctx.cwd : process.cwd(), fsIo, env.PASEO_AGENT_ID);
      return reason ? { block: true, reason } : undefined;
    } catch {
      return undefined;
    }
  });
}

/** A GuardIo from plain data (tests; the Claude Code hook's RESTART_GUARD_FIXTURE): files, cgroups by pid, processes. */
export function fixtureIo(data: { files?: Record<string, string>; cgroups?: Record<string, string>; procs?: Array<[number, string, string]> }): GuardIo {
  return {
    readFile: path => data.files?.[path] ?? null,
    cgroupOf: pid => data.cgroups?.[String(pid)] ?? '0::/user.slice/other.scope\n',
    pgrep: (pattern, full) => {
      const re = new RegExp(pattern);
      return (data.procs ?? []).filter(([, comm, cmd]) => re.test(full ? cmd : comm)).map(([pid]) => pid);
    },
  };
}
