/** Pure helpers for the phone home (layout A). No Intl, for Hermes. */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Time running: "0:42", "12:05", "1:02:09". Negative or bad input reads as 0:00. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Spoken form for accessibility: "running 3 minutes", "running 1 hour 2 minutes". */
export function spokenElapsed(ms: number): string {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (minutes < 1) return "running under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return `running ${[h ? part(h, "hour") : "", m ? part(m, "minute") : ""].filter(Boolean).join(" ")}`;
}

/** Row time, Grok style: "14:52" today, "Yesterday", "Saturday" this week, "8 Oct" before that. */
export function rowTime(ts: string | null | undefined, now: Date = new Date()): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (t >= startOfYesterday) return "Yesterday";
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  if (t >= startOfWeek) return DAYS[d.getDay()]!;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? date : `${date} ${d.getFullYear()}`;
}

type Since =
  | { kind: "none" }
  | { kind: "now" }
  | { kind: "minutes" | "hours"; n: number }
  | { kind: "weekday" | "date"; d: Date };

function since(ts: string | null | undefined, now: Date): Since {
  if (!ts) return { kind: "none" };
  const d = new Date(ts);
  const t = d.getTime();
  if (Number.isNaN(t)) return { kind: "none" };
  const ms = now.getTime() - t;
  // Future times (clock skew between hosts) read as just now.
  if (ms < 60_000) return { kind: "now" };
  if (ms < 3_600_000) return { kind: "minutes", n: Math.floor(ms / 60_000) };
  if (ms < 86_400_000) return { kind: "hours", n: Math.floor(ms / 3_600_000) };
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  return { kind: t >= startOfWeek ? "weekday" : "date", d };
}

/**
 * Sidebar "last used": "now" under a minute (or in the future), "4m", "2h" under a day, "Tue"
 * within the last six calendar days, "3 Oct" this year, "Oct 2025" before. No time: "".
 */
export function sinceShort(ts: string | null | undefined, now: Date = new Date()): string {
  const s = since(ts, now);
  switch (s.kind) {
    case "none":
      return "";
    case "now":
      return "now";
    case "minutes":
      return `${s.n}m`;
    case "hours":
      return `${s.n}h`;
    case "weekday":
      return DAYS[s.d.getDay()]!.slice(0, 3);
    case "date":
      return s.d.getFullYear() === now.getFullYear()
        ? `${s.d.getDate()} ${MONTHS[s.d.getMonth()]}`
        : `${MONTHS[s.d.getMonth()]} ${s.d.getFullYear()}`;
  }
}

/** Spoken form of `sinceShort`: "last used 4 minutes ago", "last used Tuesday". No time: "". */
export function spokenSince(ts: string | null | undefined, now: Date = new Date()): string {
  const s = since(ts, now);
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  switch (s.kind) {
    case "none":
      return "";
    case "now":
      return "last used just now";
    case "minutes":
      return `last used ${part(s.n, "minute")} ago`;
    case "hours":
      return `last used ${part(s.n, "hour")} ago`;
    case "weekday":
      return `last used ${DAYS[s.d.getDay()]}`;
    case "date":
      return `last used ${sinceShort(s.d.toISOString(), now)}`;
  }
}

/**
 * Featured bot on top; the rest most recent activity first, then by `order` and name. Bots with no
 * chat activity go last.
 */
export function homeOrder<B extends { id: string; name: string; order: number; featured: boolean }>(
  bots: readonly B[],
  activityOf: (bot: B) => string | null | undefined,
): { featured: B | null; rest: B[] } {
  const featured = bots.find((bot) => bot.featured) ?? null;
  const time = (bot: B) => {
    const t = Date.parse(activityOf(bot) ?? "");
    return Number.isNaN(t) ? -Infinity : t;
  };
  const rest = bots
    .filter((bot) => bot !== featured)
    .sort((a, b) => time(b) - time(a) || a.order - b.order || a.name.localeCompare(b.name));
  return { featured, rest };
}

/**
 * When the running turn started. The server's answer (first timeline entry of the latest turn)
 * counts only if it was fetched after the row was seen going to "working"; before that it may
 * describe the previous turn, so the moment the client saw the switch is used instead.
 */
export function runningSince(
  serverTurnStartedAt: string | null | undefined,
  serverFetchedAt: number,
  workingSeenAt: number,
): number {
  const server = Date.parse(serverTurnStartedAt ?? "");
  if (!Number.isNaN(server) && serverFetchedAt > workingSeenAt) return Math.min(server, serverFetchedAt);
  return workingSeenAt;
}

/**
 * A row's place in the home's order: the server's last activity (newest chat message or DM, sent
 * or received), else the preview's time. The app's agent `lastActivityAt` is not used: it also
 * moves without any message (2026-10-08: "the bots dont sort by recency").
 */
export function activityAt(row: { activityAt?: string | null; preview?: { ts: string } | null } | undefined): string | null {
  return row?.activityAt ?? row?.preview?.ts ?? null;
}

/**
 * The order key shared by the phone home and the desktop sidebar: the server's activity
 * (`activityAt`), else the agent's own `lastActivityAt` the client has seen, only for bots the
 * server has no message time for.
 */
export function recencyOf(
  rows: ReadonlyMap<string, { activityAt?: string | null; preview?: { ts: string } | null }>,
  agentAt: ReadonlyMap<string, string>,
): (bot: { id: string }) => string | null {
  return (bot) => activityAt(rows.get(bot.id)) ?? agentAt.get(bot.id) ?? null;
}

/** `homeOrder` as one flat list (featured first): the desktop sidebar's order. */
export function botOrder<B extends { id: string; name: string; order: number; featured: boolean }>(
  bots: readonly B[],
  activityOf: (bot: B) => string | null | undefined,
): B[] {
  const { featured, rest } = homeOrder(bots, activityOf);
  return featured ? [featured, ...rest] : rest;
}

/**
 * The order on screen kept while the pointer is over the list (rows must not move under a click):
 * bots still present stay where they were, bots that are new go at the end in `next`'s order.
 */
export function holdOrder(held: readonly string[] | null, next: readonly string[]): string[] {
  if (!held) return [...next];
  const present = new Set(next);
  const kept = held.filter((id) => present.has(id));
  const seen = new Set(kept);
  return [...kept, ...next.filter((id) => !seen.has(id))];
}

export type LastKnownStatus = { status: string; at: number };

/** Statuses the home last saw live, by bot id; `status` "none" and "read" are not kept. */
export function rememberStatus(
  held: Readonly<Record<string, LastKnownStatus>>,
  botId: string,
  status: string,
  at: number,
): Record<string, LastKnownStatus> {
  const current = held[botId];
  if (status === "none" || status === "read") {
    if (!current) return held as Record<string, LastKnownStatus>;
    const { [botId]: _gone, ...rest } = held;
    return rest;
  }
  if (current?.status === status) return held as Record<string, LastKnownStatus>;
  return { ...held, [botId]: { status, at } };
}

/** One row of the mixed chat list: a bot's chat or a group chat. */
export type ChatRow<B, G> = { kind: "bot"; key: string; bot: B } | { kind: "group"; key: string; group: G };

/**
 * Group chats mingle with the bots' chats and rise on recency (13 Oct: "i want the group
 * chats to mingle with the other chats and just rise to the top on recency"). `bots` is already in
 * `homeOrder` (without the featured bot, which stays pinned above); a group's time is its last room
 * message. Newest first; on a tie or with no time at all, bots keep their order ahead of groups, and
 * groups without messages go last (by name). Keys: the bot id, or "group:<id>".
 */
export function mingle<B extends { id: string }, G extends { id: string; name: string; lastTs: string | null }>(
  bots: readonly B[],
  groups: readonly G[],
  botAt: (bot: B) => string | null | undefined,
): ChatRow<B, G>[] {
  const time = (at: string | null | undefined) => {
    const t = Date.parse(at ?? "");
    return Number.isNaN(t) ? -Infinity : t;
  };
  const sortedGroups = [...groups].sort((a, b) => time(b.lastTs) - time(a.lastTs) || a.name.localeCompare(b.name));
  const out: ChatRow<B, G>[] = [];
  let g = 0;
  for (const bot of bots) {
    const t = time(botAt(bot));
    // A group goes before this bot only when it is strictly newer.
    while (g < sortedGroups.length && time(sortedGroups[g]!.lastTs) > t) {
      const group = sortedGroups[g++]!;
      out.push({ kind: "group", key: `group:${group.id}`, group });
    }
    out.push({ kind: "bot", key: bot.id, bot });
  }
  for (; g < sortedGroups.length; g++) {
    const group = sortedGroups[g]!;
    out.push({ kind: "group", key: `group:${group.id}`, group });
  }
  return out;
}
