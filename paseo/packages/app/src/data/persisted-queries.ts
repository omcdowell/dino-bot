/**
 * The app's own device-cached queries (DI1 G4: usage was blank offline and on a cold start).
 *
 * Same rule as plugin queries (plugins/plugin-cache.ts): a query opts in with
 * `meta: { persist: true }`, only successful data is kept, the largest entries are left out above
 * the byte limit (and that is logged), and writes are debounced. All of it is one JSON value under
 * one key. At start the app hydrates it before the hosts answer; TanStack's `hydrate` never
 * replaces data newer than the stored copy, so a fetch that already landed wins.
 */
import { hydrate, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { dehydratePersisted, logTrim, trimPersisted } from "@/plugins/plugin-cache";

export const PERSISTED_QUERIES_KEY = "paseo:query-cache:v1";

export interface PersistedQueriesStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const DehydratedSchema = z.object({
  queries: z.array(z.unknown()),
  mutations: z.array(z.unknown()),
});

export function createPersistedQueries(
  storage: PersistedQueriesStorage,
  options: { debounceMs?: number; maxBytes?: number; key?: string } = {},
) {
  const debounceMs = options.debounceMs ?? 2_000;
  const maxBytes = options.maxBytes ?? 512_000;
  const key = options.key ?? PERSISTED_QUERIES_KEY;
  let written: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tracked: QueryClient | null = null;

  const quietly = (work: Promise<unknown>) => work.then(() => undefined).catch(() => undefined);

  function write(): Promise<void> {
    timer = null;
    if (!tracked) return Promise.resolve();
    const { state, trimmed } = trimPersisted(dehydratePersisted(tracked), maxBytes);
    logTrim("query-cache", trimmed, maxBytes);
    const json = JSON.stringify(state);
    if (json === written) return Promise.resolve();
    written = json;
    if (state.queries.length === 0) return quietly(storage.removeItem(key));
    return quietly(storage.setItem(key, json));
  }

  return {
    /** Puts the stored queries into `client`; a missing or unreadable copy is ignored. */
    async restore(client: QueryClient): Promise<void> {
      let raw: string | null = null;
      try {
        raw = await storage.getItem(key);
      } catch {
        return;
      }
      if (!raw) return;
      try {
        const parsed = DehydratedSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        written ??= raw;
        hydrate(client, parsed.data as Parameters<typeof hydrate>[1]);
      } catch {
        // A copy from another shape: the next write replaces it.
      }
    },

    /** Writes `client`'s persisted queries (debounced) whenever one of them changes. */
    track(client: QueryClient): () => void {
      tracked = client;
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (timer) return;
        if (event.type !== "updated" && event.type !== "added" && event.type !== "removed") return;
        if (event.query.meta?.persist !== true) return;
        timer = setTimeout(() => void write(), debounceMs);
      });
      return () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
        timer = null;
        if (tracked === client) tracked = null;
      };
    },

    /** Writes a pending change now (tests, app going to the background). */
    flush(): Promise<void> {
      if (!timer) return Promise.resolve();
      clearTimeout(timer);
      return write();
    },
  };
}
