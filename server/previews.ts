/**
 * Row previews for the phone home: one line about each bot's latest response, DMs included
 * (2026-10-08: "just a short summary include the latest response inc dms").
 *
 * No summarising: the preview is the last chat item, trimmed. Two sources, newest wins:
 * - the bot's current chat: the last assistant message (or error) in the timeline tail;
 * - the bot's DM ledger: the latest DM the bot sent, as "Messaged <name>: <subject>".
 *
 * The same timeline read gives `turnStartedAt`, the start of the chat's latest turn, so the row
 * can show how long a running turn has been going.
 */
import type { BotPreview } from "../shared/home-rpc";

export const PREVIEW_TAIL = 40;
/** Second, longer read when the latest turn fills the whole first window (long running turns). */
export const PREVIEW_TAIL_LONG = 1000;
export const PREVIEW_MAX = 140;

export type PreviewEntry = {
  timestamp: string;
  turnId?: string | null;
  item: { type: string; text?: string; message?: string };
};

/** A table's `|---|:--:|` row, or a rule (`---`, `***`). */
const RULE_LINE = /^\s*(\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?|([-*_])(\s*\3){2,})\s*$/;

/** Markdown marks out (tables: rows as "cell · cell"), whitespace collapsed, cut at `max` with an ellipsis. */
export function oneLine(text: string, max = PREVIEW_MAX): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => !RULE_LINE.test(line))
    .map((line) =>
      /^\s*\|.*\|\s*$/.test(line)
        ? line
            .trim()
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(" · ")
        : line,
    )
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** The last assistant message or error in the window, as a preview. */
export function chatPreview(entries: readonly PreviewEntry[]): BotPreview | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { item, timestamp } = entries[i]!;
    if (item.type === "assistant_message" && item.text?.trim()) {
      return { kind: "reply", text: oneLine(item.text), ts: timestamp };
    }
    if (item.type === "error" && item.message?.trim()) {
      return { kind: "error", text: oneLine(`Error: ${item.message}`), ts: timestamp };
    }
  }
  return null;
}

const MESSAGE_TYPES = new Set(["user_message", "assistant_message", "error"]);

/** When the chat last had a message (prompt, reply or error) in the window; tool calls do not count. */
export function chatMessageAt(entries: readonly PreviewEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (MESSAGE_TYPES.has(entries[i]!.item.type)) return entries[i]!.timestamp;
  }
  return null;
}

/** The newest of the given ISO times (bad or missing ones skipped); null when none. */
export function newestTime(...times: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const time of times) {
    const ms = Date.parse(time ?? "");
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = time!;
      bestMs = ms;
    }
  }
  return best;
}

/** Whether the latest turn may have started before the window: it fills the window and more is held. */
export function turnFillsWindow(entries: readonly PreviewEntry[], hasOlder: boolean): boolean {
  const turnId = entries.at(-1)?.turnId;
  return hasOlder && !!turnId && entries.every((entry) => entry.turnId === turnId);
}

/**
 * Start of the latest turn: its first entry, or the user message just before it when that message
 * carries no turn id (a chat's first prompt). Null when the last entry has no turn id.
 */
export function turnStartedAt(entries: readonly PreviewEntry[]): string | null {
  const last = entries.at(-1);
  const turnId = last?.turnId;
  if (!last || !turnId) return null;
  let i = entries.length - 1;
  while (i > 0 && entries[i - 1]!.turnId === turnId) i--;
  const before = entries[i - 1];
  if (before && !before.turnId && before.item.type === "user_message") return before.timestamp;
  return entries[i]!.timestamp;
}

export type OutgoingDm = { ts: string; to: string; subject: string };

/** "Messaged Flint: can you check…", from the bot's latest sent DM. */
export function dmPreview(dm: OutgoingDm, nameOf: (party: string) => string): BotPreview {
  return { kind: "dm", text: oneLine(`Messaged ${nameOf(dm.to)}: ${dm.subject}`), ts: dm.ts };
}

/** The newer of the two; ties go to the chat. */
export function latestPreview(chat: BotPreview | null, dm: BotPreview | null): BotPreview | null {
  if (!chat) return dm;
  if (!dm) return chat;
  return Date.parse(dm.ts) > Date.parse(chat.ts) ? dm : chat;
}

export type PreviewChat = { id: string; lastActivityAt?: string | null; updatedAt?: string | null };
type ChatResult = { preview: BotPreview | null; turnStartedAt: string | null; messageAt: string | null };

/** One timeline read per chat per new activity: answers are cached on the chat's activity stamps. */
export class PreviewsService {
  private readonly cache = new Map<string, { key: string; value: ChatResult }>();

  static key(chat: PreviewChat): string {
    return `${chat.lastActivityAt ?? ""}|${chat.updatedAt ?? ""}`;
  }

  async forChat(
    chat: PreviewChat,
    fetchTail: (agentId: string, limit: number) => Promise<{ entries: readonly PreviewEntry[]; hasOlder?: boolean }>,
  ): Promise<ChatResult> {
    const key = PreviewsService.key(chat);
    const hit = this.cache.get(chat.id);
    if (hit?.key === key) return hit.value;
    let value: ChatResult = { preview: null, turnStartedAt: null, messageAt: null };
    try {
      const page = await fetchTail(chat.id, PREVIEW_TAIL);
      let started = turnStartedAt(page.entries);
      if (turnFillsWindow(page.entries, page.hasOlder ?? false)) {
        // The turn began before the window: read further back for its real start.
        const long = await fetchTail(chat.id, PREVIEW_TAIL_LONG);
        started = turnStartedAt(long.entries);
      }
      value = { preview: chatPreview(page.entries), turnStartedAt: started, messageAt: chatMessageAt(page.entries) };
    } catch {
      // A failed read shows no preview this round and is retried on the next poll.
      return value;
    }
    this.cache.set(chat.id, { key, value });
    return value;
  }

  /** Drops chats that are no longer any bot's current chat. */
  retain(chatIds: Iterable<string>) {
    const keep = new Set(chatIds);
    for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
  }
}
