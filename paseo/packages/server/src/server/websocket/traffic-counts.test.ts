import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapSessionMessage } from "../messages.js";
import { WebSocketRuntimeMetricsWindow } from "./runtime-metrics.js";
import { TRAFFIC_COUNTS_FILE, TrafficCounts } from "./traffic-counts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(maxBytes?: number) {
  const home = mkdtempSync(join(tmpdir(), "traffic-counts-"));
  dirs.push(home);
  let now = Date.parse("2026-11-20T10:00:00.000Z");
  const file = join(home, TRAFFIC_COUNTS_FILE);
  const traffic = new TrafficCounts(file, () => now, maxBytes);
  const metrics = new WebSocketRuntimeMetricsWindow(() => now, traffic);
  return {
    file,
    traffic,
    metrics,
    advance(ms: number) {
      now += ms;
    },
    lines(path = file) {
      return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

describe("TrafficCounts", () => {
  it("keeps every type by direction after the runtime window resets, and appends one line per flush", () => {
    const { file, metrics, traffic, advance, lines } = setup();
    // More than the 20 types the runtime snapshot keeps.
    for (let i = 0; i < 30; i += 1) metrics.recordInboundSessionRequest(`type_${i}`);
    metrics.recordInboundSessionRequest("type_0");
    metrics.recordInboundMessage("ping");
    metrics.recordOutboundMessage({ type: "pong" });
    metrics.recordOutboundMessage(
      wrapSessionMessage({
        type: "agent_stream",
        payload: {
          agentId: "agent-secret-id",
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "assistant_message", text: "private words" },
          },
          timestamp: "2026-11-20T10:00:00.000Z",
        },
      }),
    );
    metrics.recordOutboundBinaryFrame();
    metrics.snapshotAndReset();
    advance(60 * 60 * 1000);

    traffic.flush();
    metrics.recordInboundMessage("ping");
    advance(5_000);
    traffic.flush({ final: true });

    const [first, second] = lines();
    expect(first.from).toBe("2026-11-20T10:00:00.000Z");
    expect(first.to).toBe("2026-11-20T11:00:00.000Z");
    expect(first.final).toBe(false);
    expect(Object.keys(first.inSession)).toHaveLength(30);
    expect(first.inSession.type_0).toBe(2);
    expect(first.in).toEqual({ ping: 1 });
    expect(first.out).toEqual({ pong: 1, session_message: 1 });
    expect(first.outSession).toEqual({ agent_stream: 1 });
    expect(first.outStream).toEqual({ "timeline:assistant_message": 1 });
    expect(first.outBinary).toEqual({ binary: 1 });
    expect(second).toMatchObject({ from: first.to, final: true, in: { ping: 1 }, inSession: {} });

    // No contents or ids.
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("agent-secret-id");
    expect(raw).not.toContain("private words");
  });

  it("moves a full file to traffic.1.jsonl before appending", () => {
    const { file, traffic, lines } = setup(100);
    traffic.flush();
    writeFileSync(file, `${"x".repeat(200)}\n`);
    traffic.record("in", "hello");
    traffic.flush();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].in).toEqual({ hello: 1 });
    expect(statSync(file.replace(/\.jsonl$/, ".1.jsonl")).size).toBe(201);
  });
});
