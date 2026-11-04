/**
 * Append-only JSONL log of every push decision (sent, refused, failed) and registry change.
 * File 600. Device tokens appear as their last 8 characters only; no key material, no JWTs.
 */
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readSync, fstatSync } from "node:fs";
import { dirname } from "node:path";

export type LogEvent =
  | "sent"
  | "refused"
  | "failed"
  | "registered"
  | "revoked"
  | "token-dropped"
  | "error"
  // Live Activity channel (server/live-activity.ts). Never "sent": the alert rate limit restores
  // only from "sent", so these pushes do not count against it.
  | "la-start"
  | "la-update"
  | "la-end"
  | "la-failed"
  | "la-sync";

export interface LogEntry {
  ts: string;
  event: LogEvent;
  [field: string]: unknown;
}

export class PushLog {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  append(event: LogEvent, fields: Record<string, unknown> = {}): LogEntry {
    const entry: LogEntry = { ts: new Date(this.now()).toISOString(), event, ...fields };
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (error) {
      console.error(`[paseo-apns] log append failed (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    return entry;
  }

  /** The last entries (reads at most the last 256 KB). */
  tail(maxBytes = 256 * 1024): LogEntry[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      const out: LogEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // torn line
        }
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }
}
