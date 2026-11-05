import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenTimeout, openBotFromSidebar, openChatPatiently, startingLabel, type SidebarOpenDeps } from "../client/bot-open";

const TAP_AT = 1_760_000_000_000;

function harness(options: { navigation?: boolean; chat?: () => Promise<{ agentId: string; created: boolean }> } = {}) {
  const calls: unknown[] = [];
  const deps: SidebarOpenDeps = {
    navigation:
      options.navigation === false
        ? undefined
        : { openAgent: (input) => calls.push({ openAgent: input }) },
    openScreen: (input) => calls.push({ openScreen: input }),
    openChat: async (botId) => {
      calls.push({ openChat: botId });
      return options.chat ? options.chat() : { agentId: "agent-new", created: true };
    },
    onCreated: () => calls.push("created"),
    now: () => TAP_AT,
    inFlight: new Set(),
  };
  return { deps, calls };
}

test("our app: a bot with a chat opens the chat directly (no bot screen, no nonce)", async () => {
  const { deps, calls } = harness();
  await openBotFromSidebar({ id: "bitzer", name: "Bitzer", agentId: "agent-1" }, deps);
  assert.deepEqual(calls, [{ openAgent: { agentId: "agent-1" } }]);
});

test("our app: a bot with no chat yet gets one from the daemon, then opens it directly", async () => {
  const { deps, calls } = harness();
  await openBotFromSidebar({ id: "flint", name: "Flint", agentId: null }, deps);
  assert.deepEqual(calls, [{ openChat: "flint" }, "created", { openAgent: { agentId: "agent-new" } }]);
});

test("our app: an existing chat found by the daemon is not reported as created", async () => {
  const { deps, calls } = harness({ chat: async () => ({ agentId: "agent-old", created: false }) });
  await openBotFromSidebar({ id: "flint", name: "Flint" }, deps);
  assert.deepEqual(calls, [{ openChat: "flint" }, { openAgent: { agentId: "agent-old" } }]);
});

test("our app: if the daemon cannot open a chat, the bot page opens without a jump (its buttons show the error)", async () => {
  const { deps, calls } = harness({
    chat: async () => {
      throw new Error("daemon down");
    },
  });
  await openBotFromSidebar({ id: "flint", name: "Flint" }, deps);
  assert.deepEqual(calls, [
    { openChat: "flint" },
    { openScreen: { screenId: "bot", params: { botId: "flint", name: "Flint" } } },
  ]);
});

test("our app: a second tap while the first chat is still being opened does nothing", async () => {
  let release!: (value: { agentId: string; created: boolean }) => void;
  let pending = true;
  const { deps, calls } = harness({
    chat: () =>
      pending
        ? new Promise((resolve) => (release = resolve))
        : Promise.resolve({ agentId: "agent-new", created: false }),
  });
  const first = openBotFromSidebar({ id: "flint", name: "Flint" }, deps);
  await openBotFromSidebar({ id: "flint", name: "Flint" }, deps);
  release({ agentId: "agent-new", created: false });
  await first;
  pending = false;
  assert.deepEqual(calls, [{ openChat: "flint" }, { openAgent: { agentId: "agent-new" } }]);
  // Done: the next tap works again.
  await openBotFromSidebar({ id: "flint", name: "Flint" }, deps);
  assert.equal(calls.length, 4);
});

test("upstream app (no sidebar navigation): the old bot-screen path with a nonce", async () => {
  const { deps, calls } = harness({ navigation: false });
  await openBotFromSidebar({ id: "bitzer", name: "Bitzer", agentId: "agent-1" }, deps);
  await openBotFromSidebar({ id: "flint", name: "Flint" }, deps);
  assert.deepEqual(calls, [
    { openScreen: { screenId: "bot", params: { botId: "bitzer", name: "Bitzer", agentId: "agent-1", nonce: `${TAP_AT}` } } },
    { openScreen: { screenId: "bot", params: { botId: "flint", name: "Flint", nonce: `${TAP_AT}` } } },
  ]);
});

// Review video (5 Nov): "Plugin RPC timed out: bots.invoke" on a bot's first open on a fresh host.
const TIMEOUT = new Error("Plugin RPC timed out: bots.invoke");

test("first open: a daemon timeout while the chat is created is asked again, and the screen is told it is starting", async () => {
  let calls = 0;
  let starting = 0;
  const result = await openChatPatiently(
    async () => {
      calls++;
      if (calls === 1) throw TIMEOUT; // the host is still creating the chat
      return { agentId: "agent-new", created: false }; // the same chat, made by the first call
    },
    { onStarting: () => starting++, slowMs: 60_000 },
  );
  assert.deepEqual(result, { agentId: "agent-new", created: false });
  assert.equal(calls, 2);
  assert.equal(starting, 1);
});

test("first open: a slow answer says 'starting' before any timeout, once", async () => {
  let starting = 0;
  const result = await openChatPatiently(
    () => new Promise<{ agentId: string; created: boolean }>((resolve) => setTimeout(() => resolve({ agentId: "a", created: true }), 40)),
    { onStarting: () => starting++, slowMs: 5 },
  );
  assert.equal(result.agentId, "a");
  assert.equal(starting, 1);
});

test("a fast open says nothing about starting", async () => {
  let starting = 0;
  await openChatPatiently(async () => ({ agentId: "a", created: false }), { onStarting: () => starting++, slowMs: 1_000 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(starting, 0);
});

test("other errors are not retried; timeouts stop after the retry budget", async () => {
  let calls = 0;
  await assert.rejects(
    openChatPatiently(async () => {
      calls++;
      throw new Error("Unknown bot: nobody");
    }),
    /Unknown bot/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    openChatPatiently(
      async () => {
        calls++;
        throw TIMEOUT;
      },
      { retries: 2, slowMs: 60_000 },
    ),
    /timed out/,
  );
  assert.equal(calls, 3);
});

test("timeout detection and the starting label", () => {
  assert.equal(isOpenTimeout(TIMEOUT), true);
  assert.equal(isOpenTimeout(new Error("Request timeout after 60000ms")), true);
  assert.equal(isOpenTimeout(new Error("Unknown bot")), false);
  assert.match(startingLabel("Wallace"), /^Starting Wallace… /);
});

test("sidebar: a first open that times out once still opens the chat and reports starting", async () => {
  let n = 0;
  const { deps, calls } = harness({
    chat: async () => {
      n++;
      if (n === 1) throw TIMEOUT;
      return { agentId: "agent-new", created: false };
    },
  });
  deps.onStarting = (bot) => calls.push({ starting: bot.id });
  await openBotFromSidebar({ id: "wallace", name: "Wallace", agentId: null }, deps);
  assert.deepEqual(calls, [{ openChat: "wallace" }, { starting: "wallace" }, { openChat: "wallace" }, { openAgent: { agentId: "agent-new" } }]);
});
