/**
 * Measures background sync of bot chats on slow links (chat-prefetch phase 2).
 *
 *   npx tsx scripts/measure-keep-live.ts [--agents 8] [--only 32k-1000ms] [--json out.json]
 *
 * An in-process daemon runs the mock provider (model e2e-tool-heavy: tool calls with ~6 KB of
 * output, like bot chats). A DaemonClient behind ThrottledProxy plays the app with one of these
 * policies:
 *
 *   before        Phase 1: only the open chat is subscribed. Opening another bot chat fetches its
 *                 tail (50 items, full).
 *   live          Keep-live, normal mode: every bot chat is subscribed and streams live.
 *   constrained   Keep-live, constrained mode without compact (6a only): background chats are not
 *                 subscribed; each one fetches its delta once when its turn ends.
 *   compact       6a + 6b: as constrained, and background fetches omit large tool output.
 *
 * Per link profile and policy it records: bytes while all chats run one turn, when the open chat's
 * turn finished on the client, when every chat was current, the cost of opening a background chat
 * afterwards, and the same after the link drops for 10, 30 and 60 s while the chats work.
 */
import { writeFileSync } from "node:fs";
import { MockLoadTestAgentClient } from "../src/server/agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";
import { ThrottledProxy, type LinkProfile } from "../src/server/test-utils/throttled-proxy.js";

const args = process.argv.slice(2);
const agentCount = Number(argValue("--agents") ?? 8);
const jsonOut = argValue("--json");
const only = argValue("--only");
const onlyPolicy = argValue("--policy");
const dropouts = (argValue("--dropouts") ?? "10,30,60").split(",").map(Number).filter(Boolean);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const PROFILES: Array<{ name: string; profile: LinkProfile }> = [
  { name: "64k-300ms", profile: { bitsPerSecond: 64_000, rttMs: 300, jitterMs: 50 } },
  { name: "32k-1000ms", profile: { bitsPerSecond: 32_000, rttMs: 1000, jitterMs: 100 } },
];

type Policy = "before" | "live" | "constrained" | "compact";
const POLICIES: Policy[] = ["before", "live", "constrained", "compact"];

interface Cursor {
  epoch: string;
  seq: number;
}

interface Phase {
  bytesDown: number;
  visibleMs: number | null;
  allCurrentMs: number | null;
  openMs: number;
  openBytesDown: number;
}

interface Result {
  profile: string;
  policy: Policy;
  connectMs: number;
  connectBytesDown: number;
  turns: Phase;
  dropouts: Array<Phase & { seconds: number; reconnectMs: number | null }>;
}

async function main(): Promise<void> {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  } as Parameters<typeof createTestPaseoDaemon>[0]);
  const driver = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await driver.connect();
  const agentIds: string[] = [];
  for (let index = 0; index < agentCount; index += 1) {
    const agent = await driver.createAgent({
      provider: "mock",
      model: "e2e-tool-heavy",
      cwd: daemon.staticDir,
      title: `Bot ${index}`,
      labels: { bot: `bot-${index}`, "paseo.keep-live": "1" },
    });
    agentIds.push(agent.id);
  }
  // Real bot chats have history: three turns each.
  for (let turn = 0; turn < 3; turn += 1) {
    await runTurns(driver, agentIds, `seed ${turn}`);
  }

  const results: Result[] = [];
  for (const { name, profile } of PROFILES) {
    if (only && name !== only) continue;
    for (const policy of POLICIES) {
      if (onlyPolicy && policy !== onlyPolicy) continue;
      const result = await measure(daemon.port, driver, agentIds, name, profile, policy);
      results.push(result);
      console.error(JSON.stringify(result));
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ agentCount, results }, null, 2));
  printTable(results);
  await driver.close();
  await daemon.close();
}

/** Sends one prompt to each agent on the unthrottled driver and waits until all are idle. */
async function runTurns(driver: DaemonClient, agentIds: string[], text: string): Promise<void> {
  await Promise.all(agentIds.map((id) => driver.sendAgentMessage(id, text, {})));
  await Promise.all(agentIds.map((id) => driver.waitForFinish(id, 120_000)));
}

async function measure(
  port: number,
  driver: DaemonClient,
  agentIds: string[],
  profileName: string,
  profile: LinkProfile,
  policy: Policy,
): Promise<Result> {
  const proxy = new ThrottledProxy({ host: "127.0.0.1", port }, profile, { seed: 7 });
  const proxyPort = await proxy.listen();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${proxyPort}/ws`,
    reconnect: { enabled: true },
  });
  const takeDown = () => {
    const value = proxy.totals.down;
    proxy.resetCounters();
    return value;
  };
  const visibleId = agentIds[0]!;
  const backgroundIds = agentIds.slice(1);
  const keepLive = policy !== "before";
  // The app compacts background catch-up whenever the daemon supports it; "constrained" leaves it
  // off to show what 6a alone saves.
  const compactBackground = policy === "live" || policy === "compact";
  const subscribedIds = policy === "live" ? agentIds : [visibleId];
  const cursors = new Map<string, Cursor>();
  const completedAt = new Map<string, number>();
  const status = new Map<string, string>();
  const idleListeners: Array<(agentId: string) => void> = [];

  client.subscribeRawMessages((message) => {
    if (message.type !== "agent_update") return;
    const payload = message.payload as { kind?: string; agent?: { id: string; status: string } };
    if (payload.kind !== "upsert" || !payload.agent) return;
    const previous = status.get(payload.agent.id);
    status.set(payload.agent.id, payload.agent.status);
    if (previous === "running" && payload.agent.status !== "running") {
      for (const listener of idleListeners) listener(payload.agent.id);
    }
  });

  let started = Date.now();
  await client.connect();
  const agents = client.observeAgents({ scope: "active", page: { limit: 200 } });
  agents.subscribe({ snapshot: () => {}, update: () => {} });
  const ready: Promise<unknown>[] = [agents.ready];
  for (const agentId of subscribedIds) {
    const subscription = client.subscribeAgentTimeline(agentId, (message) => {
      if (message.type !== "agent_stream") return;
      const payload = message.payload as {
        seq?: number;
        epoch?: string;
        event?: { type?: string };
      };
      if (typeof payload.seq === "number" && payload.epoch) {
        const current = cursors.get(agentId);
        if (!current || payload.seq > current.seq) {
          cursors.set(agentId, { epoch: payload.epoch, seq: payload.seq });
        }
      }
      if (payload.event?.type === "turn_completed") completedAt.set(agentId, Date.now());
    });
    ready.push(subscription.ready);
  }
  await Promise.all(ready);
  // Initial catch-up: the open chat always; every keep-live chat in the new policies.
  const fetchTail = async (agentId: string, compact: boolean) => {
    const page = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 50,
      projection: "projected",
      ...(compact ? { compact: true } : {}),
    });
    if (page.endCursor && page.epoch) {
      cursors.set(agentId, { epoch: page.epoch, seq: page.endCursor.seq });
    }
  };
  const fetchAfter = async (agentId: string, compact: boolean) => {
    const cursor = cursors.get(agentId);
    if (!cursor) return fetchTail(agentId, compact);
    const page = await client.fetchAgentTimeline(agentId, {
      direction: "after",
      cursor,
      limit: 200,
      projection: "projected",
      ...(compact ? { compact: true } : {}),
    });
    if (page.endCursor)
      cursors.set(agentId, { epoch: page.epoch ?? cursor.epoch, seq: page.endCursor.seq });
    return undefined;
  };
  await fetchTail(visibleId, false);
  if (keepLive) {
    for (const agentId of backgroundIds) await fetchTail(agentId, compactBackground);
  }
  const connectMs = Date.now() - started;
  const connectBytesDown = takeDown();

  // Pull queue for constrained policies: one delta fetch per finished background turn, in order.
  const pulledAt = new Map<string, number>();
  let pulls = Promise.resolve();
  if (policy === "constrained" || policy === "compact") {
    idleListeners.push((agentId) => {
      if (agentId === visibleId) return;
      pulls = pulls.then(async () => {
        await fetchAfter(agentId, compactBackground).catch(() => undefined);
        pulledAt.set(agentId, Date.now());
        return undefined;
      });
    });
  }

  const backgroundCurrent = (since: number) => {
    if (policy === "before") return true;
    const doneAt = policy === "live" ? completedAt : pulledAt;
    return backgroundIds.every((id) => (doneAt.get(id) ?? 0) >= since);
  };

  // Opening a background chat once its turn is over.
  const openBackground = async (): Promise<{ ms: number; bytes: number }> => {
    takeDown();
    const openStart = Date.now();
    const agentId = backgroundIds[backgroundIds.length - 1]!;
    if (!keepLive) {
      await fetchTail(agentId, false);
    }
    // Keep-live chats are already current; opening one needs no fetch.
    return { ms: Date.now() - openStart, bytes: takeDown() };
  };

  // Phase 1: every chat runs one turn while the open chat is on screen.
  takeDown();
  started = Date.now();
  await Promise.all(agentIds.map((id) => driver.sendAgentMessage(id, "work", {})));
  await waitFor(() => (completedAt.get(visibleId) ?? 0) >= started, 180_000).catch(() => undefined);
  const visibleMs =
    (completedAt.get(visibleId) ?? 0) >= started ? completedAt.get(visibleId)! - started : null;
  await Promise.all(agentIds.map((id) => driver.waitForFinish(id, 120_000)));
  await waitFor(() => backgroundCurrent(started), 300_000).catch(() => undefined);
  const allCurrentMs = backgroundCurrent(started) ? Date.now() - started : null;
  await pulls;
  await sleep(500);
  const turnBytes = takeDown();
  const open = await openBackground();
  const turns: Phase = {
    bytesDown: turnBytes,
    visibleMs,
    allCurrentMs: policy === "before" ? null : allCurrentMs,
    openMs: open.ms,
    openBytesDown: open.bytes,
  };

  // Phase 2: dropouts while every chat works; then the app catches up, open chat first.
  const dropoutResults: Result["dropouts"] = [];
  const states: Array<{ at: number; status: string }> = [];
  const unsubscribe = client.subscribeConnectionStatus((state) => {
    states.push({ at: Date.now(), status: state.status });
  });
  const dropout = async (seconds: number): Promise<Result["dropouts"][number]> => {
    takeDown();
    const dropStart = Date.now();
    proxy.blackhole();
    await Promise.all(agentIds.map((id) => driver.sendAgentMessage(id, "work offline", {})));
    await Promise.all(agentIds.map((id) => driver.waitForFinish(id, 120_000)));
    await sleep(Math.max(0, seconds * 1000 - (Date.now() - dropStart)));
    proxy.restore();
    const restoredAt = Date.now();
    const dropped = states.some(
      (entry) => entry.at >= dropStart && entry.status === "disconnected",
    );
    if (dropped) {
      await waitFor(
        () => states.some((entry) => entry.at >= restoredAt && entry.status === "connected"),
        120_000,
      ).catch(() => undefined);
    }
    const reconnected = states.find(
      (entry) => entry.at >= restoredAt && entry.status === "connected",
    );
    let visibleCaughtUp: number | null = null;
    let allCaughtUp: number | null = null;
    if (dropped && reconnected) {
      // The socket was replaced: the app fetches what it missed, open chat first.
      await fetchAfter(visibleId, false).catch(() => undefined);
      visibleCaughtUp = Date.now() - restoredAt;
      if (keepLive) {
        for (const agentId of backgroundIds) {
          await fetchAfter(agentId, compactBackground).catch(() => undefined);
        }
        allCaughtUp = Date.now() - restoredAt;
      }
    } else if (!dropped) {
      // The dead path was shorter than detection: held data flows again on the same socket. The
      // open chat streams; constrained chats pull when their idle status arrives.
      await waitFor(() => (completedAt.get(visibleId) ?? 0) >= dropStart, 180_000).catch(
        () => undefined,
      );
      visibleCaughtUp =
        (completedAt.get(visibleId) ?? 0) >= dropStart ? Date.now() - restoredAt : null;
      if (keepLive) {
        await waitFor(() => backgroundCurrent(dropStart), 300_000).catch(() => undefined);
        await pulls;
        allCaughtUp = backgroundCurrent(dropStart) ? Date.now() - restoredAt : null;
      }
    }
    await sleep(500);
    const bytesDown = takeDown();
    const reopen = await openBackground();
    return {
      seconds,
      reconnectMs: reconnectDelay(dropped, reconnected?.at, restoredAt),
      bytesDown,
      visibleMs: visibleCaughtUp,
      allCurrentMs: allCaughtUp,
      openMs: reopen.ms,
      openBytesDown: reopen.bytes,
    };
  };
  for (const seconds of dropouts) dropoutResults.push(await dropout(seconds));
  unsubscribe();

  await client.close().catch(() => undefined);
  await proxy.close();
  return {
    profile: profileName,
    policy,
    connectMs,
    connectBytesDown,
    turns,
    dropouts: dropoutResults,
  };
}

function reconnectDelay(
  dropped: boolean,
  reconnectedAt: number | undefined,
  restoredAt: number,
): number | null {
  if (!dropped) return 0;
  return reconnectedAt === undefined ? null : reconnectedAt - restoredAt;
}

function printTable(results: Result[]): void {
  console.table(
    results.map((r) => ({
      profile: r.profile,
      policy: r.policy,
      "connect ms": r.connectMs,
      "connect KB": kb(r.connectBytesDown),
      "turn KB": kb(r.turns.bytesDown),
      "open chat done ms": r.turns.visibleMs,
      "all current ms": r.turns.allCurrentMs,
      "open bg ms": r.turns.openMs,
      "open bg KB": kb(r.turns.openBytesDown),
    })),
  );
  console.table(
    results.flatMap((r) =>
      r.dropouts.map((d) => ({
        profile: r.profile,
        policy: r.policy,
        "drop s": d.seconds,
        "reconnect ms": d.reconnectMs,
        "open chat ms": d.visibleMs,
        "all current ms": d.allCurrentMs,
        "catch-up KB": kb(d.bytesDown),
        "open bg ms": d.openMs,
        "open bg KB": kb(d.openBytesDown),
      })),
    ),
  );
}

function kb(bytes: number): number {
  return Math.round(bytes / 102.4) / 10;
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
