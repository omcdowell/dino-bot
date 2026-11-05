/**
 * Measures the daemon <-> client path on slow, lossy links.
 *
 *   npx tsx scripts/measure-low-bitrate.ts [--agents 20] [--deflate] [--json out.json]
 *
 * Runs an in-process daemon with the mock provider on a temp PASEO_HOME, and a DaemonClient
 * behind ThrottledProxy. For each link profile it records bytes and times for: connect and
 * initial sync, one tracked send (received / accepted / canonical row), one streamed turn, and a
 * dead-path outage (detection, reconnect, catch-up).
 */
import { writeFileSync } from "node:fs";
import { MockLoadTestAgentClient } from "../src/server/agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";
import { ThrottledProxy, type LinkProfile } from "../src/server/test-utils/throttled-proxy.js";

const args = process.argv.slice(2);
const agentCount = Number(argValue("--agents") ?? 20);
const jsonOut = argValue("--json");
const deflate = args.includes("--deflate");
const only = argValue("--only");

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const PROFILES: Array<{ name: string; profile: LinkProfile }> = [
  { name: "lan", profile: {} },
  { name: "64k-300ms", profile: { bitsPerSecond: 64_000, rttMs: 300, jitterMs: 50 } },
  { name: "32k-1000ms", profile: { bitsPerSecond: 32_000, rttMs: 1000, jitterMs: 100 } },
  {
    name: "32k-1000ms-5%",
    profile: { bitsPerSecond: 32_000, rttMs: 1000, jitterMs: 100, loss: 0.05 },
  },
  {
    name: "32k-1000ms-10%",
    profile: { bitsPerSecond: 32_000, rttMs: 1000, jitterMs: 100, loss: 0.1 },
  },
];

interface Result {
  profile: string;
  connect: { ms: number; up: number; down: number };
  sync: { ms: number; up: number; down: number; byType: Record<string, number> };
  send: {
    receivedMs: number | null;
    acceptedMs: number;
    canonicalMs: number;
    up: number;
    down: number;
  };
  stream: { ms: number; down: number; messages: number; byType: Record<string, number> };
  outage: {
    detectMs: number | null;
    reconnectMs: number | null;
    catchUpMs: number | null;
    down: number;
    up: number;
    byType: Record<string, number>;
  };
}

async function main(): Promise<void> {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
    ...(deflate ? { perMessageDeflate: true } : {}),
  } as Parameters<typeof createTestPaseoDaemon>[0]);
  const seeder = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await seeder.connect();
  const agentIds: string[] = [];
  for (let index = 0; index < agentCount; index += 1) {
    const agent = await seeder.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: daemon.staticDir,
      title: `Bot ${index}`,
      labels: { bot: `bot-${index}` },
    });
    agentIds.push(agent.id);
  }
  // Give a few chats some history, like real bot chats.
  await Promise.all(
    agentIds.slice(0, 5).map((id) => seeder.sendAgentMessage(id, "seed history", {})),
  );
  await sleep(3000);
  await seeder.close();

  const results: Result[] = [];
  for (const { name, profile } of PROFILES) {
    if (only && name !== only) continue;
    results.push(await measureProfile(daemon.port, name, profile, agentIds[0]));
    console.error(JSON.stringify(results.at(-1)));
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ deflate, agentCount, results }, null, 2));
  printTable(results);
  await daemon.close();
}

async function measureProfile(
  port: number,
  name: string,
  profile: LinkProfile,
  agentId: string,
): Promise<Result> {
  const proxy = new ThrottledProxy({ host: "127.0.0.1", port }, profile, { seed: 7 });
  const proxyPort = await proxy.listen();
  const byType = new Map<string, number>();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${proxyPort}/ws`,
    reconnect: { enabled: true },
  });
  client.subscribeRawMessages((message) => {
    const key = message.type === "status" ? `status.${message.payload.status}` : message.type;
    byType.set(key, (byType.get(key) ?? 0) + JSON.stringify(message).length);
  });
  const take = () => {
    const snapshot = Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1]));
    byType.clear();
    return snapshot;
  };
  const counters = () => {
    const value = { ...proxy.totals };
    proxy.resetCounters();
    return value;
  };

  let started = Date.now();
  await client.connect();
  const connectBytes = counters();
  const connect = { ms: Date.now() - started, up: connectBytes.up, down: connectBytes.down };
  take();

  // What the app does when it opens: directory, open chat timeline, events.
  started = Date.now();
  const agents = client.observeAgents({ scope: "active", page: { limit: 200 } });
  agents.subscribe({ snapshot: () => {}, update: () => {} });
  const workspaces = client.observeWorkspaces({});
  workspaces.subscribe({ snapshot: () => {}, update: () => {} });
  const events = client.observeEvents([
    "agent_attention_required",
    "agent_permission_request",
    "agent_permission_resolved",
    "providers_snapshot_update",
  ]);
  events.subscribe({ snapshot: () => {}, update: () => {} });
  let lastSeq = 0;
  let epoch = "";
  let canonicalAt = 0;
  const timelineEvents: string[] = [];
  const timeline = client.subscribeAgentTimeline(agentId, (message) => {
    if (message.type === "agent_stream") {
      const payload = message.payload as {
        seq?: number;
        epoch?: string;
        event?: { type?: string; item?: { type?: string; clientMessageId?: string } };
      };
      if (typeof payload.seq === "number") lastSeq = Math.max(lastSeq, payload.seq);
      if (payload.epoch) epoch = payload.epoch;
      timelineEvents.push(payload.event?.type ?? "?");
      if (payload.event?.item?.type === "user_message" && payload.event.item.clientMessageId) {
        canonicalAt ||= Date.now();
      }
    }
  });
  await Promise.all([agents.ready, workspaces.ready, events.ready, timeline.ready]);
  const page = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 50,
    projection: "projected",
  });
  lastSeq = Math.max(lastSeq, page.endCursor?.seq ?? 0);
  epoch = page.epoch ?? epoch;
  const syncBytes = counters();
  const sync = { ms: Date.now() - started, up: syncBytes.up, down: syncBytes.down, byType: take() };

  // One tracked send to an idle agent; the turn streams for ~2 s afterwards.
  started = Date.now();
  let receivedAt = 0;
  canonicalAt = 0;
  await client.sendAgentMessage(agentId, "How is the link? Please answer briefly.", {
    messageId: `measure-${name}`,
    onReceived: () => {
      receivedAt = Date.now();
    },
  });
  const acceptedMs = Date.now() - started;
  await waitFor(() => canonicalAt > 0, 60_000);
  const sendBytes = counters();
  const send = {
    receivedMs: receivedAt ? receivedAt - started : null,
    acceptedMs,
    canonicalMs: canonicalAt - started,
    up: sendBytes.up,
    down: sendBytes.down,
  };
  // Let the streamed turn finish (mock e2e-fast-stream lasts ~2 s; slow links drain longer).
  const streamStart = Date.now();
  timelineEvents.length = 0;
  await waitFor(() => timelineEvents.includes("turn_completed"), 120_000);
  await sleep(500);
  const streamBytes = counters();
  const stream = {
    ms: Date.now() - streamStart,
    down: streamBytes.down,
    messages: timelineEvents.length,
    byType: take(),
  };

  // A dead path for 25 s while the agent works, then the path returns.
  const states: Array<{ at: number; state: string }> = [];
  const unsubscribe = client.subscribeConnectionStatus((state) => {
    states.push({ at: Date.now(), state: state.status });
  });
  await client.sendAgentMessage(agentId, "keep working while I am in the lift", {
    messageId: `outage-${name}`,
  });
  counters();
  take();
  const outageStart = Date.now();
  proxy.blackhole();
  await waitFor(() => states.some((entry) => entry.state === "disconnected"), 60_000).catch(
    () => undefined,
  );
  const detected = states.find((entry) => entry.state === "disconnected");
  await sleep(Math.max(0, 25_000 - (Date.now() - outageStart)));
  proxy.restore();
  const restoredAt = Date.now();
  await waitFor(
    () => states.some((entry) => entry.at >= restoredAt && entry.state === "connected"),
    120_000,
  ).catch(() => undefined);
  const reconnected = states.find((entry) => entry.at >= restoredAt && entry.state === "connected");
  // App-style catch-up: fetch what the open chat missed after the last seen row.
  let catchUpMs: number | null = null;
  if (reconnected) {
    const catchUpStart = Date.now();
    await client.fetchAgentTimeline(agentId, {
      direction: "after",
      cursor: { epoch, seq: lastSeq },
      limit: 200,
      projection: "projected",
    });
    catchUpMs = Date.now() - catchUpStart;
    await sleep(2000);
  }
  unsubscribe();
  const outageBytes = counters();
  const outage = {
    detectMs: detected ? detected.at - outageStart : null,
    reconnectMs: reconnected ? reconnected.at - restoredAt : null,
    catchUpMs,
    down: outageBytes.down,
    up: outageBytes.up,
    byType: take(),
  };

  await client.close().catch(() => undefined);
  await proxy.close();
  return { profile: name, connect, sync, send, stream, outage };
}

function printTable(results: Result[]): void {
  const rows = results.map((r) => ({
    profile: r.profile,
    "connect ms": r.connect.ms,
    "connect B": r.connect.down + r.connect.up,
    "sync ms": r.sync.ms,
    "sync B down": r.sync.down,
    "✓ ms": r.send.receivedMs,
    "accepted ms": r.send.acceptedMs,
    "blue ms": r.send.canonicalMs,
    "turn B down": r.stream.down,
    "turn msgs": r.stream.messages,
    "detect ms": r.outage.detectMs,
    "reconnect ms": r.outage.reconnectMs,
    "outage B down": r.outage.down,
  }));
  console.table(rows);
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
