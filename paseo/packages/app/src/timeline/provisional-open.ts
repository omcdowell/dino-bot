import { create } from "zustand";
import type { StreamItem } from "@/types/stream";

/**
 * B2a provisional open. A notification tap on a killed app paints the last-known chat from the
 * on-device replica at once (viewed-timeline-sync, status "painted", not synchronized) and shows the
 * notification's own text as a provisional reply under it, marked stale, until the live page lands.
 *
 * Rules (sync-architecture UX):
 * - The preview is display only: it lives outside the session store, so it is never persisted,
 *   sent, quoted, or acted on, and it never takes a slot in the timeline (no reordering).
 * - Live wins: once the timeline is synchronized and holds an assistant reply at or after the
 *   notification time (or any newer row), the preview is dropped; it is also dropped after a
 *   hard timeout so a stale bubble can never outlive the session.
 * - The composer stays usable: nothing here blocks input.
 */

/** A preview older than this is never shown (the live page would have come or failed by now). */
export const PROVISIONAL_MAX_AGE_MS = 120_000;

export interface ProvisionalReply {
  serverId: string;
  agentId: string;
  /** The notification body (the daemon's ≤220-char plain-text preview of the reply). */
  text: string;
  /** When the daemon raised the notification (ms since epoch). */
  notifiedAt: number;
  /** When the user tapped (ms since epoch). */
  openedAt: number;
}

interface ProvisionalState {
  replies: ReadonlyMap<string, ProvisionalReply>;
}

const useProvisionalStore = create<ProvisionalState>(() => ({ replies: new Map() }));

function keyOf(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

export function noteProvisionalReply(reply: ProvisionalReply): void {
  const text = reply.text.trim();
  if (!text) return;
  const next = new Map(useProvisionalStore.getState().replies);
  next.set(keyOf(reply.serverId, reply.agentId), { ...reply, text });
  useProvisionalStore.setState({ replies: next });
}

export function clearProvisionalReply(serverId: string, agentId: string): void {
  const current = useProvisionalStore.getState().replies;
  const key = keyOf(serverId, agentId);
  if (!current.has(key)) return;
  const next = new Map(current);
  next.delete(key);
  useProvisionalStore.setState({ replies: next });
}

export function readProvisionalReply(
  serverId: string,
  agentId: string,
): ProvisionalReply | undefined {
  return useProvisionalStore.getState().replies.get(keyOf(serverId, agentId));
}

export function useProvisionalReply(
  serverId: string,
  agentId: string | undefined,
): ProvisionalReply | undefined {
  return useProvisionalStore((state) =>
    agentId ? state.replies.get(keyOf(serverId, agentId)) : undefined,
  );
}

export type ProvisionalDecision = "show" | "drop";

/**
 * Pure reconcile rule. `synchronized` = the live page (not the disk copy) has been applied.
 * `items` = what the timeline holds now (painted or live).
 */
export function decideProvisional(input: {
  reply: ProvisionalReply;
  synchronized: boolean;
  items: readonly Pick<StreamItem, "kind" | "timestamp">[];
  now: number;
}): ProvisionalDecision {
  const { reply, synchronized, items, now } = input;
  if (now - reply.openedAt > PROVISIONAL_MAX_AGE_MS) return "drop";
  // Live rows that already cover the notified reply: the real text is on screen.
  const covered = items.some(
    (item) =>
      item.kind === "assistant_message" && item.timestamp.getTime() >= reply.notifiedAt - 1000,
  );
  if (covered) return "drop";
  // Live page applied but the reply is not in it (deleted, edited, rewound): live wins.
  if (synchronized) return "drop";
  return "show";
}

/** Notification data -> provisional reply, or null when it is not an agent reply notification. */
export function provisionalFromNotification(input: {
  data: Record<string, unknown> | undefined;
  body: string | null | undefined;
  date: number | null | undefined;
  now: number;
}): ProvisionalReply | null {
  const data = input.data;
  const serverId = typeof data?.serverId === "string" ? data.serverId : null;
  const agentId = typeof data?.agentId === "string" ? data.agentId : null;
  const reason = typeof data?.reason === "string" ? data.reason : null;
  // Only a finished reply has reply text; permission/error bodies are prompts, not content.
  if (!serverId || !agentId || reason !== "finished" || !input.body?.trim()) return null;
  const notifiedAt = typeof input.date === "number" && input.date > 0 ? input.date : input.now;
  return { serverId, agentId, text: input.body, notifiedAt, openedAt: input.now };
}
