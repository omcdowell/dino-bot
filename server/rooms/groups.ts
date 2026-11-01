import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_ID_RE, GROUP_ID_RE, GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS, GroupSchema, leadsOf, type Group } from "../../shared/rooms/schema";

/** §3.1: `<bots root>/.groups.json`, written by Emmet at deploy. */
export const GROUPS_FILE = ".groups.json";
const PROFILE_FILE = ".optchat-profile";

/** The previous file, kept beside it on every in-app edit (one level of undo, by hand). */
export const GROUPS_BACKUP_SUFFIX = ".bak";

/** A members edit was refused; the message is shown to the owner as is. */
export class GroupEditError extends Error {}

export interface GroupsRead {
  groups: Group[];
  /** One line per group or file problem; invalid groups are left out, valid ones still load. */
  errors: string[];
}

function isBot(root: string, id: string): boolean {
  try {
    return readFileSync(join(root, id, PROFILE_FILE), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/** Validates the parsed file. Members must be bots under `root` (folders with an OptChat profile). */
export function validateGroups(raw: unknown, root: string): GroupsRead {
  const errors: string[] = [];
  const groups: Group[] = [];
  if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1 || !Array.isArray((raw as { groups?: unknown }).groups)) {
    return { groups, errors: ["groups file: expected { v: 1, groups: [...] }"] };
  }
  const seen = new Set<string>();
  for (const [i, entry] of ((raw as { groups: unknown[] }).groups).entries()) {
    const g = entry as Partial<Record<keyof Group | "lead", unknown>>;
    const where = `group ${typeof g?.id === "string" ? g.id : `#${i}`}`;
    if (!g || typeof g.id !== "string" || !GROUP_ID_RE.test(g.id)) {
      errors.push(`${where}: bad id`);
      continue;
    }
    if (seen.has(g.id)) {
      errors.push(`${where}: duplicate id`);
      continue;
    }
    if (typeof g.name !== "string" || !g.name.trim()) {
      errors.push(`${where}: missing name`);
      continue;
    }
    const members = Array.isArray(g.members) ? g.members : null;
    if (!members || !members.every((m): m is string => typeof m === "string" && BOT_ID_RE.test(m))) {
      errors.push(`${where}: bad members`);
      continue;
    }
    if (new Set(members).size !== members.length || members.length < 2 || members.length > 8) {
      errors.push(`${where}: needs 2-8 distinct members`);
      continue;
    }
    const missing = members.filter((m) => !isBot(root, m));
    if (missing.length) {
      errors.push(`${where}: not bots under ${root}: ${missing.join(", ")}`);
      continue;
    }
    const parsed = GroupSchema.safeParse({ id: g.id, name: g.name.trim(), members, leads: leadsOf(g) });
    if (!parsed.success) {
      errors.push(`${where}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      continue;
    }
    seen.add(g.id);
    groups.push(parsed.data);
  }
  return { groups, errors };
}

/** Reads `<root>/.groups.json`, re-reading only when its mtime or size changes. Missing file = no groups. */
export class GroupsFile {
  private key = "";
  private cached: GroupsRead = { groups: [], errors: [] };

  constructor(private readonly root: string, private readonly path = join(root, GROUPS_FILE)) {}

  get filePath(): string {
    return this.path;
  }

  /** Forget the cached read (after an edit made outside `setMembers`). */
  invalidate(): void {
    this.key = "";
  }

  read(): GroupsRead {
    let key: string;
    try {
      const st = statSync(this.path);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.key = "";
      this.cached = { groups: [], errors: [] };
      return this.cached;
    }
    if (key === this.key) return this.cached;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      this.cached = { groups: [], errors: [`groups file: ${error instanceof Error ? error.message : String(error)}`] };
      this.key = key;
      return this.cached;
    }
    this.cached = validateGroups(raw, this.root);
    this.key = key;
    return this.cached;
  }

  list(): Group[] {
    return this.read().groups;
  }

  get(id: string): Group | null {
    return this.list().find((g) => g.id === id) ?? null;
  }

  /**
   * In-app members edit (group info sheet): the group's members and leads become exactly these.
   * Validated with the same rules as loading (known bots under the root, 2-8 distinct members, at least
   * one lead, every lead among them), so the file never holds what it would refuse to load. Only this
   * group's `members` and `leads` change (an old single `lead` key is replaced by `leads`); every other
   * group and field (even ones this version does not read) is kept.
   * The current file is copied to `.groups.json.bak`, then the new one goes in by temp file + rename.
   * All file work is synchronous, so two edits in one process cannot interleave.
   */
  setMembers(id: string, members: string[], leads: string[]): { before: Group; after: Group } {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      throw new GroupEditError("No groups file on this host.");
    }
    let raw: { v?: unknown; groups?: unknown };
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch (error) {
      throw new GroupEditError(`The groups file does not parse; fix it by hand first (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!raw || raw.v !== 1 || !Array.isArray(raw.groups)) throw new GroupEditError("The groups file is not { v: 1, groups: [...] }.");
    const index = raw.groups.findIndex((g) => (g as { id?: unknown } | null)?.id === id);
    const before = this.get(id);
    if (index < 0 || !before) throw new GroupEditError(`Unknown group: ${id}`);
    const problem = membersProblem(members, leads, this.root);
    if (problem) throw new GroupEditError(problem);
    const { lead: _old, ...kept } = raw.groups[index] as { lead?: unknown };
    const entry = { ...kept, members: [...members], leads: members.filter((m) => leads.includes(m)) };
    const checked = validateGroups({ v: 1, groups: [entry] }, this.root);
    if (checked.errors.length || !checked.groups[0]) throw new GroupEditError(checked.errors.join("; ") || "Invalid group");
    const groups = [...raw.groups];
    groups[index] = entry;
    let mode = 0o644;
    try {
      mode = statSync(this.path).mode & 0o777;
    } catch {
      // keep the default
    }
    writeFileSync(`${this.path}${GROUPS_BACKUP_SUFFIX}`, text, { mode });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...raw, groups }, null, 2)}\n`, { mode });
    renameSync(tmp, this.path);
    this.key = "";
    return { before, after: checked.groups[0] };
  }
}

/**
 * Build 31 (bot management): new groups and renames from the phone home. Same file rules as
 * `setMembers`: validated, `.bak` copy of the old file, temp file + rename, synchronous.
 */
export function createGroup(file: GroupsFile, root: string, input: { id: string; name: string; members: string[]; leads: string[] }): Group {
  const path = file.filePath;
  let raw: { v?: unknown; groups?: unknown } = { v: 1, groups: [] };
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  if (text !== null) {
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch (error) {
      throw new GroupEditError(`The groups file does not parse; fix it by hand first (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!raw || raw.v !== 1 || !Array.isArray(raw.groups)) throw new GroupEditError("The groups file is not { v: 1, groups: [...] }.");
  }
  const groups = raw.groups as unknown[];
  const name = input.name.trim();
  if (!name) throw new GroupEditError("Give the group a name.");
  let id = input.id;
  if (!GROUP_ID_RE.test(id)) throw new GroupEditError("Use letters or numbers in the group name.");
  const taken = new Set(groups.map((g) => (g as { id?: unknown } | null)?.id));
  for (let n = 2; taken.has(id); n++) id = `${input.id.slice(0, 37)}-${n}`;
  const problem = membersProblem(input.members, input.leads, root);
  if (problem) throw new GroupEditError(problem);
  const entry = { id, name, members: [...input.members], leads: input.members.filter((m) => input.leads.includes(m)) };
  const checked = validateGroups({ v: 1, groups: [entry] }, root);
  if (checked.errors.length || !checked.groups[0]) throw new GroupEditError(checked.errors.join("; ") || "Invalid group");
  writeGroups(path, text, { ...raw, v: 1, groups: [...groups, entry] });
  file.invalidate();
  return checked.groups[0];
}

export function renameGroup(file: GroupsFile, id: string, name: string): void {
  const path = file.filePath;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new GroupEditError("No groups file on this host.");
  }
  let raw: { v?: unknown; groups?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch (error) {
    throw new GroupEditError(`The groups file does not parse; fix it by hand first (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.groups)) throw new GroupEditError("The groups file is not { v: 1, groups: [...] }.");
  const trimmed = name.trim();
  if (!trimmed) throw new GroupEditError("Give the group a name.");
  const index = raw.groups.findIndex((g) => (g as { id?: unknown } | null)?.id === id);
  if (index < 0) throw new GroupEditError(`Unknown group: ${id}`);
  const groups = [...raw.groups];
  groups[index] = { ...(groups[index] as object), name: trimmed };
  writeGroups(path, text, { ...raw, groups });
  file.invalidate();
}

function writeGroups(path: string, previous: string | null, next: object): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // new file
  }
  if (previous !== null) writeFileSync(`${path}${GROUPS_BACKUP_SUFFIX}`, previous, { mode });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  renameSync(tmp, path);
}

/** Why a members/leads set cannot be saved (null: it can). Same limits as the file contract (§3.1). */
export function membersProblem(members: readonly string[], leads: readonly string[], root: string): string | null {
  if (members.length < GROUP_MIN_MEMBERS) return `A group needs at least ${GROUP_MIN_MEMBERS} members.`;
  if (members.length > GROUP_MAX_MEMBERS) return `A group has at most ${GROUP_MAX_MEMBERS} members.`;
  if (new Set(members).size !== members.length) return "A bot is listed twice.";
  const bad = members.filter((m) => !BOT_ID_RE.test(m) || !isBot(root, m));
  if (bad.length) return `Not a bot on this host: ${bad.join(", ")}.`;
  if (leads.length === 0) return "A group needs at least one lead.";
  if (new Set(leads).size !== leads.length) return "A lead is listed twice.";
  if (!leads.every((l) => members.includes(l))) return "Every lead must be a member.";
  return null;
}
