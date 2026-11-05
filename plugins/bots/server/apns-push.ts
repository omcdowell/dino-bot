/**
 * Client for the paseo-apns add-on's local endpoint (a separate plugin, ~/code/paseo-apns).
 * bot-dm only speaks HTTP to it; nothing here imports from paseo-apns.
 *
 *   POST http://127.0.0.1:<port>/notify   Authorization: Bearer <~/.config/paseo-apns/notify-token>
 *   GET  http://127.0.0.1:<port>/status[?sender=<bot>]
 *
 * Port and token come from the add-on's state dir ($PASEO_APNS_DIR, default ~/.config/paseo-apns):
 * config.json `port` (default 6790) and the `notify-token` file. PASEO_APNS_URL overrides the URL.
 * Erasable TypeScript only: Node runs this file directly.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_APNS_PORT = 6790;

export type PushRequest = {
  sender: string;
  /** Whose per-sender slot the push uses, when not the sender's (a worker's launching bot). */
  limitKey?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

/** What bot-dm needs to know after asking for a push. */
export type PushOutcome =
  | { kind: "sent"; sent: number; nextSlotAt: string | null }
  | { kind: "rate_limited"; retryAt: string; retryInSeconds: number; message: string }
  | { kind: "no_device"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

export type PushStatus =
  | { reachable: true; configured: boolean; devices: number; nextSlotAt: string | null; rateWindowSeconds: number; perSender: boolean }
  | { reachable: false; message: string };

export interface PushPort {
  /** `sender`: ask for that sender's (or limit key's) next slot; the add-on is per sender. */
  status(sender?: string): Promise<PushStatus>;
  notify(request: PushRequest): Promise<PushOutcome>;
}

function stateDir(env: NodeJS.ProcessEnv): string {
  return env.PASEO_APNS_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "paseo-apns");
}

/** URL and bearer of the add-on's endpoint, or why it is not set up. Also used by live-activity-port.ts. */
export function endpoint(env: NodeJS.ProcessEnv): { url: string; token: string } | { error: string } {
  const dir = stateDir(env);
  let token: string;
  try {
    token = readFileSync(join(dir, "notify-token"), "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return { error: `the paseo-apns add-on is not set up on this machine (no ${join(dir, "notify-token")}: ${code})` };
  }
  if (env.PASEO_APNS_URL) return { url: env.PASEO_APNS_URL.replace(/\/$/, ""), token };
  let port = DEFAULT_APNS_PORT;
  try {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    if (Number.isInteger(config?.port)) port = config.port;
  } catch {
    // default port
  }
  return { url: `http://127.0.0.1:${port}`, token };
}

const causeCode = (error: unknown): string => {
  const e = error as { code?: string; cause?: { code?: string }; name?: string };
  if (e?.name === "AbortError") return "timeout";
  return e?.cause?.code ?? e?.code ?? e?.name ?? "error";
};

export function httpPush(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): PushPort {
  const call = async (path: string, init: RequestInit) => {
    const ep = endpoint(env);
    if ("error" in ep) return { unavailable: ep.error } as const;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${ep.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${ep.token}`, "content-type": "application/json" },
        signal: abort.signal,
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body } as const;
    } catch (error) {
      const code = causeCode(error);
      return {
        unavailable:
          code === "ECONNREFUSED"
            ? `the paseo-apns add-on is not running (nothing listens on ${ep.url}; check \`paseo plugin ls\`)`
            : `the paseo-apns add-on did not answer (${code})`,
      } as const;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async status(sender) {
      const r = await call(sender ? `/status?sender=${encodeURIComponent(sender)}` : "/status", { method: "GET" });
      if ("unavailable" in r) return { reachable: false, message: r.unavailable! };
      if (r.status === 401) return { reachable: false, message: "the paseo-apns add-on refused bot-dm's notify token (401)" };
      const b = r.body ?? {};
      return {
        reachable: true,
        configured: b.configured === true,
        devices: Number(b.devices) || 0,
        nextSlotAt: typeof b.nextSlotAt === "string" ? b.nextSlotAt : null,
        rateWindowSeconds: Number(b.rateWindowSeconds) || 600,
        perSender: b.perSender === true,
      };
    },
    async notify(request) {
      const r = await call("/notify", { method: "POST", body: JSON.stringify(request) });
      if ("unavailable" in r) return { kind: "unavailable", message: r.unavailable! };
      const b = r.body ?? {};
      const message = typeof b.message === "string" ? b.message : `HTTP ${r.status}`;
      if (r.status === 200 && b.ok) return { kind: "sent", sent: Number(b.sent) || 0, nextSlotAt: b.nextSlotAt ?? null };
      if (b.code === "rate_limited") {
        return { kind: "rate_limited", retryAt: String(b.retryAt), retryInSeconds: Number(b.retryInSeconds) || 0, message };
      }
      if (b.code === "no_device") return { kind: "no_device", message };
      if (b.code === "not_configured" || r.status === 401) {
        return { kind: "unavailable", message: r.status === 401 ? "the paseo-apns add-on refused bot-dm's notify token (401)" : message };
      }
      return { kind: "failed", message: `${b.code ?? `HTTP ${r.status}`}: ${message}` };
    },
  };
}
