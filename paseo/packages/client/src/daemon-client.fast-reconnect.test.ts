import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMemorySessionTokenStore, DaemonClient } from "./daemon-client.js";
import type { DaemonTransport } from "./daemon-client-transport-types.js";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
} as never;

/** One fake socket to the daemon: records what the client sends, answers pings unless silent. */
class FakeSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly openedAt = performance.now();
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  silent = false;
  private onMessage: (data: unknown) => void = () => {};
  private onOpen: () => void = () => {};
  private onClose: (event?: unknown) => void = () => {};

  constructor(readonly headers: Record<string, string> | undefined) {}

  readonly transport: DaemonTransport = {
    send: (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(frame);
      if (frame.type === "ping" && !this.silent) this.onMessage(JSON.stringify({ type: "pong" }));
    },
    close: (code?: number, reason?: string) => {
      this.closes.push({ code, reason });
    },
    onMessage: (handler) => {
      this.onMessage = (data) => handler(data, typeof data !== "string");
      return () => {};
    },
    onOpen: (handler) => {
      this.onOpen = handler;
      return () => {};
    },
    onClose: (handler) => {
      this.onClose = handler;
      return () => {};
    },
    onError: () => () => {},
  };

  open(): void {
    this.onOpen();
  }

  frame(frame: unknown): void {
    this.onMessage(JSON.stringify(frame));
  }

  serverInfo(): void {
    this.frame({
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", serverId: "srv_fast", hostname: null, version: null },
      },
    });
  }

  daemonCloses(code: number, reason: string): void {
    this.onClose({ code, reason });
  }

  hello(): Record<string, unknown> | undefined {
    return this.sent.find((frame) => frame.type === "hello");
  }
}

const clients: DaemonClient[] = [];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  // No jitter: every delay is its nominal value.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(options: {
  pathProbe?: boolean | ((input: { url: string; timeoutMs: number }) => Promise<boolean>);
  password?: string;
  sessionTokens?: ReturnType<typeof createMemorySessionTokenStore>;
}) {
  const sockets: FakeSocket[] = [];
  const client = new DaemonClient({
    url: "ws://daemon.test/ws",
    clientId: "clsk_phone",
    logger: noopLogger,
    ...(options.password ? { password: options.password } : {}),
    ...(options.sessionTokens ? { sessionTokens: options.sessionTokens } : {}),
    reconnect: { pathProbe: options.pathProbe ?? false },
    transportFactory: ({ headers }) => {
      const socket = new FakeSocket(headers);
      sockets.push(socket);
      return socket.transport;
    },
  });
  clients.push(client);
  return { client, sockets };
}

async function connectFirst(client: DaemonClient, sockets: FakeSocket[]): Promise<FakeSocket> {
  const connected = client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const first = sockets[0]!;
  first.open();
  first.serverInfo();
  await connected;
  return first;
}

function attemptTimesAfter(sockets: FakeSocket[], from: number): number[] {
  return sockets.slice(1).map((socket) => Math.round(socket.openedAt - from));
}

function firstDisconnectAt(client: DaemonClient): () => number {
  let at = -1;
  client.subscribeConnectionStatus((state) => {
    if (state.status === "disconnected" && at < 0) at = performance.now();
  });
  return () => at;
}

test("after a liveness teardown it retries every ~0.75 s, dropping attempts that do not open", async () => {
  const { client, sockets } = setup({});
  const first = await connectFirst(client, sockets);
  const disconnectedAt = firstDisconnectAt(client);
  first.silent = true;
  // Ping at 10 s, silent until 16 s; the re-probe goes at once and is silent until 22 s.
  await vi.advanceTimersByTimeAsync(22_100);
  expect(client.getConnectionState().status).toBe("disconnected");
  const teardownAt = disconnectedAt();
  expect(Math.round(teardownAt)).toBeGreaterThanOrEqual(22_000);

  // Nothing answers: each attempt is dropped 2.5 s after it started (no RTT sample yet), and the
  // next one goes 0.75 s later, instead of 1 s, 2 s, 4 s ... with a 15 s connect timeout each.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(attemptTimesAfter(sockets, teardownAt)).toEqual([750, 4000, 7250, 10500, 13750, 17000]);
});

test("after the fast window it backs off as before", async () => {
  const { client, sockets } = setup({});
  const first = await connectFirst(client, sockets);
  const disconnectedAt = firstDisconnectAt(client);
  first.silent = true;
  await vi.advanceTimersByTimeAsync(22_100);
  const teardownAt = disconnectedAt();
  await vi.advanceTimersByTimeAsync(120_000);
  const times = attemptTimesAfter(sockets, teardownAt);
  const inWindow = times.filter((t) => t < 60_000);
  const after = times.filter((t) => t >= 60_000);
  expect(inWindow.length).toBeGreaterThanOrEqual(18);
  // Past the window: the capped 15 s backoff plus the 15 s connect timeout per attempt.
  expect(after.length).toBeLessThanOrEqual(3);
  for (let i = 1; i < after.length; i += 1) {
    expect(after[i]! - after[i - 1]!).toBeGreaterThanOrEqual(15_000);
  }
});

test("a socket that comes back resets the schedule", async () => {
  const { client, sockets } = setup({});
  const first = await connectFirst(client, sockets);
  first.silent = true;
  await vi.advanceTimersByTimeAsync(22_000 + 800);
  const second = sockets[1]!;
  second.open();
  second.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
  // A later plain transport close (not a liveness teardown) uses the normal 1 s first step.
  const closedAt = performance.now();
  second.daemonCloses(1006, "");
  await vi.advanceTimersByTimeAsync(1_500);
  expect(attemptTimesAfter(sockets.slice(1), closedAt)).toEqual([1000]);
});

test("while a heartbeat is unanswered, a fresh socket that opens replaces the stuck one at once", async () => {
  const probe = vi.fn(async () => true);
  const { client, sockets } = setup({ pathProbe: probe });
  const first = await connectFirst(client, sockets);
  first.silent = true;
  // First heartbeat goes unanswered at 16 s: the probe runs and opens.
  await vi.advanceTimersByTimeAsync(16_050);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(first.closes).toEqual([{ code: 1001, reason: "Liveness check timed out" }]);
  // The new attempt goes at once (not after the 1 s backoff, nor at 22 s).
  expect(sockets).toHaveLength(2);
  expect(Math.round(sockets[1]!.openedAt / 10)).toBe(1600);
});

test("probes about once a second and leaves the socket alone while nothing opens", async () => {
  const probe = vi.fn(async () => false);
  const { client, sockets } = setup({ pathProbe: probe });
  const first = await connectFirst(client, sockets);
  first.silent = true;
  await vi.advanceTimersByTimeAsync(21_900);
  expect(client.getConnectionState().status).toBe("connected");
  expect(probe.mock.calls.length).toBeGreaterThanOrEqual(5);
  expect(probe.mock.calls.length).toBeLessThanOrEqual(7);
  // The second heartbeat still tears it down as before.
  await vi.advanceTimersByTimeAsync(200);
  expect(client.getConnectionState().status).toBe("disconnected");
});

test("stops probing as soon as the old socket shows life", async () => {
  const probe = vi.fn(async () => false);
  const { client, sockets } = setup({ pathProbe: probe });
  const first = await connectFirst(client, sockets);
  first.silent = true;
  await vi.advanceTimersByTimeAsync(17_100);
  const callsSoFar = probe.mock.calls.length;
  expect(callsSoFar).toBeGreaterThan(0);
  first.silent = false;
  first.serverInfo();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(probe.mock.calls.length).toBe(callsSoFar);
  expect(client.getConnectionState().status).toBe("connected");
});

test("keeps the session token the daemon issues and presents it instead of the password", async () => {
  const store = createMemorySessionTokenStore();
  const { client, sockets } = setup({ password: "correct-password", sessionTokens: store });
  const connected = client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const first = sockets[0]!;
  first.open();
  expect(first.hello()?.auth).toEqual({ kind: "password", password: "correct-password" });
  expect(first.hello()?.capabilities).toMatchObject({ session_tokens: true });
  expect(first.headers?.Authorization).toBe("Bearer correct-password");
  first.frame({ type: "session.token", token: "pst1.id.secret", expiresAt: Date.now() + 1000 });
  first.serverInfo();
  await connected;
  expect(store.get()).toBe("pst1.id.secret");

  first.daemonCloses(1006, "");
  await vi.advanceTimersByTimeAsync(1_000);
  const second = sockets[1]!;
  second.open();
  expect(second.hello()?.auth).toEqual({ kind: "sessionToken", token: "pst1.id.secret" });
  // No password on the upgrade either.
  expect(second.headers?.Authorization).toBeUndefined();
});

test("drops a refused session token and goes again with the password at once", async () => {
  const store = createMemorySessionTokenStore("pst1.stale.secret");
  const { client, sockets } = setup({ password: "correct-password", sessionTokens: store });
  void client.connect().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const first = sockets[0]!;
  first.open();
  expect(first.hello()?.auth).toEqual({ kind: "sessionToken", token: "pst1.stale.secret" });
  first.frame({ type: "hello.rejected", reason: "session_token_invalid", accepts: ["password"] });
  first.daemonCloses(4401, "Session token invalid");
  expect(store.get()).toBeNull();
  expect(client.authFailureReason).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  const second = sockets[1]!;
  expect(Math.round(second.openedAt - first.openedAt)).toBe(0);
  second.open();
  expect(second.hello()?.auth).toEqual({ kind: "password", password: "correct-password" });
});

test("drops the token when an older daemon closes the hello as invalid", async () => {
  const store = createMemorySessionTokenStore("pst1.old.secret");
  const { client, sockets } = setup({ password: "correct-password", sessionTokens: store });
  void client.connect().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  sockets[0]!.open();
  sockets[0]!.daemonCloses(4002, "Invalid hello");
  expect(store.get()).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1]!.open();
  expect(sockets[1]!.hello()?.auth).toEqual({ kind: "password", password: "correct-password" });
});

test("a wrong password is still an auth failure that stops reconnecting", async () => {
  const { client, sockets } = setup({ password: "wrong" });
  const connected = client.connect().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  sockets[0]!.open();
  sockets[0]!.frame({
    type: "hello.rejected",
    reason: "incorrect_password",
    accepts: ["password"],
  });
  sockets[0]!.daemonCloses(4401, "Incorrect password");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(client.authFailureReason).toBe("incorrect_password");
  expect(sockets).toHaveLength(1);
  expect(await connected).toBeInstanceOf(Error);
});
