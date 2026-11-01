import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWSOutboundMessage as validateAot } from "../../src/validation/ws-outbound.js";
import { validateWSOutboundMessage as validateNode } from "../../src/validation/ws-outbound-node.js";

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const envelopes: Array<[string, unknown]> = [
  ["pong", { type: "pong" }],
  ["unknown type", { type: "not_a_message" }],
  [
    "agent stream with defaults",
    {
      type: "session",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "timeline",
            provider: "codex",
            item: { type: "assistant_message", text: "hello" },
          },
        },
      },
    },
  ],
  [
    "attention required",
    {
      type: "session",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: { title: "Agent finished", body: "Done", data: { agentId: "agent-1" } },
        },
      },
    },
  ],
  [
    "corrupted session payload",
    { type: "session", message: { type: "agent_stream", payload: { agentId: 7 } } },
  ],
];

describe("Node WS outbound validator", () => {
  it.each(envelopes)("agrees with the AOT validator: %s", (_name, envelope) => {
    const aot = validateAot(structuredClone(envelope));
    const node = validateNode(structuredClone(envelope));
    expect(node.success).toBe(aot.success);
    if (aot.success && node.success) expect(node.data).toEqual(aot.data);
  });

  it("is what Node resolves for the package subpath; other runtimes keep the AOT build", () => {
    const manifest = JSON.parse(readFileSync(resolve(protocolRoot, "package.json"), "utf8"));
    const entry = manifest.exports["./validation/ws-outbound"];
    expect(Object.keys(entry)).toEqual(["types", "node", "default"]);
    expect(entry.node).toBe("./dist/validation/ws-outbound-node.js");
    expect(entry.default).toBe("./dist/validation/ws-outbound.js");
  });
});
