// Bundled by run.mjs and loaded in an Electron window: the desktop app's IndexedDB row store on
// real Chromium storage. One phase per Electron process, so "measure" is a cold start.
import type { ReplicaRow, ReplicaRowStore } from "../../src/runtime/replica-cache/row-store";
import { createIndexedDbReplicaRowStore } from "../../src/runtime/replica-cache/row-store.web";

const DATABASE = "paseo-replica-row-store";
const SERVER = "bench-host";
const PAGES_PER_CHAT = 20;
const PAGE_BYTES = 140_000;
const HEAD_BYTES = 60_000;

function text(seed: number, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let line = 0; size < bytes; line += 1) {
    const value = `{"kind":"tool_call","seq":${seed * 1000 + line},"output":"line ${line} of npm test for ${seed}: ${((seed * 7919 + line * 104729) % 1_000_003).toString(36)} ok"}`;
    lines.push(value);
    size += value.length + 1;
  }
  return lines.join("\n").slice(0, bytes);
}

function store(): ReplicaRowStore {
  return createIndexedDbReplicaRowStore({ databaseName: DATABASE, schemaVersion: 2 });
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

function heapMb(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10 : null;
}

async function fill(targetMb: number) {
  const rows = store();
  await rows.open();
  let bytes = 0;
  let chats = 0;
  const started = performance.now();
  while (bytes < targetMb * 1024 * 1024) {
    const agentId = `agent-${chats}`;
    const upserts: ReplicaRow[] = [
      { serverId: SERVER, kind: "timeline", id: agentId, payload: text(chats, HEAD_BYTES) },
    ];
    for (let page = 0; page < PAGES_PER_CHAT; page += 1) {
      upserts.push({
        serverId: SERVER,
        kind: "timeline_page",
        id: `${agentId}|epoch-1|${page * 100 + 1}|${page * 100 + 100}`,
        payload: text(chats * 100 + page, PAGE_BYTES),
      });
    }
    await rows.apply({ upserts, deletes: [] });
    bytes += HEAD_BYTES + PAGES_PER_CHAT * PAGE_BYTES;
    chats += 1;
  }
  return {
    phase: "fill",
    chats,
    storedMb: Math.round(bytes / 1024 / 1024),
    fillS: Math.round((performance.now() - started) / 100) / 10,
  };
}

async function measure() {
  const rows = store();
  const open = await timed(() => rows.open());
  const heapBefore = heapMb();
  const index = await timed(() => rows.readIndex());
  const heapAfter = heapMb();
  const chats = index.value.filter((entry) => entry.kind === "timeline").length;
  const head = await timed(() => rows.read(SERVER, ["timeline"], [`agent-${chats - 1}`]));
  const pageIds = index.value
    .filter((entry) => entry.id.startsWith("agent-0|"))
    .map((entry) => entry.id);
  const page = await timed(() =>
    rows.read(SERVER, ["timeline_page"], [pageIds[pageIds.length - 1]]),
  );
  const touch = await timed(() =>
    rows.touch([{ serverId: SERVER, kind: "timeline_page", id: pageIds[0] }], Date.now()),
  );
  // What the previous store did at every cold start: walk every stored value once.
  const walk = await timed(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(DATABASE);
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const cursor = request.result.transaction("rows").objectStore("rows").openCursor();
          let walked = 0;
          cursor.addEventListener("error", () => reject(cursor.error));
          cursor.addEventListener("success", () => {
            const current = cursor.result;
            if (!current) {
              request.result.close();
              resolve(walked);
              return;
            }
            walked += (current.value as ReplicaRow).payload.length;
            current.continue();
          });
        });
      }),
  );
  return {
    phase: "measure",
    rows: index.value.length,
    storedMb: Math.round(index.value.reduce((sum, entry) => sum + entry.bytes, 0) / 1024 / 1024),
    openMs: open.ms,
    readIndexMs: index.ms,
    indexHeapGrowthMb:
      heapBefore === null || heapAfter === null
        ? null
        : Math.round((heapAfter - heapBefore) * 10) / 10,
    headReadMs: head.ms,
    headBytes: head.value[0]?.payload.length ?? 0,
    pageReadMs: page.ms,
    pageBytes: page.value[0]?.payload.length ?? 0,
    touchMs: touch.ms,
    oldStyleValueWalkMs: walk.ms,
    oldStyleWalkedMb: Math.round(walk.value / 1024 / 1024),
  };
}

(globalThis as { bench?: unknown }).bench = { fill, measure };
