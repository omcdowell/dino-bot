/**
 * The app's session list and rewind for Claude Code bots (provider `optchat-cc`), as Paseo offers them for pi bots.
 *
 * Session list: one entry per Claude Code bot folder (its `.bot.json` chat is optchat-cc), with the last message of
 * its OptChat log; opening it is a chat of that bot with its history, as a reopened chat.
 *
 * Rewind: as on a pi bot (pi moves its session tree; OptChat's log is append-only), the chat drops the rewound message
 * and what followed, and so does its history when it is reopened (the hidden log ranges ride in the chat's persistence).
 * The bot's OptChat memory keeps them, on pi as here: rewinding a bot's chat does not make the bot forget.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderPersistence, ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { memoryDirectory } from "pi-optchat/api";

/** Log ranges [from, to) a chat no longer shows (rewound). */
export type Hidden = Array<[number, number]>;

export const ccPersistence = (bot: string, hidden: Hidden): ProviderPersistence => ({ version: 1, data: hidden.length ? { bot, hidden } : { bot } });

/** The hidden ranges a chat's persistence carries (none for a chat from before rewind, or a bad value). */
export function hiddenOf(persistence: ProviderPersistence | undefined): Hidden {
  const data = persistence?.data as { hidden?: unknown } | undefined;
  const list = Array.isArray(data?.hidden) ? data!.hidden : [];
  return list.filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isSafeInteger(n) && n >= 0) && r[0] < r[1]);
}

export const shown = (hidden: Hidden) => (e: { i: number }) => !hidden.some(([from, to]) => e.i >= from && e.i < to);

/** The token a user message carries for a rewind: its log index (a reopened chat's rows) or its inbox id (the receipt). */
export type RewindToken = { i: number } | { turn: string };

/**
 * The range a rewind to `token` hides: from the message's log entry to the end of the log. An error a person can act
 * on when the message is not in the log (not typed into the bot yet).
 */
export function rewindRange(token: unknown, root: ReadonlyArray<{ i: number; kind: string; receipt?: string }>): [number, number] {
  const t = (token ?? {}) as { i?: unknown; turn?: unknown };
  const entry =
    typeof t.i === "number" ? root.find((e) => e.i === t.i && e.kind === "user") : typeof t.turn === "string" ? root.find((e) => e.receipt === t.turn && e.kind === "user") : undefined;
  if (!entry) throw new Error("That message has not reached the bot yet; stop it instead of rewinding.");
  return [entry.i, (root.at(-1)?.i ?? entry.i) + 1];
}

/** Adds a range, merged with those it overlaps or touches. */
export function addHidden(hidden: Hidden, range: [number, number]): Hidden {
  const all = [...hidden, range].sort((a, b) => a[0] - b[0]);
  const out: Hidden = [];
  for (const r of all) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const isCcChat = (dir: string) => {
  try {
    const p = JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8"))?.chat?.provider;
    return p === "optchat-cc" || (typeof p === "string" && p.startsWith("optchat-cc/"));
  } catch {
    return false;
  }
};

/** The newest user or answer line of a profile's OptChat log, and when it was written; read only. */
function lastMessage(profileDir: string): { text?: string; at?: string } {
  try {
    const main = join(memoryDirectory(profileDir), "main");
    const files = readdirSync(main).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files.reverse()) {
      const lines = readFileSync(join(main, f), "utf8").trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if ((e.kind === "user" || e.kind === "talk") && typeof e.text === "string")
            return { text: e.text.replace(/\s+/g, " ").slice(0, 200), at: typeof e.date === "string" ? e.date : statSync(join(main, f)).mtime.toISOString() };
        } catch {}
      }
    }
  } catch {}
  return {};
}

/** The Claude Code bots under `botsRoot` (in `cwd`, if given), newest first, as the app's session list. */
export function listCcSessions(
  input: { cwd?: string; query?: string; limit?: number },
  botsRoot: string,
  optchatHome: string,
  extra: Iterable<string> = [],
): ProviderSessionSummary[] {
  const root = resolve(botsRoot);
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith("."));
  } catch {}
  const open = new Set(extra);
  const out: Array<ProviderSessionSummary & { at: number }> = [];
  for (const bot of names.sort()) {
    const dir = join(root, bot);
    if (input.cwd && resolve(input.cwd) !== dir) continue;
    let profile = "";
    try {
      profile = readFileSync(join(dir, ".optchat-profile"), "utf8").trim();
    } catch {}
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) || !(open.has(bot) || isCcChat(dir))) continue;
    const last = lastMessage(join(optchatHome, "profiles", profile));
    const q = input.query?.trim().toLowerCase();
    if (q && !`${bot} ${last.text ?? ""}`.toLowerCase().includes(q)) continue;
    out.push({
      persistence: ccPersistence(bot, []),
      cwd: dir,
      title: bot,
      ...(last.text ? { description: last.text } : {}),
      ...(last.at ? { updatedAt: last.at } : {}),
      at: last.at ? Date.parse(last.at) || 0 : 0,
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, input.limit && input.limit > 0 ? input.limit : undefined).map(({ at: _at, ...s }) => s);
}
