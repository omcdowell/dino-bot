import { createHash } from "node:crypto";
import { PUSH_CHECK_MS, PUSH_KINDS, PUSH_LEASE_MS, pushEventName, type PushKind } from "../shared/push-rpc";

export type Emit = (name: string, data: unknown) => void;

/**
 * Pushes each bots-home kind (previews, workers, quiet) to the apps when it changes.
 * `publish` is called with every freshly computed value, from RPC handlers and from the
 * watch loop; a value that differs from the last one bumps the kind's revision and is emitted.
 * The loop runs only while a client called within PUSH_LEASE_MS, so an idle host does no work.
 */
export class BotsPush {
  private readonly revs: Record<PushKind, number> = { previews: 0, workers: 0, quiet: 0 };
  private readonly hashes = new Map<PushKind, string>();
  private leaseUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly emit: Emit | undefined,
    private readonly compute: Record<PushKind, () => Promise<unknown>>,
    private readonly options: { now?: () => number; checkMs?: number; leaseMs?: number; onError?: (error: unknown) => void } = {},
  ) {}

  get pushes(): boolean {
    return typeof this.emit === "function";
  }

  revisions(): Record<PushKind, number> {
    return { ...this.revs };
  }

  /** A client asked for data: keep watching for a while. */
  touch(): void {
    if (!this.pushes || this.stopped) return;
    this.leaseUntil = this.now() + (this.options.leaseMs ?? PUSH_LEASE_MS);
    if (!this.timer && !this.running) this.schedule();
  }

  publish(kind: PushKind, data: unknown): void {
    const hash = createHash("sha1").update(JSON.stringify(data)).digest("base64");
    if (this.hashes.get(kind) === hash) return;
    this.hashes.set(kind, hash);
    this.revs[kind] += 1;
    if (!this.emit || this.stopped) return;
    try {
      this.emit(pushEventName(kind), { rev: this.revs[kind], data });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** One pass over every kind (the loop's tick; tests call it directly). */
  async check(): Promise<void> {
    for (const kind of PUSH_KINDS) {
      if (this.stopped) return;
      try {
        this.publish(kind, await this.compute[kind]());
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.now() > this.leaseUntil) return;
      this.running = true;
      void this.check().finally(() => {
        this.running = false;
        if (!this.stopped && this.now() <= this.leaseUntil) this.schedule();
      });
    }, this.options.checkMs ?? PUSH_CHECK_MS);
    this.timer.unref?.();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
