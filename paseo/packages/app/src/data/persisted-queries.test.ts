// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { PersistedQueryClient } from "@/plugins/plugin-cache";
import { createPersistedQueries, type PersistedQueriesStorage } from "./persisted-queries";

function memoryStorage() {
  const items = new Map<string, string>();
  const storage: PersistedQueriesStorage = {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
  };
  return { items, storage };
}

const REPORTS = [{ id: "fixture:account-1", fetchedAt: "2026-11-20T10:00:00.000Z" }];

describe("persisted queries (the app's own device cache)", () => {
  it("brings a `meta.persist` query back after a restart, with no host", async () => {
    const { storage } = memoryStorage();
    const before = new PersistedQueryClient();
    const persisted = createPersistedQueries(storage, { debounceMs: 10 });
    persisted.track(before);
    await before.fetchQuery({
      queryKey: ["usage", "host-a", "reports"],
      queryFn: async () => REPORTS,
      meta: { persist: true },
    });
    await before.fetchQuery({
      queryKey: ["usage", "host-a", "agent", "a1"],
      queryFn: async () => [],
    });
    await persisted.flush();

    const after = new PersistedQueryClient();
    await createPersistedQueries(storage).restore(after);
    expect(after.getQueryData(["usage", "host-a", "reports"])).toEqual(REPORTS);
    // Only queries that opt in are kept.
    expect(after.getQueryData(["usage", "host-a", "agent", "a1"])).toBeUndefined();
  });

  it("keeps a restored query that no screen observes (no 5 min garbage collection)", async () => {
    const { storage } = memoryStorage();
    const before = new PersistedQueryClient();
    const persisted = createPersistedQueries(storage, { debounceMs: 10 });
    persisted.track(before);
    await before.fetchQuery({
      queryKey: ["usage", "host-a", "reports"],
      queryFn: async () => REPORTS,
      meta: { persist: true },
    });
    await persisted.flush();

    const after = new PersistedQueryClient();
    const restored = createPersistedQueries(storage, { debounceMs: 10 });
    restored.track(after);
    await restored.restore(after);
    const query = after.getQueryCache().find({ queryKey: ["usage", "host-a", "reports"] });
    expect(query?.gcTime).toBe(Infinity);
    expect(query?.state.data).toEqual(REPORTS);
  });

  it("does not replace data fetched before the stored copy was read", async () => {
    const { storage } = memoryStorage();
    const before = new PersistedQueryClient();
    const persisted = createPersistedQueries(storage, { debounceMs: 10 });
    persisted.track(before);
    await before.fetchQuery({
      queryKey: ["usage", "host-a", "reports"],
      queryFn: async () => REPORTS,
      meta: { persist: true },
    });
    await persisted.flush();

    const after = new PersistedQueryClient();
    const fresh = [{ id: "fixture:account-1", fetchedAt: "2026-11-20T11:00:00.000Z" }];
    await after.fetchQuery({
      queryKey: ["usage", "host-a", "reports"],
      queryFn: async () => fresh,
      meta: { persist: true },
    });
    await createPersistedQueries(storage).restore(after);
    expect(after.getQueryData(["usage", "host-a", "reports"])).toEqual(fresh);
  });

  it("over the byte limit leaves the largest out and says so", async () => {
    const { items, storage } = memoryStorage();
    const client = new PersistedQueryClient();
    const persisted = createPersistedQueries(storage, {
      debounceMs: 10,
      maxBytes: 1_000,
      key: "k",
    });
    persisted.track(client);
    await client.fetchQuery({
      queryKey: ["small"],
      queryFn: async () => "s",
      meta: { persist: true },
    });
    await client.fetchQuery({
      queryKey: ["big"],
      queryFn: async () => "b".repeat(2_000),
      meta: { persist: true },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await persisted.flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual(['["big"]']);
    } finally {
      warn.mockRestore();
    }
    const kept = JSON.parse(items.get("k") ?? "{}") as { queries: Array<{ queryKey: unknown }> };
    expect(kept.queries.map((query) => query.queryKey)).toEqual([["small"]]);
  });

  it("ignores an unreadable stored copy", async () => {
    const { items, storage } = memoryStorage();
    items.set("k", "{not json");
    const client = new QueryClient();
    await expect(createPersistedQueries(storage, { key: "k" }).restore(client)).resolves.toBe(
      undefined,
    );
    expect(client.getQueryCache().getAll()).toEqual([]);
  });
});
