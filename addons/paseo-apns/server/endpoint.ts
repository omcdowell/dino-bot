/**
 * Local HTTP endpoint for senders on this machine (bot-dm, scripts):
 *
 *   POST /notify   {sender, limitKey?, title, body, data?, collapseId?}  -> NotifyResult
 *   GET  /status[?sender=<s>]                                 -> {ok, configured, devices, nextSlotAt}
 *   POST /live-activity {sender, bots:[{id,name,working,workers,since,icon?}]} -> {ok, changed, flushAt}
 *        The busy-bots set for the Live Activity (server/live-activity.ts); not an alert, not
 *        rate limited by the alert window.
 *
 * `limitKey` (optional, a sender name) is whose slot the push uses in per-sender mode; `?sender=`
 * asks for that sender's next slot.
 *
 * Bound to 127.0.0.1 only, and it also refuses non-loopback peers. Every request needs
 * `Authorization: Bearer <notify-token>` (the token file is 600 in the state dir; it is not the
 * daemon password). Bodies over 16 KB are refused.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { NotifyInput, NotifyResult } from "./notify.ts";
import type { LaBot } from "./live-activity.ts";

export const MAX_REQUEST_BYTES = 16 * 1024;
const SENDER_RE = /^(worker:)?[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface EndpointHandlers {
  notify(input: NotifyInput): Promise<NotifyResult>;
  status(sender?: string): Record<string, unknown>;
  liveActivity?(bots: LaBot[]): { changed: boolean; flushAt: string | null };
}

const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Lucide icon component name, e.g. "Brain"; anything else is dropped (the widget draws a letter). */
const ICON_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** Validates a /live-activity body. Returns an error string or the bots. */
export function parseLiveActivity(raw: unknown): LaBot[] | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "body must be a JSON object";
  const { sender, bots } = raw as Record<string, unknown>;
  if (typeof sender !== "string" || !SENDER_RE.test(sender)) return "sender must be a plugin or bot name";
  if (!Array.isArray(bots) || bots.length > 100) return "bots must be an array of at most 100";
  const out: LaBot[] = [];
  for (const b of bots) {
    if (typeof b !== "object" || b === null) return "each bot must be an object";
    const { id, name, working, workers, since, icon, stalled, stalledWorkers } = b as Record<string, unknown>;
    if (typeof id !== "string" || !BOT_ID_RE.test(id)) return "bot id must be a folder name";
    if (typeof name !== "string" || name.length > 200) return "bot name must be a string";
    if (typeof working !== "boolean") return "working must be a boolean";
    if (typeof workers !== "number" || !Number.isInteger(workers) || workers < 0 || workers > 1000) return "workers must be a count";
    if (typeof since !== "number" || !Number.isFinite(since) || since < 0) return "since must be unix seconds";
    if (icon !== undefined && icon !== null && typeof icon !== "string") return "icon must be a string";
    if (stalled !== undefined && stalled !== null && typeof stalled !== "boolean") return "stalled must be a boolean";
    if (stalledWorkers !== undefined && stalledWorkers !== null && (typeof stalledWorkers !== "number" || !Number.isInteger(stalledWorkers) || stalledWorkers < 0 || stalledWorkers > 1000)) {
      return "stalledWorkers must be a count";
    }
    const row: LaBot = { id, name, working, workers, since };
    if (typeof icon === "string" && ICON_RE.test(icon)) row.icon = icon;
    if (stalled === true) row.stalled = true;
    if (typeof stalledWorkers === "number" && stalledWorkers > 0) row.stalledWorkers = stalledWorkers;
    out.push(row);
  }
  return out;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function authorised(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return !!m && timingSafeEqual(digest(m[1]!), digest(token));
}

/** Validates a /notify body. Returns an error string or the input. */
export function parseNotify(raw: unknown): NotifyInput | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "body must be a JSON object";
  const { sender, limitKey, title, body, data, collapseId } = raw as Record<string, unknown>;
  if (typeof sender !== "string" || !SENDER_RE.test(sender)) return "sender must be a bot name or worker:<name>";
  if (limitKey !== undefined && (typeof limitKey !== "string" || !SENDER_RE.test(limitKey))) return "limitKey must be a bot name or worker:<name>";
  if (typeof title !== "string" || !title.trim() || title.length > 200) return "title must be 1-200 characters";
  if (typeof body !== "string" || !body.trim() || body.length > 4000) return "body must be 1-4000 characters";
  if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) return "data must be an object";
  if (data !== undefined && JSON.stringify(data).length > 1024) return "data must be under 1 KB as JSON";
  if (collapseId !== undefined && (typeof collapseId !== "string" || !collapseId || Buffer.byteLength(collapseId) > 64)) {
    return "collapseId must be 1-64 bytes";
  }
  return {
    sender,
    ...(limitKey ? { limitKey: limitKey as string } : {}),
    title: title.trim(),
    body: body.trim(),
    ...(data ? { data: data as Record<string, unknown> } : {}),
    ...(collapseId ? { collapseId: collapseId as string } : {}),
  };
}

/** HTTP status for a notify result. */
export function httpStatus(result: NotifyResult): number {
  switch (result.code) {
    case "sent":
      return 200;
    case "rate_limited":
      return 429;
    case "no_device":
    case "push_off":
      return 409;
    case "not_configured":
    case "key_error":
      return 503;
    case "apns_failed":
      return 502;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(`${JSON.stringify(body)}\n`);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Over the cap: stop keeping data but drain the rest, so the 413 still reaches the caller.
    // A runaway upload (64x the cap) is cut off.
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * MAX_REQUEST_BYTES) req.destroy();
      else if (size <= MAX_REQUEST_BYTES) chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_REQUEST_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createEndpoint(token: string, handlers: EndpointHandlers): Server {
  return createServer(async (req, res) => {
    try {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return send(res, 403, { ok: false, code: "forbidden", message: "loopback only" });
      if (!authorised(req.headers.authorization, token)) return send(res, 401, { ok: false, code: "unauthorised", message: "bad or missing notify token" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      if (req.method === "GET" && path === "/status") {
        const who = url.searchParams.get("sender");
        if (who !== null && !SENDER_RE.test(who)) return send(res, 400, { ok: false, code: "bad_request", message: "sender must be a bot name or worker:<name>" });
        return send(res, 200, { ok: true, ...handlers.status(who ?? undefined) });
      }
      if (req.method === "POST" && path === "/live-activity" && handlers.liveActivity) {
        const text = await readBody(req);
        if (text === null) return send(res, 413, { ok: false, code: "too_large", message: `request over ${MAX_REQUEST_BYTES} bytes` });
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return send(res, 400, { ok: false, code: "bad_request", message: "body is not JSON" });
        }
        const bots = parseLiveActivity(raw);
        if (typeof bots === "string") return send(res, 400, { ok: false, code: "bad_request", message: bots });
        return send(res, 200, { ok: true, ...handlers.liveActivity(bots) });
      }
      if (req.method !== "POST" || path !== "/notify") return send(res, 404, { ok: false, code: "not_found", message: "POST /notify, POST /live-activity or GET /status" });
      const text = await readBody(req);
      if (text === null) return send(res, 413, { ok: false, code: "too_large", message: `request over ${MAX_REQUEST_BYTES} bytes` });
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return send(res, 400, { ok: false, code: "bad_request", message: "body is not JSON" });
      }
      const input = parseNotify(raw);
      if (typeof input === "string") return send(res, 400, { ok: false, code: "bad_request", message: input });
      const result = await handlers.notify(input);
      const extra: Record<string, string> = result.code === "rate_limited" ? { "retry-after": String(result.retryInSeconds) } : {};
      return send(res, httpStatus(result), result, extra);
    } catch (error) {
      console.error(`[paseo-apns] endpoint error (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
      if (!res.headersSent) send(res, 500, { ok: false, code: "internal", message: "internal error; see paseo plugin logs apns" });
    }
  });
}

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
