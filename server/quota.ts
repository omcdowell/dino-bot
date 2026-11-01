/**
 * Usage windows behind the rate-limit card ("Resets …") and the Live Activity weekly gate.
 * The public plugin has no usage source of its own: an add-on (server/extensions.ts) may supply
 * one as a UsageReport reader. Without one the card shows no reset time and the gate stays open.
 */
import type { UsageReport } from "@getpaseo/plugin/server/usage";

export type QuotaWindows = {
  windows: Array<{ id: string; usedPct: number | null; resetsAt: string | null; blocked: boolean }>;
  error: string | null;
};

/** The report's windows for the rate-limited card (ids as in the report: five_hour, weekly, …). */
export function quotaFromReport(report: UsageReport): QuotaWindows {
  if (report.status !== "available") {
    return { windows: [], error: "error" in report && report.error ? String(report.error) : "unavailable" };
  }
  return {
    windows: (report.windows ?? []).map((window) => ({
      id: window.id,
      usedPct: window.usedPct ?? null,
      resetsAt: window.resetsAt ?? null,
      blocked: window.label.endsWith("(blocked)"),
    })),
    error: null,
  };
}

export const NO_QUOTA: QuotaWindows = { windows: [], error: "no usage source on this host" };
