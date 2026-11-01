import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type {
  DiagnosticsProviderTestResponse,
  DiagnosticsSpeedTestResponse,
} from "@getpaseo/protocol/messages";

/**
 * Network diagnostics for the app's Network page (networkDiagnostics). Run only on request:
 * nothing here polls, and the provider test sends no model request, so it uses no quota.
 */

const STEP_TIMEOUT_MS = 8000;
export const PROVIDER_STATUS_URL = "https://status.claude.com/api/v2/summary.json";
const STATUS_COMPONENTS = ["Claude API", "Claude Code", "claude.ai"];

type ProviderTestPayload = DiagnosticsProviderTestResponse["payload"];
type ProviderStatus = NonNullable<ProviderTestPayload["status"]>;

export function runSpeedTest(input: {
  requestId: string;
  direction: "down" | "up";
  bytes: number;
  payload?: string;
}): DiagnosticsSpeedTestResponse["payload"] {
  const startedAt = performance.now();
  if (input.direction === "down") {
    const payload = randomBytes(input.bytes).toString("base64");
    return {
      requestId: input.requestId,
      direction: "down",
      bytes: input.bytes,
      payload,
      serverMs: performance.now() - startedAt,
      error: null,
    };
  }
  const received = input.payload ? Buffer.from(input.payload, "base64").byteLength : 0;
  return {
    requestId: input.requestId,
    direction: "up",
    bytes: received,
    serverMs: performance.now() - startedAt,
    error: received === input.bytes ? null : `expected ${input.bytes} bytes, got ${received}`,
  };
}

/** The provider's API endpoint as this daemon would reach it. */
export function resolveProviderEndpoint(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  viaBaseUrl: boolean;
} {
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (base) {
    try {
      return { url: new URL(base).toString(), viaBaseUrl: true };
    } catch {
      // Fall through to the default host.
    }
  }
  return { url: "https://api.anthropic.com/", viaBaseUrl: false };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function timeTcp(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = netConnect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(performance.now() - startedAt);
    });
    socket.once("error", reject);
  });
}

function timeTls(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = tlsConnect({ host, port, servername: host });
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve(performance.now() - startedAt);
    });
    socket.once("error", reject);
  });
}

export interface ProviderTestDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  lastProviderError?: () => ProviderTestPayload["lastProviderError"];
}

export async function runProviderTest(
  input: { requestId: string; provider?: string },
  deps: ProviderTestDeps = {},
): Promise<ProviderTestPayload> {
  const fetchImpl = deps.fetch ?? fetch;
  const { url, viaBaseUrl } = resolveProviderEndpoint(deps.env);
  const target = new URL(url);
  const secure = target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  const result: ProviderTestPayload = {
    requestId: input.requestId,
    provider: input.provider ?? "claude",
    url,
    viaBaseUrl,
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
    httpMs: null,
    httpStatus: null,
    error: null,
    lastProviderError: deps.lastProviderError?.() ?? null,
    status: null,
    statusError: null,
    testedAt: new Date().toISOString(),
  };
  const statusPromise = fetchProviderStatus(fetchImpl).then(
    (status) => {
      result.status = status;
      return undefined;
    },
    (error: unknown) => {
      result.statusError = error instanceof Error ? error.message : String(error);
      return undefined;
    },
  );
  try {
    const dnsStartedAt = performance.now();
    await withTimeout(lookup(target.hostname), "DNS lookup");
    result.dnsMs = performance.now() - dnsStartedAt;
    result.tcpMs = await withTimeout(timeTcp(target.hostname, port), "TCP connect");
    if (secure) result.tlsMs = await withTimeout(timeTls(target.hostname, port), "TLS connect");
    const httpStartedAt = performance.now();
    const response = await withTimeout(
      fetchImpl(url, { method: "HEAD", redirect: "manual" }),
      "HTTP request",
    );
    result.httpMs = performance.now() - httpStartedAt;
    result.httpStatus = response.status;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  await statusPromise;
  return result;
}

interface StatuspageSummary {
  status?: { indicator?: string; description?: string };
  components?: Array<{ name?: string; status?: string }>;
  incidents?: Array<{
    name?: string;
    status?: string;
    impact?: string;
    updated_at?: string;
    incident_updates?: Array<{ body?: string }>;
  }>;
}

export async function fetchProviderStatus(fetchImpl: typeof fetch): Promise<ProviderStatus> {
  const response = await withTimeout(fetchImpl(PROVIDER_STATUS_URL), "status.claude.com");
  if (!response.ok) throw new Error(`status.claude.com answered HTTP ${response.status}`);
  return parseProviderStatus((await response.json()) as StatuspageSummary);
}

export function parseProviderStatus(summary: StatuspageSummary): ProviderStatus {
  const components = (summary.components ?? [])
    .filter((component) =>
      STATUS_COMPONENTS.some((name) =>
        component.name?.toLowerCase().startsWith(name.toLowerCase()),
      ),
    )
    .map((component) => ({ name: component.name ?? "", status: component.status ?? "unknown" }));
  return {
    indicator: summary.status?.indicator ?? "unknown",
    description: summary.status?.description ?? "",
    components,
    incidents: (summary.incidents ?? []).slice(0, 5).map((incident) => ({
      name: incident.name ?? "",
      status: incident.status ?? "",
      impact: incident.impact ?? null,
      updatedAt: incident.updated_at ?? null,
      latestUpdate: incident.incident_updates?.[0]?.body ?? null,
    })),
  };
}
