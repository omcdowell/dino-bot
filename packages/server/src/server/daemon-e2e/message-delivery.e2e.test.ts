import { WebSocket } from "ws";
import { afterEach, expect, test } from "vitest";
import type {
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/** Mock provider whose turn starts wait for a gate, so a test can act mid-start. */
class GatedStartClient extends MockLoadTestAgentClient {
  startCalls = 0;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  holdStarts(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  releaseStarts(): void {
    this.openGate?.();
    this.gate = null;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = await super.createSession(config, launchContext);
    const startTurn = session.startTurn.bind(session);
    session.startTurn = async (prompt, options) => {
      this.startCalls++;
      if (this.gate) await this.gate;
      return startTurn(prompt, options);
    };
    return session;
  }
}

class RawPeer {
  readonly frames: Array<{ type: string; message?: { type: string; payload?: unknown } }> = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      if (!binary) this.frames.push(JSON.parse(data.toString()));
    });
  }

  static async connect(port: number, clientId: string): Promise<RawPeer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const peer = new RawPeer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        clientType: "browser",
        clientId,
        protocolVersion: 1,
        appVersion: "0.8.0",
        capabilities: {},
      }),
    );
    await expect
      .poll(() => peer.frames.some((frame) => frame.message?.type === "status"))
      .toBe(true);
    return peer;
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ type: "session", message }));
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => undefined);
});

async function setup(featureValues?: Record<string, unknown>) {
  const provider = new GatedStartClient();
  const daemon: TestPaseoDaemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: { mock: provider },
  });
  cleanups.push(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  cleanups.push(() => client.close());
  const agent = await client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    cwd: daemon.staticDir,
    title: "Delivery",
    ...(featureValues ? { featureValues } : {}),
  });
  return { provider, daemon, client, agent };
}

async function userMessagesWith(client: DaemonClient, agentId: string, clientMessageId: string) {
  const timeline = await client.fetchAgentTimeline(agentId, { limit: 200 });
  return timeline.entries.filter(
    (entry) => entry.item.type === "user_message" && entry.item.clientMessageId === clientMessageId,
  );
}

test("a socket dropped mid-start does not strand the message; the retry is a no-op", async () => {
  const { provider, daemon, client, agent } = await setup();
  const messageId = "drop-mid-start";
  provider.holdStarts();
  const peer = await RawPeer.connect(daemon.port, "dropper");
  peer.send({
    type: "send_agent_message_request",
    requestId: "first-try",
    agentId: agent.id,
    text: "hello through a bad link",
    messageId,
  });
  await expect.poll(() => provider.startCalls).toBe(1);
  await peer.close();
  provider.releaseStarts();

  await client.sendAgentMessage(agent.id, "hello through a bad link", { messageId });

  await expect.poll(() => userMessagesWith(client, agent.id, messageId)).toHaveLength(1);
  expect(provider.startCalls).toBe(1);
});

test("a turn start the provider refused can be retried with the same message id", async () => {
  const { client, agent } = await setup({ mockPromptRejections: 1 });
  const messageId = "refused-then-retried";
  await expect(client.sendAgentMessage(agent.id, "try again", { messageId })).rejects.toThrow();
  await client.sendAgentMessage(agent.id, "try again", { messageId });
  await expect.poll(() => userMessagesWith(client, agent.id, messageId)).toHaveLength(1);
});

test("the daemon acknowledges a tracked message before the agent takes it", async () => {
  const { provider, client, agent } = await setup();
  const events: string[] = [];
  provider.holdStarts();
  const sending = client.sendAgentMessage(agent.id, "tick tick", {
    messageId: "ack-order",
    onReceived: () => events.push("received"),
  });
  await expect.poll(() => events).toEqual(["received"]);
  expect(provider.startCalls).toBe(1);
  provider.releaseStarts();
  const first = await sending;
  events.push(`accepted:${first.disposition}`);
  const repeat = await client.sendAgentMessage(agent.id, "tick tick", {
    messageId: "ack-order",
    onReceived: () => events.push("received-again"),
  });
  expect(repeat).toEqual({});
  expect(events).toEqual(["received", "accepted:turn_started", "received-again"]);
});

async function userMessageIds(client: DaemonClient, agentId: string) {
  const timeline = await client.fetchAgentTimeline(agentId, { limit: 200 });
  return timeline.entries.flatMap((entry) =>
    entry.item.type === "user_message" && entry.item.clientMessageId
      ? [entry.item.clientMessageId]
      : [],
  );
}

async function queuedIds(client: DaemonClient, agentId: string) {
  const result = await client.fetchAgent(agentId);
  return result?.agent.messageQueue?.items.map((item) => item.messageId) ?? [];
}

test("queued messages wait for the agent and arrive once each, in order, without the sender", async () => {
  const { daemon, client, agent } = await setup();
  await client.sendAgentMessage(agent.id, "first, starts a turn", { messageId: "q0" });
  const sender = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await sender.connect();
  const dispositions: Array<string | undefined> = [];
  for (const id of ["q1", "q2", "q3"]) {
    const result = await sender.sendAgentMessage(agent.id, `queued ${id}`, {
      messageId: id,
      activeTurnBehavior: "queue",
    });
    dispositions.push(result.disposition);
  }
  expect(dispositions).toEqual(["queued", "queued", "queued"]);
  expect(await queuedIds(client, agent.id)).toEqual(["q1", "q2", "q3"]);
  // A retry of a held message is a no-op that still reports it as queued.
  const retry = await sender.sendAgentMessage(agent.id, "queued q2", {
    messageId: "q2",
    activeTurnBehavior: "queue",
  });
  expect(retry.disposition).toBe("queued");
  await sender.close();

  await expect
    .poll(() => userMessageIds(client, agent.id), { timeout: 20_000, interval: 250 })
    .toEqual(["q0", "q1", "q2", "q3"]);
  expect(await queuedIds(client, agent.id)).toEqual([]);
}, 40_000);

test("a queued message sent to an idle agent starts at once", async () => {
  const { client, agent } = await setup();
  const result = await client.sendAgentMessage(agent.id, "nothing ahead", {
    messageId: "idle-queue",
    activeTurnBehavior: "queue",
  });
  expect(result.disposition).toBe("turn_started");
  expect(await userMessageIds(client, agent.id)).toEqual(["idle-queue"]);
});

test("a queued message after a failed turn starts a new turn instead of waiting forever", async () => {
  const { client, agent } = await setup();
  await client.sendAgentMessage(agent.id, "please emit a synthetic turn failure", {
    messageId: "fails",
  });
  await expect
    .poll(async () => (await client.fetchAgent(agent.id))?.agent.status, { timeout: 10_000 })
    .toBe("error");
  const result = await client.sendAgentMessage(agent.id, "after the error", {
    messageId: "after-error",
    activeTurnBehavior: "queue",
  });
  expect(result.disposition).toBe("turn_started");
  expect(await queuedIds(client, agent.id)).toEqual([]);
  await expect
    .poll(() => userMessageIds(client, agent.id), { timeout: 10_000 })
    .toEqual(["fails", "after-error"]);
});

test("force steers a queued message into the running turn", async () => {
  const { client, agent } = await setup();
  await client.sendAgentMessage(agent.id, "long turn", { messageId: "running" });
  await client.sendAgentMessage(agent.id, "waiting", {
    messageId: "forced",
    activeTurnBehavior: "queue",
  });
  const forced = await client.forceQueuedAgentMessage(agent.id, "forced");
  expect(forced.result).toBe("forced");
  expect(await queuedIds(client, agent.id)).toEqual([]);
  const timeline = await client.fetchAgentTimeline(agent.id, { limit: 200 });
  const turns = timeline.entries
    .filter((entry) => entry.item.type === "user_message")
    .map((entry) => entry.turnId);
  expect(turns).toHaveLength(2);
  expect(turns[1]).toBe(turns[0]);
  expect((await client.forceQueuedAgentMessage(agent.id, "forced")).result).toBe("not_queued");
});

test("cancel withdraws held and unseen messages, and is too late once the agent has one", async () => {
  const { client, agent } = await setup();
  await client.sendAgentMessage(agent.id, "busy", { messageId: "busy" });
  await client.sendAgentMessage(agent.id, "never mind", {
    messageId: "withdrawn",
    activeTurnBehavior: "queue",
  });
  expect((await client.cancelAgentMessage(agent.id, "withdrawn")).result).toBe("cancelled");
  expect(await queuedIds(client, agent.id)).toEqual([]);
  // Deleted while offline: the cancel reaches the daemon before the message ever does.
  expect((await client.cancelAgentMessage(agent.id, "unseen")).result).toBe("cancelled");
  await expect(
    client.sendAgentMessage(agent.id, "late arrival", { messageId: "unseen" }),
  ).rejects.toThrow("cancelled");
  await expect(
    client.sendAgentMessage(agent.id, "never mind", {
      messageId: "withdrawn",
      activeTurnBehavior: "queue",
    }),
  ).rejects.toThrow("cancelled");
  expect((await client.cancelAgentMessage(agent.id, "busy")).result).toBe("too_late");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(await userMessageIds(client, agent.id)).toEqual(["busy"]);
}, 20_000);

test("held messages survive a daemon restart and are still delivered once, in order", async () => {
  const provider = new GatedStartClient();
  const first = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    cleanup: false,
    agentClients: { mock: provider },
  });
  const paseoHomeRoot = first.config.paseoHome.replace(/\/\.paseo$/, "");
  let client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
  await client.connect();
  const agent = await client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    cwd: first.staticDir,
    title: "Restart",
  });
  await client.sendAgentMessage(agent.id, "long turn", { messageId: "r0" });
  for (const id of ["r1", "r2"]) {
    await client.sendAgentMessage(agent.id, `held ${id}`, {
      messageId: id,
      activeTurnBehavior: "queue",
    });
  }
  await client.close();
  await first.close();

  const second = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    paseoHomeRoot,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  cleanups.push(() => second.close());
  client = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws` });
  await client.connect();
  cleanups.push(() => client.close());
  await expect
    .poll(() => userMessageIds(client, agent.id), { timeout: 30_000, interval: 500 })
    .toEqual(expect.arrayContaining(["r1"]));
  await client.cancelAgent(agent.id);
  await expect
    .poll(async () => (await userMessageIds(client, agent.id)).filter((id) => id.startsWith("r")), {
      timeout: 30_000,
      interval: 500,
    })
    .toEqual(expect.arrayContaining(["r1", "r2"]));
  const ids = (await userMessageIds(client, agent.id)).filter((id) => id === "r1" || id === "r2");
  expect(ids).toEqual(["r1", "r2"]);
}, 90_000);
