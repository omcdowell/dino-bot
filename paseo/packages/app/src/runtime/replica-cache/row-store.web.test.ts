import {
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
  indexedDB as fakeIndexedDb,
} from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { runReplicaRowStoreContract } from "./row-store.contract";
import { createIndexedDbReplicaRowStore } from "./row-store.web";

globalThis.indexedDB = fakeIndexedDb;
globalThis.IDBKeyRange = FakeIDBKeyRange;

let databaseSequence = 0;

runReplicaRowStoreContract("IndexedDB", async () => {
  const databaseName = `replica-row-store-test-${databaseSequence++}`;
  return {
    store: createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 }),
    async openWithSchemaVersion(schemaVersion) {
      const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion });
      await store.open();
      return store;
    },
  };
});

it("uses exact IndexedDB keys for targeted rows instead of scanning the host", async () => {
  const store = createIndexedDbReplicaRowStore({
    databaseName: `replica-row-store-targeted-${databaseSequence++}`,
    schemaVersion: 1,
  });
  await store.open();
  await store.apply({
    upserts: [
      { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
      { serverId: "server-a", kind: "workspace", id: "workspace-1", payload: "workspace" },
    ],
    deletes: [],
  });
  const get = vi.spyOn(FakeIDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(FakeIDBObjectStore.prototype, "getAll");

  expect(await store.read("server-a", ["agent"], ["agent-1"])).toEqual([
    { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
  ]);
  expect(get).toHaveBeenCalledWith(["server-a", "agent", "agent-1"]);
  expect(getAll).not.toHaveBeenCalled();

  get.mockRestore();
  getAll.mockRestore();
});

function storeNamesCalled(
  method: "get" | "getAll" | "openCursor" | "put",
  run: () => Promise<unknown>,
): Promise<string[]> {
  const names: string[] = [];
  const original = FakeIDBObjectStore.prototype[method] as (...args: unknown[]) => unknown;
  const spy = vi.spyOn(FakeIDBObjectStore.prototype, method).mockImplementation(function (
    this: { name: string },
    ...args: unknown[]
  ) {
    names.push(this.name);
    return original.apply(this, args);
  } as never);
  return run().then(
    () => {
      spy.mockRestore();
      return names;
    },
    (error: unknown) => {
      spy.mockRestore();
      throw error;
    },
  );
}

async function openedStore() {
  const store = createIndexedDbReplicaRowStore({
    databaseName: `replica-row-store-index-${databaseSequence++}`,
    schemaVersion: 1,
  });
  await store.open();
  await store.apply({
    upserts: [
      { serverId: "server-a", kind: "timeline_page", id: "p1", payload: "x".repeat(10_000) },
      { serverId: "server-a", kind: "timeline", id: "agent-1", payload: "head" },
    ],
    deletes: [],
  });
  return store;
}

it("reads the cold-start index without touching row payloads", async () => {
  const store = await openedStore();
  const reads = [
    ...(await storeNamesCalled("getAll", () => store.readIndex())),
    ...(await storeNamesCalled("openCursor", () => store.readIndex())),
  ];
  expect(reads).not.toContain("rows");
  expect((await store.readIndex()).map((entry) => entry.bytes).sort()).toEqual([10_000, 4]);
});

it("marks rows as used without rewriting their payloads", async () => {
  const store = await openedStore();
  const writes = await storeNamesCalled("put", () =>
    store.touch([{ serverId: "server-a", kind: "timeline_page", id: "p1" }], 7),
  );
  expect(writes).not.toContain("rows");
  expect((await store.readIndex()).find((entry) => entry.id === "p1")?.touchedAt).toBe(7);
});

it("builds the index once from a cache written by the previous version", async () => {
  const databaseName = `replica-row-store-v1-${databaseSequence++}`;
  await new Promise<void>((resolve, reject) => {
    const request = fakeIndexedDb.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore("rows", { keyPath: ["serverId", "kind", "id"] });
      request.result.createObjectStore("meta");
    });
    request.addEventListener("success", () => {
      const database = request.result;
      const transaction = database.transaction(["rows", "meta"], "readwrite");
      transaction.objectStore("meta").put(1, "schema_version");
      transaction.objectStore("rows").put({
        serverId: "server-a",
        kind: "timeline",
        id: "agent-1",
        payload: "old head",
        bytes: 8,
        touchedAt: 123,
      });
      transaction.objectStore("rows").put({
        serverId: "server-a",
        kind: "agent",
        id: "agent-1",
        payload: "é",
      });
      transaction.addEventListener("complete", () => {
        database.close();
        resolve();
      });
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    request.addEventListener("error", () => reject(request.error));
  });

  const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 });
  await store.open();

  expect(
    (await store.readIndex()).sort((left, right) => left.kind.localeCompare(right.kind)),
  ).toEqual([
    { serverId: "server-a", kind: "agent", id: "agent-1", bytes: 2, touchedAt: 0 },
    { serverId: "server-a", kind: "timeline", id: "agent-1", bytes: 8, touchedAt: 123 },
  ]);
  expect(await store.read("server-a", ["timeline"], ["agent-1"])).toEqual([
    { serverId: "server-a", kind: "timeline", id: "agent-1", payload: "old head" },
  ]);
});
