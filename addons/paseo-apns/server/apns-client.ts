/**
 * Sends one notification to one device over HTTP/2, with Apple's error mapping.
 *
 * One long-lived HTTP/2 session per APNs host, reopened on demand after an error, GOAWAY or idle
 * close. Development (ship.sh, Xcode) builds get device tokens for the sandbox host only.
 */
import { connect, constants, type ClientHttp2Session, type SecureClientSessionOptions } from "node:http2";
import type { ApnsEnvironment } from "./config.ts";
import { ApnsKeyError, type ProviderToken } from "./jwt.ts";

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

export interface RawResponse {
  status: number;
  apnsId: string | null;
  /** Apple's `reason` from the JSON body on errors. */
  reason: string | null;
}

export interface Transport {
  post(environment: ApnsEnvironment, path: string, headers: Record<string, string>, body: string): Promise<RawResponse>;
  close(): void;
}

export interface Http2TransportOptions {
  origins?: Partial<Record<ApnsEnvironment, string>>;
  /** TLS options for tests (a self-signed fake APNs). */
  tls?: SecureClientSessionOptions;
  timeoutMs?: number;
  idleMs?: number;
}

export class Http2Transport implements Transport {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  constructor(private readonly options: Http2TransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.idleMs = options.idleMs ?? 15 * 60_000;
  }

  private session(origin: string): ClientHttp2Session {
    const held = this.sessions.get(origin);
    if (held && !held.closed && !held.destroyed) return held;
    const session = connect(origin, this.options.tls);
    const drop = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("error", drop);
    session.on("goaway", drop);
    session.on("close", drop);
    session.setTimeout(this.idleMs, () => session.close());
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  post(environment: ApnsEnvironment, path: string, headers: Record<string, string>, body: string): Promise<RawResponse> {
    const origin = this.options.origins?.[environment] ?? APNS_ORIGINS[environment];
    return new Promise((resolve, reject) => {
      let session: ClientHttp2Session;
      try {
        session = this.session(origin);
      } catch (error) {
        reject(error);
        return;
      }
      const req = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: path,
        "content-type": "application/json",
        ...headers,
      });
      req.setTimeout(this.timeoutMs, () => req.close(constants.NGHTTP2_CANCEL));
      let status = 0;
      let apnsId: string | null = null;
      const chunks: Buffer[] = [];
      req.on("response", (h) => {
        status = Number(h[constants.HTTP2_HEADER_STATUS]);
        apnsId = typeof h["apns-id"] === "string" ? h["apns-id"] : null;
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let reason: string | null = null;
        if (chunks.length) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (typeof parsed?.reason === "string") reason = parsed.reason;
          } catch {
            reason = null;
          }
        }
        if (!status) reject(new Error("no response status"));
        else resolve({ status, apnsId, reason });
      });
      req.on("error", reject);
      req.on("close", () => {
        if (!status) reject(Object.assign(new Error("stream closed"), { code: "ERR_STREAM_CLOSED" }));
      });
      req.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/** What happened to one device. `drop` means remove its token from the registry. */
export type DeviceOutcome =
  | { status: "sent"; apnsId: string | null }
  | { status: "dropped"; reason: string; http: number }
  | { status: "failed"; reason: string; http: number | null; retried: boolean };

export interface Alert {
  title: string;
  body: string;
  /** Lands as notification `data` in expo-notifications (top-level `body` key). */
  data: Record<string, unknown>;
  collapseId?: string;
}

/** APNs caps the payload at 4096 bytes. */
export const MAX_PAYLOAD_BYTES = 4096;
const ALERT_BODY_CHARS = 1000;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The APNs JSON. No badge (the stock app sets none). */
export function buildPayload(alert: Alert): string {
  let bodyChars = ALERT_BODY_CHARS;
  for (;;) {
    const json = JSON.stringify({
      aps: { alert: { title: truncate(alert.title, 120), body: truncate(alert.body, bodyChars) }, sound: "default" },
      body: alert.data,
    });
    if (Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES || bodyChars <= 40) return json;
    bodyChars = Math.floor(bodyChars / 2);
  }
}

const DROP_400 = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);

export interface PushOptions {
  pushType: "alert" | "liveactivity";
  /** apns-topic: the bundle id, or `<bundle id>.push-type.liveactivity`. */
  topic: string;
  priority: 5 | 10;
  expiresInSeconds: number;
  collapseId?: string;
}

export interface SenderOptions {
  transport: Transport;
  token: ProviderToken;
  topic: string;
  now?: () => number;
  /** Delay before the single retry after a 5xx or network error. */
  retryDelayMs?: () => number;
}

export class ApnsSender {
  private readonly now: () => number;
  private readonly retryDelayMs: () => number;

  constructor(private readonly options: SenderOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? (() => 300 + Math.floor(Math.random() * 700));
  }

  /** An alert. Throws ApnsKeyError when no JWT can be minted (no device is touched then). */
  send(environment: ApnsEnvironment, deviceToken: string, payload: string, collapseId?: string): Promise<DeviceOutcome> {
    return this.push(environment, deviceToken, payload, {
      pushType: "alert",
      topic: this.options.topic,
      priority: 10,
      // Apple keeps one undelivered notification per device for up to a day.
      expiresInSeconds: 24 * 3600,
      collapseId,
    });
  }

  /** Any push type (alert, liveactivity), with the same retries and error mapping. */
  async push(environment: ApnsEnvironment, deviceToken: string, payload: string, opts: PushOptions): Promise<DeviceOutcome> {
    let refreshed = false;
    let retried = false;
    for (;;) {
      const headers: Record<string, string> = {
        authorization: `bearer ${this.options.token.get()}`,
        "apns-topic": opts.topic,
        "apns-push-type": opts.pushType,
        "apns-priority": String(opts.priority),
        "apns-expiration": String(Math.floor(this.now() / 1000) + opts.expiresInSeconds),
        ...(opts.collapseId ? { "apns-collapse-id": opts.collapseId } : {}),
      };
      let res: RawResponse;
      try {
        res = await this.options.transport.post(environment, `/3/device/${deviceToken}`, headers, payload);
      } catch (error) {
        if (error instanceof ApnsKeyError) throw error;
        if (!retried) {
          retried = true;
          await sleep(this.retryDelayMs());
          continue;
        }
        return { status: "failed", reason: String((error as NodeJS.ErrnoException).code ?? "network"), http: null, retried };
      }
      const reason = res.reason ?? "";
      if (res.status === 200) return { status: "sent", apnsId: res.apnsId };
      if (res.status === 410) return { status: "dropped", reason: reason || "Unregistered", http: 410 };
      if (res.status === 400 && DROP_400.has(reason)) return { status: "dropped", reason, http: 400 };
      if (res.status === 403 && reason === "ExpiredProviderToken" && !refreshed) {
        refreshed = true;
        if (this.options.token.refresh() !== null) continue;
      }
      if (res.status >= 500 && !retried) {
        retried = true;
        await sleep(this.retryDelayMs());
        continue;
      }
      return { status: "failed", reason: reason || `HTTP ${res.status}`, http: res.status, retried };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
