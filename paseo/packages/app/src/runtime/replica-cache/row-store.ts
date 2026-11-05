export { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

export type ReplicaRowKind =
  | "agent"
  | "workspace"
  | "project"
  | "timeline"
  | "timeline_page"
  | "checkpoint";

export interface ReplicaRowKey {
  serverId: string;
  kind: ReplicaRowKind;
  id: string;
}

export interface ReplicaRow extends ReplicaRowKey {
  payload: string;
}

export interface ReplicaRowChanges {
  upserts: ReplicaRow[];
  deletes: ReplicaRowKey[];
}

export interface ReplicaHostRows {
  serverId: string;
  rows: ReplicaRow[];
}

/** A stored row without its payload: what the cache keeps in memory for budgeting and eviction. */
export interface ReplicaRowIndexEntry extends ReplicaRowKey {
  bytes: number;
  /** Last write or read that touched the row (ms since epoch); drives LRU eviction. */
  touchedAt: number;
}

export interface ReplicaRowStore {
  open(): Promise<void>;
  read(
    serverId: string,
    kinds: readonly ReplicaRowKind[],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]>;
  readAll(): Promise<ReplicaHostRows[]>;
  /** Keys, sizes and access times of every row, without payloads. */
  readIndex(): Promise<ReplicaRowIndexEntry[]>;
  /** Marks rows as recently used. */
  touch(keys: readonly ReplicaRowKey[], at: number): Promise<void>;
  apply(changes: ReplicaRowChanges): Promise<void>;
  deleteHost(serverId: string): Promise<void>;
  renameHost(oldServerId: string, newServerId: string): Promise<void>;
  clear(): Promise<void>;
}
