import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { ReplicaCache } from ".";
import { REPLICA_ROW_STORE_SCHEMA_VERSION } from "./row-store-schema";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type SqliteValue,
} from "./row-store-sqlite";

// Run with PASEO_CACHE_BENCH=1 (optionally PASEO_CACHE_BENCH_MB=500, PASEO_CACHE_BENCH_DIR=...).
// Fills a file-backed SQLite cache to the requested size with realistic bot chats, then measures
// what a cold start pays: loading the row index, reading one chat head, paging one sealed page.
const enabled = process.env.PASEO_CACHE_BENCH === "1";
const targetMb = Number(process.env.PASEO_CACHE_BENCH_MB ?? "100");
const SERVER_ID = "bench-host";

function openConnection(file: string): { connection: ReplicaSqliteConnection; close(): void } {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL");
  const connection: ReplicaSqliteConnection = {
    async exec(sql) {
      database.exec(sql);
    },
    async run(sql, params = []) {
      database.prepare(sql).run(...params);
    },
    async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
      return database.prepare(sql).all(...params) as Row[];
    },
    async transaction(operation) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await operation(connection);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { connection, close: () => database.close() };
}

function chat(agentId: string, count: number): StreamItem[] {
  const output = "line of tool output from a bot run\n".repeat(60);
  return Array.from({ length: count }, (_, index): StreamItem => {
    const seq = index + 1;
    const timelineCursor = { epoch: "epoch-1", seq };
    const timestamp = new Date(1_760_000_000_000 + seq * 1000);
    if (seq % 10 === 1) {
      return {
        kind: "user_message",
        id: `${agentId}-u${seq}`,
        text: `do ${seq}`,
        timestamp,
        timelineCursor,
      };
    }
    if (seq % 2 === 0) {
      return {
        kind: "tool_call",
        id: `${agentId}-t${seq}`,
        timestamp,
        timelineCursor,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: `${agentId}-c${seq}`,
            name: "Bash",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "npm test", output },
          },
        },
      } as StreamItem;
    }
    return {
      kind: "assistant_message",
      id: `${agentId}-a${seq}`,
      text: `Reply ${seq} `.repeat(40),
      timestamp,
      timelineCursor,
    };
  });
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

describe.runIf(enabled)("large chat cache", () => {
  it(
    `cold start stays flat at ${targetMb} MB`,
    async () => {
      const dir = mkdtempSync(
        path.join(process.env.PASEO_CACHE_BENCH_DIR ?? tmpdir(), "paseo-cache-"),
      );
      const file = path.join(dir, "replica.db");
      const maxBytes = 600 * 1024 * 1024;
      try {
        const writerDb = openConnection(file);
        const writer = new ReplicaCache(
          createSqliteReplicaRowStore(
            { open: async () => writerDb.connection },
            REPLICA_ROW_STORE_SCHEMA_VERSION,
          ),
          { clearLegacyCache: async () => undefined, maxBytes },
        );
        writer.setHosts([SERVER_ID]);
        const itemsPerChat = 2000;
        let agents = 0;
        while (true) {
          await writer.flush();
          if (writer.storedBytes() >= targetMb * 1024 * 1024) break;
          const agentId = `agent-${agents++}`;
          const items = chat(agentId, itemsPerChat);
          writer.commitTimeline(SERVER_ID, agentId, {
            agentId,
            items,
            range: { epoch: "epoch-1", startSeq: 1, endSeq: itemsPerChat },
            hasOlder: false,
          });
        }
        const storedMb = Math.round(writer.storedBytes() / 1024 / 1024);
        writerDb.close();

        const readerDb = openConnection(file);
        const reader = new ReplicaCache(
          createSqliteReplicaRowStore(
            { open: async () => readerDb.connection },
            REPLICA_ROW_STORE_SCHEMA_VERSION,
          ),
          { clearLegacyCache: async () => undefined, maxBytes },
        );
        reader.setHosts([SERVER_ID]);
        const heapBefore = process.memoryUsage().heapUsed;
        const firstHead = await timed(() => reader.readTimeline(SERVER_ID, "agent-0"));
        const heapAfter = process.memoryUsage().heapUsed;
        const secondHead = await timed(() => reader.readTimeline(SERVER_ID, `agent-${agents - 1}`));
        const page = await timed(() =>
          reader.readTimelinePageBefore(SERVER_ID, "agent-0", {
            epoch: "epoch-1",
            beforeSeq: firstHead.value?.range?.startSeq ?? 0,
          }),
        );
        const pageSamples: number[] = [];
        for (let index = 1; index <= 9; index += 1) {
          const agentId = `agent-${Math.floor((index * agents) / 10)}`;
          const head = await reader.readTimeline(SERVER_ID, agentId);
          const sample = await timed(() =>
            reader.readTimelinePageBefore(SERVER_ID, agentId, {
              epoch: "epoch-1",
              beforeSeq: head?.range?.startSeq ?? 0,
            }),
          );
          pageSamples.push(sample.ms);
        }
        pageSamples.sort((left, right) => left - right);
        readerDb.close();
        const result = {
          olderPageMedianMs: pageSamples[4],
          olderPageMaxMs: pageSamples[8],
          targetMb,
          storedMb,
          chats: agents,
          itemsPerChat,
          headItems: firstHead.value?.items.length,
          coldOpenAndIndexAndHeadMs: firstHead.ms,
          heapGrowthMb: Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 10) / 10,
          warmHeadMs: secondHead.ms,
          olderPageMs: page.ms,
          olderPageItems: page.value?.items.length,
        };
        appendFileSync(
          process.env.PASEO_CACHE_BENCH_OUT ?? path.join(tmpdir(), "paseo-cache-bench.jsonl"),
          `${JSON.stringify(result)}\n`,
        );
        expect(firstHead.value?.items.length).toBeGreaterThan(0);
        expect(page.value?.items.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30 * 60_000,
  );
});
