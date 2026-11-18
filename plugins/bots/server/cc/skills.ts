/**
 * The skills a bot on Claude Code sees, listed in its system prompt the way pi lists them for a pi bot (pi's
 * formatSkillsForPrompt: name, description, SKILL.md path; the bot reads the file when a task matches). The TUI runs
 * with no Skill tool and no slash commands (start-bot.sh), and the view mod replaces Claude Code's own prompt with
 * OptChat's, so this list is how a Claude Code bot learns its skills.
 *
 * Which skills, first name wins:
 *   1. the bots plugin's shared skills (plugins/bots/skills: workers, herdr, diagnose, tdd, screenshot-app, ...)
 *   2. the bot's own skills, `<bot folder>/.agents/skills/<name>/SKILL.md` (the bot prompt tells it to write them there)
 *   3. the user's global skills (pi's agent dir `skills/`, `~/.agents/skills`), only those named in pi-optchat's
 *      shared skill list (`<OPTCHAT_HOME>/skills.json` `global`, or the profile's config.json), as for a pi bot
 * pi-optchat's `hide` list drops any of them. Read on every turn (a new skill shows on the next message); sorted by
 * name, so the prompt stays byte-identical while nothing changes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface CcSkill {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md. */
  path: string;
}

export interface CcSkillSources {
  /** The bots plugin's shared skills folder (plugins/bots/skills). */
  pluginSkillsDir?: string;
  /** The bot's folder (~/bots/<bot>): its own `.agents/skills`. */
  botDir?: string;
  /** The bot's OptChat profile folder (its config.json may override the shared skill list). */
  profileDir: string;
  /** OPTCHAT_HOME (skills.json). */
  optchatHome: string;
  /** pi's agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent): its `skills/` are global skills. */
  piAgentDir?: string;
  home?: string;
}

/**
 * pi-optchat's skill list (its src/skills.ts skillPolicy, same files and keys): `<OPTCHAT_HOME>/skills.json`, else
 * herdr and workers; the profile's config.json `skills` overrides it key by key. Kept here rather than imported: that
 * module pulls pi's types (and the DOM's) into the plugin's typecheck.
 */
export function skillPolicy(profileDir: string, optchatHome: string): { global: string[]; hide: string[] } {
  const read = (file: string, nested: boolean) => {
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
      const raw = (nested ? v?.skills : v) as { global?: unknown; hide?: unknown } | null | undefined;
      const names = (a: unknown[]) => a.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      return { ...(Array.isArray(raw?.global) ? { global: names(raw.global) } : {}), ...(Array.isArray(raw?.hide) ? { hide: names(raw.hide) } : {}) };
    } catch {
      return {};
    }
  };
  return { global: ["herdr", "workers"], hide: [], ...read(join(optchatHome, "skills.json"), false), ...read(join(profileDir, "config.json"), true) };
}

/** `key: value` lines of a SKILL.md front matter, with quoted values and `>` / `|` blocks. */
export function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    out[kv[1]!] = value;
  }
  return out;
}

/** The skills in one folder: each subfolder with a SKILL.md that has a description. */
function skillsIn(dir: string | undefined): CcSkill[] {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CcSkill[] = [];
  for (const entry of names.sort()) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry, "SKILL.md");
    try {
      if (!statSync(path).isFile()) continue;
      const fm = frontMatter(readFileSync(path, "utf8"));
      if (!fm.description || fm["disable-model-invocation"] === "true") continue;
      out.push({ name: fm.name || entry, description: fm.description, path });
    } catch {}
  }
  return out;
}

export function ccBotSkills(src: CcSkillSources): CcSkill[] {
  const home = src.home ?? homedir();
  const policy = skillPolicy(src.profileDir, src.optchatHome);
  const globals = [...skillsIn(src.piAgentDir ? join(src.piAgentDir, "skills") : undefined), ...skillsIn(join(home, ".agents", "skills"))].filter((s) =>
    policy.global.includes(s.name),
  );
  const seen = new Set<string>();
  const out: CcSkill[] = [];
  for (const s of [...skillsIn(src.pluginSkillsDir), ...skillsIn(src.botDir ? join(src.botDir, ".agents", "skills") : undefined), ...globals]) {
    if (seen.has(s.name) || policy.hide.includes(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** pi's skills section (formatSkillsForPrompt), worded for Claude Code's Read tool. Empty without skills. */
export function formatCcSkills(skills: readonly CcSkill[]): string {
  if (!skills.length) return "";
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the Read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...skills.flatMap((s) => ["  <skill>", `    <name>${xml(s.name)}</name>`, `    <description>${xml(s.description)}</description>`, `    <location>${xml(s.path)}</location>`, "  </skill>"]),
    "</available_skills>",
  ].join("\n");
}

/** The bots plugin's skills folder next to claude-code/ (the mods' folder, launch.ts ccModsDir), if it is there. */
export function pluginSkillsDirFor(ccModsDir: string): string | undefined {
  const dir = resolve(ccModsDir, "..", "skills");
  return existsSync(dir) ? dir : undefined;
}

/**
 * The message pi sends for `/skill:<name> [args]` (pi's AgentSession skill expansion, the same words): the SKILL.md
 * body without its front matter in a <skill> block, then the arguments.
 */
export function skillPrompt(skill: CcSkill, args: string): string {
  const body = readFileSync(skill.path, "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim();
  const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${dirname(skill.path)}.\n\n${body}\n</skill>`;
  return args.trim() ? `${block}\n\n${args.trim()}` : block;
}

/** The command a skill message was sent as (`/skill:<name> [args]`), for the chat; null for any other text. */
export function skillCommandText(text: string): string | null {
  const m = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text.trim());
  return m ? `/skill:${m[1]}${m[2]?.trim() ? ` ${m[2].trim()}` : ""}` : null;
}
