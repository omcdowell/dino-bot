import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";

// The owner-only (spec §6.9 item 2): a provider retry or quota error in a bot chat becomes a card
// that says which usage-pool window is used up, when it resets, and which retry attempt pi is on.

export const RATE_LIMIT_CARD_KIND = "rate-limit-card";
export const RATE_LIMIT_CARD_VERSION = 1;

export const QUOTA_WINDOWS = ["five_hour", "seven_day", "seven_day_fable"] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export const RateLimitCardSchema = z.object({
  /** pi's retry attempt, when the row is a "Provider retry (attempt N)" row. */
  attempt: z.number().nullable(),
  consumer: z.string().nullable(),
  window: z.enum(QUOTA_WINDOWS).nullable(),
  /** Seconds from a Retry-After hint in the message, if any. */
  retryAfterSec: z.number().nullable(),
  message: z.string(),
});
export type RateLimitCardData = z.infer<typeof RateLimitCardSchema>;

const RETRY_RE = /^Provider retry \(attempt (\d+)\):\s*([\s\S]*)$/;
const CONSUMER_RE = /Consumer \\?"([^"\\]+)\\?" exceeded quota \((five_hour|seven_day_fable|seven_day)\)/;
const LIMIT_RE = /rate.?limit|\b429\b|exceeded quota|usage limit|overloaded_error|\b529\b/i;
const RETRY_AFTER_RE = /retry[- ]after[":\s]+(\d+)/i;

export function rateLimitCardData(message: string): RateLimitCardData | null {
  const retry = RETRY_RE.exec(message);
  const body = retry ? retry[2]! : message;
  if (!LIMIT_RE.test(body)) return null;
  const consumer = CONSUMER_RE.exec(body);
  const retryAfter = RETRY_AFTER_RE.exec(body);
  return {
    attempt: retry ? Number(retry[1]) : null,
    consumer: consumer ? consumer[1]! : null,
    window: consumer ? (consumer[2] as QuotaWindow) : null,
    retryAfterSec: retryAfter ? Number(retryAfter[1]) : null,
    message: body.trim().slice(0, 400),
  };
}

export const WINDOW_LABELS: Record<QuotaWindow, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_fable: "Fable weekly",
};

/** The card's headline, e.g. "usage pool: 5-hour quota used. Resets 17:00. Retrying (attempt 2)". */
export function rateLimitHeadline(data: RateLimitCardData, resetsAt: string | null, now = new Date()): string {
  const parts: string[] = [];
  if (data.consumer && data.window) {
    parts.push(`${data.consumer} pool: ${WINDOW_LABELS[data.window]} quota used.`);
  } else {
    parts.push("Rate limited by the provider.");
  }
  if (resetsAt) parts.push(`Resets ${formatReset(resetsAt, now)}.`);
  else if (data.retryAfterSec !== null) parts.push(`Retry after ${formatSeconds(data.retryAfterSec)}.`);
  if (data.attempt !== null) parts.push(`Retrying (attempt ${data.attempt}).`);
  return parts.join(" ");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatReset(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return time;
  const day = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${time}`;
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export const rateLimitCardTransformer: PluginTimelineTransformerContribution<"error"> = {
  id: "rate-limit-card",
  query: { itemType: "error" },
  transform({ item }) {
    const data = rateLimitCardData(item.message);
    if (!data) return undefined;
    return {
      items: [{ type: "plugin", kind: RATE_LIMIT_CARD_KIND, version: RATE_LIMIT_CARD_VERSION, data }],
    };
  },
};
