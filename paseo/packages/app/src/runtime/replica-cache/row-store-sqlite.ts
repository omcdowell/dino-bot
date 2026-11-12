import type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowIndexEntry,
  ReplicaRowKey,
  ReplicaRowStore,
} from "./row-store";

export type SqliteValue = string | number | null;

export interface ReplicaSqliteConnection {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqliteValue[]): Promise<void>;
  all<Row>(sql: string, params?: readonly SqliteValue[]): Promise<Row[]>;
  transaction(operation: (connection: ReplicaSqliteConnection) => Promise<void>): Promise<void>;
}

export interface ReplicaSqliteDriver {
  open(): Promise<ReplicaSqliteConnection>;
}

const CREATE_ROWS_SQL = `
  CREATE TABLE IF NOT EXISTS rows (
    server_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('agent', 'workspace', 'project', 'timeline', 'timeline_page', 'checkpoint', 'body')),
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    touched_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, kind, id)
  )
`;

const CREATE_META_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )
`;

/**
 * B2b: the `body` kind (durable tool bodies by hash) widened the kind CHECK without a schema
 * bump, so an existing cache is copied over instead of dropped (no cold re-download after update).
 */
async function widenRowKinds(connection: ReplicaSqliteConnection): Promise<void> {
  const table = await connection.all<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rows'",
  );
  if (!table[0] || table[0].sql.includes("'body'")) return;
  await connection.transaction(async (transaction) => {
    await transaction.exec("ALTER TABLE rows RENAME TO rows_before_body");
    await transaction.exec(CREATE_ROWS_SQL);
    await transaction.exec(
      "INSERT INTO rows (server_id, kind, id, payload, bytes, touched_at) SELECT server_id, kind, id, payload, bytes, touched_at FROM rows_before_body",
    );
    await transaction.exec("DROP TABLE rows_before_body");
  });
}

interface StoredMeta {
  value: string;
}

interface StoredIndexRow {
  server_id: string;
  kind: ReplicaRow["kind"];
  id: string;
  bytes: number;
  touched_at: number;
}

/** UTF-8 size without materialising a byte array (the Buffer polyfill does on Hermes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

interface StoredRow {
  server_id: string;
  kind: ReplicaRow["kind"];
  id: string;
  payload: string;
}

export function createSqliteReplicaRowStore(
  driver: ReplicaSqliteDriver,
  schemaVersion: number,
): ReplicaRowStore {
  let connection: ReplicaSqliteConnection | null = null;
  let opening: Promise<void> | null = null;

  function getConnection(): ReplicaSqliteConnection {
    if (!connection) {
      throw new Error("Replica row store has not been opened");
    }
    return connection;
  }

  async function open(): Promise<void> {
    opening ??= (async () => {
      const openedConnection = await driver.open();
      await openedConnection.exec(CREATE_META_SQL);
      const storedMeta = await openedConnection.all<StoredMeta>(
        "SELECT value FROM meta WHERE key = ?",
        ["schema_version"],
      );

      if (storedMeta[0]?.value !== String(schemaVersion)) {
        await openedConnection.transaction(async (transaction) => {
          await transaction.exec("DROP TABLE IF EXISTS rows");
          await transaction.exec(CREATE_ROWS_SQL);
          await transaction.run("DELETE FROM meta");
          await transaction.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
            "schema_version",
            String(schemaVersion),
          ]);
        });
      } else {
        await openedConnection.exec(CREATE_ROWS_SQL);
        await widenRowKinds(openedConnection);
      }

      connection = openedConnection;
    })();

    try {
      await opening;
    } catch (error) {
      opening = null;
      throw error;
    }
  }

  async function readAll(): Promise<ReplicaHostRows[]> {
    const storedRows = await getConnection().all<StoredRow>(
      "SELECT server_id, kind, id, payload FROM rows ORDER BY server_id, kind, id",
    );
    const hosts = new Map<string, ReplicaRow[]>();
    for (const storedRow of storedRows) {
      const rows = hosts.get(storedRow.server_id) ?? [];
      rows.push({
        serverId: storedRow.server_id,
        kind: storedRow.kind,
        id: storedRow.id,
        payload: storedRow.payload,
      });
      hosts.set(storedRow.server_id, rows);
    }
    return Array.from(hosts, ([serverId, rows]) => ({ serverId, rows }));
  }

  async function readIndex(): Promise<ReplicaRowIndexEntry[]> {
    const rows = await getConnection().all<StoredIndexRow>(
      "SELECT server_id, kind, id, bytes, touched_at FROM rows",
    );
    return rows.map((row) => ({
      serverId: row.server_id,
      kind: row.kind,
      id: row.id,
      bytes: row.bytes,
      touchedAt: row.touched_at,
    }));
  }

  async function touch(keys: readonly ReplicaRowKey[], at: number): Promise<void> {
    if (keys.length === 0) return;
    await getConnection().transaction(async (transaction) => {
      for (const key of keys) {
        await transaction.run(
          "UPDATE rows SET touched_at = ? WHERE server_id = ? AND kind = ? AND id = ?",
          [at, key.serverId, key.kind, key.id],
        );
      }
    });
  }

  async function read(
    serverId: string,
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    if (kinds.length === 0 || ids?.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(", ");
    const idClause = ids ? ` AND id IN (${ids.map(() => "?").join(", ")})` : "";
    const storedRows = await getConnection().all<StoredRow>(
      `SELECT server_id, kind, id, payload FROM rows
       WHERE server_id = ? AND kind IN (${placeholders})${idClause}
       ORDER BY kind, id`,
      [serverId, ...kinds, ...(ids ?? [])],
    );
    return storedRows.map((row) => ({
      serverId: row.server_id,
      kind: row.kind,
      id: row.id,
      payload: row.payload,
    }));
  }

  async function apply(changes: ReplicaRowChanges): Promise<void> {
    await getConnection().transaction(async (transaction) => {
      for (const key of changes.deletes) {
        await transaction.run("DELETE FROM rows WHERE server_id = ? AND kind = ? AND id = ?", [
          key.serverId,
          key.kind,
          key.id,
        ]);
      }
      const now = Date.now();
      for (const row of changes.upserts) {
        await transaction.run(
          `INSERT INTO rows (server_id, kind, id, payload, bytes, touched_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (server_id, kind, id) DO UPDATE SET payload = excluded.payload,
             bytes = excluded.bytes, touched_at = excluded.touched_at`,
          [row.serverId, row.kind, row.id, row.payload, utf8ByteLength(row.payload), now],
        );
      }
    });
  }

  async function deleteHost(serverId: string): Promise<void> {
    await getConnection().run("DELETE FROM rows WHERE server_id = ?", [serverId]);
  }

  async function renameHost(oldServerId: string, newServerId: string): Promise<void> {
    if (oldServerId === newServerId) return;
    await getConnection().transaction(async (transaction) => {
      await transaction.run(
        `INSERT INTO rows (server_id, kind, id, payload, bytes, touched_at)
         SELECT ?, kind, id, payload, bytes, touched_at FROM rows WHERE server_id = ?
         ON CONFLICT (server_id, kind, id) DO UPDATE SET payload = excluded.payload,
           bytes = excluded.bytes, touched_at = excluded.touched_at`,
        [newServerId, oldServerId],
      );
      await transaction.run("DELETE FROM rows WHERE server_id = ?", [oldServerId]);
    });
  }

  async function clear(): Promise<void> {
    await getConnection().run("DELETE FROM rows");
  }

  return { open, read, readAll, readIndex, touch, apply, deleteHost, renameHost, clear };
}
