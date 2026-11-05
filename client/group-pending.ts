/**
 * The optimistic copy of a message the owner just sent to a group (shown greyed until the host has it).
 *
 * Why not only by id: `rooms.post` writes the message, pushes ROOMS_EVENT (the thread refetches and shows
 * it) and only then wakes the leads, which can take several seconds on a cold bot. Until the RPC answers,
 * the client has no id, so the thread showed the message twice for 3-10 s (review video, 5 Nov). The copy
 * is now also matched by content: a user message with the same text that was not in the thread when the
 * owner pressed Send.
 */
import type { RoomMessage } from "../shared/rooms/schema";

export type PendingPost = {
  /** The id `rooms.post` answered with; null until it answers. */
  id: string | null;
  text: string;
  delivery: string;
  /** Ids of the owner's messages already in the thread when Send was pressed. */
  before: readonly string[];
};

export function startPending(text: string, delivery: string, messages: readonly RoomMessage[]): PendingPost {
  return { id: null, text, delivery, before: messages.filter((m) => m.from === "user").map((m) => m.id) };
}

/** True once the thread holds the sent message (by id, or by text when the id is not known yet). */
export function pendingArrived(pending: PendingPost | null, messages: readonly RoomMessage[]): boolean {
  if (!pending) return false;
  if (pending.id) return messages.some((m) => m.id === pending.id);
  const before = new Set(pending.before);
  const text = pending.text.trim(); // the host stores the trimmed text
  return messages.some((m) => m.from === "user" && !before.has(m.id) && m.text === text);
}
