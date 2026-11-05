import { readFileSync, realpathSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tools a room session may use, in one place: its own talk tools, and lookups that cannot change anything.
 *
 * A room session is a pi process started by the paseo-bots plugin. Pi also loads the user's global packages there, so
 * the session has tools such as bash, write and edit registered; room mode turns all of them off with setActiveTools,
 * and `roomToolCallProblem` blocks any call outside this list (or a lookup with an option that writes, spends beyond a
 * plain web call, opens a browser or uses the user's logins), in case something activates a tool mid-turn.
 *
 * File lookups stay inside the room's roots (roomScope: the room dir and the bots root, symlinks resolved), and a
 * fetch goes only to a public host, by a URL of at most ROOM_URL_MAX characters, so a prompt injection cannot read a
 * credential or reach the daemon, the tailnet or cloud metadata (rel-security B2). The earlier rule that a URL must
 * have appeared in the conversation was dropped (27 Oct, group chats option A).
 *
 * That is the default ("lookup" tools). The user can switch group chats to "full" tools in the app's Settings
 * (bots plugin settings `rooms.fullTools`, read per turn by roomToolMode): room sessions then have the same tools as
 * a main chat, except ROOM_NEVER_TOOLS.
 *
 * Never add: bash/powershell (cannot be restricted, even for reads), write, edit, anything that sends (bot-dm, paseo),
 * subagents/herdr, tool loaders (web_enable, tool_search, codemode), ask_user_question (no one answers in a room).
 * test/room-tools.test.ts fails if a write-capable tool name appears here.
 */

/** Registered by room mode itself (src/room/index.ts). */
export const ROOM_TALK_TOOLS = ['main_zoom', 'main_search', 'main_date', 'room_history'] as const;

/**
 * Read-only lookups, by the names pi and the user's packages register them (checked in a room session on the host,
 * 2026-10-13): pi built-ins read/grep/find/ls, pi-web-access web_search/fetch_content/get_search_content, pi-fff
 * ffgrep/fffind. A name that is not registered in a session is ignored by setActiveTools.
 */
export const ROOM_LOOKUP_TOOLS = [
  'web_search',
  'fetch_content',
  'get_search_content',
  'read',
  'grep',
  'find',
  'ls',
  'ffgrep',
  'fffind',
] as const;

/**
 * Never active in a room, even with full tools: no one answers a question in a room, so the turn would hang.
 */
export const ROOM_NEVER_TOOLS = ['ask_user_question'] as const;

/** "lookup": talk + read-only lookups (default, option A). "full": a main chat's tools (option B, opt-in). */
export type RoomToolMode = 'lookup' | 'full';

/**
 * The room's tool mode, from the bots plugin's settings file (OPTCHAT_ROOM_SETTINGS, `rooms.fullTools: true` means
 * full). Read when called (each turn and each tool call), so a change in the app applies to the next room turn without
 * a restart. No file, an unreadable one or any other value: "lookup".
 */
export function roomToolMode(env: NodeJS.ProcessEnv = process.env): RoomToolMode {
  const path = env.OPTCHAT_ROOM_SETTINGS?.trim();
  if (!path) return 'lookup';
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const rooms = typeof raw === 'object' && raw !== null ? (raw as { rooms?: unknown }).rooms : undefined;
    return typeof rooms === 'object' && rooms !== null && (rooms as { fullTools?: unknown }).fullTools === true ? 'full' : 'lookup';
  } catch {
    return 'lookup';
  }
}

/** The allow-list: every tool a room session may have active. */
export const ROOM_TOOLS = [...ROOM_TALK_TOOLS, ...ROOM_LOOKUP_TOOLS] as const;
export type RoomTool = (typeof ROOM_TOOLS)[number];

const allowed = new Set<string>(ROOM_TOOLS);

/**
 * Where a room's file lookups may look (release blocker B2, rel-security 27 Oct): an allow-list of roots, not a
 * deny-list. A room reads only its own room dir (its working directory) and the bots root (`~/bots`), after `~`,
 * `@` and `..` are expanded and symlinks resolved, so `~/.pi/agent/auth.json`, `~/.dinobot/daemon.env`,
 * `~/.paseo/local-credential`, `~/.ssh`, OptChat profiles, pi sessions and `/proc` are all out of reach. Its main
 * memory it reads with its own main_* tools, not with file lookups.
 */
export interface RoomScope {
  /** The session's working directory: relative paths resolve against it. */
  cwd: string;
  home: string;
  /** Real paths of the folders a room may read, below which every lookup must stay. */
  roots: string[];
}

/** The scope from the env the plugin sets: OPTCHAT_ROOM_DIR, and OPTCHAT_ROOM_BOTS (else PASEO_BOTS_ROOT, else ~/bots). */
export function roomScope(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): RoomScope {
  const wanted = [env.OPTCHAT_ROOM_DIR?.trim() || cwd, env.OPTCHAT_ROOM_BOTS?.trim() || env.PASEO_BOTS_ROOT?.trim() || join(home, 'bots')];
  const realHome = realPath(resolve(home));
  const roots = wanted
    .map(root => realPath(resolve(cwd, root)))
    // A root that is the home dir, or above it, would let a room read every credential; such a root is dropped.
    .filter(root => !within(realHome, root));
  return { cwd: resolve(cwd), home, roots: [...new Set(roots)] };
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** A tool path as pi's file tools resolve it (path-utils resolveToCwd): `@` prefix, `~`, file:// and cwd. */
function toolPath(raw: string, scope: RoomScope): string {
  let path = raw.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = scope.home;
  else if (path.startsWith('~/')) path = join(scope.home, path.slice(2));
  else if (/^file:\/\//i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      // Left as is: resolves under cwd, as pi would.
    }
  }
  return resolve(scope.cwd, path);
}
/** The real path, following symlinks; for a path that does not exist yet, its deepest existing parent's real path. */
function realPath(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      const parent = dirname(at);
      if (parent === at) return path;
      rest.unshift(basename(at));
      at = parent;
    }
  }
}
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Credentials a room bot has no reason to read, even inside its roots (a bot folder may hold an .env). */
const SECRET_PATH =
  /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.docker|\.kube|\.password-store)([\\/]|$)|(^|[\\/])(\.env(\.[^\\/]*)?|[^\\/]*\.env|\.netrc|\.npmrc|\.pgpass|auth\.json|local-credential|credentials(\.json)?|secrets?(\.[a-z]+)?|id_(rsa|ed25519|ecdsa)[^\\/]*|[^\\/]*\.(pem|key|p8|p12))$/i;

/** Why a room may not look at this path, or undefined when it is inside the room's roots. */
export function roomPathProblem(raw: string, scope: RoomScope = roomScope()): string | undefined {
  const real = realPath(toolPath(raw.trim(), scope));
  if (SECRET_PATH.test(raw.trim()) || SECRET_PATH.test(real)) return `${raw} holds credentials; a room does not read it.`;
  if (!scope.roots.some(root => within(real, root)))
    return `${raw} is outside the folders a room may read (its room folder and the bots folder); credentials and other files stay private. Ask in the bot's main chat instead.`;
  return undefined;
}

const GLOB = /[*?[\]{}]/;
/** ffgrep/fffind `path`: a directory prefix, a file name or a glob, relative to cwd, or absolute/~/../ outside it. */
function globPathProblem(raw: string, scope: RoomScope): string | undefined {
  const path = raw.trim();
  const first = path.search(GLOB);
  if (first < 0) return roomPathProblem(path, scope);
  const pattern = path.slice(first);
  // A glob that climbs or jumps elsewhere ({src,/etc}, **/../.., ~) cannot be checked from its literal prefix.
  if (/\.\.|~|[{,]\s*[\\/]|[{,]\s*@/.test(pattern))
    return `${raw}: a room may not search with a pattern that leaves its folders; use a plain folder path.`;
  const prefix = path.slice(0, first);
  return roomPathProblem(prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) || '/' : '.', scope);
}

/** pi-web-access fetch_content options a room may not use. */
const FETCH_BLOCKED: Record<string, string> = {
  auth: "uses the user's browser logins",
  mode: '', // checked below: only readable/raw
  prompt: 'asks a model, which costs more than a web call',
  model: 'asks a model, which costs more than a web call',
  answerModel: 'asks a model, which costs more than a web call',
  forceClone: 'clones a repository to disk',
  frames: 'extracts video frames to disk',
  timestamp: 'extracts video frames to disk',
  proxy: 'routes the fetch through another server',
};
/** Longest URL a room may fetch: links in pages and search results are shorter; long ones smuggle data out. */
export const ROOM_URL_MAX = 300;

/** IPv4 dotted quad as four numbers, or undefined. */
function v4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
  return parts.map(Number);
}
function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, Tailscale's 100.64.0.0/10
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF, 192.0.2.0/24 docs
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}
/** IPv6 address as eight 16-bit groups, or undefined. */
function v6(host: string): number[] | undefined {
  let text = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!text.includes(':')) return undefined;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const quad = v4(tail[1]);
    if (!quad) return undefined;
    text = text.slice(0, -tail[1].length) + `${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  if (text.split('::').length > 2) return undefined;
  const a = head ? head.split(':') : [],
    b = rest !== undefined && rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0) return undefined;
  const groups = [...a, ...Array(fill).fill('0'), ...b];
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.map(g => parseInt(g, 16));
}
function privateV6(g: number[]): boolean {
  const embedded = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 7).every(x => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return privateV4(embedded()); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every(x => x === 0)) return privateV4(embedded()); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(embedded()); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local, Tailscale fd7a:115c:a1e0::/48
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}
/** True for loopback, private, link-local, CGNAT/tailnet and other non-public addresses (IPv4 or IPv6 text). */
export function privateAddress(address: string): boolean {
  const quad = v4(address);
  if (quad) return privateV4(quad);
  const groups = v6(address);
  return groups ? privateV6(groups) : false;
}
/** Names that never mean a public web site. */
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|ts\.net|onion)$/;

function urlProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return 'a URL must be text';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${raw} is not a web URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${raw} is not a web URL`;
  if (raw.length > ROOM_URL_MAX) return `that URL is longer than ${ROOM_URL_MAX} characters; a room does not fetch it`;
  if (url.username || url.password) return 'a room does not fetch URLs with a user name or password in them';
  // WHATWG URL parsing has already turned 2130706433, 0x7f.1 and similar into dotted quads.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (privateAddress(host) || PRIVATE_NAME.test(host) || (!host.includes('.') && !host.includes(':')))
    return `${host} is a private or local address; a room fetches public web pages only`;
  const bare = host.replace(/^www\./, '');
  if (bare === 'github.com' || bare === 'gist.github.com')
    return 'github.com pages are cloned to disk by fetch_content; use raw.githubusercontent.com or web_search';
  if (bare === 'youtube.com' || bare === 'm.youtube.com' || bare === 'youtu.be' || bare === 'music.youtube.com')
    return 'videos go to a model, which costs more than a web call';
  return undefined;
}

export interface RoomCheck {
  /** Where file lookups may look; default: roomScope() from this process's env and cwd. */
  scope?: RoomScope;
  /** Default "lookup". With "full", only ROOM_NEVER_TOOLS are refused. */
  mode?: RoomToolMode;
}

/**
 * Why a room session may not run this tool call, or undefined when it may. `input` is the call's arguments.
 * Synchronous and side-effect free (it only resolves symlinks); room mode calls it from a `tool_call` handler and
 * blocks the call with the reason, then checks fetched host names in DNS (roomFetchDnsProblem).
 */
export function roomToolCallProblem(name: string, input: unknown, check: RoomCheck = {}): string | undefined {
  if ((ROOM_NEVER_TOOLS as readonly string[]).includes(name))
    return `${name} is not available in a group chat room; no one answers it there. Ask in the room as a reply instead.`;
  if (check.mode === 'full') return undefined;
  if (!allowed.has(name)) return `${name} is not available in a group chat room; rooms only talk and look things up.`;
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const set = (key: string) => args[key] !== undefined && args[key] !== null && args[key] !== false && args[key] !== '';
  if (name === 'web_search') {
    if (set('workflow') && args.workflow !== 'none')
      return 'web_search workflows (summary-review, auto-summary) open a browser or ask a model; use the default.';
    if (set('provider') && args.provider !== 'auto') return 'web_search in a room uses the configured provider; leave provider out.';
    if (set('proxy')) return 'web_search in a room does not use a proxy.';
    return undefined;
  }
  if (name === 'fetch_content') {
    if (set('mode') && args.mode !== 'readable' && args.mode !== 'raw')
      return 'fetch_content in a room reads pages (mode readable or raw) and does not ask a model.';
    for (const [key, why] of Object.entries(FETCH_BLOCKED)) if (why && set(key)) return `fetch_content ${key} ${why}; not in a room.`;
    const urls = fetchUrls(args);
    if (!urls.length) return undefined; // pi-web-access reports the missing URL itself
    for (const url of urls) {
      const problem = urlProblem(url);
      if (problem) return `fetch_content: ${problem}.`;
    }
    return undefined;
  }
  const scope = () => check.scope ?? roomScope();
  if (name === 'read' || name === 'grep' || name === 'find' || name === 'ls') {
    // grep, find and ls default to the working directory (the room dir); read needs a path.
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : name === 'read' ? undefined : '.';
    if (path === undefined) return undefined; // pi reports the missing path itself
    return roomPathProblem(path, scope());
  }
  if (name === 'ffgrep' || name === 'fffind') {
    if (typeof args.path === 'string' && args.path.trim()) {
      const problem = globPathProblem(args.path, scope());
      if (problem) return problem;
    }
    // fff searches its index of the working directory when no path is given.
    return roomPathProblem('.', scope());
  }
  return undefined;
}

const fetchUrls = (args: Record<string, unknown>): unknown[] => [
  ...(args.url !== undefined && args.url !== null && args.url !== '' ? [args.url] : []),
  ...(Array.isArray(args.urls) ? args.urls : []),
];

type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address);
/**
 * fetch_content hosts whose name resolves to a private address (a public name pointing at 127.0.0.1 or the tailnet).
 * A lookup that fails or takes over `timeoutMs` passes: the fetch itself will fail the same way. (A redirect or a
 * DNS answer that changes between this check and the fetch is not covered; pi-web-access follows redirects.)
 */
export async function roomFetchDnsProblem(input: unknown, resolveHost: Lookup = dnsLookup, timeoutMs = 2000) {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  for (const raw of fetchUrls(args)) {
    if (typeof raw !== 'string') continue;
    let host: string;
    try {
      host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    } catch {
      continue;
    }
    if (isIP(host)) continue;
    let addresses: string[];
    try {
      addresses = await Promise.race([
        resolveHost(host),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
      ]);
    } catch {
      continue;
    }
    const bad = addresses.find(privateAddress);
    if (bad) return `fetch_content: ${host} points at the private address ${bad}; a room fetches public web pages only.`;
  }
  return undefined;
}

/** Token shapes taken out of file lookup results in a room (a bot folder may hold one by mistake). */
const SECRET_TEXT: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk-ant-[a-z0-9]+-|sk-or-v1-|sk-proj-|sk-)[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bExponentPushToken\[[^\]]+\]/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(\b[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
];
/** `text` with token-shaped strings replaced by [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT)
    out = out.replace(pattern, (match: string, ...groups: unknown[]) =>
      pattern === SECRET_TEXT[SECRET_TEXT.length - 1] ? `${groups[0] as string}[redacted]` : '[redacted]',
    );
  return out;
}
/** The file lookups whose results room mode redacts. */
export const ROOM_FILE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'ffgrep', 'fffind']);
