import type { DeliveryState } from "@/components/delivery-tick";
import type { OutboxRecord } from "@/stores/outbox-store";

export interface PinnedMessage {
  key: string;
  clientMessageId: string;
  text: string;
  createdAt: number;
  state: DeliveryState;
  /** Only in the daemon queue (sent from another device). */
  remote: boolean;
  record: OutboxRecord | null;
}

export interface DaemonQueueItem {
  messageId: string;
  text: string;
  createdAt: string;
}

export function resolvePinnedDeliveryState(
  record: OutboxRecord,
  daemonHolds: boolean,
): DeliveryState | null {
  switch (record.state) {
    case "cancelling":
      return null;
    case "outbox":
      return daemonHolds ? "queued" : "clock";
    case "received":
      return daemonHolds ? "queued" : "single";
    case "queued":
      return "queued";
    case "taken":
      return "taken";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
  }
}

/** Joins the outbox with the daemon queue, minus everything whose canonical row is in the stream. */
export function buildPinnedMessages(input: {
  records: readonly OutboxRecord[];
  daemonQueue: readonly DaemonQueueItem[];
  inStream: ReadonlySet<string>;
}): PinnedMessage[] {
  const held = new Set(input.daemonQueue.map((item) => item.messageId));
  const own = new Set(input.records.map((record) => record.clientMessageId));
  const pinned: PinnedMessage[] = [];
  for (const record of input.records) {
    if (input.inStream.has(record.clientMessageId)) continue;
    const state = resolvePinnedDeliveryState(record, held.has(record.clientMessageId));
    if (!state) continue;
    pinned.push({
      key: record.clientMessageId,
      clientMessageId: record.clientMessageId,
      text: record.text,
      createdAt: record.createdAt,
      state,
      remote: false,
      record,
    });
  }
  for (const item of input.daemonQueue) {
    if (own.has(item.messageId) || input.inStream.has(item.messageId)) continue;
    pinned.push({
      key: item.messageId,
      clientMessageId: item.messageId,
      text: item.text,
      createdAt: Date.parse(item.createdAt) || 0,
      state: "queued",
      remote: true,
      record: null,
    });
  }
  return pinned.sort((a, b) => a.createdAt - b.createdAt);
}

/** A user row in the loaded stream, as far as matching pinned bubbles needs it. */
export interface StreamUserRow {
  clientMessageId?: string;
  text: string;
  /** Epoch ms; NaN when unknown. */
  timestamp: number;
}

/** Phone and daemon clocks may disagree; a row this much older than the send still counts. */
export const TAKEN_TEXT_MATCH_SKEW_MS = 10 * 60 * 1000;

/**
 * Taken messages whose canonical row is in the stream but lost its client message ID.
 *
 * A daemon restart rebuilds the timeline from the provider's own history, which does not keep
 * client message IDs, so a message the agent took just before the restart comes back as a
 * plain user row. Without this the taken bubble stayed pinned under the chat (blue ticks,
 * no actions) until the outbox dropped it a day later. Only taken messages are matched: the
 * daemon has confirmed the agent has them, so their canonical row exists, and settling one
 * against the wrong identical row only hides a bubble for a delivered message.
 *
 * Each row settles at most one message; newer messages take newer rows. Rows that carry a
 * client message ID belong to that send and are never used here.
 */
export function matchTakenRecordsByText(
  records: readonly OutboxRecord[],
  rows: readonly StreamUserRow[],
  alreadyInStream: ReadonlySet<string> = new Set(),
): string[] {
  const taken = records
    .filter((record) => record.state === "taken" && !alreadyInStream.has(record.clientMessageId))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (taken.length === 0) return [];
  const used = new Set<number>();
  const matched: string[] = [];
  for (const record of taken) {
    const text = record.text.trim();
    if (!text) continue;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (used.has(index)) continue;
      const row = rows[index];
      if (row.clientMessageId) continue;
      if (row.text.trim() !== text) continue;
      if (
        Number.isFinite(row.timestamp) &&
        row.timestamp < record.createdAt - TAKEN_TEXT_MATCH_SKEW_MS
      ) {
        continue;
      }
      used.add(index);
      matched.push(record.clientMessageId);
      break;
    }
  }
  return matched;
}
