import type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowIndexEntry,
  ReplicaRowKey,
  ReplicaRowStore,
} from "./row-store";
import { utf8ByteLength } from "./row-store-sqlite";

/** Rows written before the index store existed (database version 1) carry their own sizes. */
interface StoredWebRow extends ReplicaRow {
  bytes?: number;
  touchedAt?: number;
}

function toIndexEntry(row: StoredWebRow): ReplicaRowIndexEntry {
  return {
    serverId: row.serverId,
    kind: row.kind,
    id: row.id,
    bytes: row.bytes ?? utf8ByteLength(row.payload),
    touchedAt: row.touchedAt ?? 0,
  };
}

function toRow(stored: StoredWebRow): ReplicaRow {
  return { serverId: stored.serverId, kind: stored.kind, id: stored.id, payload: stored.payload };
}
import { REPLICA_ROW_STORE_SCHEMA_VERSION } from "./row-store-schema";

export type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowKey,
  ReplicaRowKind,
  ReplicaRowStore,
} from "./row-store";
export { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

const DATABASE_NAME = "paseo-replica-row-store";
// Version 2 adds INDEX_STORE: keys, sizes and access times without payloads, so a cold start
// (readIndex) and LRU touches never read or rewrite the cached chats themselves. That is what lets
// the desktop cache grow to 500 MB.
const DATABASE_VERSION = 2;
const ROWS_STORE = "rows";
const INDEX_STORE = "row_index";
const KEY_PATH = ["serverId", "kind", "id"];
const META_STORE = "meta";
const SCHEMA_VERSION_KEY = "schema_version";

interface IndexedDbReplicaRowStoreOptions {
  databaseName: string;
  schemaVersion: number;
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Replica row store request failed")),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Replica row store transaction was aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Replica row store transaction failed")),
    );
  });
}

async function runTransaction(
  database: IDBDatabase,
  storeNames: string | string[],
  operation: (transaction: IDBTransaction) => Promise<void>,
): Promise<void> {
  const transaction = database.transaction(storeNames, "readwrite");
  const completion = transactionComplete(transaction);
  try {
    await operation(transaction);
    await completion;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction already aborted after the failed request.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

async function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ROWS_STORE)) {
        database.createObjectStore(ROWS_STORE, { keyPath: KEY_PATH });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
      if (!database.objectStoreNames.contains(INDEX_STORE)) {
        const index = database.createObjectStore(INDEX_STORE, { keyPath: KEY_PATH });
        // One pass over a version-1 cache (64 MB at most) to build the index.
        const cursorRequest = request.transaction?.objectStore(ROWS_STORE).openCursor();
        cursorRequest?.addEventListener("success", () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          index.put(toIndexEntry(cursor.value as StoredWebRow));
          cursor.continue();
        });
      }
    });
    request.addEventListener("success", () => {
      // Let a newer build in another window upgrade the database instead of blocking it.
      request.result.addEventListener("versionchange", () => request.result.close());
      resolve(request.result);
    });
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open replica row store")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("Replica row store database open was blocked")),
    );
  });
}

/** @package Test seam for exercising the browser engine with an isolated database. */
export function createIndexedDbReplicaRowStore(
  options: IndexedDbReplicaRowStoreOptions,
): ReplicaRowStore {
  let database: IDBDatabase | null = null;
  let opening: Promise<void> | null = null;

  function getDatabase(): IDBDatabase {
    if (!database) throw new Error("Replica row store has not been opened");
    return database;
  }

  async function open(): Promise<void> {
    opening ??= (async () => {
      const openedDatabase = await openDatabase(options.databaseName);
      const stores = [ROWS_STORE, INDEX_STORE, META_STORE];
      await runTransaction(openedDatabase, stores, async (transaction) => {
        const storedVersion = await requestResult(
          transaction.objectStore(META_STORE).get(SCHEMA_VERSION_KEY),
        );
        if (storedVersion !== options.schemaVersion) {
          await requestResult(transaction.objectStore(ROWS_STORE).clear());
          await requestResult(transaction.objectStore(INDEX_STORE).clear());
          await requestResult(
            transaction.objectStore(META_STORE).put(options.schemaVersion, SCHEMA_VERSION_KEY),
          );
        }
      });
      database = openedDatabase;
    })();

    try {
      await opening;
    } catch (error) {
      opening = null;
      throw error;
    }
  }

  async function readAll(): Promise<ReplicaHostRows[]> {
    const transaction = getDatabase().transaction(ROWS_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const stored = await requestResult<StoredWebRow[]>(
      transaction.objectStore(ROWS_STORE).getAll(),
    );
    await completion;
    const hosts = new Map<string, ReplicaRow[]>();
    for (const row of stored.map(toRow)) {
      const hostRows = hosts.get(row.serverId) ?? [];
      hostRows.push(row);
      hosts.set(row.serverId, hostRows);
    }
    return Array.from(hosts, ([serverId, hostRows]) => ({ serverId, rows: hostRows }));
  }

  async function readIndex(): Promise<ReplicaRowIndexEntry[]> {
    const transaction = getDatabase().transaction(INDEX_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const entries = await requestResult<ReplicaRowIndexEntry[]>(
      transaction.objectStore(INDEX_STORE).getAll(),
    );
    await completion;
    return entries.map((entry) => ({
      serverId: entry.serverId,
      kind: entry.kind,
      id: entry.id,
      bytes: entry.bytes,
      touchedAt: entry.touchedAt,
    }));
  }

  async function touch(keys: readonly ReplicaRowKey[], at: number): Promise<void> {
    if (keys.length === 0) return;
    await runTransaction(getDatabase(), INDEX_STORE, async (transaction) => {
      const index = transaction.objectStore(INDEX_STORE);
      for (const key of keys) {
        const entry = await requestResult<ReplicaRowIndexEntry | undefined>(
          index.get([key.serverId, key.kind, key.id]),
        );
        if (entry) await requestResult(index.put({ ...entry, touchedAt: at }));
      }
    });
  }

  async function read(
    serverId: string,
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    if (kinds.length === 0 || ids?.length === 0) return [];
    const transaction = getDatabase().transaction(ROWS_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(ROWS_STORE);
    const requests = ids
      ? kinds.flatMap((kind) =>
          ids.map(async (id) => {
            const row = await requestResult<StoredWebRow | undefined>(
              store.get([serverId, kind, id]),
            );
            return row ? [toRow(row)] : [];
          }),
        )
      : kinds.map((kind) =>
          requestResult<StoredWebRow[]>(
            store.getAll(IDBKeyRange.bound([serverId, kind], [serverId, kind, []])),
          ).then((rows) => rows.map(toRow)),
        );
    const rows = (await Promise.all(requests)).flat();
    await completion;
    return rows.sort((left, right) =>
      left.kind === right.kind
        ? left.id.localeCompare(right.id)
        : left.kind.localeCompare(right.kind),
    );
  }

  async function apply(changes: ReplicaRowChanges): Promise<void> {
    await runTransaction(getDatabase(), [ROWS_STORE, INDEX_STORE], async (transaction) => {
      const rows = transaction.objectStore(ROWS_STORE);
      const index = transaction.objectStore(INDEX_STORE);
      for (const key of changes.deletes) {
        const id = [key.serverId, key.kind, key.id];
        await requestResult(rows.delete(id));
        await requestResult(index.delete(id));
      }
      const now = Date.now();
      for (const row of changes.upserts) {
        const stored = toRow(row);
        await requestResult(rows.put(stored));
        const entry: ReplicaRowIndexEntry = {
          serverId: stored.serverId,
          kind: stored.kind,
          id: stored.id,
          bytes: utf8ByteLength(stored.payload),
          touchedAt: now,
        };
        await requestResult(index.put(entry));
      }
    });
  }

  async function deleteHost(serverId: string): Promise<void> {
    await runTransaction(getDatabase(), [ROWS_STORE, INDEX_STORE], async (transaction) => {
      const range = IDBKeyRange.bound([serverId], [serverId, []]);
      await requestResult(transaction.objectStore(ROWS_STORE).delete(range));
      await requestResult(transaction.objectStore(INDEX_STORE).delete(range));
    });
  }

  async function renameHost(oldServerId: string, newServerId: string): Promise<void> {
    if (oldServerId === newServerId) return;
    await runTransaction(getDatabase(), [ROWS_STORE, INDEX_STORE], async (transaction) => {
      const rows = transaction.objectStore(ROWS_STORE);
      const index = transaction.objectStore(INDEX_STORE);
      const range = IDBKeyRange.bound([oldServerId], [oldServerId, []]);
      const oldRows = await requestResult<StoredWebRow[]>(rows.getAll(range));
      const oldEntries = await requestResult<ReplicaRowIndexEntry[]>(index.getAll(range));
      for (const row of oldRows) {
        await requestResult(rows.put({ ...toRow(row), serverId: newServerId }));
        await requestResult(rows.delete([row.serverId, row.kind, row.id]));
      }
      for (const entry of oldEntries) {
        await requestResult(index.put({ ...entry, serverId: newServerId }));
        await requestResult(index.delete([entry.serverId, entry.kind, entry.id]));
      }
    });
  }

  async function clear(): Promise<void> {
    await runTransaction(getDatabase(), [ROWS_STORE, INDEX_STORE], async (transaction) => {
      await requestResult(transaction.objectStore(ROWS_STORE).clear());
      await requestResult(transaction.objectStore(INDEX_STORE).clear());
    });
  }

  return { open, read, readAll, readIndex, touch, apply, deleteHost, renameHost, clear };
}

export function createReplicaRowStore(): ReplicaRowStore {
  return createIndexedDbReplicaRowStore({
    databaseName: DATABASE_NAME,
    schemaVersion: REPLICA_ROW_STORE_SCHEMA_VERSION,
  });
}
