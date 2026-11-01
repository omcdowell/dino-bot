/**
 * What an import will cost, shown before it starts. Building the memory tree is far more work than the text
 * suggests: each message is summarised, then every pair of lines is merged, level by level, and every call re-sends
 * the memory view as context. So the estimate is calibrated on a real import, not derived from the text size.
 */
import type { Price, Defaults } from '../model-defaults.ts';
import { NODE } from '../memory.ts';

/**
 * Summary nodes that need a model call: each message over NODE bytes, and each merge whose two lines together are
 * over NODE bytes (shorter ones are joined without a call). `sizes` are the logged sizes (`kind: text`) in order.
 */
export function nodesNeeded(sizes: readonly number[]): number {
  let calls = sizes.filter(s => s > NODE).length,
    level = sizes.map(s => Math.min(NODE, s));
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const source = level[i] + level[i + 1] + 1;
      if (source > NODE) calls++;
      next.push(Math.min(NODE, source));
    }
    level = next;
  }
  return calls;
}

/**
 * The Fat Controller's rebuild import, 6-7 Oct 2026 (usage.jsonl role "import"): 2,244 messages (4.08 MB of text),
 * 3,152 nodes needing a call (nodesNeeded), 20,855 compactor calls (retries of over-long lines included), 11.2 hours,
 * $217.32 on claude-sonnet-5-5. Per call: 6,417 cache-read, 3,474 cache-write, 1 uncached input and 45 output tokens.
 */
export const CALIBRATION = {
  messages: 2244,
  nodes: 3152,
  callsPerNode: 20855 / 3152,
  perCall: { input: 0.7, output: 45.1, cacheRead: 6417.4, cacheWrite: 3473.8 },
  messagesPerHour: 2244 / 11.2,
  /** One sample, so a wide band. Short histories send a smaller view per call, so they land nearer `low`. */
  low: 0.5,
  high: 1.5,
} as const;

export interface Estimate {
  messages: number;
  sourceTokens: number;
  calls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** API price of the run; undefined when the model has no known price. */
  usd?: { low: number; mid: number; high: number };
  hours: number;
  /** Share of a weekly plan allowance (1 = a whole week), when the plan has a weeklyUsd guess. */
  weeklyShare?: number;
}
/** `sizes`: logged size of each message to compact, in order (see nodesNeeded). */
export function estimate(sizes: readonly number[], price?: Price, weeklyUsd?: number): Estimate {
  const messages = sizes.length,
    textBytes = sizes.reduce((n, s) => n + s, 0);
  const calls = Math.round(nodesNeeded(sizes) * CALIBRATION.callsPerNode);
  const per = CALIBRATION.perCall;
  const tokens = {
    input: Math.round(calls * per.input),
    output: Math.round(calls * per.output),
    cacheRead: Math.round(calls * per.cacheRead),
    cacheWrite: Math.round(calls * per.cacheWrite),
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  // Providers without a cache-write price bill those tokens as plain input.
  const mid = price
    ? (tokens.input * price.input +
        tokens.output * price.output +
        tokens.cacheRead * price.cacheRead +
        tokens.cacheWrite * (price.cacheWrite || price.input)) /
      1e6
    : undefined;
  return {
    messages,
    sourceTokens: Math.ceil(textBytes / 4),
    calls,
    tokens,
    usd: mid === undefined ? undefined : { low: mid * CALIBRATION.low, mid, high: mid * CALIBRATION.high },
    hours: (calls / Math.round(CALIBRATION.nodes * CALIBRATION.callsPerNode)) * (CALIBRATION.messages / CALIBRATION.messagesPerHour),
    weeklyShare: mid !== undefined && weeklyUsd ? mid / weeklyUsd : undefined,
  };
}

const millions = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : `${Math.max(0.1, n / 1e6).toFixed(1)} M`);
const dollars = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`);
const duration = (h: number) =>
  h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;

/** The warning shown before the import starts. Plain words; numbers rounded; the uncertainty stated once. */
export function warning(e: Estimate, row: Pick<Defaults, 'label' | 'billing' | 'importCompaction'>): string {
  const model = `${row.importCompaction.model}`;
  const lines = [
    `Importing your old chats will use a lot of your ${row.billing === 'api' ? 'API credit' : 'subscription'}.`,
    `${e.messages.toLocaleString('en-US')} messages → about ${millions(e.tokens.total)} tokens with ${model} (${e.calls.toLocaleString('en-US')} model calls).`,
  ];
  if (row.billing === 'free')
    lines.push('It is free, but free models are rate limited, so it may take days. It pauses at each limit and carries on later.');
  else if (e.usd && row.billing === 'plan' && e.weeklyShare !== undefined)
    lines.push(
      `That is roughly ${Math.round(e.weeklyShare * 100)}% of a weekly ${row.label} limit (${dollars(e.usd.mid)} at API prices). It pauses when you hit a limit and carries on later.`,
    );
  else if (e.usd && row.billing === 'requests')
    lines.push(`It uses a model included in your plan; at API prices it would be about ${dollars(e.usd.mid)}.`);
  else if (e.usd)
    lines.push(`That is about ${dollars(e.usd.mid)} on your API bill (could be ${dollars(e.usd.low)}–${dollars(e.usd.high)}).`);
  else lines.push('The price of this model is unknown, so no cost is shown.');
  lines.push(
    `It runs in the background for about ${duration(e.hours)}; your bot works meanwhile and gets the old chats when it finishes. You can pause it or untick projects.`,
  );
  return lines.join('\n');
}
