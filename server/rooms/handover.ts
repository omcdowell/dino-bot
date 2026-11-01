/**
 * Room handover writer (plan U2, §3.6): every member of a group gets every room message in its main memory, as
 * blocks the plugin drops into `<profile>/memory/room-blocks/<id>.json` by atomic rename. The bot's pi-optchat appends
 * a block to its log between runs (never mid-run, never starting a turn) and removes the file. The plugin never takes
 * the bot's lock and never writes the bot's log.
 *
 * State, per group, in `<rooms root>/<group>/handover.json`: per member, the ledger id of the last message handed
 * over (`cursor`) and, while a block is being written, the block in flight (its id and first/last message ids). The
 * pending talk itself is the ledger after the cursor, so a plugin reload loses nothing; a block in flight is written
 * again with the same id after a reload, and pi-optchat applies a block id once (receipt), so nothing is duplicated.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRoomMessage, readJson, ROOM_FILE, writeJson, ensureRoomDir } from "./ledger";
import {
  buildBlock,
  emptyHandoverState,
  handedTo,
  messageEvent,
  shouldHandover,
  splitBlocks,
  type HandoverReason,
  type HandoverState,
  type RoomBlock,
} from "../../shared/rooms/handover";
import type { Group, RoomMessage } from "../../shared/rooms/schema";

export const HANDOVER_FILE = "handover.json";
/** Under the bot's OptChat profile dir; pi-optchat reads the same path (src/room/blocks.ts ROOM_BLOCKS). */
export const ROOM_BLOCKS_DIR = join("memory", "room-blocks");

export type HandoverMark = {
  /** Ledger id of the last message handed over; null: none yet (the member gets the whole ledger). */
  cursor: string | null;
  /** A block being written: written again with the same id after a reload. */
  inflight?: { id: string; first: string; last: string };
  blocks?: number;
  lastBlockAt?: string;
};
export type HandoverFile = { v: 1; members: Record<string, HandoverMark> };

export interface HandoverOptions {
  /** The group's state dir (holds room.jsonl). */
  roomDir(group: string): string;
  /** The member's OptChat profile dir (`~/.optchat/profiles/<profile>`). Blocks wait while it does not exist. */
  profileDir(bot: string): string;
  now?: () => number;
  onError?(error: unknown): void;
  /** A block was written (logging, tests). */
  onBlock?(block: RoomBlock, reason: HandoverReason | "recovered"): void;
}

type GroupHold = {
  members: string[];
  file: HandoverFile;
  pending: Map<string, RoomMessage[]>;
  states: Map<string, HandoverState>;
  /** Ledger ids already counted, so a message is never pending twice. */
  seen: Set<string>;
};

/** Every parseable ledger line, in file order. */
export function readLedger(dir: string): RoomMessage[] {
  let raw = "";
  try {
    raw = readFileSync(join(dir, ROOM_FILE), "utf8");
  } catch {
    return [];
  }
  const out: RoomMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRoomMessage(parsed)) out.push(parsed);
    } catch {
      // torn line
    }
  }
  return out;
}

/** Messages after `cursor` in ledger order (all of them when cursor is null or no longer in the ledger by id). */
function after(ledger: RoomMessage[], cursor: string | null): RoomMessage[] {
  if (cursor === null) return [...ledger];
  const at = ledger.findIndex((m) => m.id === cursor);
  return at >= 0 ? ledger.slice(at + 1) : ledger.filter((m) => m.id > cursor);
}

export class RoomHandover {
  private readonly held = new Map<string, GroupHold>();
  private readonly now: () => number;
  private names: Record<string, string> = {};
  private readonly reported = new Set<string>();

  constructor(private readonly options: HandoverOptions) {
    this.now = options.now ?? Date.now;
  }

  private stateFile(group: string) {
    return join(this.options.roomDir(group), HANDOVER_FILE);
  }

  private save(group: string, hold: GroupHold) {
    ensureRoomDir(this.options.roomDir(group));
    writeJson(this.stateFile(group), hold.file);
  }

  /** Loads (or reloads, when the members changed) a group's state from handover.json and the ledger. */
  private hold(group: Group): GroupHold {
    const cached = this.held.get(group.id);
    if (cached && cached.members.join(",") === group.members.join(",")) return cached;
    const saved = readJson<HandoverFile | null>(this.stateFile(group.id), null);
    const file: HandoverFile = saved?.v === 1 && saved.members && typeof saved.members === "object" ? saved : { v: 1, members: {} };
    const ledger = readLedger(this.options.roomDir(group.id));
    const hold: GroupHold = { members: [...group.members], file, pending: new Map(), states: new Map(), seen: new Set(ledger.map((m) => m.id)) };
    this.held.set(group.id, hold);
    for (const bot of group.members) {
      const mark = (file.members[bot] ??= { cursor: null });
      const pending = after(ledger, mark.cursor).filter((m) => handedTo(m, bot));
      hold.pending.set(bot, pending);
      hold.states.set(bot, this.stateOf(group, bot, pending));
      if (mark.inflight) this.attempt(group, hold, bot, "recovered");
    }
    return hold;
  }

  private stateOf(group: Group, bot: string, pending: RoomMessage[]): HandoverState {
    let state = emptyHandoverState();
    for (const msg of pending) state = shouldHandover(state, messageEvent(group, msg, bot, this.names), 0).state;
    return state;
  }

  /** A message was appended to `group`'s ledger. */
  message(group: Group, msg: RoomMessage, names: Record<string, string> = this.names) {
    this.names = names;
    const before = this.held.get(group.id);
    const hold = this.hold(group);
    // A (re)load read the ledger, this message included: only check the triggers.
    const loaded = before === hold;
    const fresh = !hold.seen.has(msg.id);
    if (fresh) hold.seen.add(msg.id);
    for (const bot of group.members) {
      let state = hold.states.get(bot) ?? emptyHandoverState();
      if (fresh || !loaded) {
        const mine = fresh && handedTo(msg, bot);
        if (mine) hold.pending.get(bot)!.push(msg);
        const event = mine ? messageEvent(group, msg, bot, names) : ({ kind: "tick" } as const);
        const decision = shouldHandover(state, event, this.now());
        state = decision.state;
        hold.states.set(bot, state);
        if (decision.now) this.attempt(group, hold, bot, decision.reason!);
      }
    }
  }

  /** The timer: quiet groups hand over, blocks that could not be written are tried again. */
  tick(groups: Group[]) {
    for (const group of groups) {
      try {
        const hold = this.hold(group);
        for (const bot of group.members) {
          const decision = shouldHandover(hold.states.get(bot) ?? emptyHandoverState(), { kind: "tick" }, this.now());
          if (decision.now) this.attempt(group, hold, bot, decision.reason!);
          else if (hold.file.members[bot]?.inflight) this.attempt(group, hold, bot, "recovered");
        }
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  /** Messages waiting for `bot`'s next block (tests, status). */
  pending(group: Group, bot: string): RoomMessage[] {
    return [...(this.hold(group).pending.get(bot) ?? [])];
  }

  private attempt(group: Group, hold: GroupHold, bot: string, reason: HandoverReason | "recovered") {
    try {
      this.flush(group, hold, bot, reason);
      this.reported.delete(`${group.id}/${bot}`);
    } catch (error) {
      // Kept pending (and in flight, if it was): tried again at the next message or tick. Reported once.
      const key = `${group.id}/${bot}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.options.onError?.(error);
      }
    }
  }

  /**
   * Writes `bot`'s pending talk as blocks, oldest first, each by write-ahead: in flight, file, cursor. "recovered"
   * only finishes the block in flight; the rest waits for its own trigger.
   */
  private flush(group: Group, hold: GroupHold, bot: string, reason: HandoverReason | "recovered") {
    const mark = hold.file.members[bot]!;
    const profile = this.options.profileDir(bot);
    if (!existsSync(profile)) throw new Error(`Room handover for ${bot}: no OptChat profile at ${profile}; talk kept pending.`);
    if (mark.inflight) {
      // Same lines, same id: pi-optchat applies it once even if the first write had already landed.
      const ledger = readLedger(this.options.roomDir(group.id));
      const from = ledger.findIndex((m) => m.id === mark.inflight!.first),
        to = ledger.findIndex((m) => m.id === mark.inflight!.last);
      if (from >= 0 && to >= from) {
        const block = buildBlock(group, bot, ledger.slice(from, to + 1).filter((m) => handedTo(m, bot)));
        this.writeBlock(profile, block);
        this.options.onBlock?.(block, "recovered");
      }
      this.advance(group, hold, bot, mark.inflight.last);
    }
    if (reason === "recovered") return;
    for (const run of splitBlocks(hold.pending.get(bot) ?? [])) {
      const block = buildBlock(group, bot, run);
      mark.inflight = { id: block.id, first: run[0]!.id, last: run[run.length - 1]!.id };
      this.save(group.id, hold);
      this.writeBlock(profile, block);
      this.options.onBlock?.(block, reason);
      this.advance(group, hold, bot, mark.inflight.last);
    }
    hold.states.set(bot, emptyHandoverState());
  }

  /** The cursor moves to `last`: those messages are handed over. */
  private advance(group: Group, hold: GroupHold, bot: string, last: string) {
    const mark = hold.file.members[bot]!;
    mark.cursor = last;
    delete mark.inflight;
    mark.blocks = (mark.blocks ?? 0) + 1;
    mark.lastBlockAt = new Date(this.now()).toISOString();
    const pending = hold.pending.get(bot) ?? [];
    const at = pending.findIndex((m) => m.id === last);
    hold.pending.set(bot, at >= 0 ? pending.slice(at + 1) : pending);
    hold.states.set(bot, this.stateOf(group, bot, hold.pending.get(bot)!));
    this.save(group.id, hold);
  }

  /** `<profile>/memory/room-blocks/<id>.json`, by atomic rename (the temp name does not end in .json). */
  private writeBlock(profile: string, block: RoomBlock) {
    const dir = join(profile, ROOM_BLOCKS_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, `${block.id}.json`),
      tmp = join(dir, `.${block.id}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(block)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
}
