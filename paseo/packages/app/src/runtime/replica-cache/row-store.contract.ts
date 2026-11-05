import { beforeEach, describe, expect, it } from "vitest";
import type { ReplicaRow, ReplicaRowStore } from "./row-store";

export interface ReplicaRowStoreHarness {
  store: ReplicaRowStore;
  openWithSchemaVersion(schemaVersion: number): Promise<ReplicaRowStore>;
}

export type CreateReplicaRowStoreHarness = () => Promise<ReplicaRowStoreHarness>;

function row(serverId: string, kind: ReplicaRow["kind"], id: string, payload: string): ReplicaRow {
  return { serverId, kind, id, payload };
}

export function runReplicaRowStoreContract(
  engineName: string,
  createHarness: CreateReplicaRowStoreHarness,
): void {
  describe(`${engineName} replica row store`, () => {
    let harness: ReplicaRowStoreHarness;
    let store: ReplicaRowStore;

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
      await store.open();
    });

    it("reads an empty store", async () => {
      expect(await store.readAll()).toEqual([]);
    });

    it("round-trips opaque payloads grouped by server", async () => {
      await store.apply({
        upserts: [
          row("server-b", "checkpoint", "singleton", '{"cursor":2}'),
          row("server-a", "agent", "agent-1", '{"status":"running"}'),
          row("server-a", "timeline", "singleton", "not parsed by the row store"),
        ],
        deletes: [],
      });

      expect(await store.readAll()).toEqual([
        {
          serverId: "server-a",
          rows: [
            row("server-a", "agent", "agent-1", '{"status":"running"}'),
            row("server-a", "timeline", "singleton", "not parsed by the row store"),
          ],
        },
        {
          serverId: "server-b",
          rows: [row("server-b", "checkpoint", "singleton", '{"cursor":2}')],
        },
      ]);
    });

    it("reads only requested kinds for one host", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "agent"),
          row("server-a", "timeline", "singleton", "timeline"),
          row("server-b", "agent", "agent-2", "other host"),
        ],
        deletes: [],
      });

      expect(await store.read("server-a", ["timeline"])).toEqual([
        row("server-a", "timeline", "singleton", "timeline"),
      ]);
      expect(await store.read("server-a", ["agent"], ["missing"])).toEqual([]);
    });

    it("overwrites an existing row on upsert", async () => {
      await store.apply({
        upserts: [row("server-a", "agent", "agent-1", "old")],
        deletes: [],
      });
      await store.apply({
        upserts: [row("server-a", "agent", "agent-1", "new")],
        deletes: [],
      });

      expect(await store.readAll()).toEqual([
        {
          serverId: "server-a",
          rows: [row("server-a", "agent", "agent-1", "new")],
        },
      ]);
    });

    it("deletes one row by its compound identity", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "same-id", "agent"),
          row("server-a", "workspace", "same-id", "workspace"),
        ],
        deletes: [],
      });
      await store.apply({
        upserts: [],
        deletes: [{ serverId: "server-a", kind: "agent", id: "same-id" }],
      });

      expect(await store.readAll()).toEqual([
        {
          serverId: "server-a",
          rows: [row("server-a", "workspace", "same-id", "workspace")],
        },
      ]);
    });

    it("rolls back the entire apply when one write fails", async () => {
      const invalidRow = {
        ...row("server-a", "agent", "invalid", "invalid"),
        serverId: undefined,
      } as unknown as ReplicaRow;

      await expect(
        store.apply({
          upserts: [row("server-a", "agent", "would-have-been-written", "payload"), invalidRow],
          deletes: [],
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await store.readAll()).toEqual([]);
    });

    it("deletes every row belonging to one host", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "a"),
          row("server-a", "project", "project-1", "p"),
          row("server-b", "agent", "agent-2", "b"),
        ],
        deletes: [],
      });

      await store.deleteHost("server-a");

      expect(await store.readAll()).toEqual([
        { serverId: "server-b", rows: [row("server-b", "agent", "agent-2", "b")] },
      ]);
    });

    it("renames a host and lets moved rows replace target collisions", async () => {
      await store.apply({
        upserts: [
          row("temporary", "agent", "agent-1", "temporary-agent"),
          row("temporary", "project", "project-1", "temporary-project"),
          row("canonical", "agent", "agent-1", "canonical-agent"),
          row("canonical", "workspace", "workspace-1", "canonical-workspace"),
        ],
        deletes: [],
      });

      await store.renameHost("temporary", "canonical");

      expect(await store.readAll()).toEqual([
        {
          serverId: "canonical",
          rows: [
            row("canonical", "agent", "agent-1", "temporary-agent"),
            row("canonical", "project", "project-1", "temporary-project"),
            row("canonical", "workspace", "workspace-1", "canonical-workspace"),
          ],
        },
      ]);
    });

    it("indexes rows by size and access time without payloads", async () => {
      const before = Date.now();
      await store.apply({
        upserts: [
          row("server-a", "timeline_page", "agent-1|e|1|50", "x".repeat(1000)),
          row("server-a", "timeline", "agent-1", "é"),
        ],
        deletes: [],
      });
      const index = await store.readIndex();
      const page = index.find((entry) => entry.kind === "timeline_page");
      const head = index.find((entry) => entry.kind === "timeline");
      expect(page).toMatchObject({ serverId: "server-a", id: "agent-1|e|1|50", bytes: 1000 });
      expect(head?.bytes).toBe(2);
      expect(page?.touchedAt).toBeGreaterThanOrEqual(before);
      expect(page).not.toHaveProperty("payload");

      await store.touch(
        [{ serverId: "server-a", kind: "timeline_page", id: "agent-1|e|1|50" }],
        42,
      );
      const touched = (await store.readIndex()).find((entry) => entry.kind === "timeline_page");
      expect(touched?.touchedAt).toBe(42);
      expect(await store.read("server-a", ["timeline_page"])).toEqual([
        row("server-a", "timeline_page", "agent-1|e|1|50", "x".repeat(1000)),
      ]);
    });

    it("keeps the index in step with deletes, host deletes, renames and clear", async () => {
      const ids = async () =>
        (await store.readIndex())
          .map((entry) => `${entry.serverId}/${entry.kind}/${entry.id}`)
          .sort();
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "a"),
          row("server-a", "timeline", "agent-1", "t"),
          row("server-b", "agent", "agent-2", "b"),
          row("temporary", "agent", "agent-3", "c"),
        ],
        deletes: [],
      });
      await store.apply({
        upserts: [],
        deletes: [{ serverId: "server-a", kind: "timeline", id: "agent-1" }],
      });
      expect(await ids()).toEqual([
        "server-a/agent/agent-1",
        "server-b/agent/agent-2",
        "temporary/agent/agent-3",
      ]);
      await store.deleteHost("server-b");
      await store.renameHost("temporary", "server-a");
      expect(await ids()).toEqual(["server-a/agent/agent-1", "server-a/agent/agent-3"]);
      await store.clear();
      expect(await store.readIndex()).toEqual([]);

      await store.apply({ upserts: [row("server-a", "agent", "agent-1", "a")], deletes: [] });
      const upgradedStore = await harness.openWithSchemaVersion(2);
      expect(await upgradedStore.readIndex()).toEqual([]);
    });

    it("clears all cached rows", async () => {
      await store.apply({
        upserts: [
          row("server-a", "agent", "agent-1", "a"),
          row("server-b", "agent", "agent-2", "b"),
        ],
        deletes: [],
      });

      await store.clear();

      expect(await store.readAll()).toEqual([]);
    });

    it("wipes cached rows when the schema version changes on open", async () => {
      await store.apply({
        upserts: [row("server-a", "agent", "agent-1", "stale")],
        deletes: [],
      });

      const upgradedStore = await harness.openWithSchemaVersion(2);

      expect(await upgradedStore.readAll()).toEqual([]);
    });
  });
}
