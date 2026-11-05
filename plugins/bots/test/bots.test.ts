import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotsService, chatConfig, DEFAULT_CHAT_CONFIG, discoverBots, keepLiveChanges, withFeatured, type AgentLike, type BotsPaseo } from "../server/bots";

function botsRoot(spec: Record<string, { profile?: string; meta?: object }>) {
  const root = mkdtempSync(join(tmpdir(), "bots-"));
  for (const [id, { profile, meta }] of Object.entries(spec)) {
    mkdirSync(join(root, id));
    if (profile !== undefined) writeFileSync(join(root, id, ".optchat-profile"), profile);
    if (meta) writeFileSync(join(root, id, ".bot.json"), JSON.stringify(meta));
  }
  return root;
}

function fakePaseo(init: { agents?: AgentLike[]; projects?: Array<{ path: string; name: string; custom?: string }>; config?: unknown } = {}) {
  const agents = [...(init.agents ?? [])];
  const created: Array<{ cwd: string; options: any }> = [];
  let next = 1;
  const paseo: BotsPaseo = {
    projects: {
      list: async () => ({
        projects: (init.projects ?? []).map((p) => ({
          projectRootPath: p.path,
          projectDisplayName: p.name,
          projectCustomName: p.custom ?? null,
        })),
      }),
    },
    agents: {
      list: async (options) => ({
        entries: agents
          .filter((a) => !a.archivedAt)
          .filter((a) =>
            Object.entries(options?.filter?.labels ?? {}).every(([k, v]) => a.labels?.[k] === v),
          )
          .map((agent) => ({ agent })),
      }),
      ref: (id) => ({
        archive: async () => {
          const agent = agents.find((a) => a.id === id)!;
          agent.archivedAt = "2026-10-08T00:00:00Z";
          return {};
        },
      }),
    },
    workspaces: {
      open: async (cwd) => ({
        agents: {
          create: async (options) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const id = `new-${next++}`;
            created.push({ cwd, options });
            agents.push({ id, cwd, provider: "optchat", labels: options.labels ?? {}, updatedAt: "2026-10-08T09:00:00Z" });
            return { id };
          },
        },
      }),
    },
    config: { get: async () => init.config ?? {} },
  };
  return { paseo, agents, created };
}

test("discovery lists only folders with a profile marker, ordered by .bot.json order then name", async () => {
  const root = botsRoot({
    scrat: { profile: "scrat\n" },
    "the-fat-controller": { profile: "the-fat-controller", meta: { order: 0 } },
    bitzer: { profile: "bitzer" },
    "not-a-bot": {},
    blank: { profile: "  \n" },
  });
  const { paseo } = fakePaseo({
    projects: [
      { path: join(root, "the-fat-controller"), name: "the-fat-controller", custom: "The Fat Controller" },
      { path: join(root, "scrat"), name: "scrat" },
    ],
  });
  const bots = await discoverBots(root, paseo);
  assert.deepEqual(
    bots.map((b) => [b.id, b.name, b.icon]),
    [
      ["the-fat-controller", "The Fat Controller", "Bot"],
      ["bitzer", "Bitzer", "Bot"],
      ["scrat", "Scrat", "Bot"],
    ],
  );
});

test("avatar and featured come from .bot.json; without featured, the one lowest order is featured", async () => {
  const root = botsRoot({
    "the-fat-controller": { profile: "x", meta: { order: 0, avatar: "~/icons/fc.png" } },
    flint: { profile: "x", meta: { avatar: "  ", featured: "yes" } },
    bitzer: { profile: "x" },
  });
  const { paseo } = fakePaseo();
  const bots = await discoverBots(root, paseo);
  assert.deepEqual(
    bots.map((b) => [b.id, b.avatar, b.featured]),
    [
      ["the-fat-controller", "~/icons/fc.png", true],
      ["bitzer", null, false],
      ["flint", null, false],
    ],
  );
  const explicit = await discoverBots(botsRoot({ a: { profile: "x", meta: { order: 0 } }, b: { profile: "x", meta: { featured: true } } }), paseo);
  assert.deepEqual(explicit.map((b) => [b.id, b.featured]), [["a", false], ["b", true]]);
});

test("withFeatured: no featured bot when the lowest order is shared", () => {
  const bot = (order: number, featured = false) => ({ order, featured });
  assert.deepEqual(withFeatured([bot(10), bot(10)]).map((b) => b.featured), [false, false]);
  assert.deepEqual(withFeatured([bot(10)]).map((b) => b.featured), [true]);
  assert.deepEqual(withFeatured([bot(0), bot(1, true), bot(2, true)]).map((b) => b.featured), [false, true, false]);
  assert.deepEqual(withFeatured([]), []);
});

test("a missing bots root is an empty list, not an error", async () => {
  const { paseo } = fakePaseo();
  assert.deepEqual(await discoverBots(join(tmpdir(), "does-not-exist-bots"), paseo), []);
});

test("open returns the labelled chat, newest first", async () => {
  const root = botsRoot({ bitzer: { profile: "bitzer" } });
  const { paseo, created } = fakePaseo({
    agents: [
      { id: "old", cwd: join(root, "bitzer"), provider: "optchat", labels: { bot: "bitzer" }, lastActivityAt: "2026-10-01T00:00:00Z" },
      { id: "recent", cwd: join(root, "bitzer"), provider: "optchat", labels: { bot: "bitzer" }, lastActivityAt: "2026-10-07T00:00:00Z" },
      { id: "other-bot", cwd: join(root, "scrat"), provider: "optchat", labels: { bot: "scrat" }, lastActivityAt: "2026-10-08T00:00:00Z" },
    ],
  });
  assert.deepEqual(await new BotsService(root).open("bitzer", paseo), { agentId: "recent", created: false });
  assert.equal(created.length, 0);
});

test("open adopts an OptChat chat started by hand in the bot's folder, but not a plain pi one", async () => {
  const root = botsRoot({ flint: { profile: "flint" } });
  const cwd = join(root, "flint");
  const { paseo } = fakePaseo({
    agents: [
      { id: "plain-pi", cwd, provider: "pi", labels: {}, lastActivityAt: "2026-10-08T00:00:00Z" },
      { id: "manual", cwd, provider: "optchat", labels: {}, lastActivityAt: "2026-10-07T00:00:00Z" },
    ],
  });
  assert.deepEqual(await new BotsService(root).open("flint", paseo), { agentId: "manual", created: false });
});

test("open creates a labelled chat in the bot folder when none exists, using the bot agent profile", async () => {
  const root = botsRoot({ matilda: { profile: "matilda" } });
  const { paseo, created } = fakePaseo({
    config: {
      daemon: {
        agentProfiles: [
          { id: "bot", name: "Bot", provider: "optchat", model: "anthropic/claude-sonnet-5-5", thinkingOptionId: "high" },
        ],
      },
    },
  });
  const result = await new BotsService(root).open("matilda", paseo);
  assert.equal(result.created, true);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.cwd, join(root, "matilda"));
  assert.deepEqual(created[0]!.options.config, { provider: "optchat/anthropic/claude-sonnet-5-5", thinkingOptionId: "high" });
  assert.deepEqual(created[0]!.options.labels, {
    bot: "matilda",
    "paseo.send-behavior": "queue",
    "paseo.keep-live": "1",
  });
  assert.equal(created[0]!.options.title, "Matilda");
});

test("a double tap creates one chat, not two", async () => {
  const root = botsRoot({ tweety: { profile: "tweety" } });
  const { paseo, created } = fakePaseo();
  const service = new BotsService(root);
  const [a, b] = await Promise.all([service.open("tweety", paseo), service.open("tweety", paseo)]);
  assert.equal(created.length, 1);
  assert.equal(a.agentId, b.agentId);
});

test("new chat archives every open chat for the bot and starts one", async () => {
  const root = botsRoot({ bitzer: { profile: "bitzer" } });
  const cwd = join(root, "bitzer");
  const { paseo, agents } = fakePaseo({
    agents: [
      { id: "a", cwd, provider: "optchat", labels: { bot: "bitzer" } },
      { id: "b", cwd, provider: "optchat", labels: { bot: "bitzer" } },
      { id: "keep", cwd: join(root, "x"), provider: "optchat", labels: { bot: "scrat" } },
    ],
  });
  const result = await new BotsService(root).newChat("bitzer", paseo);
  assert.equal(result.archived, 2);
  assert.ok(agents.find((a) => a.id === "keep")!.archivedAt === undefined);
  assert.deepEqual(
    agents.filter((a) => !a.archivedAt).map((a) => a.id).sort(),
    [result.agentId, "keep"].sort(),
  );
});

test("new chat keeps the model and thinking the bot was switched to", async () => {
  const root = botsRoot({ hello: { profile: "hello" } });
  const cwd = join(root, "hello");
  const { paseo, created } = fakePaseo({
    agents: [
      {
        id: "switched",
        cwd,
        provider: "optchat",
        model: "openrouter/z-ai/glm-5.3",
        thinkingOptionId: "low",
        labels: { bot: "hello" },
      },
    ],
    config: { daemon: { agentProfiles: [{ id: "bot", provider: "optchat", model: "anthropic/claude-opus-5-5", thinkingOptionId: "medium" }] } },
  });
  await new BotsService(root).newChat("hello", paseo);
  assert.deepEqual(created[0]!.options.config, { provider: "optchat/openrouter/z-ai/glm-5.3", thinkingOptionId: "low" });
});

test("new chat prefers the running model and effective thinking over the configured ones", async () => {
  const root = botsRoot({ hello: { profile: "hello" } });
  const cwd = join(root, "hello");
  const { paseo, created } = fakePaseo({
    agents: [
      {
        id: "switched",
        cwd,
        provider: "optchat",
        model: "anthropic/claude-opus-5-5",
        thinkingOptionId: "high",
        effectiveThinkingOptionId: "medium",
        runtimeInfo: { model: "openai-codex/gpt-5.6-luna" },
        labels: { bot: "hello" },
      },
    ],
  });
  await new BotsService(root).newChat("hello", paseo);
  assert.deepEqual(created[0]!.options.config, { provider: "optchat/openai-codex/gpt-5.6-luna", thinkingOptionId: "medium" });
});

test("new chat falls back to the bot profile when the old chat has no model", async () => {
  const root = botsRoot({ bitzer: { profile: "bitzer" } });
  const cwd = join(root, "bitzer");
  const { paseo, created } = fakePaseo({
    agents: [{ id: "a", cwd, provider: "optchat", labels: { bot: "bitzer" } }],
  });
  await new BotsService(root).newChat("bitzer", paseo);
  assert.deepEqual(created[0]!.options.config, DEFAULT_CHAT_CONFIG);
});

test("a chat switched to a non-Anthropic model is still the bot's chat", async () => {
  const root = botsRoot({ scrat: { profile: "scrat" }, flint: { profile: "flint" } });
  const { paseo } = fakePaseo({
    agents: [
      { id: "glm", cwd: join(root, "scrat"), provider: "optchat", model: "openrouter/z-ai/glm-5.3", labels: { bot: "scrat" } },
      { id: "luna-by-hand", cwd: join(root, "flint"), provider: "optchat", model: "openai-codex/gpt-5.6-luna", labels: {} },
    ],
  });
  const { bots, ownerOf } = await new BotsService(root).listWithOwners(paseo);
  assert.deepEqual(bots.map((b) => [b.id, b.agentId]), [["flint", "luna-by-hand"], ["scrat", "glm"]]);
  assert.equal(ownerOf("glm"), "scrat");
  assert.equal(ownerOf("luna-by-hand"), "flint");
});

test("list attaches each bot's current chat and leaves chatless bots null", async () => {
  const root = botsRoot({ bitzer: { profile: "bitzer" }, scrat: { profile: "scrat" } });
  const { paseo } = fakePaseo({
    agents: [
      { id: "b1", cwd: join(root, "bitzer"), provider: "optchat", labels: { bot: "bitzer" } },
      { id: "gone", cwd: join(root, "scrat"), provider: "optchat", labels: { bot: "scrat" }, archivedAt: "2026-10-01T00:00:00Z" },
    ],
  });
  const bots = await new BotsService(root).list(paseo);
  assert.deepEqual(bots.map((b) => [b.id, b.agentId]), [["bitzer", "b1"], ["scrat", null]]);
});

test("a chat labelled for another bot is never adopted by folder", async () => {
  const root = botsRoot({ flint: { profile: "flint" } });
  const { paseo, created } = fakePaseo({
    agents: [{ id: "scrats", cwd: join(root, "flint"), provider: "optchat", labels: { bot: "scrat" } }],
  });
  const result = await new BotsService(root).open("flint", paseo);
  assert.equal(result.created, true);
  assert.equal(created.length, 1);
});

test("unknown bot ids fail with a hint", async () => {
  const root = botsRoot({});
  const { paseo } = fakePaseo();
  await assert.rejects(new BotsService(root).open("ghost", paseo), /Unknown bot: ghost/);
});

test("chat config falls back to the default when no bot profile exists", async () => {
  const { paseo } = fakePaseo({ config: { daemon: { agentProfiles: [] } } });
  assert.deepEqual(await chatConfig(paseo), DEFAULT_CHAT_CONFIG);
});

test("listWithOwners maps every live chat of a bot (not only the current one) to the bot", async () => {
  const root = botsRoot({ bitzer: { profile: "bitzer" }, scrat: { profile: "scrat" } });
  const { paseo } = fakePaseo({
    agents: [
      { id: "b-new", cwd: join(root, "bitzer"), provider: "optchat", labels: { bot: "bitzer" }, updatedAt: "2026-10-08T02:00:00Z" },
      { id: "b-old", cwd: join(root, "bitzer"), provider: "optchat", labels: { bot: "bitzer" }, updatedAt: "2026-10-08T01:00:00Z" },
      { id: "s-hand", cwd: join(root, "scrat"), provider: "optchat", labels: {} },
      { id: "plain-pi", cwd: join(root, "scrat"), provider: "pi", labels: {} },
      { id: "elsewhere", cwd: "/tmp", provider: "optchat", labels: { bot: "not-a-bot" } },
      { id: "archived", cwd: join(root, "scrat"), provider: "optchat", labels: { bot: "scrat" }, archivedAt: "2026-10-01T00:00:00Z" },
    ],
  });
  const { bots, ownerOf } = await new BotsService(root).listWithOwners(paseo);
  assert.deepEqual(bots.map((b) => [b.id, b.agentId]), [["bitzer", "b-new"], ["scrat", "s-hand"]]);
  assert.equal(ownerOf("b-new"), "bitzer");
  assert.equal(ownerOf("b-old"), "bitzer");
  assert.equal(ownerOf("s-hand"), "scrat");
  assert.equal(ownerOf("plain-pi"), null);
  assert.equal(ownerOf("elsewhere"), null);
  assert.equal(ownerOf("archived"), null);
});

test("keepLiveChanges labels each bot's current chat and clears its older ones", () => {
  const bots = [
    { id: "matilda", cwd: "/bots/matilda" },
    { id: "flint", cwd: "/bots/flint" },
  ];
  const agents: AgentLike[] = [
    { id: "m-old", cwd: "/bots/matilda", provider: "optchat", labels: { bot: "matilda", "paseo.keep-live": "1" }, lastActivityAt: "2026-10-01T00:00:00Z" },
    { id: "m-new", cwd: "/bots/matilda", provider: "optchat", labels: { bot: "matilda" }, lastActivityAt: "2026-10-09T00:00:00Z" },
    { id: "f-hand", cwd: "/bots/flint", provider: "optchat", labels: {}, lastActivityAt: "2026-10-09T00:00:00Z" },
    { id: "other", cwd: "/repo", provider: "claude", labels: { "paseo.keep-live": "1" } },
    { id: "m-archived", cwd: "/bots/matilda", provider: "optchat", labels: { bot: "matilda", "paseo.keep-live": "1" }, archivedAt: "2026-10-02T00:00:00Z" },
  ];
  assert.deepEqual(keepLiveChanges(bots, agents), [
    { agentId: "m-old", value: "0" },
    { agentId: "m-new", value: "1" },
    { agentId: "f-hand", value: "1" },
  ]);
  const settled = agents.map((agent) => ({
    ...agent,
    labels: {
      ...agent.labels,
      ...(agent.id === "m-old" ? { "paseo.keep-live": "0" } : {}),
      ...(agent.id === "m-new" || agent.id === "f-hand" ? { "paseo.keep-live": "1" } : {}),
    },
  }));
  assert.deepEqual(keepLiveChanges(bots, settled), []);
});

test("syncKeepLive writes labels through setLabels and skips daemons without it", async () => {
  const root = botsRoot({ matilda: { profile: "matilda" } });
  const agents: AgentLike[] = [
    { id: "chat-1", cwd: join(root, "matilda"), provider: "optchat", labels: { bot: "matilda" } },
  ];
  const writes: Array<{ id: string; labels: Record<string, string> }> = [];
  const base = fakePaseo({ agents }).paseo;
  const withLabels: BotsPaseo = {
    ...base,
    agents: {
      ...base.agents,
      ref: (id) => ({
        ...base.agents.ref(id),
        setLabels: async (labels) => {
          writes.push({ id, labels });
        },
      }),
    },
  };
  assert.equal(await new BotsService(root).syncKeepLive(withLabels), 1);
  assert.deepEqual(writes, [{ id: "chat-1", labels: { "paseo.keep-live": "1" } }]);
  assert.equal(await new BotsService(root).syncKeepLive(base), 0);
});
