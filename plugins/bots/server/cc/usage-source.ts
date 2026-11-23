/**
 * Plan usage cards (5-hour and weekly windows) for Claude Code bots: a Paseo usage source.
 *
 * The app's usage popover and Settings → Usage find cards per agent through the session's usage scope
 * (`usageSession()`: provider, model, launch env). A pi bot's scope is `pi` + `anthropic/…`, which Paseo's Claude
 * usage source answers from pi's login. A Claude Code bot's scope is `optchat-cc` with the daemon's launch env, whose
 * `PASEO_AGENT_CWD` is the bot's folder. This source answers it from Claude Code's own figures: the rate-limit windows
 * the bot's TUI reports after every turn (inbox mod → engine `/usage` → `usage.json` `rateLimits`, server/cc/usage.ts).
 * No login store is read and no request is made.
 *
 * Claude Code reports windows only for a claude.ai subscription login. A bot that has had replies but never a window
 * (an API key or a proxy) gets no card, as a pi bot behind a proxy gets none from the Claude source. A bot with no
 * reply yet gets a card that says so; the next fetch after its first reply shows the windows.
 *
 * Window ids, labels and tones are the Claude source's (five_hour "Session" 5h, weekly "Weekly" wk), so the cards
 * look the same.
 *
 * The card stands in for the Claude sign-in card (`fallbackFor`): a host whose usage list has a card from the Claude
 * source (a claude.ai login on the host) lists that one and not this. A bot's own usage list keeps this card, since
 * the Claude source does not answer a Claude Code chat's scope.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

export const CC_USAGE_SOURCE = "optchat-cc";
/** The Claude sign-in usage source (the claude-usage-source plugin) whose card makes this one redundant. */
export const CLAUDE_SIGN_IN_SOURCE = "claude";
const BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const inputSchema = z.object({ bot: z.string().regex(BOT_NAME) }).strict();

/** Claude Code's kinds (2.1.323: five_hour, seven_day, and spend_limit through a gateway) as the Claude source's windows. */
const WINDOWS: Record<string, { id: string; label: string; shortLabel: string; summary: boolean }> = {
  five_hour: { id: "five_hour", label: "Session", shortLabel: "5h", summary: true },
  seven_day: { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true },
  spend_limit: { id: "spend_limit", label: "Spend limit", shortLabel: "$", summary: false },
};
const ORDER = ["five_hour", "seven_day", "spend_limit"];

interface Ledger {
  runs?: Record<string, { output?: number; usd?: number }>;
  rateLimits?: Array<{ kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }>;
  rateLimitsAt?: unknown;
}

export interface CcUsageSourceOptions {
  /** The bots home: a bot's folder is `<botsRoot>/<bot>`. */
  botsRoot: string;
  /** Each bot's state folder (`usage.json` inside), CcHost.botDir. */
  botDir: (bot: string) => string;
  /** The provider id the scope must name (optchat-cc). */
  provider: string;
  now?: () => number;
}

/** `fallbackFor` is always set here (optional in the SDK type); a daemon without it ignores the field. */
export type CcUsageSourceRegistration = UsageSourceRegistration & { fallbackFor: string[] };

export function createCcUsageSource(opts: CcUsageSourceOptions): CcUsageSourceRegistration {
  const now = opts.now ?? Date.now;
  const read = (bot: string): Ledger | null => {
    try {
      const d = JSON.parse(readFileSync(join(opts.botDir(bot), "usage.json"), "utf8"));
      return d && typeof d === "object" ? (d as Ledger) : null;
    } catch {
      return null;
    }
  };

  /** The bot this scope's chat runs in, or null (another provider, or a folder outside the bots home). */
  const botOf = (scope: UsageScope): string | null => {
    if (scope.kind !== "session" || scope.provider !== opts.provider) return null;
    const cwd = scope.env.PASEO_AGENT_CWD;
    if (!cwd) return null;
    const dir = resolve(cwd);
    if (dirname(dir) !== resolve(opts.botsRoot)) return null;
    const bot = basename(dir);
    return BOT_NAME.test(bot) ? bot : null;
  };

  return {
    id: CC_USAGE_SOURCE,
    label: "Claude",
    icon: "server/cc/claude.svg",
    fallbackFor: [CLAUDE_SIGN_IN_SOURCE],
    input: inputSchema,
    async discover(scope) {
      const bot = botOf(scope);
      if (!bot) return [];
      const ledger = read(bot);
      if (!windowsOf(ledger).length && hadReplies(ledger)) return [];
      const account: UsageAccount = {
        key: hashAccountKey(`${CC_USAGE_SOURCE}:${resolve(opts.botDir(bot))}`),
        label: bot,
        harness: "Claude Code",
        input: { bot },
      };
      return [account];
    },
    async fetch(raw) {
      const { bot } = inputSchema.parse(raw);
      const ledger = read(bot);
      const reported = windowsOf(ledger);
      if (!reported.length) {
        return {
          status: "unavailable",
          problem: {
            kind: "no_quota",
            detail: hadReplies(ledger)
              ? "Claude Code reports no plan limits for this bot (they come with a Claude subscription login)."
              : "Plan limits show after the bot's first reply.",
          },
        } satisfies UsageReport;
      }
      const at = typeof ledger?.rateLimitsAt === "string" ? Date.parse(ledger.rateLimitsAt) : NaN;
      const windows: UsageWindow[] = reported.map((r) => {
        const spec = WINDOWS[r.kind] ?? { id: r.kind, label: label(r.kind), shortLabel: "", summary: false };
        // A window whose reset has passed since Claude Code reported it: its new use is unknown until the next turn.
        const past = r.resetsAt !== null && Date.parse(r.resetsAt) <= now();
        const used = past ? null : r.percentUsed;
        return windowFromUsedPct({
          ...spec,
          utilizationPct: used,
          resetsAt: past ? null : r.resetsAt,
          tone: toneFromUsedPct(used),
        });
      });
      const details: UsageDetail[] = Number.isFinite(at) ? [{ id: "reported", label: "Reported", value: ago(now() - at) }] : [];
      return { status: "available", windows, balances: [], details } satisfies UsageReport;
    },
  };
}

/** The ledger's windows, checked, in the Claude source's order. */
function windowsOf(ledger: Ledger | null): Array<{ kind: string; percentUsed: number; resetsAt: string | null }> {
  const out: Array<{ kind: string; percentUsed: number; resetsAt: string | null }> = [];
  for (const r of Array.isArray(ledger?.rateLimits) ? ledger.rateLimits : []) {
    if (!r || typeof r.kind !== "string" || !r.kind || out.some((o) => o.kind === r.kind)) continue;
    if (typeof r.percentUsed !== "number" || !Number.isFinite(r.percentUsed) || r.percentUsed < 0) continue;
    const resetsAt = typeof r.resetsAt === "string" && Number.isFinite(Date.parse(r.resetsAt)) ? r.resetsAt : null;
    out.push({ kind: r.kind, percentUsed: r.percentUsed, resetsAt });
  }
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Whether the bot's Claude Code has had a model reply (any run with output or cost): its login is known by then. */
function hadReplies(ledger: Ledger | null): boolean {
  return Object.values(ledger?.runs ?? {}).some((r) => (r?.output ?? 0) > 0 || (r?.usd ?? 0) > 0);
}

function label(kind: string): string {
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
