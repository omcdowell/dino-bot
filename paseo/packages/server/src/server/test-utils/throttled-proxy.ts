import net from "node:net";

/**
 * A slow, lossy link between a client and the daemon, in user space (no `tc`, no root).
 *
 * - bandwidth: each direction is a FIFO serialised at `bitsPerSecond` (1500-byte segments);
 * - delay: half the round trip each way, plus up to `jitterMs`;
 * - loss: TCP never shows loss to the application, it shows a stall. A "lost" segment is
 *   delivered after a retransmission timeout (max(250 ms, 2 x RTT)) and everything behind it
 *   waits (head-of-line blocking), which is what a WebSocket over TCP sees;
 * - outage: `blackhole()` holds both directions without closing (a dead path: the socket looks
 *   open, nothing arrives); `restore()` releases what was held, as TCP retransmission would;
 * - drops: `dropAll()` resets every connection; `strandAll()` leaves clients on dead sockets.
 */
export interface LinkProfile {
  bitsPerSecond?: number;
  rttMs?: number;
  jitterMs?: number;
  loss?: number;
}

interface Direction {
  freeAt: number;
  lastDeliveryAt: number;
  pending: Array<{ at: number; chunk: Buffer }>;
  timer: NodeJS.Timeout | null;
  bytes: number;
}

interface Pair {
  client: net.Socket;
  server: net.Socket;
  up: Direction;
  down: Direction;
}

const SEGMENT_BYTES = 1500;

export class ThrottledProxy {
  private readonly pairs = new Set<Pair>();
  private server: net.Server | null = null;
  private held = false;
  private random: () => number;
  totals = { up: 0, down: 0, connections: 0 };

  constructor(
    private readonly target: { host: string; port: number },
    private profile: LinkProfile = {},
    options: { seed?: number } = {},
  ) {
    this.random = seededRandom(options.seed ?? 1);
  }

  async listen(port = 0): Promise<number> {
    this.server = net.createServer((client) => this.accept(client));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("proxy has no port");
    return address.port;
  }

  setProfile(profile: LinkProfile): void {
    this.profile = profile;
  }

  resetCounters(): void {
    this.totals = { up: 0, down: 0, connections: 0 };
  }

  /** The path goes dead: sockets stay open, nothing is delivered. */
  blackhole(): void {
    this.held = true;
  }

  /** The path comes back; held data flows again. */
  restore(): void {
    this.held = false;
    const now = Date.now();
    for (const pair of this.pairs) {
      for (const direction of [pair.up, pair.down]) {
        direction.freeAt = Math.max(direction.freeAt, now);
        direction.lastDeliveryAt = Math.max(direction.lastDeliveryAt, now);
        for (const item of direction.pending) item.at = Math.max(item.at, now);
        this.schedule(pair, direction);
      }
    }
  }

  /**
   * Strands every open connection, as after a laptop sleeps: the daemon has dropped its end, but
   * the client hears nothing (no FIN, no RST) and whatever it sends vanishes. New connections work.
   */
  strandAll(): void {
    for (const pair of this.pairs) {
      for (const direction of [pair.up, pair.down]) {
        if (direction.timer) clearTimeout(direction.timer);
        direction.timer = null;
        direction.pending = [];
      }
      pair.server.removeAllListeners();
      pair.server.on("error", () => undefined);
      pair.server.destroy();
      pair.client.removeAllListeners("data");
      pair.client.on("data", () => undefined);
    }
    this.pairs.clear();
  }

  /** Resets every connection (a hard drop: Wi-Fi to cellular, lift doors closing). */
  dropAll(): void {
    for (const pair of this.pairs) {
      pair.client.resetAndDestroy();
      pair.server.resetAndDestroy();
    }
    this.pairs.clear();
  }

  get openConnections(): number {
    return this.pairs.size;
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private accept(client: net.Socket): void {
    const server = net.connect(this.target.port, this.target.host);
    const pair: Pair = { client, server, up: newDirection(), down: newDirection() };
    this.pairs.add(pair);
    this.totals.connections += 1;
    client.setNoDelay(true);
    server.setNoDelay(true);
    client.on("data", (chunk) => this.enqueue(pair, pair.up, chunk, true));
    server.on("data", (chunk) => this.enqueue(pair, pair.down, chunk, false));
    const end = () => {
      if (!this.pairs.delete(pair)) return;
      for (const direction of [pair.up, pair.down]) {
        if (direction.timer) clearTimeout(direction.timer);
      }
      client.destroy();
      server.destroy();
    };
    client.on("close", end);
    server.on("close", end);
    client.on("error", end);
    server.on("error", end);
  }

  private enqueue(pair: Pair, direction: Direction, chunk: Buffer, up: boolean): void {
    direction.bytes += chunk.length;
    if (up) this.totals.up += chunk.length;
    else this.totals.down += chunk.length;
    const { bitsPerSecond, rttMs = 0, jitterMs = 0, loss = 0 } = this.profile;
    const now = Date.now();
    for (let offset = 0; offset < chunk.length; offset += SEGMENT_BYTES) {
      const segment = chunk.subarray(offset, offset + SEGMENT_BYTES);
      const sendStart = Math.max(now, direction.freeAt);
      const serialisation = bitsPerSecond ? (segment.length * 8 * 1000) / bitsPerSecond : 0;
      direction.freeAt = sendStart + serialisation;
      let at = direction.freeAt + rttMs / 2 + this.random() * jitterMs;
      if (loss > 0 && this.random() < loss) at += Math.max(250, rttMs * 2);
      at = Math.max(at, direction.lastDeliveryAt);
      direction.lastDeliveryAt = at;
      direction.pending.push({ at, chunk: Buffer.from(segment) });
    }
    this.schedule(pair, direction);
  }

  private schedule(pair: Pair, direction: Direction): void {
    if (direction.timer || this.held || direction.pending.length === 0) return;
    const wait = Math.max(0, direction.pending[0].at - Date.now());
    direction.timer = setTimeout(() => {
      direction.timer = null;
      if (this.held) return;
      const target = direction === pair.up ? pair.server : pair.client;
      const now = Date.now();
      while (direction.pending.length > 0 && direction.pending[0].at <= now) {
        const item = direction.pending.shift()!;
        if (!target.destroyed) target.write(item.chunk);
      }
      this.schedule(pair, direction);
    }, wait);
  }
}

function newDirection(): Direction {
  return { freeAt: 0, lastDeliveryAt: 0, pending: [], timer: null, bytes: 0 };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
