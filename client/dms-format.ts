import type { DmBotSummary } from "../shared/dm-rpc";
import type { DmStatusValue } from "../shared/dm-schema";
import type { Bot } from "../shared/rpc";

/** Workspace panel id of the DMs view (Explorer sidebar, next to Files and Changes). */
export const DMS_PANEL_ID = "dms";

/** Query keys; everything DM-related lives under ["bots", "dms"] so one invalidation refreshes it. */
export const DMS_KEY = ["bots", "dms"] as const;
export const DMS_SUMMARY_KEY = [...DMS_KEY, "summary"] as const;
export const dmsThreadsKey = (botId: string) => [...DMS_KEY, "threads", botId] as const;
export const dmsThreadKey = (botId: string, ref: string) => [...DMS_KEY, "thread", botId, ref] as const;

/** Poll intervals (report 07: summary every 30–60 s, the open thread every 10 s). */
export const SUMMARY_POLL_MS = 30_000;
export const THREADS_POLL_MS = 30_000;
export const THREAD_POLL_MS = 10_000;

export function titleCase(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** "user" is you; "worker:schedule.<id>" a Paseo schedule's run; "worker:wp1" a herdr worker; anything else a bot folder id. */
export function partyLabel(party: string, names?: ReadonlyMap<string, string>): string {
  if (party === "user") return "You";
  if (party.startsWith("worker:schedule.")) return `Schedule ${party.slice("worker:schedule.".length)}`;
  if (party.startsWith("worker:")) return `Worker ${party.slice("worker:".length)}`;
  return names?.get(party) ?? titleCase(party);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Short local time: "14:05" today, "Tue 14:05" this week, "8 Oct" before that. No Intl, for Hermes. */
export function shortTime(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return hm;
  if (d.getTime() >= startOfToday - 6 * 86_400_000) return `${DAYS[d.getDay()]} ${hm}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? date : `${date} ${d.getFullYear()}`;
}

/** Full local time for message headers: "8 Oct 14:05". */
export function longTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function statusLabel(status: DmStatusValue | null, detail: string | null): string | null {
  switch (status) {
    case null:
      return null;
    case "queued":
      return "Queued";
    case "steered":
      return "Delivered mid-turn";
    case "started":
      return "Started a turn";
    case "pushed":
      return "Pushed to your phone";
    case "failed":
      return detail ? `Failed: ${detail}` : "Failed";
    case "refused":
      return detail ? `Refused: ${detail.replace(/_/g, " ")}` : "Refused";
  }
}

/** Hop count at which a thread is flagged as a possible loop (bot-dm refuses past 3). */
export const HOP_WARN = 3;

/**
 * Whether this client's Explorer can host plugin panels. Paseo draws the Explorer as a split pane
 * (with plugin tabs) only on wide web and desktop; the iOS and Android apps and narrow web use a
 * built-in overlay with Files, Changes and PR only (app `resolveExplorerSidebarPresentation`,
 * `supportsDesktopPaneSplits() === isWeb`). There the DMs screen is the fallback.
 */
export function explorerHostsPanels(layout: { compact: boolean; platform: string }): boolean {
  return layout.platform === "web" && !layout.compact;
}

const trimSlash = (path: string) => path.replace(/\/+$/, "");

/** The bot whose folder is this workspace's directory (each bot's chat runs in ~/bots/<name>). */
export function botForDirectory<B extends Pick<Bot, "cwd">>(bots: readonly B[], directory: string | null | undefined): B | undefined {
  if (!directory) return undefined;
  const dir = trimSlash(directory);
  return bots.find((bot) => trimSlash(bot.cwd) === dir);
}

/** Shown under a bot that has DMs (report 07: hidden for bots with none, so the list stays short). */
export function showDmsRow(summary: DmBotSummary | undefined): summary is DmBotSummary {
  return !!summary && summary.total > 0;
}

