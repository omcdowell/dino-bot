import { useSyncExternalStore } from "react";

/** A thread to open in the DMs panel: by thread id, or by a message in it (timeline cards know only the message). */
export type DmThreadRef = { threadId?: string; messageId?: string };
export type DmFocus = { ref: DmThreadRef; seq: number };

/**
 * Panels take no params, so a DM card asks the bot's DMs panel to select a thread through this
 * module-level store (one per plugin installation: the card and the panel share the bundle).
 */
const pending = new Map<string, DmFocus>();
const listeners = new Set<() => void>();
let seq = 0;

export function focusDmThread(botId: string, ref: DmThreadRef): void {
  pending.set(botId, { ref, seq: ++seq });
  for (const listener of listeners) listener();
}

export function peekDmFocus(botId: string): DmFocus | null {
  return pending.get(botId) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useDmFocus(botId: string): DmFocus | null {
  return useSyncExternalStore(subscribe, () => peekDmFocus(botId), () => peekDmFocus(botId));
}
