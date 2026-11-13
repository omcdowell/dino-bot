/**
 * The old bot-dm block in a profile's AGENTS.md (`<!-- bot-dm:begin vN --> … <!-- bot-dm:end -->`),
 * written by older setups, the app's "New bot" and bin/bot-dm-snippet-sync. Its text now lives in
 * the "DinoBot bot" system-prompt section (server/bot-prompt.ts), so AGENTS.md keeps only what is the
 * bot's own. The plugin strips the block once at start (stripProfiles), after a backup.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BLOCK_RE = /\n*<!-- bot-dm:begin v\d+ -->\n[\s\S]*?<!-- bot-dm:end -->\n?/;

/** `text` without the bot-dm block (and the blank lines before it); unchanged when it has none. */
export function withoutBotDmBlock(text: string): string {
  if (!BLOCK_RE.test(text)) return text;
  const out = text.replace(BLOCK_RE, "\n");
  return out.trim() ? `${out.trimEnd()}\n` : "";
}

export type StripResult = { profile: string; backup: string };

/**
 * Strips the block from every `<optchat home>/profiles/<name>/AGENTS.md` that has one. Each file is
 * first copied to `AGENTS.md.bak-bot-dm-<time>` (same mode), then replaced atomically. A file
 * without the block is not touched, so a second run does nothing.
 */
export function stripProfiles(optchatHome: string, now = new Date()): StripResult[] {
  const root = join(optchatHome, "profiles");
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const done: StripResult[] = [];
  for (const name of names) {
    const file = join(root, name, "AGENTS.md");
    if (!existsSync(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = withoutBotDmBlock(before);
    if (after === before) continue;
    const mode = statSync(file).mode & 0o777;
    const backup = `${file}.bak-bot-dm-${stamp}`;
    copyFileSync(file, backup);
    const tmp = `${file}.bot-dm-${process.pid}`;
    writeFileSync(tmp, after, { mode });
    renameSync(tmp, file);
    done.push({ profile: name, backup });
  }
  return done;
}
