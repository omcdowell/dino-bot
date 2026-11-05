/**
 * Sends one socket's frames in the order they were queued, when some are still being produced
 * (zstd frames are compressed on the libuv pool). Frames that are ready when nothing is queued go
 * out at once. A frame that fails to produce stops the queue and reports once; the caller closes
 * the socket.
 */
export class OrderedFrameSender {
  private readonly queue: Array<{
    frame: string | Uint8Array | Promise<Uint8Array>;
    bytes: number;
    send: (frame: string | Uint8Array) => void;
    fail: (error: unknown) => void;
  }> = [];
  private draining = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  /** Plain bytes of frames queued but not yet handed to the socket (for the high-water check). */
  pendingBytes = 0;

  push(
    frame: string | Uint8Array | Promise<Uint8Array>,
    bytes: number,
    send: (frame: string | Uint8Array) => void,
    fail: (error: unknown) => void,
  ): void {
    if (this.closed) return;
    if (!this.draining && this.queue.length === 0 && !(frame instanceof Promise)) {
      send(frame);
      return;
    }
    this.pendingBytes += bytes;
    this.queue.push({ frame, bytes, send, fail });
    if (!this.draining) void this.drainQueue();
  }

  /** Resolves once every frame queued so far has been handed to the socket. */
  drain(): Promise<void> {
    if (!this.draining && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.wakeIdle();
  }

  private async drainQueue(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0 && !this.closed) {
      const entry = this.queue[0]!;
      let ready: string | Uint8Array;
      try {
        ready = await entry.frame;
      } catch (error) {
        this.close();
        entry.fail(error);
        break;
      }
      if (this.closed) break;
      this.queue.shift();
      this.pendingBytes -= entry.bytes;
      entry.send(ready);
    }
    this.draining = false;
    this.wakeIdle();
  }

  private wakeIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
