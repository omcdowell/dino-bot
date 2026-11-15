import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimNewBot,
  memorySeenStore,
  openDmsPanelForAgent,
  seedSeenBots,
  storageSeenStore,
  type DmsDefaultDeps,
} from "../client/dms-default";
import { DMS_PANEL_ID } from "../client/dms-format";
import { openBotFromSidebar, type SidebarOpenDeps } from "../client/bot-open";

test("first run seeds every bot already there, so existing bots are left alone (no backfill)", () => {
  const store = memorySeenStore();
  seedSeenBots(store, ["bitzer", "flint"]);
  assert.equal(claimNewBot(store, "bitzer"), false);
  assert.equal(claimNewBot(store, "flint"), false);
});

test("a bot that appears after the seed is new once: claimed on its first open, never again", () => {
  const store = memorySeenStore();
  seedSeenBots(store, ["bitzer"]);
  seedSeenBots(store, ["bitzer", "yoda"]); // later list: already seeded, yoda stays new
  assert.equal(claimNewBot(store, "yoda"), true);
  assert.equal(claimNewBot(store, "yoda"), false);
});

test("nothing is claimed before the seed (unknown which bots are old)", () => {
  const store = memorySeenStore();
  assert.equal(claimNewBot(store, "yoda"), false);
});

test("an empty bot list does not seed (the list may still be loading)", () => {
  const store = memorySeenStore();
  seedSeenBots(store, []);
  seedSeenBots(store, ["bitzer"]);
  assert.equal(claimNewBot(store, "bitzer"), false);
});

test("storage store persists as JSON and treats junk or a throwing storage as unseeded", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  const store = storageSeenStore(storage);
  assert.equal(store.read(), null);
  seedSeenBots(store, ["bitzer"]);
  assert.deepEqual(storageSeenStore(storage).read(), ["bitzer"]);
  data.set("paseo-bots.dms-panel.seen", "{not json");
  assert.equal(store.read(), null);
  const broken = storageSeenStore({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  });
  assert.equal(broken.read(), null);
  assert.doesNotThrow(() => broken.write(["x"]));
  assert.equal(storageSeenStore(undefined).read(), null);
});

function deps(over: Partial<DmsDefaultDeps> = {}) {
  const calls: unknown[] = [];
  const d: DmsDefaultDeps = {
    workspaceIdOf: async () => "ws-1",
    openPanel: (id, options) => calls.push({ openPanel: id, options }),
    wait: async (ms) => void calls.push({ wait: ms }),
    ...over,
  };
  return { d, calls };
}

test("opens the DMs panel in the agent's workspace Explorer after a short wait", async () => {
  const { d, calls } = deps();
  assert.equal(await openDmsPanelForAgent("agent-1", d), true);
  assert.deepEqual(calls, [{ wait: 1000 }, { openPanel: DMS_PANEL_ID, options: { workspaceId: "ws-1", location: "explorer" } }]);
});

test("retries while the workspace is not known yet or the panel cannot open, then gives up quietly", async () => {
  let n = 0;
  const { d, calls } = deps({
    workspaceIdOf: async () => (++n < 2 ? null : "ws-1"),
    openPanel: () => {
      calls.push("throw");
      throw new Error("Plugin panel context is unavailable");
    },
  });
  assert.equal(await openDmsPanelForAgent("agent-1", d, { attempts: 3, delayMs: 5 }), false);
  assert.deepEqual(calls, [{ wait: 5 }, { wait: 5 }, "throw", { wait: 5 }, "throw"]);
});

test("a workspace lookup that throws is retried like a missing one", async () => {
  let n = 0;
  const { d, calls } = deps({
    workspaceIdOf: async () => {
      if (++n === 1) throw new Error("not connected");
      return "ws-2";
    },
  });
  assert.equal(await openDmsPanelForAgent("agent-1", d, { attempts: 2, delayMs: 1 }), true);
  assert.deepEqual(calls.at(-1), { openPanel: DMS_PANEL_ID, options: { workspaceId: "ws-2", location: "explorer" } });
});

test("sidebar open: afterOpen gets the bot and the chat it opened (existing and newly made chat)", async () => {
  const seen: unknown[] = [];
  const base: SidebarOpenDeps = {
    navigation: { openAgent: () => {} },
    openScreen: () => {},
    openChat: async () => ({ agentId: "agent-new", created: false }),
    onCreated: () => {},
    afterOpen: (bot, agentId) => seen.push([bot.id, agentId]),
    inFlight: new Set(),
  };
  await openBotFromSidebar({ id: "bitzer", name: "Bitzer", agentId: "agent-1" }, base);
  await openBotFromSidebar({ id: "yoda", name: "Yoda", agentId: null }, base);
  assert.deepEqual(seen, [
    ["bitzer", "agent-1"],
    ["yoda", "agent-new"],
  ]);
});

test("sidebar open without app navigation (bot screen path) does not call afterOpen", async () => {
  const seen: unknown[] = [];
  await openBotFromSidebar(
    { id: "yoda", name: "Yoda" },
    {
      navigation: undefined,
      openScreen: () => {},
      openChat: async () => ({ agentId: "a", created: true }),
      onCreated: () => {},
      afterOpen: () => seen.push("x"),
      now: () => 1,
    },
  );
  assert.deepEqual(seen, []);
});
