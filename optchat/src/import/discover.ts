/**
 * Auto-import for onboarding: find every local agent history, group it by project, and read it into import entries.
 * Nothing is picked by hand: every project is ticked except throwaway folders (/tmp and the like), and the user can
 * untick a project before the import starts.
 */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { scanClaudeMemories, scanLocal, type Conversation, type ImportedEntry, type Source } from './sources.ts';
import { homeRoots, readAny, scanCursor, scanGemini, scanPi } from './adapters.ts';
import { chronological, deduplicate } from './job.ts';
import { bytes } from '../memory.ts';

export const SOURCE_LABELS: Record<Source, string> = {
  pi: 'pi',
  claude: 'Claude Code',
  'claude-memory': 'Claude Code memories',
  codex: 'Codex CLI',
  cursor: 'Cursor agent',
  gemini: 'Gemini CLI',
  chatgpt: 'ChatGPT export',
};
/** Agents we looked for and do not read yet, with why. Shown so the user knows they were not skipped silently. */
export const NOT_SUPPORTED = [
  { name: 'OpenCode', path: '~/.local/share/opencode', why: 'stores sessions in SQLite (opencode.db) since 2026; no adapter yet' },
  { name: 'GitHub Copilot CLI', path: '~/.copilot/session-state', why: 'no sample logs to build an adapter from' },
  {
    name: 'Cursor IDE chat panel',
    path: '~/.config/Cursor/User/workspaceStorage/*/state.vscdb',
    why: 'SQLite; only the agent transcripts are read',
  },
];
export interface SourceSummary {
  source: Source;
  label: string;
  conversations: number;
  bytes: number;
}
export interface ProjectGroup {
  project: string;
  conversations: number;
  bytes: number;
  sources: Partial<Record<Source, number>>;
  /** Ticked by default unless it is a throwaway folder or a bot's own folder. */
  ticked: boolean;
  unticked?: 'throwaway' | 'bot';
}
export interface Discovery {
  home: string;
  sources: SourceSummary[];
  projects: ProjectGroup[];
  conversations: Conversation[];
  warnings: string[];
}
const THROWAWAY = /^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders|\/dev\/shm)(\/|$)|^tmp-/;
export const throwaway = (project: string) => THROWAWAY.test(project);
/** A bot's folder (it or a parent has a .optchat-profile file): the bot already remembers these chats itself. */
export function botFolder(project: string, seen = new Map<string, boolean>()): boolean {
  if (!isAbsolute(project)) return false;
  for (let dir = project; ; dir = dirname(dir)) {
    const known = seen.get(dir);
    if (known !== undefined) return known;
    if (existsSync(join(dir, '.optchat-profile'))) {
      seen.set(project, true);
      return true;
    }
    if (dirname(dir) === dir) break;
  }
  seen.set(project, false);
  return false;
}

export async function discover(home = homedir(), signal?: AbortSignal): Promise<Discovery> {
  const roots = homeRoots(home);
  const scans = await Promise.all([
    scanPi(roots.pi, signal),
    scanLocal('claude', [roots.claude], signal),
    scanClaudeMemories(roots.claude, signal),
    scanLocal('codex', roots.codex, signal),
    scanCursor(roots.cursor, signal),
    scanGemini(roots.gemini, signal),
  ]);
  const conversations = scans.flatMap(s => s.conversations).sort((a, b) => a.date.localeCompare(b.date));
  const bots = new Map<string, boolean>();
  const sources = new Map<Source, SourceSummary>(),
    projects = new Map<string, ProjectGroup>();
  for (const c of conversations) {
    const s = sources.get(c.source) ?? { source: c.source, label: SOURCE_LABELS[c.source], conversations: 0, bytes: 0 };
    s.conversations++;
    s.bytes += c.size;
    sources.set(c.source, s);
    let p = projects.get(c.project);
    if (!p) {
      // A bot's own folder says 'bot' even when the home itself sits in a temp folder (tests, CI).
      const unticked = botFolder(c.project, bots) ? 'bot' : throwaway(c.project) ? 'throwaway' : undefined;
      p = { project: c.project, conversations: 0, bytes: 0, sources: {}, ticked: !unticked, ...(unticked ? { unticked } : {}) };
    }
    p.conversations++;
    p.bytes += c.size;
    p.sources[c.source] = (p.sources[c.source] ?? 0) + 1;
    projects.set(c.project, p);
  }
  return {
    home,
    sources: [...sources.values()],
    projects: [...projects.values()].sort((a, b) => b.bytes - a.bytes || a.project.localeCompare(b.project)),
    conversations,
    warnings: scans.flatMap(s => s.warnings),
  };
}

export interface Read {
  entries: ImportedEntry[];
  warnings: string[];
  /** Messages per project after de-duplication, and their text size. */
  perProject: Map<string, { messages: number; bytes: number }>;
  bytes: number;
  /** Logged size of each entry in import order (chronological by conversation), for the estimate. */
  sizes: number[];
}
/** Reads the ticked projects (all ticked ones if `projects` is omitted), oldest conversation first, de-duplicated. */
export async function readDiscovered(
  found: Discovery,
  projects = found.projects.filter(p => p.ticked).map(p => p.project),
  signal?: AbortSignal,
  progress: (done: number, total: number) => void = () => {},
): Promise<Read> {
  const wanted = new Set(projects);
  const chosen = found.conversations.filter(c => wanted.has(c.project));
  const all: ImportedEntry[] = [],
    warnings: string[] = [...found.warnings];
  for (const [k, c] of chosen.entries()) {
    const read = await readAny(c, signal);
    all.push(...read.entries);
    warnings.push(...read.warnings);
    progress(k + 1, chosen.length);
  }
  const { added: entries } = deduplicate([], all);
  const perProject = new Map<string, { messages: number; bytes: number }>();
  let total = 0;
  for (const e of entries) {
    const key = e.origin?.project ?? '';
    const p = perProject.get(key) ?? { messages: 0, bytes: 0 };
    p.messages++;
    p.bytes += bytes(e.text);
    total += bytes(e.text);
    perProject.set(key, p);
  }
  const sizes = chronological(entries).map(e => bytes(`${e.kind}: ${e.text}`));
  return { entries, warnings, perProject, bytes: total, sizes };
}
