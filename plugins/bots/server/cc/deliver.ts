/**
 * How a message reaches a Claude Code bot's TUI: the engine types it with `herdr agent prompt` (no mod submits), so
 * a Stop never holds it (Claude Code holds a mod's input after a Stop until the person types; typed text is the
 * person's). Typing has hazards (research/friend/report-cc-herdr-delivery.md, section 4); the guards are here:
 *
 * - the text is normalised as the TUI would change it (CR/CRLF to LF, tab to 4 spaces, NFC, no control characters),
 *   so the engine's receipt match (the logged user message against the item's text) holds;
 * - a text that opens with `/` (a command), `!` (bash mode), `-` (a herdr option) or other ASCII punctuation gets a
 *   leading space, so it is plain text; the labels (`[dm …]`, `[room …]`) open with `[` and are kept as they are;
 * - a very long text goes in a file the message points to.
 */
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the engine needs from the bot's TUI (server/cc/launch.ts herdrDelivery). */
export interface CcDelivery {
  /** herdr's state of the TUI: idle, done, working, blocked, unknown; `gone` when no such agent. */
  state(): Promise<string>;
  /** Types the text and Enter (`herdr agent prompt`, no --wait). `code` is herdr's error code (agent_blocked …). */
  prompt(text: string): Promise<{ ok: true } | { ok: false; code: string; message?: string }>;
  /** Clears the composer of a text typed there and not submitted (before it is typed again). */
  clear(text: string): Promise<void>;
  /** The TUI's session transcript (JSONL), if herdr knows it. */
  sessionFile(): Promise<string | null>;
}

/** Most bytes typed; a longer text goes in a file. Measured fine at 31 KB. */
export const MAX_TYPED_BYTES = 64_000;

/** The text as the TUI keeps it when typed (so the receipt match holds): LF only, tabs as 4 spaces, NFC, no controls. */
export function normalise(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "    ")
      .normalize("NFC")
      // C0 controls but LF, DEL and C1 controls (ESC sequences lose their ESC, so the rest stays as text).
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
  );
}

/**
 * ASCII punctuation the composer may read as a mode or command (`/` command, `!` bash, `#`, `&`, `-` herdr's argv):
 * any of it but the openers SAFE_START names.
 */
const RISKY_START = /^[!-\/:-@\[-`{-~]/;
const SAFE_START = /^[\[("'`]/;

/** A leading space when the first character could be a command or mode; trimmed first. */
export function guardLeading(text: string): string {
  const t = text.trim();
  return RISKY_START.test(t) && !SAFE_START.test(t) ? ` ${t}` : t;
}

/** The text to type for an item: normalised and guarded; over MAX_TYPED_BYTES, a pointer to a file holding it. */
export function typedText(text: string, id: string, spillDir: string): string {
  const t = guardLeading(normalise(text));
  if (Buffer.byteLength(t) <= MAX_TYPED_BYTES) return t;
  mkdirSync(spillDir, { recursive: true, mode: 0o700 });
  const file = join(spillDir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
  writeFileSync(file, text, { mode: 0o600 });
  const first = t.trimStart().split("\n", 1)[0]!;
  const label = /^\[(dm|room) [^\]\n]*\]$/.test(first) ? `${first}\n` : "";
  return `${label}(This message is ${Buffer.byteLength(text)} bytes, too long to type: it is in ${file}. Read that file for the whole message; if Read cuts its long lines, \`cat\` it with Bash.)`;
}

/** Bot traffic (a bot DM, a room message or task), by its label; else the owner's own message. */
export const isBotTraffic = (text: string) => /^\s*\[(dm|room) /.test(text);

/** A prompt without the view a new session's first prompt carries in front of it. */
export const afterView = (t: string) => (t.startsWith("<chat>") && t.includes("</chat>") ? t.slice(t.indexOf("</chat>") + 7).trim() : t);

/** A typed text, as the mods report it, is the item's: the same after normalising (a view may stand before it). */
export function sameText(typed: string, itemText: string): boolean {
  const a = normalise(typed).trim();
  const b = normalise(itemText).trim();
  if (!b) return false;
  return a === b || (a.startsWith("<chat>") && a.endsWith(b));
}

/**
 * Whether the TUI's transcript holds the text, written at or after `since` (ms): `user` as a user message (a typed
 * text whose ack, the mod's hook, was lost), `queued` as a message Claude Code put into a running turn (a
 * `queued_command` attachment: typed just as a turn started). Reads the last 4 MB at most.
 */
export function transcriptHas(file: string, text: string, since: number): "user" | "queued" | null {
  const want = normalise(text).trim();
  if (!want) return null;
  let raw = "";
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    raw = buf.toString("utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"user"') && !line.includes("queued_command")) continue;
    let m: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown }; attachment?: { type?: unknown; prompt?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
    if (Number.isFinite(at) && at < since - 2000) continue;
    if (m.type === "attachment" && m.attachment?.type === "queued_command") {
      if (typeof m.attachment.prompt === "string" && normalise(m.attachment.prompt).includes(want)) return "queued";
      continue;
    }
    if (m.type !== "user" && m.message?.role !== "user") continue;
    const c = m.message?.content;
    const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.flatMap((b) => (b && typeof b.text === "string" ? [b.text] : [])) : [];
    if (texts.some((t) => normalise(t).includes(want))) return "user";
  }
  return null;
}
