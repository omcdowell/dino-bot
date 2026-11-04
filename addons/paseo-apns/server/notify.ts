/**
 * One push to the registered devices: config check, device lookup, rate limit, send, registry clean-up,
 * log. Every outcome is logged, sent or refused.
 */
import type { Settings } from "./config.ts";
import { ApnsKeyError } from "./jwt.ts";
import { buildPayload, type ApnsSender, type DeviceOutcome } from "./apns-client.ts";
import { tokenTail, type DeviceStore } from "./devices.ts";
import type { PushLog } from "./push-log.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface NotifyInput {
  /** Who asked (bot name or worker:<name>), stamped by the caller (bot-dm). */
  sender: string;
  /**
   * Whose slot the push uses when the limit is per sender, if not the sender's own: bot-dm sets it
   * to the launching bot for a worker's push, so workers cannot dodge their bot's limit.
   */
  limitKey?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  collapseId?: string;
}

export type NotifyResult =
  | {
      ok: true;
      code: "sent";
      sent: number;
      failed: number;
      devices: Array<{ device: string } & DeviceOutcome>;
      nextSlotAt: string;
    }
  | { ok: false; code: "rate_limited"; retryAt: string; retryInSeconds: number; message: string }
  | { ok: false; code: "no_device"; message: string }
  | { ok: false; code: "not_configured"; message: string }
  | { ok: false; code: "push_off"; message: string }
  | { ok: false; code: "key_error"; message: string }
  | { ok: false; code: "apns_failed"; devices: Array<{ device: string } & DeviceOutcome>; message: string };

export interface NotifyDeps {
  settings: Settings;
  devices: DeviceStore;
  limiter: RateLimiter;
  log: PushLog;
  /** null when not configured. */
  sender: ApnsSender | null;
  now?: () => number;
}

/** Marks our pushes in the notification data; the app's foreground handler keys on it. */
export const PUSH_SOURCE = "paseo-apns";

const excerpt = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

export async function notify(input: NotifyInput, deps: NotifyDeps): Promise<NotifyResult> {
  const now = (deps.now ?? Date.now)();
  const key = input.limitKey ?? input.sender;
  const summary = {
    sender: input.sender,
    ...(input.limitKey && input.limitKey !== input.sender ? { limitKey: input.limitKey } : {}),
    title: excerpt(input.title),
    bodyChars: input.body.length,
  };
  const refuse = <R extends NotifyResult>(result: R, extra: Record<string, unknown> = {}): R => {
    deps.log.append(result.code === "apns_failed" || result.code === "key_error" ? "failed" : "refused", {
      ...summary,
      code: result.code,
      ...extra,
    });
    return result;
  };

  if (deps.settings.mode === "local") {
    return refuse({
      ok: false,
      code: "push_off",
      message: "remote push is off on this host (mode local); the app shows new messages when it is opened",
    });
  }
  const apns = deps.settings.apns;
  if (!apns || !deps.sender) {
    return refuse({ ok: false, code: "not_configured", message: `paseo-apns is not configured: ${deps.settings.configError ?? "no sender"}` });
  }
  const devices = deps.devices.list().filter((d) => d.topic === apns.topic);
  if (!devices.length) {
    return refuse({
      ok: false,
      code: "no_device",
      message: `no device is registered for ${apns.topic}; open the Paseo app on the phone once so it registers`,
    });
  }
  const check = deps.limiter.check(key, now);
  if (!check.ok) {
    const retryInSeconds = Math.ceil((check.retryAt - now) / 1000);
    return refuse(
      {
        ok: false,
        code: "rate_limited",
        retryAt: new Date(check.retryAt).toISOString(),
        retryInSeconds,
        message: `one push per ${Math.round(deps.settings.rateWindowMs / 60_000)} min${deps.settings.perSender ? ` per sender (${key})` : " across all senders"}; next slot at ${new Date(check.retryAt).toISOString()} (in ${retryInSeconds} s)`,
      },
      { retryAt: new Date(check.retryAt).toISOString() },
    );
  }
  const giveBack = deps.limiter.take(key, now);

  const payload = buildPayload({
    title: input.title,
    body: input.body,
    // `source` last, so callers cannot drop it: the app shows foreground banners only for it.
    data: { kind: "alert", ...(deps.settings.serverId ? { serverId: deps.settings.serverId } : {}), ...(input.data ?? {}), source: PUSH_SOURCE },
  });
  let results: Array<{ device: string } & DeviceOutcome>;
  try {
    results = await Promise.all(
      devices.map(async (d) => ({ device: tokenTail(d.token), ...(await deps.sender!.send(d.environment, d.token, payload, input.collapseId)) })),
    );
  } catch (error) {
    giveBack();
    if (error instanceof ApnsKeyError) {
      return refuse({ ok: false, code: "key_error", message: `APNs key could not be used (${error.code})` }, { keyError: error.code });
    }
    throw error;
  }

  devices.forEach((d, i) => {
    const r = results[i]!;
    if (r.status === "dropped") {
      deps.devices.remove(d.token);
      deps.log.append("token-dropped", { device: r.device, reason: r.reason, http: r.http });
    }
  });
  const sent = results.filter((r) => r.status === "sent").length;
  if (!sent) {
    giveBack();
    return refuse(
      { ok: false, code: "apns_failed", devices: results, message: `APNs accepted it for no device: ${results.map((r) => `${r.device} ${r.status}${"reason" in r ? ` ${r.reason}` : ""}`).join(", ")}` },
      { devices: results },
    );
  }
  deps.log.append("sent", { ...summary, devices: results, collapseId: input.collapseId ?? null });
  return {
    ok: true,
    code: "sent",
    sent,
    failed: results.length - sent,
    devices: results,
    nextSlotAt: new Date(now + deps.settings.rateWindowMs).toISOString(),
  };
}
