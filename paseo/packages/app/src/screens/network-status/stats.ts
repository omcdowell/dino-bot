export interface RttStats {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  jitterMs: number | null;
  lossPct: number | null;
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}

export function percentile(values: readonly number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? null;
}

/** Mean absolute difference between consecutive round trips (RFC 3550 style, unsmoothed). */
export function jitter(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
  }
  return total / (values.length - 1);
}

/** Summary of round-trip samples, where null means the probe got no answer. */
export function summariseRtt(samples: ReadonlyArray<number | null>): RttStats {
  const answered = samples.filter((value): value is number => value !== null);
  return {
    samples: samples.length,
    medianMs: median(answered),
    p95Ms: percentile(answered, 95),
    jitterMs: jitter(answered),
    lossPct:
      samples.length > 0 ? ((samples.length - answered.length) / samples.length) * 100 : null,
  };
}

export function formatMs(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value >= 10_000) return `${(value / 1000).toFixed(0)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

export function formatMbps(bytes: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0) return null;
  return (bytes * 8) / (elapsedMs / 1000) / 1_000_000;
}
