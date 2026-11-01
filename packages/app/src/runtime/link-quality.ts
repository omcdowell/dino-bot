/**
 * Slow-link detection for constrained mode (in the car on a weak cellular link). The
 * inputs are what the app already has: heartbeat round trips from the daemon client, NetInfo's
 * cellular generation, and how often the socket dropped recently. Enter fast, leave slowly, so a
 * flapping link does not keep re-subscribing every background chat.
 */

export type LinkMode = "normal" | "constrained";

export interface LinkQualityInput {
  now: number;
  /** Heartbeat samples, oldest first; null rttMs = no pong. */
  rttSamples: ReadonlyArray<{ at: number; rttMs: number | null }>;
  cellularGeneration: string | null;
  /** Times the socket to this host went from connected to disconnected. */
  disconnects: readonly number[];
  /**
   * Chromium's Network Information API (desktop and web). It estimates the link from observed
   * round trips and throughput, so it also sees a laptop on a phone hotspot, which NetInfo
   * reports as plain Wi-Fi. Absent on the phone.
   */
  browserConnection?: BrowserConnection | null;
  /** "Treat this network as metered" setting: always constrained. */
  metered?: boolean;
}

export interface BrowserConnection {
  effectiveType: string | null;
  saveData: boolean;
}

/** Reads `navigator.connection`; null where the platform has none (React Native, Safari). */
export function readBrowserConnection(
  nav:
    | { connection?: { effectiveType?: unknown; saveData?: unknown } }
    | undefined = typeof navigator === "undefined" ? undefined : (navigator as never),
): BrowserConnection | null {
  const connection = nav?.connection;
  if (!connection || typeof connection !== "object") return null;
  return {
    effectiveType: typeof connection.effectiveType === "string" ? connection.effectiveType : null,
    saveData: connection.saveData === true,
  };
}

export interface LinkQualityState {
  mode: LinkMode;
  /** Since when the link has looked good (for the exit delay). */
  goodSince: number | null;
  reason: string | null;
}

export const LINK_ENTER_RTT_MS = 800;
export const LINK_EXIT_RTT_MS = 400;
export const LINK_EXIT_HOLD_MS = 120_000;
export const LINK_SAMPLE_WINDOW_MS = 120_000;
export const LINK_DISCONNECT_WINDOW_MS = 300_000;
export const LINK_DISCONNECTS_TO_ENTER = 2;

export const INITIAL_LINK_QUALITY: LinkQualityState = {
  mode: "normal",
  goodSince: null,
  reason: null,
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function badReason(input: LinkQualityInput, rttThresholdMs: number): string | null {
  if (input.metered) return "metered network";
  const generation = input.cellularGeneration?.toLowerCase() ?? null;
  if (generation === "2g" || generation === "3g") return `cellular ${generation}`;
  const effectiveType = input.browserConnection?.effectiveType?.toLowerCase() ?? null;
  if (effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g") {
    return `connection ${effectiveType}`;
  }
  if (input.browserConnection?.saveData) return "save data";
  const recent = input.rttSamples.filter(
    (sample) => input.now - sample.at <= LINK_SAMPLE_WINDOW_MS,
  );
  const lost = recent.filter((sample) => sample.rttMs === null).length;
  const rtt = median(
    recent.flatMap((sample) => (sample.rttMs === null ? [] : [sample.rttMs])).slice(-5),
  );
  if (rtt !== null && rtt >= rttThresholdMs) return `round trip ${Math.round(rtt)} ms`;
  if (recent.length >= 3 && lost / recent.length >= 0.34) return "heartbeats lost";
  const drops = input.disconnects.filter((at) => input.now - at <= LINK_DISCONNECT_WINDOW_MS);
  if (drops.length >= LINK_DISCONNECTS_TO_ENTER) return `${drops.length} drops in 5 min`;
  return null;
}

export function nextLinkQuality(
  previous: LinkQualityState,
  input: LinkQualityInput,
): LinkQualityState {
  if (previous.mode === "normal") {
    const reason = badReason(input, LINK_ENTER_RTT_MS);
    return reason ? { mode: "constrained", goodSince: null, reason } : previous;
  }
  const reason = badReason(input, LINK_EXIT_RTT_MS);
  if (reason) {
    return previous.goodSince === null && previous.reason === reason
      ? previous
      : { mode: "constrained", goodSince: null, reason };
  }
  const goodSince = previous.goodSince ?? input.now;
  if (input.now - goodSince >= LINK_EXIT_HOLD_MS) return INITIAL_LINK_QUALITY;
  return previous.goodSince === goodSince ? previous : { ...previous, goodSince };
}
