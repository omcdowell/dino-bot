import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  CompactV2Decoder,
  createMemoryFeatureCache,
  encodeCompactV2,
} from "@getpaseo/protocol/compact-v2";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/messages";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";

/**
 * compact_v2: what the app builds from a decoded message (agent rows, workspace descriptors,
 * timeline entries) equals what it builds from today's message. Messages are the DB1 captures
 * (565382b B1b and 409927f slim) kept in packages/protocol.
 */
const FIXTURE = path.resolve(
  __dirname,
  "../../../../protocol/src/__fixtures__/compact-v2-db1-messages.json",
);
type Msg = Record<string, unknown>;
const captured = (JSON.parse(readFileSync(FIXTURE, "utf8")) as Array<{ message: Msg }>)
  .flatMap(({ message }) => (message.type === "batch" ? (message.m as Msg[]) : [message]))
  .filter((message) => message.type === "session");

const hashFeatures = (features: unknown) =>
  createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 16);

function roundTrip(message: Msg): Msg {
  const decoder = new CompactV2Decoder(createMemoryFeatureCache());
  decoder.decode(
    encodeCompactV2(
      { type: "session", message: { type: "status", payload: { status: "server_info", serverId: "s", features: {} } } },
      { state: { knownFeaturesHash: null }, hashFeatures },
    ),
  );
  const wire = JSON.stringify(
    encodeCompactV2(message, { state: { knownFeaturesHash: null }, hashFeatures }),
  );
  return decoder.decode(JSON.parse(wire)) as Msg;
}

const parse = (message: Msg) => {
  const parsed = WSOutboundMessageSchema.parse(message);
  if (parsed.type !== "session") throw new Error("not a session message");
  return parsed.message;
};

describe("compact_v2 decode as the app sees it", () => {
  test("sidebar agent rows normalize identically", () => {
    let rows = 0;
    for (const message of captured) {
      const before = parse(message);
      if (before.type !== "fetch_agents_response") continue;
      const after = parse(roundTrip(message));
      if (after.type !== "fetch_agents_response") throw new Error("type changed");
      expect(after.payload.entries.length).toBe(before.payload.entries.length);
      before.payload.entries.forEach((entry, index) => {
        const decoded = after.payload.entries[index]!;
        expect(normalizeAgentSnapshot(decoded.agent, "srv")).toEqual(
          normalizeAgentSnapshot(entry.agent, "srv"),
        );
        expect(decoded.project).toEqual(entry.project);
        rows += 1;
      });
    }
    expect(rows).toBeGreaterThan(20);
  });

  test("workspace descriptors normalize identically", () => {
    let rows = 0;
    for (const message of captured) {
      const before = parse(message);
      if (before.type !== "fetch_workspaces_response" && before.type !== "workspace_update") continue;
      const after = parse(roundTrip(message));
      const list = (m: ReturnType<typeof parse>) =>
        m.type === "fetch_workspaces_response"
          ? m.payload.entries
          : m.type === "workspace_update" && m.payload.kind === "upsert"
            ? [m.payload.workspace]
            : [];
      const original = list(before);
      const decoded = list(after);
      expect(decoded.length).toBe(original.length);
      original.forEach((workspace, index) => {
        expect(normalizeWorkspaceDescriptor(decoded[index]!)).toEqual(
          normalizeWorkspaceDescriptor(workspace),
        );
        rows += 1;
      });
    }
    expect(rows).toBeGreaterThan(10);
  });

  test("timeline entries and live stream events are identical apart from the paseoCompact marker contents", () => {
    let rows = 0;
    const marker = (value: unknown) =>
      JSON.parse(JSON.stringify(value), (key, inner) => (key === "paseoCompact" ? {} : inner));
    for (const message of captured) {
      const before = parse(message);
      if (before.type === "fetch_agent_timeline_response") {
        const after = parse(roundTrip(message));
        if (after.type !== "fetch_agent_timeline_response") throw new Error("type changed");
        expect(after.payload.entries).toEqual(marker(before.payload.entries));
        expect(after.payload.agent).toEqual(before.payload.direction === "tail" ? before.payload.agent : null);
        rows += after.payload.entries.length;
      }
      if (before.type === "agent_stream") {
        expect(parse(roundTrip(message))).toEqual(marker(before));
        rows += 1;
      }
    }
    expect(rows).toBeGreaterThan(30);
  });
});
