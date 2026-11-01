/**
 * Group chat handover (plan U2, §3.6): pure rules for when a member's room talk goes to its main memory, and the block
 * it goes in. No clock, no randomness, no I/O. The server side (server/rooms/handover.ts) writes the blocks.
 *
 * A block holds every room line since the member's last block, the ones it did not answer included, one line per
 * message tagged `room:<sender>:`. pi-optchat appends it to the bot's log as a user message headed
 * `[room <group> block <id> msgs <first>-<last>]` and files it as `room:<group>`, never as the user's words.
 */
import { parseMentions } from "./router";
import type { Group, RoomMessage } from "./schema";

/** Hand over after this many room messages since the last block. */
export const HANDOVER_MSGS = 5;
/** …or once the room has been quiet this long with talk pending. */
export const HANDOVER_QUIET_MS = 20 * 60 * 1000;
/** …or once the pending lines reach this many UTF-8 bytes. */
export const HANDOVER_BYTES = 6 * 1024;
/** One message's line is cut to this many bytes in a block. */
export const BLOCK_LINE_MAX_BYTES = 3 * 1024;
/** A block holds at most this many bytes of lines (a longer backlog goes out as several blocks, in order). */
export const BLOCK_MAX_BYTES = 8 * 1024;

export type HandoverReason = "mention" | "turns" | "size" | "quiet";

/** What a member has pending: room messages since its last block. */
export type HandoverState = {
  /** Messages pending. */
  pending: number;
  /** Bytes of their block lines. */
  bytes: number;
  /** ms time of the newest pending message; null when none. */
  lastAt: number | null;
  /** A pending message @mentions the member (or @all), from someone else. */
  mention: boolean;
};

export type HandoverEvent =
  | { kind: "message"; at: number; bytes: number; mention: boolean }
  | { kind: "tick" };

export const emptyHandoverState = (): HandoverState => ({ pending: 0, bytes: 0, lastAt: null, mention: false });

/** The state after `event` (a tick changes nothing). */
export function foldHandover(state: HandoverState, event: HandoverEvent): HandoverState {
  if (event.kind !== "message") return state;
  return {
    pending: state.pending + 1,
    bytes: state.bytes + event.bytes,
    lastAt: Math.max(state.lastAt ?? event.at, event.at),
    mention: state.mention || event.mention,
  };
}

/**
 * Whether the member's pending talk goes out now, after `event`. Triggers: an @mention of the member, HANDOVER_MSGS
 * messages, HANDOVER_BYTES of lines, or HANDOVER_QUIET_MS without a new message. Checked at every message and timer
 * tick, so the first trigger reached wins. `state` is the next state (the event folded in); after a handover the
 * caller starts again from `emptyHandoverState()`.
 */
export function shouldHandover(
  state: HandoverState,
  event: HandoverEvent,
  now: number,
): { now: boolean; reason?: HandoverReason; state: HandoverState } {
  const next = foldHandover(state, event);
  if (next.pending === 0) return { now: false, state: next };
  if (next.mention) return { now: true, reason: "mention", state: next };
  if (next.pending >= HANDOVER_MSGS) return { now: true, reason: "turns", state: next };
  if (next.bytes >= HANDOVER_BYTES) return { now: true, reason: "size", state: next };
  if (next.lastAt !== null && now - next.lastAt >= HANDOVER_QUIET_MS) return { now: true, reason: "quiet", state: next };
  return { now: false, state: next };
}

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

function cutBytes(s: string, limit: number): string {
  if (utf8(s) <= limit) return s;
  return `${Buffer.from(s, "utf8").subarray(0, Math.max(0, limit - utf8("…"))).toString("utf8").replace(/\uFFFD+$/, "")}…`;
}

/**
 * A message's block line: `room:<sender>: <text>`. Its later lines are indented two spaces, so no message can start a
 * line that reads as another sender's (a bot cannot write a `room:user:` line).
 */
export function blockLine(msg: Pick<RoomMessage, "from" | "text">): string {
  const text = cutBytes(msg.text.replace(/\r\n?/g, "\n").trim(), BLOCK_LINE_MAX_BYTES);
  return `room:${msg.from}: ${text.replace(/\n/g, "\n  ")}`;
}

/** Bytes a message adds to a block (its line and newline). */
export const blockLineBytes = (msg: Pick<RoomMessage, "from" | "text">) => utf8(blockLine(msg)) + 1;

/** Whether `msg` @mentions `bot` (by id or first name, or @all), from someone else. */
export function mentions(group: Group, msg: Pick<RoomMessage, "from" | "text">, bot: string, names: Record<string, string>): boolean {
  if (msg.from === bot) return false;
  const m = parseMentions(msg.text, group, names);
  return m.all || m.bots.includes(bot);
}

/**
 * Whether `msg` goes into `bot`'s blocks: every room line except the bot's own `bot-room post` lines, which its main
 * chat wrote and already holds.
 */
export const handedTo = (msg: Pick<RoomMessage, "from" | "via">, bot: string) => !(msg.via === "main" && msg.from === bot);

/** The handover event for one new room message, for `bot`. */
export function messageEvent(group: Group, msg: RoomMessage, bot: string, names: Record<string, string>): HandoverEvent {
  return { kind: "message", at: Date.parse(msg.ts), bytes: blockLineBytes(msg), mention: mentions(group, msg, bot, names) };
}

/** A block file (§3.6), as pi-optchat reads it: `{ id, group, from, to, text }`, plus `v` and `member`. */
export type RoomBlock = {
  v: 1;
  /** The id of its last room message: unique per member, and the same if the same lines are written again. */
  id: string;
  group: string;
  member: string;
  /** ISO times of its first and last message. */
  from: string;
  to: string;
  text: string;
};

/** A block id pi-optchat accepts (its file name and log receipt). */
export const blockId = (lastMessageId: string) => lastMessageId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "").slice(0, 121) || "block";

/** The block of `msgs` (oldest first, at least one) for `bot`. */
export function buildBlock(group: Group, bot: string, msgs: RoomMessage[]): RoomBlock {
  if (!msgs.length) throw new Error("A block needs at least one message.");
  const first = msgs[0]!,
    last = msgs[msgs.length - 1]!,
    id = blockId(last.id);
  const text = [`[room ${group.id} block ${id} msgs ${first.id}-${last.id}]`, ...msgs.map(blockLine)].join("\n");
  return { v: 1, id, group: group.id, member: bot, from: first.ts, to: last.ts, text };
}

/** `msgs` cut into runs of at most BLOCK_MAX_BYTES of lines each (a run holds at least one message), in order. */
export function splitBlocks(msgs: RoomMessage[], maxBytes = BLOCK_MAX_BYTES): RoomMessage[][] {
  const runs: RoomMessage[][] = [];
  let run: RoomMessage[] = [],
    size = 0;
  for (const msg of msgs) {
    const add = blockLineBytes(msg);
    if (run.length && size + add > maxBytes) {
      runs.push(run);
      run = [];
      size = 0;
    }
    run.push(msg);
    size += add;
  }
  if (run.length) runs.push(run);
  return runs;
}
