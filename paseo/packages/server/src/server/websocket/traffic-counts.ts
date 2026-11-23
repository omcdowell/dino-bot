import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Full per-type WebSocket message counts, appended once an hour to
 * `$PASEO_HOME/runtime-metrics/traffic.jsonl` (one JSON object per line).
 *
 * The 30-second `ws_runtime_metrics` log keeps only the top types per window, so a rare type can
 * look unused. This keeps every type, by direction, so a cut can be checked against real traffic
 * (`paseo/scripts/traffic-usage.mjs`, `paseo/scripts/traffic-check.mjs`).
 *
 * Only message type names (a fixed set from the protocol schemas) and counts are stored: no
 * contents, ids, clients or addresses.
 */

export const TRAFFIC_COUNTS_FLUSH_MS = 60 * 60 * 1000;
export const TRAFFIC_COUNTS_FILE = join("runtime-metrics", "traffic.jsonl");
/** When the file passes this size it becomes `traffic.1.jsonl` (replacing the older one). */
export const TRAFFIC_COUNTS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * - `in`: top-level inbound frames (`hello`, `ping`, `session`, ...)
 * - `inSession`: inbound session requests (`fetch_agents_request`, ...)
 * - `out`: top-level outbound frames (`session` messages are counted as `session_message`)
 * - `outSession`: outbound session messages (`agent_stream`, `*_response`, ...)
 * - `outStream`: outbound `agent_stream` events (`timeline:<item type>` or the event type)
 * - `outBinary`: outbound binary frames
 */
export const TRAFFIC_CHANNELS = [
  "in",
  "inSession",
  "out",
  "outSession",
  "outStream",
  "outBinary",
] as const;
export type TrafficChannel = (typeof TRAFFIC_CHANNELS)[number];

export interface TrafficCountsRecord extends Record<TrafficChannel, Record<string, number>> {
  v: 1;
  from: string;
  to: string;
  final: boolean;
}

export class TrafficCounts {
  private windowStartedAt: number;
  private counts = createChannels();

  constructor(
    private readonly filePath: string,
    private readonly clock: () => number = Date.now,
    private readonly maxBytes: number = TRAFFIC_COUNTS_MAX_BYTES,
  ) {
    this.windowStartedAt = this.clock();
  }

  record(channel: TrafficChannel, type: string): void {
    const map = this.counts[channel];
    map.set(type, (map.get(type) ?? 0) + 1);
  }

  snapshotAndReset(options?: { final?: boolean }): TrafficCountsRecord {
    const now = this.clock();
    const record = {
      v: 1,
      from: new Date(this.windowStartedAt).toISOString(),
      to: new Date(now).toISOString(),
      final: Boolean(options?.final),
    } as TrafficCountsRecord;
    for (const channel of TRAFFIC_CHANNELS) {
      record[channel] = Object.fromEntries(this.counts[channel]);
    }
    this.counts = createChannels();
    this.windowStartedAt = now;
    return record;
  }

  /** Appends the current window to the file and starts a new one. Throws on a write error. */
  flush(options?: { final?: boolean }): TrafficCountsRecord {
    const record = this.snapshotAndReset(options);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.rotateIfLarge();
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    return record;
  }

  private rotateIfLarge(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size >= this.maxBytes) {
      renameSync(this.filePath, this.filePath.replace(/\.jsonl$/, ".1.jsonl"));
    }
  }
}

function createChannels(): Record<TrafficChannel, Map<string, number>> {
  return Object.fromEntries(TRAFFIC_CHANNELS.map((c) => [c, new Map<string, number>()])) as Record<
    TrafficChannel,
    Map<string, number>
  >;
}
