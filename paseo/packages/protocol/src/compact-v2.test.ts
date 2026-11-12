import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CompactV2Decoder,
  createMemoryFeatureCache,
  encodeCompactV2,
  type CompactV2EncodeContext,
} from "./compact-v2.js";
import { WSOutboundMessageSchema } from "./messages.js";

// One message of each type and phase from the DB1 captures (cap-b1b: 565382b B1b client;
// cap-slim: 409927f slim directory), long strings cut to 160 chars, pages cut to 12 rows.
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "compact-v2-db1-messages.json",
);
const captured = JSON.parse(readFileSync(FIXTURE, "utf8")) as Array<{
  label: string;
  phase: string;
  message: Record<string, unknown>;
}>;

const hashFeatures = (features: unknown) =>
  createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 16);
const context = (known: string | null = null): CompactV2EncodeContext => ({
  state: { knownFeaturesHash: known },
  hashFeatures,
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const session = (type: string, payload: Record<string, unknown>) => ({
  type: "session",
  message: { type, payload },
});
const statusOf = (features: Record<string, unknown>) =>
  session("status", {
    status: "server_info",
    serverId: "srv_1",
    permissions: ["daemon.read"],
    features,
  });

/** What the app may legitimately see differ from the uncompacted message (all unread). */
function expectedAfterRoundTrip(message: Record<string, unknown>): unknown {
  const out = clone(message);
  const inner = (out.message ?? out) as { type: string; payload: Record<string, unknown> };
  const p = inner.payload;
  if (inner.type === "status") delete p.permissions;
  const items: Array<Record<string, unknown>> = [];
  if (inner.type === "fetch_agent_timeline_response") {
    if (p.direction !== "tail") p.agent = null;
    for (const row of p.entries as Array<Record<string, unknown>>) items.push(row.item as never);
  }
  if (inner.type === "agent_stream") {
    const event = p.event as Record<string, unknown> | undefined;
    if (event?.item) items.push(event.item as never);
  }
  for (const item of items) {
    const metadata = item.metadata as Record<string, unknown> | undefined;
    if (metadata?.paseoCompact) metadata.paseoCompact = {};
  }
  return out;
}

function decodeArmed(decoder: CompactV2Decoder, message: unknown): unknown {
  return decoder.decode(clone(message));
}

function armedDecoder(): CompactV2Decoder {
  const decoder = new CompactV2Decoder(createMemoryFeatureCache());
  const ctx = context();
  decoder.decode(clone(encodeCompactV2(statusOf({ a: true }), ctx)));
  expect(decoder.armed).toBe(true);
  return decoder;
}

/** Key order is not part of the contract; compare canonical JSON. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}

describe("compact_v2 round trip on DB1 captures", () => {
  it("decode(encode(m)) equals m (modulo unread fields) for every captured message", () => {
    let changed = 0;
    for (const { label, phase, message } of captured) {
      const decoder = armedDecoder();
      const ctx = context();
      const original = clone(message);
      const items = message.type === "batch" ? (message.m as Array<Record<string, unknown>>) : [message];
      for (const item of items) {
        const encoded = encodeCompactV2(item, ctx);
        expect(item, "encoder must not mutate").toEqual(
          (original.type === "batch" ? (original.m as unknown[])[items.indexOf(item)] : original) as never,
        );
        if (JSON.stringify(encoded) !== JSON.stringify(item)) changed += 1;
        const decoded = decodeArmed(decoder, JSON.parse(JSON.stringify(encoded)));
        expect(canonical(decoded), `${label} ${phase}`).toEqual(canonical(expectedAfterRoundTrip(item)));
      }
    }
    expect(changed).toBeGreaterThan(20);
  });

  it("decoded messages pass the outbound schema exactly like the originals", () => {
    for (const { message } of captured) {
      const items = message.type === "batch" ? (message.m as Array<Record<string, unknown>>) : [message];
      for (const item of items) {
        const before = WSOutboundMessageSchema.safeParse(item);
        if (!before.success) continue;
        const decoder = armedDecoder();
        const decoded = decodeArmed(decoder, JSON.parse(JSON.stringify(encodeCompactV2(item, context()))));
        const after = WSOutboundMessageSchema.safeParse(decoded);
        expect(after.success).toBe(true);
        expect(canonical(after.data)).toEqual(
          canonical(WSOutboundMessageSchema.parse(expectedAfterRoundTrip(item))),
        );
      }
    }
  });

  it("is smaller on the wire for every directory and timeline message", () => {
    for (const { message } of captured) {
      const inner = (message.message ?? message) as { type: string };
      if (!/fetch_agents_response|fetch_workspaces_response|fetch_agent_timeline_response|status/.test(inner.type))
        continue;
      const encoded = JSON.stringify(encodeCompactV2(message, context()));
      expect(encoded.length).toBeLessThan(JSON.stringify(message).length);
    }
  });
});

describe("compact_v2 A1 status features", () => {
  const features = { slimDirectory: true, directorySync: true, rewind: true };

  it("sends the map once with its hash, then only the hash", () => {
    const ctx = context();
    const first = encodeCompactV2(statusOf(features), ctx) as ReturnType<typeof statusOf>;
    expect(first.message.payload.features).toEqual(features);
    expect(first.message.payload).not.toHaveProperty("permissions");
    const fh = (first.message.payload as Record<string, unknown>).fh;
    expect(typeof fh).toBe("string");
    const second = encodeCompactV2(statusOf(features), ctx) as ReturnType<typeof statusOf>;
    expect(second.message.payload).not.toHaveProperty("features");
    expect((second.message.payload as Record<string, unknown>).fh).toBe(fh);
  });

  it("sends only the hash when the hello presented the current hash, and the app restores the map", () => {
    const cache = createMemoryFeatureCache();
    const decoder = new CompactV2Decoder(cache);
    decoder.decode(clone(encodeCompactV2(statusOf(features), context())));
    const presented = decoder.cachedFeaturesHash();
    expect(presented).toBe(hashFeatures(features));

    const reconnect = encodeCompactV2(statusOf(features), context(presented));
    expect(JSON.stringify(reconnect)).not.toContain("slimDirectory");
    decoder.reset();
    const decoded = decoder.decode(clone(reconnect)) as ReturnType<typeof statusOf>;
    expect(decoded.message.payload.features).toEqual(features);
    expect(decoded.message.payload).not.toHaveProperty("fh");
    expect(decoded.message.payload).not.toHaveProperty("cv2");
  });

  it("sends the full map again when the features changed", () => {
    const changed = { ...features, newThing: true };
    const out = encodeCompactV2(statusOf(changed), context(hashFeatures(features))) as ReturnType<
      typeof statusOf
    >;
    expect(out.message.payload.features).toEqual(changed);
  });
});

describe("compact_v2 decoder arming", () => {
  it("leaves messages from a daemon without compact_v2 untouched", () => {
    const decoder = new CompactV2Decoder(createMemoryFeatureCache());
    const legacy = statusOf({ a: true });
    expect(decoder.decode(clone(legacy))).toEqual(legacy);
    expect(decoder.armed).toBe(false);
    const page = session("fetch_agent_timeline_response", {
      agentId: "a",
      direction: "before",
      entries: [{ seqStart: 1, item: { type: "assistant_message", text: "x" } }],
    });
    expect(decoder.decode(clone(page))).toEqual(page);
  });

  it("disarms on reset (new socket)", () => {
    const decoder = armedDecoder();
    decoder.reset();
    expect(decoder.armed).toBe(false);
  });
});

describe("compact_v2 rules", () => {
  it("A4 trims a timeline row to what differs from its defaults", () => {
    const row = {
      provider: "codex",
      item: {
        type: "tool_call",
        callId: "c1",
        name: "execute",
        detail: { type: "shell", command: "ls" },
        metadata: { kind: "execute", title: "List", paseoCompact: { short: true, bodyHash: "abc" } },
        status: "completed",
        error: null,
      },
      timestamp: "2026-11-11T15:50:11.737Z",
      seqStart: 42,
      seqEnd: 42,
      sourceSeqRanges: [{ startSeq: 42, endSeq: 42 }],
      turnId: "t",
      collapsed: [],
    };
    const page = session("fetch_agent_timeline_response", {
      agentId: "a",
      agent: { id: "a" },
      direction: "before",
      entries: [row],
      error: null,
      reset: false,
    });
    const encoded = encodeCompactV2(page, context()) as typeof page;
    expect(encoded.message.payload).not.toHaveProperty("agent");
    expect(encoded.message.payload.entries[0]).toEqual({
      item: {
        type: "tool_call",
        callId: "c1",
        name: "execute",
        detail: { command: "ls" },
        metadata: { title: "List", paseoCompact: 1 },
        status: "completed",
        error: null,
      },
      timestamp: Date.parse("2026-11-11T15:50:11.737Z"),
      seqStart: 42,
      turnId: "t",
    });
    const decoded = armedDecoder().decode(clone(encoded)) as typeof page;
    expect(decoded.message.payload.entries[0]).toEqual({
      ...row,
      item: { ...row.item, metadata: { ...row.item.metadata, paseoCompact: {} } },
    });
    expect(decoded.message.payload.agent).toBeNull();
  });

  it("A4 keeps a tool row without metadata.kind lossless", () => {
    const stream = session("agent_stream", {
      agentId: "a",
      timestamp: "2026-11-11T15:50:11.737Z",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "tool_call", callId: "c", name: "Read", detail: { type: "read" }, metadata: { title: "x" } },
      },
    });
    const decoded = armedDecoder().decode(clone(encodeCompactV2(stream, context())));
    expect(decoded).toEqual(stream);
  });

  it("A7 keeps timestamps that are not exact millisecond ISO strings", () => {
    const update = session("agent_patch", {
      agentId: "a",
      set: { updatedAt: "2026-11-11T15:50:11Z", lastUserMessageAt: "2026-11-11T15:50:11.737Z", title: null },
    });
    const encoded = encodeCompactV2(update, context()) as typeof update;
    expect(encoded.message.payload.set.updatedAt).toBe("2026-11-11T15:50:11Z");
    expect(typeof encoded.message.payload.set.lastUserMessageAt).toBe("number");
    expect(encoded.message.payload.set.title).toBeNull();
    expect(armedDecoder().decode(clone(encoded))).toEqual(update);
  });

  it("A3 restores workspace paths from workspaceDirectory and a git worktreeRoot stays absent", () => {
    const workspace = {
      id: "w",
      projectCustomName: null,
      projectCustomIconRevision: null,
      title: null,
      pinnedAt: null,
      archivingAt: null,
      statusEnteredAt: "2026-11-11T15:50:11.737Z",
      activityAt: null,
      diffStat: null,
      background: false,
      internal: false,
      scripts: [],
      projectRootPath: "/r",
      workspaceDirectory: "/r",
      status: "done",
      project: {
        projectKey: "p",
        projectName: "p",
        workspaceName: null,
        checkout: {
          cwd: "/r",
          isGit: true,
          currentBranch: "main",
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      },
    };
    const message = session("workspace_update", { kind: "upsert", workspace });
    const encoded = encodeCompactV2(message, context());
    expect(JSON.stringify(encoded).match(/\/r/g)?.length).toBe(1);
    expect(armedDecoder().decode(clone(encoded))).toEqual(message);
  });
});
