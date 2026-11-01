/**
 * Group chats from the device cache (gc-cache, 2026-10-13: "group chats need caching").
 *
 * The app keeps plugin queries marked `meta: { persist: true }` per host (plugin-cache.ts in the
 * Paseo app): dehydrated after a 2 s debounce, restored before the host answers. Two limits shape
 * this file:
 * - The app drops ALL of a plugin's persisted queries when their JSON passes 1 MB (avatars, bots
 *   list, previews included, about 350 KB today). So the group threads kept here have a hard byte
 *   budget: THREAD_CACHE_MAX messages per group, at most THREAD_CACHE_GROUP_BYTES per group and
 *   THREAD_CACHE_BYTES for all groups (least recently changed groups go first).
 * - A query with no observer is garbage-collected after 5 min, and a removed query is removed from
 *   storage too. So all groups share ONE persisted query (ROOMS_THREAD_CACHE_KEY) that the home,
 *   the sidebar and the group screen observe, with gcTime Infinity.
 *
 * Shape safety: anything read from the device may be an older or partial shape (a cached
 * pre-multi-lead `rooms.list` blanked the home on 2026-10-13). Every reader here normalises: a bad
 * field gets a default, a bad record is dropped, nothing throws.
 */
import type { QueryClient, QueryObserverOptions } from "@tanstack/react-query";
import type { RoomMessage } from "../shared/rooms/schema";
import type { MemberState, RoomMemberState, RoomSummary } from "./group-types";

/** Device-only: the latest messages of recently opened groups, shown at once on open. */
export const ROOMS_THREAD_CACHE_KEY = ["rooms", "thread-cache"] as const;
/** Newest messages kept per group. */
export const THREAD_CACHE_MAX = 100;
/** Per-group and total JSON budgets (characters, as the app measures its 1 MB cap). */
export const THREAD_CACHE_GROUP_BYTES = 96 * 1024;
export const THREAD_CACHE_BYTES = 256 * 1024;

export type CachedThread = { savedAt: number; messages: RoomMessage[]; members: RoomMemberState[] };
export type ThreadCache = { v: 1; groups: Record<string, CachedThread> };
export type Thread = { messages: RoomMessage[]; members: RoomMemberState[] };

export const EMPTY_THREAD_CACHE: ThreadCache = { v: 1, groups: {} };

const MEMBER_STATES: readonly MemberState[] = ["idle", "room", "main-busy", "queued"];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

/** One ledger message, or null when it lacks what the transcript needs (id, ts, from, text). */
export function normaliseMessage(raw: unknown, groupId = ""): RoomMessage | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const ts = str(raw.ts);
  const from = str(raw.from);
  const text = str(raw.text);
  if (!id || !ts || !from || text === null) return null;
  const msg: RoomMessage = {
    v: 1,
    id,
    ts,
    group: str(raw.group) ?? groupId,
    from,
    text,
    hop: typeof raw.hop === "number" && Number.isFinite(raw.hop) ? raw.hop : 0,
    to: strings(raw.to),
  };
  if (Array.isArray(raw.refused)) {
    msg.refused = raw.refused.flatMap((r) =>
      isObject(r) && typeof r.bot === "string" && typeof r.reason === "string" ? [{ bot: r.bot, reason: r.reason }] : [],
    ) as RoomMessage["refused"];
  }
  if (typeof raw.re === "string") msg.re = raw.re;
  if (isObject(raw.assigned) && typeof raw.assigned.bot === "string" && typeof raw.assigned.agentId === "string") {
    msg.assigned = { bot: raw.assigned.bot, agentId: raw.assigned.agentId };
  }
  if (typeof raw.task === "boolean") msg.task = raw.task;
  if (raw.via === "main") msg.via = "main";
  return msg;
}

/** Messages in order, one per id (a repeated id keeps its last copy, in its first place). */
export function dedupeMessages(messages: readonly RoomMessage[]): RoomMessage[] {
  const at = new Map<string, number>();
  const out: RoomMessage[] = [];
  for (const msg of messages) {
    const index = at.get(msg.id);
    if (index === undefined) {
      at.set(msg.id, out.length);
      out.push(msg);
    } else {
      out[index] = msg;
    }
  }
  return out;
}

export function normaliseMembers(raw: unknown): RoomMemberState[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    if (!isObject(m) || typeof m.botId !== "string") return [];
    const state = MEMBER_STATES.includes(m.state as MemberState) ? (m.state as MemberState) : "idle";
    const queued = typeof m.queued === "number" && Number.isInteger(m.queued) && m.queued >= 0 ? m.queued : 0;
    return [{ botId: m.botId, state, queued }];
  });
}

/** A `rooms.thread` answer (live or cached head): never throws, ids unique. */
export function normaliseThread(raw: unknown, groupId = ""): Thread {
  const data = isObject(raw) ? raw : {};
  const messages = Array.isArray(data.messages)
    ? data.messages.flatMap((m) => {
        const msg = normaliseMessage(m, groupId);
        return msg ? [msg] : [];
      })
    : [];
  return { messages: dedupeMessages(messages), members: normaliseMembers(data.members) };
}

/** One `rooms.list` row; null when it has no id. Old single-`lead` rows read as `leads: [lead]`. */
export function normaliseSummary(raw: unknown): RoomSummary | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) return null;
  const members = Array.isArray(raw.members)
    ? raw.members.flatMap((m) => {
        // Very old rows may list plain bot ids.
        if (typeof m === "string") return [{ botId: m, name: m, icon: "Bot", avatarHash: null }];
        if (!isObject(m) || typeof m.botId !== "string") return [];
        return [
          {
            botId: m.botId,
            name: str(m.name) ?? m.botId,
            icon: str(m.icon) ?? "Bot",
            avatarHash: str(m.avatarHash),
          },
        ];
      })
    : [];
  const leads = Array.isArray(raw.leads)
    ? strings(raw.leads)
    : typeof raw.lead === "string"
      ? [raw.lead]
      : members[0]
        ? [members[0].botId]
        : [];
  return {
    id: raw.id,
    name: str(raw.name) ?? raw.id,
    leads,
    members,
    lastTs: str(raw.lastTs),
    lastPreview: str(raw.lastPreview),
  };
}

export function normaliseList(raw: unknown): { groups: RoomSummary[] } {
  const groups = isObject(raw) && Array.isArray(raw.groups) ? raw.groups : [];
  return {
    groups: groups.flatMap((g) => {
      const summary = normaliseSummary(g);
      return summary ? [summary] : [];
    }),
  };
}

const size = (x: unknown) => JSON.stringify(x).length;

/** The cache as stored on the device; anything unreadable is dropped. */
export function normaliseThreadCache(raw: unknown): ThreadCache {
  if (!isObject(raw) || !isObject(raw.groups)) return EMPTY_THREAD_CACHE;
  const groups: Record<string, CachedThread> = {};
  for (const [groupId, entry] of Object.entries(raw.groups)) {
    if (!isObject(entry)) continue;
    const thread = normaliseThread(entry, groupId);
    if (thread.messages.length === 0) continue;
    const savedAt = typeof entry.savedAt === "number" && Number.isFinite(entry.savedAt) ? entry.savedAt : 0;
    groups[groupId] = { savedAt, ...thread };
  }
  return { v: 1, groups };
}

/** The cached thread of one group, or null. */
export function cachedThreadOf(raw: unknown, groupId: string): Thread | null {
  const entry = normaliseThreadCache(raw).groups[groupId];
  return entry ? { messages: entry.messages, members: entry.members } : null;
}

/** The newest THREAD_CACHE_MAX messages that fit THREAD_CACHE_GROUP_BYTES. */
function capMessages(messages: readonly RoomMessage[]): RoomMessage[] {
  const kept = messages.slice(-THREAD_CACHE_MAX);
  let bytes = size(kept);
  while (kept.length > 0 && bytes > THREAD_CACHE_GROUP_BYTES) bytes -= size(kept.shift()) + 1;
  return kept;
}

const sameThread = (a: CachedThread, b: Thread) =>
  a.messages.length === b.messages.length &&
  a.messages.every((m, i) => m.id === b.messages[i]!.id && m.text === b.messages[i]!.text) &&
  a.members.length === b.members.length &&
  a.members.every((m, i) => m.botId === b.members[i]!.botId);

/**
 * Keeps a fresh thread of `groupId` in the cache: its newest messages within the caps, member
 * states reset to idle (a cached "typing" would be stale). Returns `cache` itself when nothing
 * changed, so a poll does not rewrite the device. Older groups are dropped past THREAD_CACHE_BYTES.
 */
export function putThread(cache: ThreadCache, groupId: string, thread: Thread, now: number): ThreadCache {
  const fresh: Thread = {
    messages: capMessages(dedupeMessages(thread.messages)),
    members: thread.members.map((m) => ({ botId: m.botId, state: "idle" as const, queued: 0 })),
  };
  const held = cache.groups[groupId];
  if (held && sameThread(held, fresh)) return cache;
  const groups: Record<string, CachedThread> = { ...cache.groups };
  if (fresh.messages.length === 0) delete groups[groupId];
  else groups[groupId] = { savedAt: now, ...fresh };
  // Newest first; keep groups while they fit the total budget (the fresh one always fits).
  const order = Object.keys(groups).sort((a, b) => (a === groupId ? -1 : b === groupId ? 1 : groups[b]!.savedAt - groups[a]!.savedAt));
  const kept: Record<string, CachedThread> = {};
  let bytes = 0;
  for (const id of order) {
    const entry = groups[id]!;
    const entryBytes = size(entry) + id.length + 4;
    if (bytes + entryBytes > THREAD_CACHE_BYTES) continue;
    kept[id] = entry;
    bytes += entryBytes;
  }
  return { v: 1, groups: kept };
}

/** Writes a live thread into the device copy, only when it changed (polls do not rewrite the device). */
export function rememberThread(queryClient: QueryClient, groupId: string, fresh: Thread, now = Date.now()): void {
  const held = normaliseThreadCache(queryClient.getQueryData(ROOMS_THREAD_CACHE_KEY));
  const next = putThread(held, groupId, fresh, now);
  if (next !== held) queryClient.setQueryData<ThreadCache>(ROOMS_THREAD_CACHE_KEY, next);
}

/**
 * Data written before this bundle started came from the device cache (an earlier session): a head
 * that old says nothing about who is working now.
 */
const SESSION_START = Date.now();

/** Woken: a member is in a room turn or has one queued. Cached heads (older than this session) never count. */
export function headWoken(head: Thread | undefined, dataUpdatedAt: number, sessionStart = SESSION_START): boolean {
  if (!head || dataUpdatedAt < sessionStart) return false;
  return head.members.some((m) => m.state === "room" || m.state === "queued");
}

/**
 * useQuery options for one group's thread, stale-while-revalidate from the device copy: the cached
 * messages seed the query as already-stale data (no spinner), the host's answer replaces them (same
 * ids, so React keeps every bubble; no double messages) and refreshes the copy. Offline, the copy
 * stays on screen under the error. The thread query itself is not persisted (200 messages).
 */
export function threadQueryOptions(
  queryClient: QueryClient,
  groupId: string,
  fetchThread: () => Promise<unknown>,
): QueryObserverOptions<Thread, Error, Thread, Thread, readonly unknown[]> {
  return {
    queryKey: ["rooms", "thread", groupId],
    queryFn: async (): Promise<Thread> => {
      const fresh = normaliseThread(await fetchThread(), groupId);
      rememberThread(queryClient, groupId, fresh);
      return fresh;
    },
    initialData: () => (groupId ? (cachedThreadOf(queryClient.getQueryData(ROOMS_THREAD_CACHE_KEY), groupId) ?? undefined) : undefined),
    // Seeded data is never fresh: the host is asked at once.
    initialDataUpdatedAt: 0,
    enabled: !!groupId,
  };
}
