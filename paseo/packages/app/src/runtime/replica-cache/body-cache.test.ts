import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { DurableBodyCache } from "./body-cache";
import { ReplicaCache } from "./index";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type ReplicaSqliteDriver,
  type SqliteValue,
} from "./row-store-sqlite";
import { REPLICA_ROW_STORE_SCHEMA_VERSION } from "./row-store-schema";
import {
  clearFullToolCallCache,
  loadFullToolCallDetail,
  prefetchToolBodies,
} from "@/timeline/compact-tool-call";

function driverFor(database: DatabaseSync): ReplicaSqliteDriver {
  function connection(): ReplicaSqliteConnection {
    return {
      async exec(sql) {
        database.exec(sql);
      },
      async run(sql, params = []) {
        database.prepare(sql).run(...(params as SQLInputValue[]));
      },
      async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
        return database.prepare(sql).all(...(params as SQLInputValue[])) as Row[];
      },
      async transaction(operation) {
        database.exec("BEGIN IMMEDIATE");
        try {
          await operation(connection());
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
  return { open: async () => connection() };
}

function freshStore(database = new DatabaseSync(":memory:")) {
  return createSqliteReplicaRowStore(driverFor(database), REPLICA_ROW_STORE_SCHEMA_VERSION);
}

const toolItem = (output: string) => ({
  type: "tool_call",
  callId: "c1",
  detail: { type: "shell", command: "ls", output },
});

describe("DurableBodyCache (B2b)", () => {
  it("survives a restart: a body written by one process is read by the next", async () => {
    const database = new DatabaseSync(":memory:");
    const first = new DurableBodyCache(freshStore(database));
    await first.put("host", "hash1", toolItem("full output"));
    const second = new DurableBodyCache(freshStore(database));
    expect(await second.get("host", "hash1")).toEqual(toolItem("full output"));
    expect(await second.get("other-host", "hash1")).toBeUndefined();
    expect([...(await second.hashes("host"))]).toEqual(["hash1"]);
  });

  it("is bounded: least recently used bodies go first", async () => {
    let clock = 1;
    const store = freshStore();
    const body = (n: number) => ({ type: "tool_call", detail: { output: "x".repeat(400), n } });
    const bytes = JSON.stringify(body(0)).length;
    const cache = new DurableBodyCache(store, bytes * 3, () => clock++);
    await cache.put("h", "a", body(1));
    await cache.put("h", "b", body(2));
    await cache.put("h", "c", body(3));
    await cache.get("h", "a"); // a is now the most recent
    await cache.put("h", "d", body(4));
    expect(await cache.get("h", "b")).toBeUndefined();
    expect(await cache.get("h", "a")).toEqual(body(1));
    expect(await cache.get("h", "d")).toEqual(body(4));
    expect(cache.storedBytes()).toBeLessThanOrEqual(bytes * 3);
  });

  it("does not count against, or get evicted by, the chat replica budget", async () => {
    const database = new DatabaseSync(":memory:");
    const store = freshStore(database);
    const bodies = new DurableBodyCache(store);
    await bodies.put("host", "big", { type: "tool_call", detail: { output: "y".repeat(5000) } });
    const replica = new ReplicaCache(freshStore(database), {
      maxBytes: 1000,
      clearLegacyCache: async () => undefined,
    });
    replica.setHosts(["host"]);
    await replica.flush();
    // Loads the replica's index (the path a budget check uses).
    await replica.readTimelinePageBefore("host", "agent", { epoch: "e", beforeSeq: 1 });
    expect(replica.archivedThrough("host", "agent", { epoch: "e", fromSeq: 0 })).toBeUndefined();
    expect(replica.storedBytes()).toBe(0);
    expect(await new DurableBodyCache(freshStore(database)).get("host", "big")).toBeTruthy();
  });

  it("keeps an existing v2 cache when the body kind is added (no drop on update)", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
    database.exec(
      `INSERT INTO meta VALUES ('schema_version', '${REPLICA_ROW_STORE_SCHEMA_VERSION}')`,
    );
    database.exec(`CREATE TABLE rows (
      server_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'workspace', 'project', 'timeline', 'timeline_page', 'checkpoint')),
      id TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
      touched_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (server_id, kind, id))`);
    database.exec(`INSERT INTO rows VALUES ('host', 'agent', 'a1', '{"x":1}', 7, 5)`);
    const store = freshStore(database);
    await store.open();
    expect(await store.read("host", ["agent"])).toEqual([
      { serverId: "host", kind: "agent", id: "a1", payload: '{"x":1}' },
    ]);
    await store.apply({
      upserts: [{ serverId: "host", kind: "body", id: "h", payload: "{}" }],
      deletes: [],
    });
    expect((await store.read("host", ["body"])).length).toBe(1);
  });
});

function bodiesFor(callIds: string[]) {
  const bodies = callIds.map((callId) => ({
    callId,
    hash: `h${callId.slice(1)}`,
    item: toolItem(callId),
  }));
  return { bodies, notLoaded: false };
}

describe("tap and prefetch through the durable cache", () => {
  const shortMarker = { short: true, bodyHash: "hash-c1", omittedBytes: 4000 };

  it("tap: a short row uses the bodies request once, then reads from disk after a restart", async () => {
    clearFullToolCallCache();
    const database = new DatabaseSync(":memory:");
    const client = {
      fetchAgentTimelineItem: vi.fn(),
      fetchAgentTimelineBodies: vi.fn(async () => ({
        bodies: [{ callId: "c1", hash: "hash-c1", item: toolItem("full") }],
        notLoaded: false,
      })),
    };
    const cache = new DurableBodyCache(freshStore(database));
    const detail = await loadFullToolCallDetail(client, "agent", "c1", {
      serverId: "host",
      marker: shortMarker,
      bodyCache: cache,
    });
    expect(detail).toEqual(toolItem("full").detail);
    expect(client.fetchAgentTimelineBodies).toHaveBeenCalledWith("agent", {
      callIds: ["c1"],
      priority: "tap",
    });
    await vi.waitFor(async () => expect(await cache.get("host", "hash-c1")).toBeTruthy());

    clearFullToolCallCache(); // app restart: memory gone
    const offline = {
      fetchAgentTimelineItem: vi.fn(async () => {
        throw new Error("offline");
      }),
      fetchAgentTimelineBodies: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const again = await loadFullToolCallDetail(offline, "agent", "c1", {
      serverId: "host",
      marker: shortMarker,
      bodyCache: new DurableBodyCache(freshStore(database)),
    });
    expect(again).toEqual(toolItem("full").detail);
    expect(offline.fetchAgentTimelineBodies).not.toHaveBeenCalled();
  });

  it("old daemon (rows never marked short): uses the item request, never the bodies request", async () => {
    clearFullToolCallCache();
    const client = {
      fetchAgentTimelineItem: vi.fn(async () => ({ item: toolItem("old") })),
      fetchAgentTimelineBodies: vi.fn(),
    };
    const detail = await loadFullToolCallDetail(client, "agent", "c1", {
      serverId: "host",
      marker: { omittedBytes: 10 },
      bodyCache: new DurableBodyCache(freshStore()),
    });
    expect(detail).toEqual(toolItem("old").detail);
    expect(client.fetchAgentTimelineBodies).not.toHaveBeenCalled();
  });

  it("an agent the daemon has not loaded falls back to the item request", async () => {
    clearFullToolCallCache();
    const client = {
      fetchAgentTimelineItem: vi.fn(async () => ({ item: toolItem("resumed") })),
      fetchAgentTimelineBodies: vi.fn(async () => ({ bodies: [], notLoaded: true })),
    };
    expect(
      await loadFullToolCallDetail(client, "agent", "c1", {
        serverId: "host",
        marker: shortMarker,
      }),
    ).toEqual(toolItem("resumed").detail);
  });

  it("prefetch: only on a good link, background lane, newest first, skips bodies on disk", async () => {
    const cache = new DurableBodyCache(freshStore());
    await cache.put("host", "h1", toolItem("cached"));
    const client = {
      fetchAgentTimelineItem: vi.fn(),
      fetchAgentTimelineBodies: vi.fn(async (_agent: string, keys: { callIds?: string[] }) =>
        bodiesFor(keys.callIds ?? []),
      ),
    };
    const rows = [1, 2, 3, 4].map((n) => ({
      callId: `c${n}`,
      metadata: { paseoCompact: { short: true, bodyHash: `h${n}` } },
    }));
    rows.push({ callId: "c5", metadata: { paseoCompact: { short: true } } } as never); // running: no hash
    const base = { client, serverId: "host", agentId: "agent", rows, bodyCache: cache };
    expect(await prefetchToolBodies({ ...base, goodLink: false })).toBe(0);
    expect(client.fetchAgentTimelineBodies).not.toHaveBeenCalled();
    expect(await prefetchToolBodies({ ...base, goodLink: true, max: 2 })).toBe(2);
    expect(client.fetchAgentTimelineBodies).toHaveBeenCalledWith("agent", {
      callIds: ["c4", "c3"],
      priority: "background",
    });
    expect(await cache.get("host", "h4")).toEqual(toolItem("c4"));
  });
});
