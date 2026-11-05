/**
 * Quiet DM turns: which bot chats are "unread" only because of turns that a bot DM started.
 *
 * Paseo sets a chat's "finished" attention flag when the agent goes from running to idle, and only
 * if the flag is not already set (edge-triggered; `attentionTimestamp` is when it was set). A bot
 * answering another bot's DM or a worker report therefore turns its row green although the owner
 * wrote nothing. the owner's decision (2026-10-08): hide the green dot when every turn behind the
 * flag was started by a delivered `[dm …]` message. Turns the owner started, and needs-you or error
 * states, show as before.
 *
 * How: read the tail of the chat's timeline. Steered messages carry the running turn's turnId, so
 * a turn's prompts are its user messages. The turn that set the flag is the last turn that started
 * at or before `attentionTimestamp`; every later turn counts too, and so does any earlier turn that
 * ran straight into it (gap under CHAIN_GAP_MS, so the agent may never have gone idle in between).
 * The row is quiet only when all prompts in those turns are DM envelopes. Anything uncertain (no
 * turn ids, as for history replayed after a reload; a window that may cut the turn off; a fetch
 * error) leaves the dot showing.
 */
import { parseEnvelope } from "../shared/dm-schema";

export const CHAIN_GAP_MS = 5_000;
export const TIMELINE_TAIL = 200;

export type TimelineEntryLike = {
  timestamp: string;
  turnId?: string | null;
  item: { type: string; text?: string };
};

export type AttentionAgent = {
  id: string;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
};

/** A user message that is a delivered bot DM (or worker report). */
export function isDmPrompt(text: string | undefined): boolean {
  return typeof text === "string" && parseEnvelope(text) !== null;
}

type Turn = { turnId: string | null; first: number; last: number; prompts: string[] };

function turnsOf(entries: readonly TimelineEntryLike[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    const ts = Date.parse(e.timestamp);
    const turnId = e.turnId ?? null;
    let turn = turns.at(-1);
    if (!turn || turn.turnId !== turnId || turnId === null) {
      // Entries without a turn id are never merged: each is its own unknown turn.
      turn = { turnId, first: ts, last: ts, prompts: [] };
      turns.push(turn);
    }
    turn.last = Math.max(turn.last, ts);
    if (e.item.type === "user_message") turn.prompts.push(e.item.text ?? "");
  }
  return turns;
}

/**
 * True when the chat's current "finished" flag is owed only to DM-started turns.
 * `hasOlder`: the window does not reach the start of the timeline.
 */
export function dmOnlyUnread(
  entries: readonly TimelineEntryLike[],
  attentionTimestamp: string | null | undefined,
  hasOlder = false,
): boolean {
  const at = attentionTimestamp ? Date.parse(attentionTimestamp) : NaN;
  if (Number.isNaN(at)) return false;
  const turns = turnsOf(entries);
  let s = -1;
  for (let i = 0; i < turns.length; i++) if (turns[i]!.first <= at) s = i;
  if (s < 0) return false;
  while (s > 0 && turns[s]!.first - turns[s - 1]!.last < CHAIN_GAP_MS) s--;
  // The first turn in the window may have started before the window did.
  if (s === 0 && hasOlder) return false;
  const counted = turns.slice(s);
  if (counted.some((t) => t.turnId === null)) return false;
  const prompts = counted.flatMap((t) => t.prompts);
  return prompts.length > 0 && prompts.every(isDmPrompt);
}

export type TimelinePage = { entries: readonly TimelineEntryLike[]; hasOlder: boolean };

/** Caches one answer per chat and attention flag, so polling costs one timeline read per new turn. */
export class DmTurnsService {
  private readonly cache = new Map<string, { key: string; quiet: boolean }>();

  /** Ids of the given chats whose "finished" flag comes only from DM-started turns. */
  async quiet(agents: readonly AttentionAgent[], fetchTail: (agentId: string) => Promise<TimelinePage>): Promise<string[]> {
    const live = new Set<string>();
    const out: string[] = [];
    await Promise.all(
      agents.map(async (agent) => {
        if (!agent.requiresAttention || agent.attentionReason !== "finished" || !agent.attentionTimestamp) return;
        live.add(agent.id);
        const key = `${agent.attentionTimestamp}|${agent.lastActivityAt ?? ""}|${agent.updatedAt ?? ""}`;
        let hit = this.cache.get(agent.id);
        if (hit?.key !== key) {
          let quiet = false;
          try {
            const page = await fetchTail(agent.id);
            quiet = dmOnlyUnread(page.entries, agent.attentionTimestamp, page.hasOlder);
          } catch {
            quiet = false;
          }
          hit = { key, quiet };
          this.cache.set(agent.id, hit);
        }
        if (hit.quiet) out.push(agent.id);
      }),
    );
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    return out.sort();
  }
}
