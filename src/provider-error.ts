/** What a failed provider call said about itself: its HTTP status and how long it asked us to wait. */
export interface ProviderFailure {
  status?: number;
  /** Retry-After, in milliseconds. */
  retryAfterMs?: number;
}

/** Statuses that mean "too busy, come back later" rather than "this request is wrong". */
export const BUSY = new Set([429, 503, 529]);

/** Retry-After from response headers: `retry-after-ms`, or `retry-after` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = Number.parseFloat(headers.get('retry-after-ms') ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * What an error message gives away when the headers are gone: the SDKs start it with the status ("429 {...}"), and
 * pi-ai's own retry says "Server requested 120s retry delay" when the delay was over its limit.
 */
export function parseFailure(message: string): ProviderFailure {
  const status = /^(\d{3})\b/.exec(message.trim())?.[1];
  const delay = /Server requested (\d+(?:\.\d+)?)s retry delay/.exec(message)?.[1];
  return {
    ...(status ? { status: Number(status) } : {}),
    ...(delay ? { retryAfterMs: Number(delay) * 1000 } : {}),
  };
}

/** A compactor call that failed, with what the provider said about it. */
export class CompactorError extends Error implements ProviderFailure {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CompactorError';
  }
}

/** Status and Retry-After of any thrown value: a CompactorError's fields, or what its message gives away. */
export function failureOf(error: unknown): ProviderFailure {
  const parsed = parseFailure(error instanceof Error ? error.message : String(error));
  const own = (error ?? {}) as ProviderFailure;
  return {
    ...parsed,
    ...(typeof own.status === 'number' ? { status: own.status } : {}),
    ...(typeof own.retryAfterMs === 'number' ? { retryAfterMs: own.retryAfterMs } : {}),
  };
}

/**
 * How a failed compaction is retried. busy: the provider is overloaded, so the whole compactor holds. transient: the
 * network, a 5xx or anything unrecognised, so the node is tried again later. permanent: the provider will refuse this
 * node however often it is sent (another 4xx, a Terms of Service block, a refusal), or the model gives no line for it.
 * 401, 403 and 408 are transient: a lapsed login or a timeout says nothing about the node, and every node would fail.
 */
export type FailureClass = 'busy' | 'transient' | 'permanent';
const NOT_THE_NODE = new Set([401, 403, 408]);
/** A Terms of Service block or a refusal, with or without a status. */
export const REFUSED = /terms of service|usage polic|request was blocked|\brefusal\b|violat/i;
const INVALID = /invalid[_ ]request/i;
const NO_LINE = /^Compactor (returned|called)/;
export function classify(error: unknown): FailureClass {
  const { status } = failureOf(error),
    message = error instanceof Error ? error.message : String(error);
  if (status !== undefined && BUSY.has(status)) return 'busy';
  if (REFUSED.test(message) || INVALID.test(message) || NO_LINE.test(message)) return 'permanent';
  if (status !== undefined && status >= 400 && status < 500 && !NOT_THE_NODE.has(status)) return 'permanent';
  return 'transient';
}

/**
 * Why a permanent failure happened, from a fixed vocabulary that never quotes the error message, so it is safe in a
 * fallback line and in an escalation (a provider's error could echo what it refused).
 */
export function permanentReason(error: unknown) {
  const { status } = failureOf(error),
    message = error instanceof Error ? error.message : String(error);
  if (REFUSED.test(message)) return 'blocked by the provider';
  if (NO_LINE.test(message)) return 'no line from the model';
  if (status !== undefined) return `HTTP ${status}`;
  if (INVALID.test(message)) return 'invalid request';
  return 'refused';
}
