import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DaemonClient } from "./daemon-client.js";
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
  readonly createdAt = performance.now();
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  silent = false;
  private onMessage: (data: unknown) => void = () => {};
  private onOpen: () => void = () => {};
  private onClose: (event?: unknown) => void = () => {};
  private unanswered: Array<Record<string, unknown>> = [];

  readonly transport: DaemonTransport = {
    send: (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(frame);
      if (this.silent) this.unanswered.push(frame);
      else this.answer(frame);
    },
    close: (code?: number, reason?: string) => {
      this.closes.push({ code, reason });
    },
    // Like a real socket, removing a listener stops delivery to it.
    onMessage: (handler) => {
      const bound = (data: unknown) => handler(data, typeof data !== "string");
      this.onMessage = bound;
      return () => {
        if (this.onMessage === bound) this.onMessage = () => {};
      };
    },
    onOpen: (handler) => {
      this.onOpen = handler;
      return () => {
        if (this.onOpen === handler) this.onOpen = () => {};
      };
    },
    onClose: (handler) => {
      this.onClose = handler;
      return () => {
        if (this.onClose === handler) this.onClose = () => {};
      };
    },
    onError: () => () => {},
  };

  open(): void {
    this.onOpen();
  }

  /** Heartbeat pings and session pings get their pong. */
  private answer(frame: Record<string, unknown>): void {
    if (frame.type === "ping") this.onMessage(JSON.stringify({ type: "pong" }));
    const message = frame.message as { type?: string; requestId?: string } | undefined;
    if (frame.type === "session" && message?.type === "ping") {
      const now = Date.now();
      this.frame({
        type: "session",
        message: {
          type: "pong",
          payload: {
            requestId: message.requestId,
            clientSentAt: now,
            serverReceivedAt: now,
            serverSentAt: now,
          },
        },
      });
    }
  }

  /** The link comes back for this socket: what was queued is answered. */
  revive(): void {
    this.silent = false;
    for (const frame of this.unanswered.splice(0)) this.answer(frame);
  }

  frame(frame: unknown): void {
    this.onMessage(JSON.stringify(frame));
  }

  status(status: string): void {
    this.frame({ type: "session", message: { type: "status", payload: { status } } });
  }

  serverInfo(): void {
    this.frame({
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", serverId: "srv_race", hostname: null, version: null },
      },
    });
  }

  dies(code = 1006, reason = ""): void {
    this.onClose({ code, reason });
  }

  hellos(): number {
    return this.sent.filter((frame) => frame.type === "hello").length;
  }
}

const clients: DaemonClient[] = [];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(
  options: {
    race?: boolean;
    pathProbe?: (input: { url: string; timeoutMs: number }) => Promise<boolean>;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const client = new DaemonClient({
    url: "ws://daemon.test/ws",
    clientId: "clsk_phone",
    logger: noopLogger,
    reconnect: { pathProbe: options.pathProbe ?? false, race: options.race ?? true },
    transportFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket.transport;
    },
  });
  clients.push(client);
  const statuses: string[] = [];
  client.subscribeRawMessages((message) => {
    if (message.type === "status") statuses.push(String(message.payload.status));
  });
  return { client, sockets, statuses };
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

/** Connected, then the link goes silent and the 10 s heartbeat has been unanswered for 2 s. */
async function stuckAfterDeadSpot(client: DaemonClient, sockets: FakeSocket[]) {
  const first = await connectFirst(client, sockets);
  first.silent = true;
  await vi.advanceTimersByTimeAsync(12_000);
  expect(client.getConnectionState().status).toBe("connected");
  return first;
}

const totalHellos = (sockets: FakeSocket[]) => sockets.reduce((n, s) => n + s.hellos(), 0);

test("network back on a suspect socket: a second socket starts at once, the old one is kept", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  expect(sockets).toHaveLength(2);
  expect(first.closes).toEqual([]);
  expect(sockets[1]!.hellos()).toBe(0);
  expect(client.getConnectionState().status).toBe("connected");
});

test("old socket wins: its pong closes the second socket before its hello", async () => {
  const { client, sockets, statuses } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  // TCP retransmits on the old socket: the pongs arrive, then the stream it was carrying.
  expect(second.closes).toEqual([]);
  first.revive();
  expect(second.closes).toEqual([{ code: 1000, reason: "Not needed" }]);
  first.status("stream_chunk");
  expect(statuses).toContain("stream_chunk");
  // The second socket opening late changes nothing.
  second.open();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(second.hellos()).toBe(0);
  expect(first.closes).toEqual([]);
  expect(sockets).toHaveLength(2);
  expect(client.getConnectionState().status).toBe("connected");
  expect(statuses.filter((s) => s === "stream_chunk")).toHaveLength(1);
  expect(client.getConnectionRaceStats()).toMatchObject({ started: 1, oldWon: 1, newWon: 0 });
});

test("new socket wins: it opens first, the old one is closed and exactly one hello goes", async () => {
  const { client, sockets, statuses } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  second.open();
  expect(first.closes).toEqual([{ code: 1001, reason: "Replaced by a faster connection" }]);
  await vi.advanceTimersByTimeAsync(0);
  // No third socket: the open second socket is the reconnect attempt.
  expect(sockets).toHaveLength(2);
  expect(second.hellos()).toBe(1);
  expect(totalHellos(sockets)).toBe(2); // the first connect + the takeover
  second.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
  // A late frame on the replaced socket is not delivered.
  first.status("late_from_old");
  second.status("from_new");
  expect(statuses).not.toContain("late_from_old");
  expect(statuses.filter((s) => s === "from_new")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(2);
  expect(client.getConnectionRaceStats()).toMatchObject({ started: 1, oldWon: 0, newWon: 1 });
});

test("old socket dies mid-race: the second socket takes over at once", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  first.dies(1006, "");
  await vi.advanceTimersByTimeAsync(0);
  // Adopted while still connecting: no backoff, no third socket.
  expect(sockets).toHaveLength(2);
  expect(client.getConnectionState().status).toBe("connecting");
  second.open();
  expect(second.hellos()).toBe(1);
  second.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(2);
  expect(second.closes).toEqual([]);
});

test("both die: the client reconnects as without a race", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  second.dies(1006, "");
  expect(client.getConnectionState().status).toBe("connected");
  expect(client.getConnectionRaceStats()).toMatchObject({ dropped: 1 });
  first.dies(1006, "");
  expect(client.getConnectionState().status).toBe("disconnected");
  // The normal 1 s first step after a plain close.
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(3);
  sockets[2]!.open();
  sockets[2]!.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
  expect(totalHellos(sockets)).toBe(2);
});

test("both die, old first: the adopted second socket's failure reconnects as usual", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  first.dies(1006, "");
  await vi.advanceTimersByTimeAsync(0);
  sockets[1]!.dies(1006, "");
  expect(client.getConnectionState().status).toBe("disconnected");
  await vi.advanceTimersByTimeAsync(2_500);
  expect(sockets.length).toBe(3);
  expect(totalHellos(sockets)).toBe(1);
});

test("a second socket that does not open in time is dropped; the old one stays", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  // No RTT sample yet (250 ms assumed): max(2 s, 1.5 s + 4 x 250 ms) = 2.5 s.
  await vi.advanceTimersByTimeAsync(2_499);
  expect(second.closes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(second.closes).toEqual([{ code: 1000, reason: "Not needed" }]);
  expect(first.closes).toEqual([]);
  expect(client.getConnectionRaceStats()).toMatchObject({ dropped: 1 });
  // The old socket coming back later is used as before.
  first.status("back");
  first.revive();
  expect(client.getConnectionState().status).toBe("connected");
});

test("a healthy socket answers the verify ping within the grace: no second socket", async () => {
  const { client, sockets } = setup();
  await connectFirst(client, sockets);
  await vi.advanceTimersByTimeAsync(3_000);
  client.ensureConnected({ verify: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(1);
  expect(client.getConnectionRaceStats().started).toBe(0);
});

test("a quiet socket that does not answer within the grace gets a second socket", async () => {
  const { client, sockets } = setup();
  const first = await connectFirst(client, sockets);
  await vi.advanceTimersByTimeAsync(3_000);
  first.silent = true;
  client.ensureConnected({ verify: true });
  // No RTT sample yet: grace = 1.5 x 250 + 50 ms.
  await vi.advanceTimersByTimeAsync(424);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
});

test("an attempt that has not opened races a fresh one; the first to open is used", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  first.dies(1006, "");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets).toHaveLength(2);
  const stuckAttempt = sockets[1]!;
  await vi.advanceTimersByTimeAsync(1_000);
  client.ensureConnected({ verify: true });
  expect(sockets).toHaveLength(3);
  const fresh = sockets[2]!;
  fresh.open();
  expect(stuckAttempt.closes).toEqual([{ code: 1001, reason: "Replaced by a faster attempt" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(3);
  expect(fresh.hellos()).toBe(1);
  expect(stuckAttempt.hellos()).toBe(0);
  fresh.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
});

test("an attempt that opens first keeps its place; the fresh one is closed unused", async () => {
  const { client, sockets } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  first.dies(1006, "");
  await vi.advanceTimersByTimeAsync(2_000);
  const attempt = sockets[1]!;
  client.ensureConnected({ verify: true });
  const fresh = sockets[2]!;
  attempt.open();
  expect(fresh.closes).toEqual([{ code: 1000, reason: "Not needed" }]);
  expect(attempt.hellos()).toBe(1);
  fresh.open();
  expect(fresh.hellos()).toBe(0);
  attempt.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
});

test("a custom transport is not raced unless asked", async () => {
  // Desktop socket/pipe transports come in as a transportFactory: no race by default.
  const own: FakeSocket[] = [];
  const plain = new DaemonClient({
    url: "ws://daemon.test/ws",
    clientId: "clsk_desktop",
    logger: noopLogger,
    reconnect: { pathProbe: false },
    transportFactory: () => {
      const socket = new FakeSocket();
      own.push(socket);
      return socket.transport;
    },
  });
  clients.push(plain);
  const first = await stuckAfterDeadSpot(plain, own);
  plain.ensureConnected({ verify: true });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(own).toHaveLength(1);
  expect(first.closes).toEqual([]);
});

test("closing the client mid-race closes the second socket", async () => {
  const { client, sockets } = setup();
  await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  await client.close();
  expect(sockets[1]!.closes).toEqual([{ code: 1000, reason: "Not needed" }]);
  expect(sockets[1]!.hellos()).toBe(0);
});

test("the path probe leaves the choice to a race in progress", async () => {
  const probe = vi.fn(async () => true);
  const { client, sockets } = setup({ pathProbe: probe });
  const first = await connectFirst(client, sockets);
  first.silent = true;
  await vi.advanceTimersByTimeAsync(15_900);
  client.ensureConnected({ verify: true });
  expect(sockets).toHaveLength(2);
  // The heartbeat misses at 16 s and the probe opens: without a race it would replace the socket.
  await vi.advanceTimersByTimeAsync(200);
  expect(probe).toHaveBeenCalled();
  expect(first.closes).toEqual([]);
  expect(sockets).toHaveLength(2);
  // The old socket answers: it is kept, nothing was replaced.
  first.revive();
  first.status("back");
  await vi.advanceTimersByTimeAsync(3_000);
  expect(first.closes).toEqual([]);
  expect(sockets[1]!.hellos()).toBe(0);
  expect(client.getConnectionState().status).toBe("connected");
});

test("old socket wins on any frame: a stream frame closes the second socket before its hello", async () => {
  const { client, sockets, statuses } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  // The daemon's direction is back first (no pong yet): that is enough for the old socket.
  first.status("stream_chunk");
  expect(second.closes).toEqual([{ code: 1000, reason: "Not needed" }]);
  expect(statuses.filter((s) => s === "stream_chunk")).toHaveLength(1);
  // The second socket opening late changes nothing.
  second.open();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(second.hellos()).toBe(0);
  expect(first.closes).toEqual([]);
  expect(sockets).toHaveLength(2);
  expect(client.getConnectionRaceStats()).toMatchObject({ started: 1, oldWon: 1, newWon: 0 });
});

test("second socket opening while the old one is silent takes over at once (no hold)", async () => {
  const { client, sockets, statuses } = setup();
  const first = await stuckAfterDeadSpot(client, sockets);
  client.ensureConnected({ verify: true });
  const second = sockets[1]!;
  second.open();
  // No wait for a pong on the old socket: it is closed the moment the second socket opens.
  expect(first.closes).toEqual([{ code: 1001, reason: "Replaced by a faster connection" }]);
  // A frame on the old socket after that is too late and not delivered.
  first.status("late_stream_chunk");
  await vi.advanceTimersByTimeAsync(1);
  expect(second.hellos()).toBe(1);
  expect(sockets).toHaveLength(2);
  second.serverInfo();
  expect(client.getConnectionState().status).toBe("connected");
  expect(statuses).not.toContain("late_stream_chunk");
  expect(client.getConnectionRaceStats()).toMatchObject({ oldWon: 0, newWon: 1 });
});
