import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReset, rateLimitCardData, rateLimitCardTransformer, rateLimitHeadline } from "../client/rate-limit-data";
import { quotaFromReport } from "../server/quota";

const PROXY_429 =
  'Provider retry (attempt 2): 429 {"type":"error","error":{"type":"rate_limit_error","message":"Consumer \\"alice\\" exceeded quota (five_hour). Retry-After: 1800"}}';

test("a pi retry row with a proxy quota error becomes a card", () => {
  const data = rateLimitCardData(PROXY_429);
  assert.deepEqual(
    { attempt: data?.attempt, consumer: data?.consumer, window: data?.window, retryAfterSec: data?.retryAfterSec },
    { attempt: 2, consumer: "alice", window: "five_hour", retryAfterSec: 1800 },
  );
});

test("a plain quota error (no retry) still matches; other errors are left alone", () => {
  assert.equal(rateLimitCardData('Consumer "alice" exceeded quota (seven_day)')?.window, "seven_day");
  assert.equal(rateLimitCardData("Provider retry (attempt 1): Request timed out.")?.attempt, undefined);
  assert.equal(rateLimitCardData("Provider retry (attempt 1): Request timed out."), null);
  assert.equal(rateLimitCardData("Permission denied"), null);
  assert.equal(rateLimitCardData("Provider retry (attempt 3): 429 Too Many Requests")?.consumer, null);
});

test("headline names the pool window, reset time and attempt", () => {
  const data = rateLimitCardData(PROXY_429)!;
  const now = new Date(2026, 9, 10, 15, 0);
  const resetsAt = new Date(2026, 9, 10, 17, 0).toISOString();
  assert.equal(
    rateLimitHeadline(data, resetsAt, now),
    "alice pool: 5-hour quota used. Resets 17:00. Retrying (attempt 2).",
  );
  assert.equal(rateLimitHeadline(data, null, now), "alice pool: 5-hour quota used. Retry after 30 min. Retrying (attempt 2).");
  const generic = rateLimitCardData("429 Too Many Requests")!;
  assert.equal(rateLimitHeadline(generic, null, now), "Rate limited by the provider.");
  assert.match(formatReset(new Date(2026, 9, 12, 6, 0).toISOString(), now), /12 Oct 06:00$/);
});

test("the transformer only replaces matching error rows", () => {
  const hit = rateLimitCardTransformer.transform({ item: { type: "error", message: PROXY_429 }, phase: "complete" });
  assert.equal(hit?.items[0]?.kind, "rate-limit-card");
  const miss = rateLimitCardTransformer.transform({ item: { type: "error", message: "boom" }, phase: "complete" });
  assert.equal(miss, undefined);
});

const win = (id: string, label: string, usedPct: number, blocked: boolean, resetsAt: string | null = null) => ({
  id,
  label: blocked ? `${label} (blocked)` : label,
  shortLabel: id,
  usedPct,
  remainingPct: Math.max(0, 100 - usedPct),
  resetsAt,
  tone: "default" as const,
});
test("quota windows come from the usage report", () => {
  const report = { status: "available" as const, windows: [win("five_hour", "5-hour", 100, true, "2026-10-10T09:00:00Z")] };
  assert.deepEqual(quotaFromReport(report), {
    windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-10T09:00:00Z", blocked: true }],
    error: null,
  });
  assert.equal(quotaFromReport({ status: "error", error: "down" }).error, "down");
});
