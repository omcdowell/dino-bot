/**
 * Per-socket priority lanes for clients with the priority_sync capability (PS2).
 *
 * Messages are queued as JSON text BEFORE frame compression: a socket's zstd stream fixes the order
 * once a frame is compressed, so priority has to be decided here. Lane 0 (control) always goes at
 * once. Lower lanes go only while the socket's own send buffer is below a low watermark, so a later
 * high-priority message can still overtake: once bytes sit in the socket buffer nothing can.
 *
 * Ordering domains: messages that depend on each other's order (one agent's stream and its
 * tail/after pages; the directory) share a domain, and all queued messages of one domain always sit
 * in ONE lane: a new message joins the higher of its own lane and the lane its domain already
 * occupies, and promote() moves a whole domain up. So no lane order or starvation pick can reorder
 * a domain.
 *
 * Coalescing: everything that is ready in one drain goes out as one batch frame, up to
 * BATCH_MAX_BYTES (`{"type":"batch","m":[...]}`), instead of one frame per message.
 *
 * Live coalescing (B1c/PS2d): live stream messages may be enqueued with `linger`: they wait up to
 * LINGER_MS for company instead of going out on their own, so a burst of live rows becomes one frame.
 * Any non-lingering message (first text of a turn, turn end, control, replies) drains the queue at
 * once and carries everything lingering with it; so does BATCH_MAX_BYTES of lingering bytes.
 *
 * Starvation guard: when the head of a lower lane has waited STARVATION_MS while higher lanes kept
 * the socket busy, it gets one batch, then strict order resumes.
 */
export const LANE_COUNT = 7;
export const BATCH_MAX_BYTES = 16 * 1024;
export const STARVATION_MS = 250;
export const DEFAULT_LOW_WATER_BYTES = 32 * 1024;
export const LINGER_MS = 80;

export type Lane = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface QueuedMessage {
  payload: string;
  bytes: number;
  domain: string | null;
  enqueuedAt: number;
  onSent?: () => void;
}

export interface PrioritySendQueueOptions {
  /** Bytes still waiting in the socket (and its compressor) that the queue cannot reorder. */
  pendingBytes: () => number;
  /** Hands one frame payload to the socket (JSON text of one message or of a batch). */
  send: (payload: string, messages: number) => void;
  lowWaterBytes?: number;
  lingerMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class PrioritySendQueue {
  private readonly lanes: QueuedMessage[][] = Array.from({ length: LANE_COUNT }, () => []);
  private readonly domainLane = new Map<string, { lane: Lane; count: number }>();
  private readonly lowWater: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private timer: unknown = null;
  private lingerTimer: unknown = null;
  private lingerBytes = 0;
  private readonly lingerMs: number;
  private immediate = false;
  private closed = false;
  /** Counters for diagnostics and tests. */
  readonly stats = { frames: 0, messages: 0, batches: 0, starvationPicks: 0, promotions: 0 };

  constructor(private readonly options: PrioritySendQueueOptions) {
    this.lowWater = options.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
    this.lingerMs = options.lingerMs ?? LINGER_MS;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get queuedMessages(): number {
    return this.lanes.reduce((sum, lane) => sum + lane.length, 0);
  }

  laneOfDomain(domain: string): Lane | null {
    return this.domainLane.get(domain)?.lane ?? null;
  }

  enqueue(
    payload: string,
    lane: Lane,
    domain: string | null = null,
    onSent?: () => void,
    linger = false,
  ): void {
    if (this.closed) return;
    let target = lane;
    if (domain !== null) {
      const held = this.domainLane.get(domain);
      if (held) {
        if (held.lane < target) target = held.lane;
        else if (held.lane > target) this.moveDomain(domain, held.lane, target);
        const current = this.domainLane.get(domain)!;
        current.count += 1;
      } else {
        this.domainLane.set(domain, { lane: target, count: 1 });
      }
    }
    this.lanes[target]!.push({
      payload,
      bytes: Buffer.byteLength(payload),
      domain,
      enqueuedAt: this.now(),
      ...(onSent ? { onSent } : {}),
    });
    if (!linger || lane === 0) {
      this.requestDrain();
      return;
    }
    this.lingerBytes += Buffer.byteLength(payload);
    if (this.lingerBytes >= BATCH_MAX_BYTES) this.requestDrain();
    else if (this.lingerTimer === null)
      this.lingerTimer = this.schedule(() => {
        this.lingerTimer = null;
        this.drain();
      }, this.lingerMs);
  }

  /** Moves every queued message of `domain` up to `lane` (keeping their order). */
  promote(domain: string, lane: Lane): void {
    const held = this.domainLane.get(domain);
    if (!held || held.lane <= lane) return;
    this.moveDomain(domain, held.lane, lane);
    this.stats.promotions += 1;
    this.requestDrain();
  }

  /** Called when the socket's buffer may have room again. */
  poke(): void {
    this.requestDrain();
  }

  close(): void {
    this.closed = true;
    for (const lane of this.lanes) lane.length = 0;
    this.domainLane.clear();
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.clearLinger();
  }

  private clearLinger(): void {
    if (this.lingerTimer !== null) this.cancel(this.lingerTimer);
    this.lingerTimer = null;
    this.lingerBytes = 0;
  }

  /** Sends everything queued now, in lane order, ignoring the watermark (before a binary frame). */
  flushAll(): void {
    if (this.closed) return;
    this.clearLinger();
    for (let lane = 0; lane < LANE_COUNT; lane += 1)
      while (this.lanes[lane]!.length > 0) this.sendBatch(lane as Lane);
  }

  /** Synchronous drain (tests, and the scheduled callback). */
  drain(): void {
    this.immediate = false;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.clearLinger();
    if (this.closed) return;
    // Lane 0 never waits for the watermark.
    while (this.lanes[0]!.length > 0) this.sendBatch(0);
    while (this.hasLowerWork()) {
      if (this.options.pendingBytes() >= this.lowWater) {
        this.timer = this.schedule(() => this.drain(), 10);
        return;
      }
      const starving = this.starvingLane();
      if (starving !== null) {
        this.stats.starvationPicks += 1;
        this.sendBatch(starving);
        continue;
      }
      const lane = this.lanes.findIndex((queue, index) => index > 0 && queue.length > 0);
      this.sendBatch(lane as Lane);
    }
  }

  private hasLowerWork(): boolean {
    for (let index = 1; index < LANE_COUNT; index += 1) if (this.lanes[index]!.length > 0) return true;
    return false;
  }

  private starvingLane(): Lane | null {
    const first = this.lanes.findIndex((queue, index) => index > 0 && queue.length > 0);
    const limit = this.now() - STARVATION_MS;
    for (let index = first + 1; index < LANE_COUNT; index += 1) {
      const head = this.lanes[index]![0];
      if (head && head.enqueuedAt <= limit) return index as Lane;
    }
    return null;
  }

  private requestDrain(): void {
    if (this.immediate || this.closed) return;
    this.immediate = true;
    // Same-tick messages coalesce into one batch.
    queueMicrotask(() => {
      if (this.immediate) this.drain();
    });
  }

  private moveDomain(domain: string, from: Lane, to: Lane): void {
    const source = this.lanes[from]!;
    const moved: QueuedMessage[] = [];
    for (let index = 0; index < source.length; ) {
      if (source[index]!.domain === domain) moved.push(source.splice(index, 1)[0]!);
      else index += 1;
    }
    this.lanes[to]!.push(...moved);
    const held = this.domainLane.get(domain);
    if (held) held.lane = to;
  }

  /** Takes messages from the head of `lane` (and, for a batch, from the same lane only). */
  private sendBatch(lane: Lane): void {
    const queue = this.lanes[lane]!;
    const taken: QueuedMessage[] = [];
    let bytes = 0;
    while (queue.length > 0) {
      const next = queue[0]!;
      if (taken.length > 0 && bytes + next.bytes > BATCH_MAX_BYTES) break;
      taken.push(queue.shift()!);
      bytes += next.bytes;
    }
    for (const message of taken) this.release(message);
    const payload =
      taken.length === 1
        ? taken[0]!.payload
        : `{"type":"batch","m":[${taken.map((message) => message.payload).join(",")}]}`;
    this.stats.frames += 1;
    this.stats.messages += taken.length;
    if (taken.length > 1) this.stats.batches += 1;
    this.options.send(payload, taken.length);
    for (const message of taken) message.onSent?.();
  }

  private release(message: QueuedMessage): void {
    if (message.domain === null) return;
    const held = this.domainLane.get(message.domain);
    if (!held) return;
    held.count -= 1;
    if (held.count <= 0) this.domainLane.delete(message.domain);
  }
}
