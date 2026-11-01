import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_ATTEMPTS, PushSlotNotifier, RETRY_MS, SLOT_SENDER, STALE_MS, recordRefusal, slotMessage } from "../server/push-slot-notify";
import { SYSTEM_SENDERS } from "../bot-dm/policy";
import { ULID_RE } from "../shared/dm-schema";
import { setUserName } from "../shared/party";

// Prompts and notices name the user from the settings; these tests use a configured name.
setUserName("Sam");

const T0 = Date.parse("2026-10-11T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function harness(opts: { results?: boolean[]; slots?: Record<string, string | null> } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "push-slot-")), "bot-dm", "push-slots.jsonl");
  let now = T0;
  const sent: Array<{ to: string; id: string; text: string }> = [];
  const slots = opts.slots ?? {};
  const make = () =>
    new PushSlotNotifier({
      path,
      now: () => now,
      send: async (dm) => {
        sent.push(dm);
        return opts.results?.length ? opts.results.shift()! : true;
      },
      nextSlot: async (bot) => slots[bot] ?? null,
    });
  const refuse = (bot: string, atMs: number, retryMs: number, dm = "01K0000000000000000000000A") =>
    recordRefusal(path, { bot, at: iso(atMs), retryAt: iso(retryMs), dm });
  return { path, sent, make, slots, refuse, tick: (ms: number) => (now += ms), at: () => now };
}

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("worker:push-slot is a system sender", () => {
  assert.equal(SLOT_SENDER, "worker:push-slot");
  assert.ok(SYSTEM_SENDERS.includes(SLOT_SENDER));
});

test("slotMessage: the refusal time, in UTC", () => {
  assert.match(slotMessage([{ at: "2026-10-11T08:03:20.000Z" }]), /^Your push slot to Sam is open again \(was refused at 08:03 UTC\)\./);
  assert.match(slotMessage([{ at: "2026-10-11T08:03:20.000Z" }, { at: "2026-10-11T08:05:00.000Z" }]), /\(was refused 2 times, last at 08:05 UTC\)/);
});

test("one DM when the slot reopens, not before, never twice", async () => {
  const h = harness();
  h.refuse("bitzer", T0 + 3 * MIN, T0 + 10 * MIN);
  const n = h.make();
  await n.tick();
  assert.equal(h.sent.length, 0, "not before the slot reopens");
  h.tick(10 * MIN);
  await n.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.to, "bitzer");
  assert.match(h.sent[0]!.id, ULID_RE);
  assert.match(h.sent[0]!.text, /was refused at 08:03 UTC/);
  h.tick(MIN);
  await n.tick();
  await n.tick();
  assert.equal(h.sent.length, 1, "once only");
  assert.deepEqual(lines(h.path).map((r) => r.type), ["refused", "notice", "notice-sent"]);
});

test("no refusal, no DM (a successful push alone never notifies)", async () => {
  const h = harness({ slots: { bitzer: iso(T0 + 10 * MIN) } });
  h.tick(30 * MIN);
  await h.make().tick();
  assert.equal(h.sent.length, 0);
});

test("several refusals in one window: one DM; per bot", async () => {
  const h = harness();
  h.refuse("bitzer", T0 + 2 * MIN, T0 + 10 * MIN);
  h.refuse("bitzer", T0 + 6 * MIN, T0 + 10 * MIN);
  h.refuse("flint", T0 + 4 * MIN, T0 + 12 * MIN);
  h.tick(10 * MIN);
  const n = h.make();
  await n.tick();
  assert.deepEqual(h.sent.map((d) => d.to), ["bitzer"]);
  assert.match(h.sent[0]!.text, /refused 2 times, last at 08:06 UTC/);
  h.tick(2 * MIN);
  await n.tick();
  assert.deepEqual(h.sent.map((d) => d.to), ["bitzer", "flint"]);
});

test("a new refusal after the notice gets its own notice in the next window", async () => {
  const h = harness();
  h.refuse("bitzer", T0 + 2 * MIN, T0 + 10 * MIN);
  h.tick(10 * MIN);
  const n = h.make();
  await n.tick();
  h.refuse("bitzer", T0 + 15 * MIN, T0 + 21 * MIN); // pushed at 08:11, refused at 08:15
  h.tick(6 * MIN);
  await n.tick();
  assert.equal(h.sent.length, 1, "08:16: not yet");
  h.tick(5 * MIN);
  await n.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!.text, /was refused at 08:15 UTC/);
  assert.notEqual(h.sent[0]!.id, h.sent[1]!.id);
});

test("survives a plugin reload: a pending notice is sent by the new instance, a sent one is not resent", async () => {
  const h = harness();
  h.refuse("bitzer", T0 + 3 * MIN, T0 + 10 * MIN);
  await h.make().tick(); // old instance, before the slot reopens
  h.tick(11 * MIN);
  await h.make().tick(); // reloaded
  assert.equal(h.sent.length, 1);
  await h.make().tick(); // reloaded again
  assert.equal(h.sent.length, 1);
});

test("skipped when the slot was already used again (the bot pushed after its window)", async () => {
  const h = harness();
  h.refuse("bitzer", T0 + 3 * MIN, T0 + 10 * MIN);
  h.tick(12 * MIN);
  h.slots.bitzer = iso(T0 + 21 * MIN); // pushed at 08:11
  await h.make().tick();
  assert.equal(h.sent.length, 0);
  assert.equal(lines(h.path).at(-1).type, "notice-skipped");
  delete h.slots.bitzer;
  h.tick(20 * MIN);
  await h.make().tick();
  assert.equal(h.sent.length, 0, "still skipped later");
});

test("stale notices (plugin was down for hours) are dropped, not sent", async () => {
  const h = harness();
  h.refuse("bitzer", T0 + 3 * MIN, T0 + 10 * MIN);
  h.tick(10 * MIN + STALE_MS + MIN);
  await h.make().tick();
  assert.equal(h.sent.length, 0);
  assert.equal(lines(h.path).at(-1).reason, "stale");
});

test("failed send: retried with the same DM id, RETRY_MS apart, at most MAX_ATTEMPTS", async () => {
  const h = harness({ results: [false, false, false, false] });
  h.refuse("bitzer", T0 + 3 * MIN, T0 + 10 * MIN);
  h.tick(10 * MIN);
  const n = h.make();
  await n.tick();
  await n.tick();
  assert.equal(h.sent.length, 1, "not before RETRY_MS");
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    h.tick(RETRY_MS);
    await n.tick();
  }
  assert.equal(h.sent.length, MAX_ATTEMPTS);
  assert.equal(new Set(h.sent.map((d) => d.id)).size, 1, "same id: bot-dm drops a duplicate");
});

test("plugin build rule: index.server.ts and server/ import only from server/ and shared/", async () => {
  const { readdirSync } = await import("node:fs");
  const repo = join(import.meta.dirname, "..");
  const files = ["index.server.ts", ...readdirSync(join(repo, "server")).filter((f) => f.endsWith(".ts")).map((f) => `server/${f}`)];
  for (const f of files) {
    const src = readFileSync(join(repo, f), "utf8");
    for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
      const spec = m[1]!;
      const ok = f === "index.server.ts" ? /^\.\/(server|shared)\//.test(spec) : /^(\.\/|\.\.\/shared\/)/.test(spec);
      assert.ok(ok, `${f} imports ${spec}`);
    }
  }
});
