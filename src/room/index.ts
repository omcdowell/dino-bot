import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { flat } from '../memory.ts';
import { normalizeParty } from '../user.ts';
import { dataHome, profilePath } from '../profiles.ts';
import { result } from '../tools.ts';
import { MemoryReader } from './reader.ts';
import { roomInstructions, roomPrompt } from './prompt.ts';
import {
  ROOM_FILE_TOOLS,
  ROOM_NEVER_TOOLS,
  ROOM_TALK_TOOLS,
  ROOM_TOOLS,
  redactSecrets,
  roomFetchDnsProblem,
  roomScope,
  roomToolCallProblem,
  roomToolMode,
  type RoomToolMode,
} from './tools.ts';

/** The room session's settings, from the env the plugin sets (plan §3.3). */
export interface RoomEnv {
  group: string;
  member: string;
  /** The room's state dir, holding room.jsonl. */
  dir: string;
  /** The member's profile dir, read-only. */
  main: string;
}
export function roomEnv(env: NodeJS.ProcessEnv = process.env): RoomEnv {
  const group = env.OPTCHAT_ROOM?.trim() ?? '',
    member = env.OPTCHAT_ROOM_MEMBER?.trim() ?? '',
    dir = env.OPTCHAT_ROOM_DIR?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(group)) throw new Error(`OPTCHAT_ROOM is not a group id: ${JSON.stringify(group)}`);
  if (!member) throw new Error('OPTCHAT_ROOM_MEMBER is not set.');
  if (!dir) throw new Error('OPTCHAT_ROOM_DIR is not set.');
  // profilePath validates the bot id; the profile is under OPTCHAT_HOME, as for a main chat.
  profilePath(member);
  const main = env.OPTCHAT_ROOM_MAIN?.trim() || join(env.OPTCHAT_HOME ? resolve(env.OPTCHAT_HOME) : dataHome(), 'profiles', member);
  return { group, member, dir, main };
}

/** Bytes of room.jsonl read from its end; a room is small, and the oldest lines are the least useful. */
const HISTORY_BYTES = 2_000_000;
export interface RoomLine {
  id: string;
  ts: string;
  from: string;
  text: string;
  /** "main": posted from that bot's main chat with bot-room post; `re` is the room line it answers. */
  via?: 'main';
  re?: string;
}
/** The room's lines, oldest first, from the last HISTORY_BYTES of room.jsonl. Damaged lines are skipped. */
export function readRoom(file: string): RoomLine[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, 'r');
  let text: string;
  try {
    const size = fstatSync(fd).size,
      from = Math.max(0, size - HISTORY_BYTES),
      buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    text = buffer.toString('utf8');
    if (from) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
  const lines: RoomLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) continue;
      const { id, ts, from, text, via, re } = value as Record<string, unknown>;
      if (typeof id === 'string' && typeof ts === 'string' && typeof from === 'string' && typeof text === 'string')
        lines.push({
          id,
          ts,
          from: normalizeParty(from),
          text,
          ...(via === 'main' ? { via: 'main' as const } : {}),
          ...(typeof re === 'string' ? { re } : {}),
        });
    } catch {
      // A line being written, or a damaged one.
    }
  }
  return lines;
}
const stamp = (ts: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts) ? `${ts.slice(0, 10)} ${ts.slice(11, 16)}Z` : ts);
/**
 * After a line's sender code: a bot-room post from a main chat. `member` (the room session's bot) sees its own as
 * "(you, from your main chat, re <id>)", as in the plugin's digests.
 */
export const viaNote = (line: RoomLine, member?: string) =>
  line.via !== 'main'
    ? ''
    : `${line.from === member ? ' (you, from your main chat' : ' (from its main chat'}${line.re ? `, re ${line.re}` : ''})`;
/** Up to `limit` (≤ 50) room lines before the line `before` (or the newest), oldest first, labelled by sender code. */
export function roomHistory(file: string, before?: string, limit = 20, member?: string) {
  const all = readRoom(file),
    n = Math.max(1, Math.min(50, Math.floor(limit)));
  let stop = all.length;
  if (before) {
    stop = all.findIndex(line => line.id === before);
    if (stop < 0) throw new Error(`No room line ${before}.`);
  }
  const from = Math.max(0, stop - n),
    lines = all.slice(from, stop).map(line => `${line.id}  ${stamp(line.ts)} ${line.from}${viaNote(line, member)}: ${flat(line.text)}`);
  if (!lines.length) return 'No earlier room lines.';
  return from ? `(${from} earlier lines: room_history before=${all[from].id})\n${lines.join('\n')}` : lines.join('\n');
}

const allowedTools = new Set<string>(ROOM_TOOLS);
const neverTools = new Set<string>(ROOM_NEVER_TOOLS);
/** A transcript message with tool declarations outside the allow-list (with full tools: ROOM_NEVER_TOOLS) left out. */
export function onlyRoomTools<M>(message: M, mode: RoomToolMode = 'lookup'): M {
  const m = message as { role?: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
  if (m.role !== 'system' || (!m.toolsAdded && !m.toolsRemoved)) return message;
  const { toolsAdded, toolsRemoved, ...rest } = m;
  const keep = (name: string) => (mode === 'full' ? !neverTools.has(name) : allowedTools.has(name));
  const added = toolsAdded?.filter(tool => keep(tool.name)) ?? [];
  const removed = toolsRemoved?.filter(tool => keep(tool.name)) ?? [];
  return { ...rest, ...(added.length ? { toolsAdded: added } : {}), ...(removed.length ? { toolsRemoved: removed } : {}) } as M;
}

/**
 * Room mode (plan §2 U3): the process is one bot's seat in a group room. It opens no profile (no lock, no memory
 * tree, no compactor) and writes nothing under the profile; it reads the bot's AGENTS.md and memory, talks, and can
 * look things up (tools.ts: web search, fetch, file reads) but not change anything. Pi keeps the session's own short history, so there is no context hook.
 *
 * Tool mode (tools.ts roomToolMode, read each turn from the bots plugin's settings): "lookup" by default; "full" when
 * the user switched group chats to full tools in the app, and then the session has its main chat's tools (the set pi
 * started it with) but still never ROOM_NEVER_TOOLS, and its prompt says so.
 */
export default function room(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env) {
  let settings: RoomEnv | undefined, fault: string | undefined;
  try {
    settings = roomEnv(env);
  } catch (error) {
    fault = `OptChat room mode: ${error instanceof Error ? error.message : String(error)}`;
  }
  const reader = settings ? new MemoryReader(settings.main) : undefined;
  const required = () => {
    if (!reader || !settings) throw new Error(fault ?? 'Room mode is not set up.');
    return { reader, settings };
  };
  /** The prompt's AGENTS.md and memory extract, taken on the session's first turn and kept, so the prefix stays cached. */
  let instructions: string | undefined;

  pi.registerTool({
    name: 'main_zoom',
    label: 'Zoom main memory',
    description: 'Read-only: open line id+n of your main chat memory into the two lines of n/2 under it; n = 1 gives the message whole.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    async execute(_id: string, args: { id: number; n: number }) {
      return result(required().reader.zoom(args.id, args.n));
    },
  });
  pi.registerTool({
    name: 'main_search',
    label: 'Search main memory',
    description:
      'Read-only, a last resort once zooming has failed: find original messages of your main chat containing every term (case-insensitive), newest first, as id+0|kind date: snippet lines.',
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id: string, args: { query: string; limit?: number }) {
      return result(required().reader.search(args.query, args.limit));
    },
  });
  pi.registerTool({
    name: 'main_date',
    label: 'Main memory date',
    description: 'The date and time of message id of your main chat memory.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    async execute(_id: string, args: { id: number }) {
      return result(required().reader.date(args.id));
    },
  });
  pi.registerTool({
    name: 'room_history',
    label: 'Room history',
    description:
      'Older lines of this room, oldest first: up to limit (default 20, at most 50) lines before the line id `before`, or the newest.',
    parameters: Type.Object({
      before: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id: string, args: { before?: string; limit?: number }) {
      const { settings } = required();
      return result(roomHistory(join(settings.dir, 'room.jsonl'), args.before, args.limit, settings.member));
    },
  });

  /** The tools pi started the session with, as in a main chat: "full" mode's set. Taken before room mode trims it. */
  let startTools: string[] | undefined;
  /** The mode of the turn now running (or the last one). */
  let mode: RoomToolMode = 'lookup';
  let applied: RoomToolMode | undefined;
  const roomTools = () => {
    startTools ??= pi.getActiveTools();
    const before = applied;
    applied = mode;
    if (mode === 'lookup') return pi.setActiveTools([...ROOM_TOOLS]);
    // Full: what pi started with and the room's own talk tools, plus anything a tool loader activated during an
    // earlier full turn (as a main chat keeps it).
    const names = new Set([...startTools, ...(before === 'full' ? pi.getActiveTools() : []), ...ROOM_TALK_TOOLS]);
    for (const name of ROOM_NEVER_TOOLS) names.delete(name);
    pi.setActiveTools([...names]);
  };
  pi.on('session_start', (_event, ctx) => {
    mode = roomToolMode(env);
    roomTools();
    if (fault) ctx.ui.notify(fault, 'error');
    else ctx.ui.setStatus('optchat', `OptChat room: ${settings!.member} · ${settings!.group}`);
  });
  pi.on('input', (_event, ctx) => {
    if (!fault) return { action: 'continue' as const };
    ctx.ui.notify(fault, 'error');
    return { action: 'handled' as const };
  });
  // Belt and braces: a tool activated mid-turn (a loader, another package) or an option that writes or spends is
  // blocked here, whatever the active set says.
  // File lookups stay under the room dir and the bots root; a fetch goes to public hosts only (tools.ts).
  // The mode is read again on each call, so switching full tools off in the app holds from the next call on.
  pi.on('tool_call', async (event, ctx) => {
    const now = roomToolMode(env);
    const scope = roomScope(env, ctx.cwd);
    const problem =
      roomToolCallProblem(event.toolName, event.input, { scope, mode: now }) ??
      (now === 'lookup' && event.toolName === 'fetch_content' ? await roomFetchDnsProblem(event.input) : undefined);
    return problem ? { block: true, reason: problem } : undefined;
  });
  // A bot folder may hold a token by mistake: file lookup results reach the room with token shapes taken out
  // (lookup mode; full tools read files as a main chat does).
  pi.on('tool_result', event => {
    if (!ROOM_FILE_TOOLS.has(event.toolName) || roomToolMode(env) === 'full') return undefined;
    let changed = false;
    const content = event.content.map(part => {
      if (part.type !== 'text') return part;
      const text = redactSecrets(part.text);
      if (text !== part.text) changed = true;
      return text === part.text ? part : { ...part, text };
    });
    return changed ? { content } : undefined;
  });
  pi.on('before_agent_start', (event, ctx) => {
    mode = roomToolMode(env);
    roomTools();
    const { settings, reader } = required();
    if (instructions === undefined) {
      let agents: string, extract: string;
      try {
        agents = readFileSync(join(settings.main, 'AGENTS.md'), 'utf8');
      } catch {
        agents = `(No AGENTS.md found for ${settings.member}.)`;
      }
      try {
        extract = reader.extract();
      } catch (error) {
        extract = `(Main memory unavailable: ${error instanceof Error ? error.message : String(error)})`;
        ctx.ui.notify(extract, 'error');
      }
      instructions = roomInstructions(agents, extract);
    }
    const options = event.systemPromptOptions;
    options.customPrompt = roomPrompt(settings.member, settings.group, undefined, mode);
    // Nothing from the room's working directory, the user's global files or skills: the room sees only its own prompt.
    options.contextFiles = [];
    options.skills = [];
    options.sections.instructions = instructions;
  });
  // Packages loaded after this one may change the active set in their own before_agent_start handlers (on the host,
  // rpiv-ask-user-question re-adds ask_user_question whenever there is a UI, as under Paseo). So every request is
  // projected: tool declarations outside the allow-list are left out, whatever the active set says. (A call to one
  // is blocked by the tool_call handler above anyway.)
  pi.on('context_with_system', event => ({ messages: event.messages.map(message => onlyRoomTools(message, mode)) }));
  pi.on('cache_warming_decision', () => ({ action: 'stop' as const }));
}
