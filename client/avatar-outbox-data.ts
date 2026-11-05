/**
 * The avatar outbox (client/avatar-outbox.ts) as one persisted, device-only query, and the hook that sends it.
 *
 * - Persisted like the group thread cache (`meta.persist`, gcTime Infinity, observed by the always-mounted home),
 *   so a save made offline survives a restart. Small: one avatar.json (~300 B) per bot.
 * - `useAvatarOutboxSender` runs on the home: it sends due saves at once, when the queue changes, and on a timer
 *   at the next retry time. Nothing here blocks the UI.
 */
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AvatarJson } from "../shared/avatar";
import { useAvatarApi } from "./avatar-api";
import {
  EMPTY_OUTBOX,
  drainOutbox,
  enqueueSave,
  nextDueAt,
  normaliseOutbox,
  retryNow,
  type AvatarOutbox,
  type BotAvatarEntry,
} from "./avatar-outbox";

export const AVATAR_OUTBOX_KEY = ["bots", "avatar-outbox"] as const;

export const readOutbox = (queryClient: QueryClient): AvatarOutbox => normaliseOutbox(queryClient.getQueryData(AVATAR_OUTBOX_KEY));

export function writeOutbox(queryClient: QueryClient, update: (box: AvatarOutbox) => AvatarOutbox): void {
  queryClient.setQueryData<AvatarOutbox>(AVATAR_OUTBOX_KEY, (raw) => update(normaliseOutbox(raw)));
}

/** The outbox (observed, so it is never garbage-collected off the device). */
export function useAvatarOutbox(): AvatarOutbox {
  const queryClient = useQueryClient();
  return (
    useQuery({
      queryKey: AVATAR_OUTBOX_KEY,
      queryFn: () => queryClient.getQueryData<unknown>(AVATAR_OUTBOX_KEY) ?? EMPTY_OUTBOX,
      select: normaliseOutbox,
      staleTime: Infinity,
      gcTime: Infinity,
      meta: { persist: true },
    }).data ?? EMPTY_OUTBOX
  );
}

export function useBotAvatarEntry(botId: string | null | undefined): BotAvatarEntry | undefined {
  const box = useAvatarOutbox();
  return botId ? box.bots[botId] : undefined;
}

/** Save = queue it (optimistic). Returns the avatar as queued (with its revision). */
export function useSaveAvatar(): (botId: string, avatar: AvatarJson, currentHash?: string | null) => AvatarJson {
  const queryClient = useQueryClient();
  return useCallback(
    (botId, avatar, currentHash) => {
      let queued = avatar;
      writeOutbox(queryClient, (box) => {
        const r = enqueueSave(box, botId, avatar, Date.now(), currentHash);
        queued = r.avatar;
        return r.box;
      });
      return queued;
    },
    [queryClient],
  );
}

/** Sends queued saves (mount once, on the home). `hostAnswering`: the bot list is live, not the device's copy;
 *  when it turns true, queued saves are retried at once instead of at their backoff time. */
export function useAvatarOutboxSender(hostAnswering = true): void {
  const queryClient = useQueryClient();
  const box = useAvatarOutbox();
  const api = useAvatarApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const inFlight = useRef(new Set<string>());
  // Re-armed after every send, so a save that failed (or was queued meanwhile) gets its own timer.
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (hostAnswering) writeOutbox(queryClient, (b) => retryNow(b, Date.now()));
  }, [hostAnswering, queryClient]);
  const due = nextDueAt(box);
  useEffect(() => {
    if (due === null) return;
    const wait = Math.max(0, due - Date.now());
    const timer = setTimeout(() => {
      void drainOutbox(
        () => readOutbox(queryClient),
        (update) => writeOutbox(queryClient, update),
        { save: (input) => apiRef.current.save(input) },
        Date.now,
        inFlight.current,
      ).finally(bump);
    }, wait);
    return () => clearTimeout(timer);
  }, [due, tick, queryClient]);
}
