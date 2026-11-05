import { median } from "./stats";

/**
 * Phone ↔ internet probes. iOS has no raw ICMP, so each target gets timed HTTPS GETs instead of a
 * ping. Two targets are bare IPs (no DNS) and one needs DNS, so "IPs fine, google.com fails"
 * points at DNS.
 */

export type InternetTargetId = "cloudflare" | "google_dns" | "google";

export interface InternetTarget {
  id: InternetTargetId;
  label: string;
  url: string;
  expectStatus: number;
  usesDns: boolean;
  /** The target sends no CORS headers, so a browser can only time it as an opaque request. */
  opaqueOnWeb: boolean;
}

export const INTERNET_TARGETS: readonly InternetTarget[] = [
  {
    id: "cloudflare",
    label: "1.1.1.1",
    url: "https://1.1.1.1/cdn-cgi/trace",
    expectStatus: 200,
    usesDns: false,
    opaqueOnWeb: false,
  },
  {
    id: "google_dns",
    label: "8.8.8.8",
    url: "https://8.8.8.8/resolve?name=example.com",
    expectStatus: 200,
    usesDns: false,
    opaqueOnWeb: false,
  },
  {
    id: "google",
    label: "google.com",
    url: "https://www.google.com/generate_204",
    expectStatus: 204,
    usesDns: true,
    opaqueOnWeb: true,
  },
];

export const INTERNET_ATTEMPTS = 3;
const INTERNET_TIMEOUT_MS = 6000;

export interface InternetTargetResult {
  id: InternetTargetId;
  label: string;
  okCount: number;
  attempts: number;
  medianMs: number | null;
  error: string | null;
}

export interface CloudflareTrace {
  ip: string | null;
  loc: string | null;
  colo: string | null;
  tls: string | null;
}

export type InternetVerdict = "online" | "partial" | "dns" | "no_internet";

export interface InternetResult {
  verdict: InternetVerdict;
  medianMs: number | null;
  targets: InternetTargetResult[];
  trace: CloudflareTrace | null;
}

/** Just the call the probes make, so tests need not match every platform's fetch overloads. */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface InternetProbeDeps {
  fetch: ProbeFetch;
  now: () => number;
  isWeb: boolean;
  attempts?: number;
  timeoutMs?: number;
}

export function parseCloudflareTrace(body: string): CloudflareTrace {
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return {
    ip: fields.get("ip") ?? null,
    loc: fields.get("loc") ?? null,
    colo: fields.get("colo") ?? null,
    tls: fields.get("tls") ?? null,
  };
}

async function timedRequest(
  target: InternetTarget,
  deps: InternetProbeDeps,
): Promise<{ ms: number; body: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? INTERNET_TIMEOUT_MS);
  const opaque = deps.isWeb && target.opaqueOnWeb;
  const startedAt = deps.now();
  try {
    const response = await deps.fetch(target.url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      ...(opaque ? { mode: "no-cors" as const } : {}),
    });
    const body = target.id === "cloudflare" && !opaque ? await response.text() : null;
    const ms = deps.now() - startedAt;
    // An opaque response has status 0; reaching it at all proves the round trip.
    if (!opaque && response.status !== target.expectStatus) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { ms, body };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function probeTarget(
  target: InternetTarget,
  deps: InternetProbeDeps,
): Promise<{ result: InternetTargetResult; traceBody: string | null }> {
  const attempts = deps.attempts ?? INTERNET_ATTEMPTS;
  const times: number[] = [];
  let lastError: string | null = null;
  let traceBody: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { ms, body } = await timedRequest(target, deps);
      times.push(ms);
      traceBody = body ?? traceBody;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    result: {
      id: target.id,
      label: target.label,
      okCount: times.length,
      attempts,
      medianMs: median(times),
      error: times.length === attempts ? null : lastError,
    },
    traceBody,
  };
}

export function decideInternetVerdict(
  targets: readonly InternetTargetResult[],
  definitions: readonly InternetTarget[] = INTERNET_TARGETS,
): InternetVerdict {
  const reached = (result: InternetTargetResult) => result.okCount > 0;
  if (targets.every(reached)) {
    return targets.every((result) => result.okCount === result.attempts) ? "online" : "partial";
  }
  if (!targets.some(reached)) return "no_internet";
  const usesDns = (result: InternetTargetResult) =>
    definitions.find((target) => target.id === result.id)?.usesDns === true;
  const ipTargetsOk = targets.filter((result) => !usesDns(result)).every(reached);
  const dnsTargetsFail = targets.filter(usesDns).every((result) => !reached(result));
  return ipTargetsOk && dnsTargetsFail ? "dns" : "partial";
}

export async function runInternetProbes(deps: InternetProbeDeps): Promise<InternetResult> {
  const outcomes = await Promise.all(INTERNET_TARGETS.map((target) => probeTarget(target, deps)));
  const targets = outcomes.map((outcome) => outcome.result);
  const traceBody = outcomes.find((outcome) => outcome.traceBody)?.traceBody ?? null;
  return {
    verdict: decideInternetVerdict(targets),
    medianMs: median(
      targets.map((target) => target.medianMs).filter((ms): ms is number => ms !== null),
    ),
    targets,
    trace: traceBody ? parseCloudflareTrace(traceBody) : null,
  };
}
