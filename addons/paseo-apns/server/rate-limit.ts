/**
 * One push per window (default 10 min). Global across all senders unless perSender is on; then
 * each sender (or the limitKey its push names, e.g. a worker's launching bot) has its own window.
 * Over the limit the push is refused, never queued; the caller learns when the next slot opens.
 */
export const GLOBAL_KEY = "*";

export type RateCheck = { ok: true } | { ok: false; retryAt: number };

export class RateLimiter {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly perSender: boolean,
  ) {}

  private key(sender: string) {
    return this.perSender ? sender : GLOBAL_KEY;
  }

  check(sender: string, now: number): RateCheck {
    const at = this.last.get(this.key(sender));
    if (at === undefined || now - at >= this.windowMs) return { ok: true };
    return { ok: false, retryAt: at + this.windowMs };
  }

  /** Takes the slot. Returns a function that gives it back (used when nothing was delivered). */
  take(sender: string, now: number): () => void {
    const key = this.key(sender);
    const before = this.last.get(key);
    this.last.set(key, now);
    return () => {
      if (this.last.get(key) !== now) return;
      if (before === undefined) this.last.delete(key);
      else this.last.set(key, before);
    };
  }

  /** Restores slots from earlier `sent` log entries, so a plugin reload does not reset the limit. */
  restore(entries: Array<{ ts: string; event: string; sender?: unknown; limitKey?: unknown }>): void {
    for (const e of entries) {
      if (e.event !== "sent") continue;
      const at = Date.parse(e.ts);
      if (!Number.isFinite(at)) continue;
      // The slot a push used: its limitKey (a worker's push charged to its bot), else its sender.
      const who = typeof e.limitKey === "string" ? e.limitKey : typeof e.sender === "string" ? e.sender : GLOBAL_KEY;
      const key = this.key(who);
      if ((this.last.get(key) ?? -Infinity) < at) this.last.set(key, at);
    }
  }
}
