/**
 * Group chat data on the client: the group list (home, sidebar), one group's thread and member
 * states, posting, and a device-side "seen up to" time per group for the unread dot.
 *
 * Built against plan §3.4 (`shared/rooms/rpc.ts`). Hosts without the rooms RPCs answer with an
 * error: the list reads as empty, so the home and sidebar simply show no Groups section.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { Group } from "../shared/rooms/schema";
import { PushEventSchema } from "../shared/push-rpc";
import { ROOMS_EVENT, ROOMS_POLL_MS, roomsListRpc, roomsPostRpc, roomsSetMembersRpc, roomsThreadRpc } from "../shared/rooms/rpc";
import type { RoomMemberState, RoomSummary } from "./group-types";
import { usePushLive, type BotEvents } from "./push";
import {
  EMPTY_THREAD_CACHE,
  headWoken,
  normaliseList,
  normaliseThread,
  ROOMS_THREAD_CACHE_KEY,
  threadQueryOptions,
} from "./group-cache";
import type { Bot } from "../shared/rpc";
import type { AvatarSource } from "./bot-avatar";
import type { Names } from "./group-format";

export const ROOMS_KEY = ["rooms"] as const;
export const ROOMS_LIST_KEY = ["rooms", "list"] as const;
export const roomsThreadKey = (groupId: string) => ["rooms", "thread", groupId] as const;
/** Head of a thread (member states + newest message) for the home/sidebar working ring. */
export const roomsHeadKey = (groupId: string) => ["rooms", "head", groupId] as const;
/** Device-only: newest message time the owner has seen per group. */
export const ROOMS_SEEN_KEY = ["rooms", "seen"] as const;

/** Thread page size: the server keeps older lines for `before` paging. */
export const THREAD_LIMIT = 200;
/** Group rows (home, sidebar) without pushes. */
export const ROOMS_LIST_POLL_MS = 10_000;
/** Safety-net polls while pushes arrive (a missed push is caught within this). */
const LIVE_THREAD_POLL_MS = 15_000;
const LIVE_LIST_POLL_MS = 60_000;

/** `client.events` (same hub as client/push.ts); null on apps without plugin events. */
let roomEvents: BotEvents | null = null;
export function setRoomEvents(value: BotEvents | undefined): void {
  roomEvents = value ?? null;
}

/**
 * The host pushes ROOMS_EVENT `{ rev, data: { groupId } }` when a room's ledger or member states
 * change: refetch that group's thread and head, and the group rows.
 */
function useRoomsPush(): boolean {
  const queryClient = useQueryClient();
  useEffect(() => {
    const hub = roomEvents;
    if (!hub) return;
    return hub.on(ROOMS_EVENT, (raw) => {
      const event = PushEventSchema.safeParse(raw);
      const data = event.success ? (event.data.data as { groupId?: unknown } | null) : null;
      const groupId = typeof data?.groupId === "string" ? data.groupId : null;
      if (groupId) {
        void queryClient.invalidateQueries({ queryKey: roomsThreadKey(groupId) });
        void queryClient.invalidateQueries({ queryKey: roomsHeadKey(groupId) });
      }
      void queryClient.invalidateQueries({ queryKey: ROOMS_LIST_KEY });
    });
  }, [queryClient]);
  return usePushLive() && !!roomEvents;
}

/** Device cache may hold the pre-multi-lead shape ({ lead: "x" }); never let it crash the home page. */
function normaliseLeads(summary: RoomSummary): string[] {
  const raw = summary as RoomSummary & { lead?: unknown; leads?: unknown };
  if (Array.isArray(raw.leads)) return raw.leads.filter((x): x is string => typeof x === "string");
  if (typeof raw.lead === "string") return [raw.lead];
  return summary.members?.[0]?.botId ? [summary.members[0].botId] : [];
}

export function toGroup(summary: RoomSummary): Group {
  return { id: summary.id, name: summary.name, members: (summary.members ?? []).map((m) => m.botId), leads: normaliseLeads(summary) };
}

/**
 * The device's last threads of recently opened groups (one persisted query for all groups, see
 * group-cache.ts). Observed by the home, the sidebar and the group screen with gcTime Infinity, so
 * it is never garbage-collected (which would also drop it from the device).
 */
function useThreadCache(): unknown {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ROOMS_THREAD_CACHE_KEY,
    queryFn: () => queryClient.getQueryData<unknown>(ROOMS_THREAD_CACHE_KEY) ?? EMPTY_THREAD_CACHE,
    staleTime: Infinity,
    gcTime: Infinity,
    meta: { persist: true },
  }).data;
}

export function useRoomsList() {
  const live = useRoomsPush();
  useThreadCache();
  const list = useRpc(roomsListRpc);
  const query = useQuery({
    queryKey: ROOMS_LIST_KEY,
    queryFn: () => list({}),
    // The device copy may be an older shape: read every row through normaliseList.
    select: normaliseList,
    staleTime: 5_000,
    refetchInterval: live ? LIVE_LIST_POLL_MS : ROOMS_LIST_POLL_MS,
    retry: 1,
    meta: { persist: true },
  });
  return { groups: query.data?.groups ?? [], error: query.error, isLoading: query.isLoading, refetch: query.refetch };
}

/**
 * Member states and the newest message only: a cheap poll for rows outside the group screen.
 * Kept on the device (small: one message), but a cached head draws no working ring until the
 * host confirms it.
 */
export function useRoomHead(groupId: string) {
  const live = useRoomsPush();
  const thread = useRpc(roomsThreadRpc);
  const query = useQuery({
    queryKey: roomsHeadKey(groupId),
    queryFn: () => thread({ groupId, limit: 1 }),
    select: (raw: unknown) => normaliseThread(raw, groupId),
    staleTime: 5_000,
    refetchInterval: live ? LIVE_LIST_POLL_MS : ROOMS_LIST_POLL_MS,
    retry: 1,
    meta: { persist: true },
  });
  return { woken: headWoken(query.data, query.dataUpdatedAt) };
}

/** One group's thread; opens at once on the device's last copy (threadQueryOptions). */
export function useRoomThread(groupId: string) {
  const live = useRoomsPush();
  const thread = useRpc(roomsThreadRpc);
  const queryClient = useQueryClient();
  useThreadCache();
  const query = useQuery({
    ...threadQueryOptions(queryClient, groupId, () => thread({ groupId, limit: THREAD_LIMIT })),
    queryKey: roomsThreadKey(groupId),
    refetchInterval: live ? LIVE_THREAD_POLL_MS : ROOMS_POLL_MS,
  });
  return {
    messages: query.data?.messages ?? [],
    members: query.data?.members ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

export function usePostToRoom(groupId: string) {
  const post = useRpc(roomsPostRpc);
  const queryClient = useQueryClient();
  return useCallback(
    async (text: string, opts: { assign?: boolean } = {}) => {
      const result = await post({ groupId, text, ...(opts.assign ? { assign: true } : {}) });
      void queryClient.invalidateQueries({ queryKey: roomsThreadKey(groupId) });
      void queryClient.invalidateQueries({ queryKey: ROOMS_LIST_KEY });
      return result;
    },
    [groupId, post, queryClient],
  );
}

type Seen = Readonly<Record<string, string>>;

/** The device copy keeps only group id -> ISO time pairs. */
function normaliseSeen(raw: unknown): Seen {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}

/** Per-group "seen up to" time, kept on the device; `markSeen` after the thread is on screen. */
export function useRoomsSeen() {
  const queryClient = useQueryClient();
  const seen: Seen =
    useQuery({
      queryKey: ROOMS_SEEN_KEY,
      queryFn: () => queryClient.getQueryData<Seen>(ROOMS_SEEN_KEY) ?? {},
      select: normaliseSeen,
      staleTime: Infinity,
      meta: { persist: true },
    }).data ?? {};
  const markSeen = useCallback(
    (groupId: string, ts: string | null | undefined) => {
      if (!ts) return;
      queryClient.setQueryData<Seen>(ROOMS_SEEN_KEY, (raw) => {
        const held = normaliseSeen(raw);
        return held[groupId] && held[groupId]! >= ts ? held : { ...held, [groupId]: ts };
      });
    },
    [queryClient],
  );
  return { seen, markSeen };
}

/** Unread: a newer message than the one the owner last saw on the group screen. */
export const isUnread = (summary: RoomSummary, seen: Seen) =>
  !!summary.lastTs && (!seen[summary.id] || summary.lastTs > seen[summary.id]!);

/**
 * Display names for mention rules and labels: every bot (so "@flint" reads as "not in this group",
 * as the router refuses it), members' own names from the room as the fallback.
 */
export function namesFor(summary: RoomSummary | undefined, bots: readonly Bot[]): Names {
  const names: Record<string, string> = {};
  for (const m of summary?.members ?? []) names[m.botId] = m.name;
  for (const b of bots) names[b.id] = b.name;
  return names;
}

/** Avatar source for a member: the bots list entry (has the avatar path), else the room's own icon. */
export function avatarFor(botId: string, summary: RoomSummary | undefined, bots: readonly Bot[]): AvatarSource {
  const bot = bots.find((b) => b.id === botId);
  if (bot) return bot;
  const member = summary?.members.find((m) => m.botId === botId);
  return { id: botId, avatar: null, avatarHash: member?.avatarHash ?? null, icon: member?.icon ?? "Bot" };
}

/** Group info sheet: set members/leads; the list and thread refetch (the push also triggers it). */
export function useSetMembers(groupId: string) {
  const set = useRpc(roomsSetMembersRpc);
  const queryClient = useQueryClient();
  return useCallback(
    async (members: string[], leads: string[]) => {
      const result = await set({ groupId, members, leads });
      await queryClient.invalidateQueries({ queryKey: ROOMS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: roomsThreadKey(groupId) });
      void queryClient.invalidateQueries({ queryKey: roomsHeadKey(groupId) });
      return result;
    },
    [groupId, set, queryClient],
  );
}
