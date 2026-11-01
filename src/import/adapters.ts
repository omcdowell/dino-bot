/**
 * Adapters for the agents /optchat import did not read: pi, Cursor (agent CLI / IDE agent transcripts) and
 * Gemini CLI. Each turns one source's local logs into the import format OptChat already uses: user messages
 * and final assistant replies, tool activity and reasoning left out, one receipt per message.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { record } from '../cache.ts';
import type { Kind, Origin } from '../memory.ts';
import { digest, filesUnder, jsonLines, missingSource, readConversation, string, text, timestamp } from './sources.ts';
import type { Conversation, ImportedEntry, Scan } from './sources.ts';

export const homeRoots = (home: string) => ({
  pi: join(home, '.pi/agent/sessions'),
  claude: join(home, '.claude/projects'),
  codex: [join(home, '.codex/sessions'), join(home, '.codex/archived_sessions')],
  cursor: join(home, '.cursor/projects'),
  gemini: join(home, '.gemini/tmp'),
});

const titleOf = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 110);
function entry(
  c: Conversation,
  message: string,
  kind: Kind,
  content: string,
  date: string,
  identity: unknown[] = [c.source, c.id, message, kind, content],
): ImportedEntry | undefined {
  if (!content.trim()) return undefined;
  const origin: Origin = { source: c.source, conversation: c.id, message, title: c.title, project: c.project };
  return {
    kind,
    date,
    origin,
    text: `[Historical ${c.source} · ${date} · conversation ${c.id} · ${c.title}]\n${content}`,
    receipt: `import:${digest(JSON.stringify(identity))}`,
  };
}
const missing = (file: string) => `${file}: source file is no longer available; conversation skipped.`;

// ---------- pi ----------
/** pi: ~/.pi/agent/sessions/<cwd-slug>/<time>_<id>.jsonl, a `session` header (id, cwd) then one entry per line. */
export async function scanPi(root: string, signal?: AbortSignal): Promise<Scan> {
  const conversations: Conversation[] = [],
    warnings: string[] = [];
  for (const file of await filesUnder(root, n => n.endsWith('.jsonl'), signal)) {
    try {
      const info = await stat(file);
      let id = basename(file, '.jsonl'),
        project = dirname(file),
        date = info.mtime.toISOString(),
        title = '',
        named = '';
      for await (const { value: v, line } of jsonLines(file, warnings, Infinity, signal)) {
        if (v.type === 'session') {
          id = string(v.id) ?? id;
          project = string(v.cwd) ?? project;
          date = timestamp(v.timestamp, date);
        } else if (v.type === 'session_info' && string(v.name)) named = String(v.name);
        else if (!title && v.type === 'message' && record(v.message) && v.message.role === 'user') title = titleOf(text(v.message.content));
        if (title && (named || line > 200)) break;
      }
      conversations.push({ source: 'pi', id, file, project, date, title: named || title || id, size: info.size });
    } catch (error) {
      signal?.throwIfAborted();
      if (!missingSource(error)) throw error;
      warnings.push(missing(file));
    }
  }
  return { conversations, warnings };
}
async function readPi(c: Conversation, signal?: AbortSignal) {
  const entries: ImportedEntry[] = [],
    warnings: string[] = [];
  for await (const { value: v, line } of jsonLines(c.file, warnings, Infinity, signal)) {
    if (v.type !== 'message' || !record(v.message)) continue;
    const m = v.message,
      id = string(v.id) ?? `line:${line}`,
      date = timestamp(v.timestamp ?? m.timestamp, c.date);
    // A forked session copies its parent's entries with the same ids and times; leaving the conversation out of
    // the receipt imports each copied message once.
    const add = (kind: Kind, content: string) => {
      const e = entry(c, id, kind, content, date, ['pi', id, date, kind, content]);
      if (e) entries.push(e);
    };
    if (m.role === 'user') add('user', text(m.content));
    else if (m.role === 'assistant') {
      // Only a reply that ended the turn: text written alongside tool calls is work in progress.
      const blocks = Array.isArray(m.content) ? m.content : [];
      const tools = blocks.some(b => record(b) && b.type === 'toolCall');
      if (m.stopReason === 'stop' && !tools) add('talk', text(m.content));
    }
  }
  return { entries, warnings };
}

// ---------- Cursor ----------
/** Cursor: ~/.cursor/projects/<path-slug>/agent-transcripts/<id>/<id>.jsonl, lines of {role, message: {content}}. No times. */
export async function scanCursor(root: string, signal?: AbortSignal): Promise<Scan> {
  const conversations: Conversation[] = [],
    warnings: string[] = [];
  const projects = await readdir(root, { withFileTypes: true }).catch(error => {
    if (missingSource(error)) return [];
    throw error;
  });
  for (const dir of projects
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()) {
    const transcripts = join(root, dir, 'agent-transcripts');
    for (const file of await filesUnder(transcripts, n => n.endsWith('.jsonl'), signal)) {
      if (relative(transcripts, file).split(/[\\/]/).includes('subagents')) continue;
      try {
        const info = await stat(file);
        let title = '';
        for await (const { value: v } of jsonLines(file, warnings, 5, signal))
          if (v.role === 'user' && record(v.message)) {
            title = text(v.message.content);
            break;
          }
        // Runs driven by pi through Cursor's SDK are already in pi's own history.
        if (title.includes('Cursor SDK tool boundary')) continue;
        conversations.push({
          source: 'cursor',
          id: basename(file, '.jsonl'),
          file,
          project: cursorProject(dir),
          date: info.mtime.toISOString(),
          title: titleOf(userQuery(title)) || basename(file, '.jsonl'),
          size: info.size,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!missingSource(error)) throw error;
        warnings.push(missing(file));
      }
    }
  }
  return { conversations, warnings };
}
/** The folder name is the path with '/' and '.' turned into '-'; take the path back when it exists, else keep the name. */
function cursorProject(slug: string): string {
  const guess = '/' + slug.replace(/-/g, '/');
  return existsSync(guess) ? guess : slug;
}
const userQuery = (s: string) => {
  const inner = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(s)?.[1];
  return (inner ?? s).replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, '').trim();
};
async function readCursor(c: Conversation, signal?: AbortSignal) {
  const entries: ImportedEntry[] = [],
    warnings: string[] = [];
  let pending: ImportedEntry | undefined;
  const flush = () => {
    if (pending) entries.push(pending);
    pending = undefined;
  };
  for await (const { value: v, line } of jsonLines(c.file, warnings, Infinity, signal)) {
    if (!record(v.message)) continue;
    const blocks = Array.isArray(v.message.content) ? v.message.content : [];
    if (v.role === 'user') {
      flush();
      const e = entry(c, `line:${line}`, 'user', userQuery(text(v.message.content)), c.date);
      if (e) entries.push(e);
    } else if (v.role === 'assistant') {
      // The last text-only reply before the next request is the answer; replies with tool calls are progress notes.
      pending = blocks.some(b => record(b) && b.type === 'tool_use')
        ? undefined
        : entry(c, `line:${line}`, 'talk', text(v.message.content), c.date);
    }
  }
  flush();
  return { entries, warnings };
}

// ---------- Gemini CLI ----------
/** Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.json, {sessionId, startTime, messages: [{id, timestamp, type, content}]}. */
export async function scanGemini(root: string, signal?: AbortSignal): Promise<Scan> {
  const conversations: Conversation[] = [],
    warnings: string[] = [];
  for (const file of await filesUnder(root, n => /^session-.*\.json$/.test(n), signal)) {
    if (basename(dirname(file)) !== 'chats') continue;
    try {
      const info = await stat(file);
      const data: unknown = JSON.parse(await readFile(file, { encoding: 'utf8', signal }));
      if (!record(data) || !Array.isArray(data.messages)) {
        warnings.push(`${file}: not a Gemini CLI session; skipped`);
        continue;
      }
      const first = data.messages.find(m => record(m) && m.type === 'user');
      const folder = dirname(dirname(file));
      conversations.push({
        source: 'gemini',
        id: string(data.sessionId) ?? basename(file, '.json'),
        file,
        project: geminiProject(folder),
        date: timestamp(data.startTime, info.mtime.toISOString()),
        title: (record(first) && titleOf(geminiText(first.content))) || basename(file, '.json'),
        size: info.size,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SyntaxError) warnings.push(`${file}: invalid JSON; skipped`);
      else if (missingSource(error)) warnings.push(missing(file));
      else throw error;
    }
  }
  return { conversations, warnings };
}
function geminiProject(folder: string): string {
  try {
    return readFileSync(join(folder, '.project_root'), 'utf8').trim() || basename(folder);
  } catch {
    return basename(folder); // older versions name the folder by a hash of the project path
  }
}
const geminiText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(p => (record(p) ? (string(p.text) ?? '') : '')).join('')
      : text(content);
async function readGemini(c: Conversation, signal?: AbortSignal) {
  const entries: ImportedEntry[] = [],
    warnings: string[] = [];
  const data: unknown = JSON.parse(await readFile(c.file, { encoding: 'utf8', signal }));
  if (!record(data) || !Array.isArray(data.messages)) return { entries, warnings: [`${c.file}: not a Gemini CLI session`] };
  let pending: ImportedEntry | undefined;
  const flush = () => {
    if (pending) entries.push(pending);
    pending = undefined;
  };
  for (const [k, m] of data.messages.entries()) {
    if (!record(m)) continue;
    const id = string(m.id) ?? `message:${k}`,
      date = timestamp(m.timestamp, c.date);
    if (m.type === 'user') {
      flush();
      const e = entry(c, id, 'user', geminiText(m.content), date);
      if (e) entries.push(e);
    } else if (m.type === 'gemini')
      pending = Array.isArray(m.toolCalls) && m.toolCalls.length ? undefined : entry(c, id, 'talk', geminiText(m.content), date);
  }
  flush();
  return { entries, warnings };
}

/** Reads any source: the adapters above, or /optchat import's own readers for Claude, Codex, ChatGPT and Claude memories. */
export async function readAny(c: Conversation, signal?: AbortSignal): Promise<{ entries: ImportedEntry[]; warnings: string[] }> {
  signal?.throwIfAborted();
  const reader = c.source === 'pi' ? readPi : c.source === 'cursor' ? readCursor : c.source === 'gemini' ? readGemini : undefined;
  if (!reader) return readConversation(c, signal);
  try {
    const result = await reader(c, signal);
    return { entries: [...new Map(result.entries.map(e => [e.receipt, e])).values()], warnings: result.warnings };
  } catch (error) {
    signal?.throwIfAborted();
    if (!missingSource(error)) throw error;
    return { entries: [], warnings: [missing(c.file)] };
  }
}
