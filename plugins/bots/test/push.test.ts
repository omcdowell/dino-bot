import { test } from "node:test";
import assert from "node:assert/strict";
import { BotsPush } from "../server/push";
import { staleKinds } from "../shared/push-rpc";

function harness(withEmit = true) {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const values = { previews: { bots: [] as unknown[] }, workers: { bots: [], herdr: "ok" }, quiet: { agentIds: [] as string[] }, dms: { bots: [] as unknown[], stamp: "s0" } };
  let now = 0;
  const push = new BotsPush(
    withEmit ? (name, data) => emitted.push({ name, data }) : undefined,
    {
      previews: async () => values.previews,
      workers: async () => values.workers,
      quiet: async () => values.quiet,
      dms: async () => values.dms,
    },
    { now: () => now, checkMs: 5, leaseMs: 50 },
  );
  return { push, emitted, values, advance: (ms: number) => (now += ms) };
}

test("a kind is pushed only when its value changes, with a new revision", async () => {
  const h = harness();
  await h.push.check();
  assert.deepEqual(h.emitted.map((e) => e.name), ["bots.previews", "bots.workers", "bots.quiet", "bots.dms"]);
  await h.push.check();
  assert.equal(h.emitted.length, 4, "unchanged values are not pushed again");
  h.values.quiet = { agentIds: ["a1"] };
  await h.push.check();
  assert.deepEqual(h.emitted.at(-1), { name: "bots.quiet", data: { rev: 2, data: { agentIds: ["a1"] } } });
  assert.deepEqual(h.push.revisions(), { previews: 1, workers: 1, quiet: 2, dms: 1 });
});

test("a DM status change alone (same summary, new stamp) pushes dms", async () => {
  const h = harness();
  await h.push.check();
  h.values.dms = { bots: [], stamp: "s1" };
  await h.push.check();
  assert.deepEqual(h.emitted.at(-1), { name: "bots.dms", data: { rev: 2, data: { bots: [], stamp: "s1" } } });
});

test("an RPC answer that matches the last push sends nothing", () => {
  const h = harness();
  h.push.publish("previews", { bots: [1] });
  h.push.publish("previews", { bots: [1] });
  assert.equal(h.emitted.length, 1);
});

test("hosts without emit keep revisions but push nothing", async () => {
  const h = harness(false);
  assert.equal(h.push.pushes, false);
  await h.push.check();
  assert.equal(h.emitted.length, 0);
  h.push.touch();
  assert.deepEqual(h.push.revisions(), { previews: 1, workers: 1, quiet: 1, dms: 1 });
});

test("the watch loop runs only while a client keeps the lease", async () => {
  const h = harness();
  h.push.touch();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.emitted.length, 4);
  h.advance(100); // lease over
  h.values.quiet = { agentIds: ["late"] };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.emitted.length, 4, "nobody watching: no recompute");
  h.push.touch();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.emitted.at(-1)?.name, "bots.quiet");
  h.push.stop();
});

test("the revision check refetches only kinds whose push was missed", () => {
  assert.deepEqual(
    staleKinds({ previews: 3, workers: null, quiet: 1, dms: 2 }, { previews: 4, workers: 9, quiet: 1, dms: 3 }),
    ["previews", "dms"],
  );
});
