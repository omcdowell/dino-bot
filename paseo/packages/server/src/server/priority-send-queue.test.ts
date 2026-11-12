import { describe, expect, it } from "vitest";
import { BATCH_MAX_BYTES, PrioritySendQueue, STARVATION_MS, type Lane } from "./priority-send-queue.js";

function harness(options: { pending?: () => number } = {}) {
  const frames: string[] = [];
  let clock = 0;
  let pending = 0;
  const timers: Array<() => void> = [];
  const queue = new PrioritySendQueue({
    pendingBytes: options.pending ?? (() => pending),
    send: (payload) => frames.push(payload),
    now: () => clock,
    schedule: (cb) => {
      timers.push(cb);
      return timers.length;
    },
    cancel: () => {},
  });
  const messages = () =>
    frames.flatMap((frame) => {
      const parsed = JSON.parse(frame) as { type: string; m?: unknown[]; id?: string };
      return parsed.type === "batch" ? (parsed.m as Array<{ id: string }>).map((m) => m.id) : [parsed.id];
    });
  return {
    queue,
    frames,
    messages,
    setPending: (bytes: number) => (pending = bytes),
    advance: (ms: number) => (clock += ms),
    runTimers: () => timers.splice(0).forEach((cb) => cb()),
  };
}
const msg = (id: string, pad = 0) => JSON.stringify({ type: "session", id, pad: "x".repeat(pad) });

describe("PrioritySendQueue", () => {
  it("sends lanes in strict order and coalesces one tick into one batch frame", () => {
    const h = harness();
    h.queue.enqueue(msg("bulk"), 6);
    h.queue.enqueue(msg("other"), 3);
    h.queue.enqueue(msg("open"), 1);
    h.queue.enqueue(msg("dir"), 2);
    h.queue.drain();
    expect(h.messages()).toEqual(["open", "dir", "other", "bulk"]);
    // one frame per lane (a batch never mixes lanes)
    expect(h.frames).toHaveLength(4);
    h.frames.length = 0;
    for (const id of ["a", "b", "c"]) h.queue.enqueue(msg(id), 1);
    h.queue.drain();
    expect(h.frames).toHaveLength(1);
    expect(JSON.parse(h.frames[0]!)).toMatchObject({ type: "batch" });
    expect(h.messages()).toEqual(["a", "b", "c"]);
  });

  it("holds lower lanes above the low watermark but never lane 0", () => {
    const h = harness();
    h.setPending(64 * 1024);
    h.queue.enqueue(msg("bulk"), 6);
    h.queue.enqueue(msg("attention"), 0);
    h.queue.drain();
    expect(h.messages()).toEqual(["attention"]);
    h.queue.enqueue(msg("open"), 1);
    h.queue.drain();
    expect(h.messages()).toEqual(["attention"]);
    h.setPending(0);
    h.runTimers();
    // the open chat overtook the bulk message that was queued first
    expect(h.messages()).toEqual(["attention", "open", "bulk"]);
  });

  it("caps a batch at BATCH_MAX_BYTES", () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) h.queue.enqueue(msg(`m${i}`, 6000), 1);
    h.queue.drain();
    for (const frame of h.frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(BATCH_MAX_BYTES + 64);
    expect(h.messages()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("keeps one domain in one lane: later messages join the earlier lane, promotion moves all", () => {
    const h = harness();
    h.setPending(1e9);
    h.queue.enqueue(msg("a1"), 1, "agent:a");
    h.queue.enqueue(msg("a2"), 3, "agent:a"); // focus moved away: still lane 1 behind a1
    expect(h.queue.laneOfDomain("agent:a")).toBe(1);
    h.queue.enqueue(msg("b1"), 3, "agent:b");
    h.queue.enqueue(msg("x"), 1);
    h.queue.enqueue(msg("b2"), 3, "agent:b");
    h.queue.promote("agent:b", 1);
    h.setPending(0);
    h.queue.drain();
    expect(h.messages()).toEqual(["a1", "a2", "x", "b1", "b2"]);
    expect(h.queue.laneOfDomain("agent:b")).toBeNull();
  });

  it("a higher-lane message in a held domain pulls the whole domain up", () => {
    const h = harness();
    h.setPending(1e9);
    h.queue.enqueue(msg("b1"), 3, "agent:b");
    h.queue.enqueue(msg("o"), 2);
    h.queue.enqueue(msg("b2"), 1, "agent:b");
    h.setPending(0);
    h.queue.drain();
    expect(h.messages()).toEqual(["b1", "b2", "o"]);
  });

  it("starvation guard: a lower lane waiting 250 ms gets one batch while a higher lane keeps the socket busy", () => {
    let pending = 0;
    const h = harness({ pending: () => pending });
    h.queue.enqueue(msg("bulk"), 6);
    // Lane 1 floods; the socket accepts one frame per drain.
    let sent = 0;
    for (let round = 0; round < 5; round += 1) {
      h.queue.enqueue(msg(`open${round}`), 1);
      pending = 0;
      const before = h.frames.length;
      // allow exactly one frame, then report a full buffer
      const original = h.frames.push.bind(h.frames);
      h.frames.push = (...items: string[]) => {
        pending = 1e9;
        return original(...items);
      };
      h.queue.drain();
      h.frames.push = original;
      sent += h.frames.length - before;
      h.advance(100);
    }
    expect(sent).toBe(5);
    expect(h.messages()).toContain("bulk");
    expect(h.messages().indexOf("bulk")).toBeGreaterThan(0);
    expect(h.queue.stats.starvationPicks).toBe(1);
    expect(STARVATION_MS).toBe(250);
  });

  it("property: per-domain order survives random lanes, focus changes and promotions", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 200; trial += 1) {
      let pending = 0;
      const frames: string[] = [];
      let clock = 0;
      const queue = new PrioritySendQueue({
        pendingBytes: () => pending,
        send: (p) => frames.push(p),
        now: () => clock,
        schedule: () => 0,
        cancel: () => {},
      });
      const sentOrder: Record<string, number[]> = {};
      const counters: Record<string, number> = {};
      for (let step = 0; step < 60; step += 1) {
        const r = rand();
        const domain = ["agent:a", "agent:b", "dir", null][Math.floor(rand() * 4)]!;
        if (r < 0.7) {
          const key = domain ?? "none";
          const n = (counters[key] = (counters[key] ?? 0) + 1);
          queue.enqueue(JSON.stringify({ d: key, n }), Math.floor(rand() * 7) as Lane, domain);
        } else if (r < 0.8 && domain) queue.promote(domain, Math.floor(rand() * 3) as Lane);
        else {
          pending = rand() < 0.5 ? 0 : 1e9;
          clock += Math.floor(rand() * 400);
          queue.drain();
        }
      }
      pending = 0;
      queue.flushAll();
      for (const frame of frames) {
        const parsed = JSON.parse(frame) as { type?: string; m?: unknown[] };
        const items = (parsed.type === "batch" ? parsed.m : [parsed]) as Array<{ d: string; n: number }>;
        for (const item of items) (sentOrder[item.d] ??= []).push(item.n);
      }
      for (const [key, order] of Object.entries(sentOrder)) {
        if (key === "none") continue;
        expect(order).toEqual([...order].sort((x, y) => x - y));
        expect(order).toHaveLength(counters[key]!);
      }
    }
  });

  it("lingers live rows into one frame until the window ends or an urgent message flushes", async () => {
    const h = harness();
    for (const id of ["start", "tool1", "tool2"]) h.queue.enqueue(msg(id), 1, "agent:a", undefined, true);
    await Promise.resolve();
    expect(h.frames).toHaveLength(0);
    // first text of the turn is urgent: it goes now and carries the lingering rows
    h.queue.enqueue(msg("text"), 1, "agent:a");
    await Promise.resolve();
    expect(h.frames).toHaveLength(1);
    expect(h.messages()).toEqual(["start", "tool1", "tool2", "text"]);
    h.queue.enqueue(msg("tool3"), 1, "agent:a", undefined, true);
    await Promise.resolve();
    expect(h.frames).toHaveLength(1);
    h.runTimers(); // the window ends
    expect(h.frames).toHaveLength(2);
    expect(h.messages()).toEqual(["start", "tool1", "tool2", "text", "tool3"]);
  });

  it("flushes lingering rows once they fill a batch", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.queue.enqueue(msg(`r${i}`, BATCH_MAX_BYTES / 4), 3, "agent:b", undefined, true);
    await Promise.resolve();
    expect(h.frames.length).toBeGreaterThan(0);
    expect(h.messages()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("never lingers lane 0", async () => {
    const h = harness();
    h.queue.enqueue(msg("attention"), 0, null, undefined, true);
    await Promise.resolve();
    expect(h.messages()).toEqual(["attention"]);
  });
});

