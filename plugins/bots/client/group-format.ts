/**
 * Pure helpers for the group chat screen (2B transcript, composer hint, @ picker, member status).
 * No React, no Intl (Hermes), no clock inside: callers pass `now`.
 */
import { USER, SYSTEM, leadsFirst, type Group, type RoomMessage } from "../shared/rooms/schema";
import type { MemberState, RoomMemberState } from "./group-types";
import { memberKeys, mentionTokens, parseMentions, resolveToken } from "./group-mentions";

/** Bot id → display name ("peggy" → "Peggy"). Missing names fall back to the title-cased id. */
export type Names = Record<string, string>;

/** A run of text; `strong` runs are drawn in the foreground colour at weight 600. */
export type Segment = { text: string; strong?: boolean };

const pad = (n: number) => String(n).padStart(2, "0");

export function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function displayName(id: string, names: Names): string {
  if (id === USER) return "You";
  return names[id] || titleCase(id);
}

/** "07:02", local time. Bad input: "". */
export function clockTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const segmentsText = (segments: Segment[]) => segments.map((s) => s.text).join("");

/** "Wallace, Scrat and Peggy" is too wordy for a hint line: comma list as in the mockups. */
const list = (ids: string[], names: Names) => ids.map((id) => displayName(id, names)).join(", ");

/** "Wallace (lead)" or "Wallace, Peggy (leads)". */
export function leadsLabel(group: Pick<Group, "leads" | "members">, names: Names, ids: readonly string[] = group.leads): string {
  const ordered = group.members.filter((m) => ids.includes(m));
  return `${list(ordered, names)} (${ordered.length === 1 ? "lead" : "leads"})`;
}

// ---------- composer hint ("To Wallace (lead) · @name or @all for others") ----------

/**
 * The hint above the composer: who the draft goes to, from the same mention rules as the router.
 * `picking`: the @ picker is open.
 */
export function composerHint(
  text: string,
  group: Group,
  names: Names,
  opts: { picking?: boolean; assign?: boolean } = {},
): Segment[] {
  const m = parseMentions(text, group, names);
  const leads = group.members.filter((id) => group.leads.includes(id));
  const role = leads.length === 1 ? "lead" : "leads";
  // Every lead hears every message from the owner (it may PASS), so leads he did not name are listed after.
  const plusLeads = (named: string[]): Segment[] => {
    const extra = leads.filter((id) => !named.includes(id));
    return extra.length ? [{ text: ` + ${leadsLabel(group, names, extra)}` }] : [];
  };
  const assigning = opts.assign ? assignTargets(text, group, names) : [];
  if (assigning.length) {
    return [{ text: "To " }, { text: list(assigning, names), strong: true }, ...plusLeads(m.bots), { text: " · task goes to their main chat" }];
  }
  if (m.all) {
    return [{ text: "To " }, { text: "everyone", strong: true }, { text: ` (${group.members.length})` }];
  }
  if (m.bots.length === 0) {
    const outside = m.nonMembers.length ? ` · ${list(m.nonMembers, names)} not in this group` : "";
    if (outside) return [{ text: "To " }, { text: list(leads, names), strong: true }, { text: ` (${role})${outside}` }];
    const tail = opts.picking ? "pick who to wake" : text.trim() ? "add @name to wake others" : "@name or @all for others";
    return [{ text: "To " }, { text: list(leads, names), strong: true }, { text: ` (${role}) · ${tail}` }];
  }
  const bots = [...m.bots].sort((a, b) => order(group, a) - order(group, b));
  const head: Segment[] = [{ text: "To " }, { text: list(bots, names), strong: true }, ...plusLeads(bots)];
  if (m.tasked.length) return [...head, { text: ` · task goes to ${list(m.tasked, names)}'s main chat` }];
  if (bots.length === 1) return [...head, { text: " · Assign or task: sends it to their main chat" }];
  return head;
}

// ---------- Assign toggle ----------

/**
 * The members an Assign-toggled message goes to as a task: every member named with @name (by id or first name),
 * in group order. Not @all: a task goes to named members only. Empty: the toggle is hidden.
 */
export function assignTargets(text: string, group: Group, names: Names): string[] {
  return [...parseMentions(text, group, names).bots].sort((a, b) => order(group, a) - order(group, b));
}

/**
 * What the composer posts: the trimmed draft, and `assign` only while the toggle is on and shown (the draft
 * names a member). Null: nothing to send.
 */
export function composerPost(draft: string, assignOn: boolean, group: Group, names: Names): { text: string; assign: boolean } | null {
  const text = draft.trim();
  if (!text) return null;
  return { text, assign: assignOn && assignTargets(text, group, names).length > 0 };
}

/**
 * The send button, as in the app's bot-chat composer (`resolvePrimaryActionKind` in
 * packages/app/src/composer/input/input.tsx): not shown until the draft has non-blank text,
 * a spinner (button disabled) while the post is in flight.
 */
export function sendButton(draft: string, sending: boolean): "hidden" | "send" | "sending" {
  if (sending) return "sending";
  return draft.trim() ? "send" : "hidden";
}

// ---------- delivery line under the owner's message ----------

/**
 * "Wallace (lead)", "Wallace, Peggy (leads)", "Scrat + Wallace (lead)", "Wallace, Scrat, Peggy": from the router's
 * `to`, so it is always true. Leads woken without being named are listed after the named members.
 */
export function deliveryLine(msg: RoomMessage, group: Group, names: Names): string {
  if (msg.to.length === 0) return "Nobody";
  const m = parseMentions(msg.text, group, names);
  const ordered = [...msg.to].sort((a, b) => order(group, a) - order(group, b));
  if (m.all) return list(ordered, names);
  const named = ordered.filter((id) => m.bots.includes(id));
  const leads = ordered.filter((id) => !m.bots.includes(id) && group.leads.includes(id));
  const rest = ordered.filter((id) => !named.includes(id) && !leads.includes(id));
  if (!leads.length) return list(ordered, names);
  const head = [...named, ...rest];
  return head.length ? `${list(head, names)} + ${leadsLabel(group, names, leads)}` : leadsLabel(group, names, leads);
}

const order = (group: Group, id: string) => {
  const i = group.members.indexOf(id);
  return i < 0 ? group.members.length : i;
};

// ---------- markdown ----------

/**
 * Whether a message uses markdown worth rendering (bold/italic, code, headings, lists, quotes, links,
 * tables). Bot messages that do are drawn with the host's Markdown, like direct chats; plain ones keep
 * the @mention highlight (visual-bugs 3: raw `**bold**` and `| table |` in group bubbles).
 */
export function hasMarkdown(text: string): boolean {
  return (
    /\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|```|\[[^\]\n]+\]\([^)\s]+\)|~~[^~\n]+~~/.test(text) ||
    /^\s{0,3}(#{1,6}\s|[-*+]\s+\S|\d+[.)]\s+\S|>\s?)/m.test(text) ||
    /^\s*\|.*\|\s*$/m.test(text)
  );
}

// ---------- @mention highlight ----------

/** Text split into runs; `strong` runs are @mentions of members or @all (drawn in the accent colour). */
export function mentionSpans(text: string, group: Group, names: Names): Segment[] {
  const keys = memberKeys(group, names);
  const out: Segment[] = [];
  let at = 0;
  for (const token of mentionTokens(text)) {
    if (!resolveToken(token.word, keys)) continue;
    if (token.start > at) out.push({ text: text.slice(at, token.start) });
    out.push({ text: text.slice(token.start, token.end), strong: true });
    at = token.end;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at) });
  return out;
}

// ---------- thread items (2B transcript) ----------

export type ThreadItem =
  | { kind: "user"; key: string; msg: RoomMessage; delivery: string }
  /**
   * A bot message (2A bubble). A run is the same bot's messages within 2 min with nothing between
   * them: `header` = first of its run (name shown in the bubble), `tail` = last (avatar beside it).
   */
  | {
      kind: "bot";
      key: string;
      msg: RoomMessage;
      name: string;
      time: string;
      header: boolean;
      tail: boolean;
      /** A post from the bot's main chat (`bot-room post`): "re: <first words of the task>", drawn above the text. */
      reLine?: string;
    }
  /** A task went to `bot`'s main chat; `from` is the lead bot's name when the lead assigned it (else the owner). */
  | { kind: "handover"; key: string; bot: string; name: string; agentId: string | null; from?: string }
  | { kind: "system"; key: string; text: string; icon: SystemIcon };

export type SystemIcon = "check" | "alert" | "pause" | "info";

/** Consecutive messages from one bot within this gap share one avatar/name header. */
export const GROUP_GAP_MS = 2 * 60_000;

/** U5 `sentLine`: "Sent to <Bot>'s main chat", or "… (from <Lead>)" for a lead bot's task. */
const SENT_RE = /^Sent to (.+?)'s main chat(?: \(from (.+)\))?\.?$/;

const REFUSAL_TEXT: Record<string, string> = {
  hop_cap: "too many bot hops",
  rate_cap: "too many bot wakes in 10 min",
  not_member: "not in this group",
};

function systemIcon(text: string): SystemIcon {
  if (/could not|failed|error/i.test(text)) return "alert";
  if (/paused/i.test(text)) return "pause";
  return "info";
}

function botForName(name: string, group: Group, names: Names): string | null {
  const n = name.trim().toLowerCase();
  return group.members.find((id) => id.toLowerCase() === n || displayName(id, names).toLowerCase() === n) ?? null;
}

/**
 * Ledger messages (oldest first) → what the transcript draws:
 * - the owner: a right-aligned bubble and its delivery line.
 * - Bot: avatar + name + time (header), then the text; a run from one bot within GROUP_GAP_MS
 *   shows the header once.
 * - Assignments (`assigned`, or U5's "Sent to X's main chat" system line): one hand-over marker
 *   per (message, bot); the system line and the field never both draw one.
 * - Other system lines: centred, with an icon. Refused bot wakes (hop/rate caps): a system line.
 */
export function threadItems(messages: RoomMessage[], group: Group, names: Names): ThreadItem[] {
  const items: ThreadItem[] = [];
  const markers = new Set<string>();
  let last: { from: string; at: number } | null = null;
  const marker = (bot: string, agentId: string | null, key: string, from?: string) => {
    if (markers.has(key)) return;
    markers.add(key);
    items.push({ kind: "handover", key: `handover-${key}`, bot, name: displayName(bot, names), agentId, ...(from ? { from } : {}) });
  };
  messages.forEach((msg, index) => {
    const at = new Date(msg.ts).getTime();
    if (msg.from === USER) {
      items.push({ kind: "user", key: msg.id, msg, delivery: deliveryLine(msg, group, names) });
      last = null;
      if (msg.assigned) marker(msg.assigned.bot, msg.assigned.agentId, `${msg.id}-${msg.assigned.bot}`);
      return;
    }
    if (msg.from === SYSTEM) {
      const sent = SENT_RE.exec(msg.text.trim());
      const bot = sent ? botForName(sent[1]!, group, names) : null;
      if (bot) {
        // A lead bot's task names the lead; its line points at the lead's message with `re`.
        const lead = sent![2] ? (botForName(sent![2], group, names) ?? null) : null;
        const from = lead ? displayName(lead, names) : sent![2];
        // Tie the line to the newest message from the user that assigned this bot, so the field and the
        // line make one marker between them.
        const source = from ? undefined : [...messages.slice(0, index)].reverse().find((m) => m.from === USER);
        const sourceAssigned = source?.assigned?.bot === bot ? source.assigned : undefined;
        const agentId = msg.assigned?.agentId ?? sourceAssigned?.agentId ?? null;
        const key = source && sourceAssigned ? `${source.id}-${bot}` : msg.re ? `${msg.re}-${bot}` : `${msg.id}-${bot}`;
        marker(bot, agentId, key, from);
      } else if (msg.assigned) {
        marker(msg.assigned.bot, msg.assigned.agentId, `${msg.id}-${msg.assigned.bot}`);
      } else {
        items.push({ kind: "system", key: msg.id, text: msg.text, icon: systemIcon(msg.text) });
      }
      last = null;
      return;
    }
    const prev = last as { from: string; at: number } | null;
    const reLine = msg.via === "main" ? replyLine(msg.re ? messages.find((m) => m.id === msg.re) : undefined) : undefined;
    const header = !(prev && prev.from === msg.from && Number.isFinite(at) && at - prev.at <= GROUP_GAP_MS);
    items.push({
      kind: "bot",
      key: msg.id,
      msg,
      name: displayName(msg.from, names),
      time: clockTime(msg.ts),
      header,
      tail: true,
      ...(reLine ? { reLine } : {}),
    });
    last = { from: msg.from, at };
    if (msg.assigned) marker(msg.assigned.bot, msg.assigned.agentId, `${msg.id}-${msg.assigned.bot}`);
    for (const r of msg.refused ?? []) {
      if (r.reason === "self") continue;
      items.push({
        kind: "system",
        key: `${msg.id}-refused-${r.bot}`,
        text: `Not passed to ${displayName(r.bot, names)} (${REFUSAL_TEXT[r.reason] ?? r.reason})`,
        icon: "pause",
      });
      last = null;
    }
  });
  // Runs only join bubbles that sit next to each other: a marker or a system line between two
  // messages starts a new run (name again) and ends the previous one (avatar there).
  items.forEach((item, i) => {
    if (item.kind !== "bot") return;
    const prev = items[i - 1];
    if (!(prev?.kind === "bot" && prev.msg.from === item.msg.from)) item.header = true;
    if (!item.header && prev?.kind === "bot") prev.tail = false;
  });
  return items;
}

/** Words of a task shown in a main-chat post's "re:" line. */
export const RE_LINE_WORDS = 8;

/**
 * The "re:" line of a bot's main-chat post: "re: <first words of the message it answers>" (leading @mentions
 * dropped), or "from main chat" when that message is not loaded.
 */
export function replyLine(parent: Pick<RoomMessage, "text"> | undefined): string {
  if (!parent) return "from main chat";
  const words = parent.text
    .replace(/^(\s*@[A-Za-z0-9_-]+[,:;]?)+\s*/, "")
    .replace(/^task\s*:\s*/i, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "from main chat";
  return `re: ${words.slice(0, RE_LINE_WORDS).join(" ")}${words.length > RE_LINE_WORDS ? "…" : ""}`;
}

// ---------- member status ----------

/** Status line in the picker, the info sheet and the members panel. */
export function memberStatus(state: RoomMemberState | undefined): string {
  switch (state?.state) {
    case "room":
      return "Replying in the room";
    case "main-busy":
      return "Working in main chat";
    case "queued":
      return state.queued > 0 ? `Working in main chat · ${state.queued} waiting` : "Working in main chat";
    default:
      return "Idle";
  }
}

/** Hollow ring (working) or a plain dot (idle), as the home's StatusTrail. */
export const memberBusy = (state: MemberState | undefined) => state === "room" || state === "main-busy" || state === "queued";

/**
 * The line above the composer: "**Wallace** is typing · Scrat working in main chat". Only bots the
 * router woke appear (state room or queued); a member merely busy in its main chat does not.
 * Null when nobody is woken. `first`: the bot whose avatar leads the line.
 */
export function typingLine(
  members: RoomMemberState[],
  group: Group,
  names: Names,
): { first: string; segments: Segment[] } | null {
  const sorted = [...members].sort((a, b) => order(group, a.botId) - order(group, b.botId));
  const typing = sorted.filter((m) => m.state === "room").map((m) => m.botId);
  const waiting = sorted.filter((m) => m.state === "queued").map((m) => m.botId);
  if (!typing.length && !waiting.length) return null;
  const segments: Segment[] = [];
  if (typing.length) {
    typing.forEach((id, i) => {
      if (i) segments.push({ text: ", " });
      segments.push({ text: displayName(id, names), strong: true });
    });
    segments.push({ text: typing.length === 1 ? " is typing" : " are typing" });
  }
  if (waiting.length) {
    if (segments.length) segments.push({ text: " · " });
    segments.push({ text: `${list(waiting, names)} working in main chat` });
  }
  return { first: typing[0] ?? waiting[0]!, segments };
}

/** Room sessions stop after this long without a turn (plan U4 QUIET_MS). */
export const QUIET_MS = 15 * 60_000;

/** "Quiet since 07:15 · room sessions have closed": nobody woken and the last message is old. */
export function quietLine(messages: RoomMessage[], members: RoomMemberState[], now: number): string | null {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) return null;
  if (members.some((m) => m.state === "room" || m.state === "queued")) return null;
  const at = new Date(lastMsg.ts).getTime();
  if (!Number.isFinite(at) || now - at < QUIET_MS) return null;
  return `Quiet since ${clockTime(lastMsg.ts)} · room sessions have closed`;
}

// ---------- @ picker ----------

/** The "@word" being typed at the cursor: where it starts and what is typed after "@". */
export type ActiveMention = { start: number; query: string };

export function activeMention(text: string, cursor: number = text.length): ActiveMention | null {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const match = /(^|[^A-Za-z0-9_.@+-])@([A-Za-z0-9_-]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2]!.length - 1, query: match[2]! };
}

/** Replace the "@que" being typed with "@id " and give the new cursor position. */
export function insertMention(text: string, active: ActiveMention, id: string): { text: string; cursor: number } {
  const end = active.start + 1 + active.query.length;
  const rest = text.slice(end).replace(/^[A-Za-z0-9_-]*/, "");
  const insert = `@${id}${/^\s/.test(rest) ? "" : " "}`;
  return { text: text.slice(0, active.start) + insert + rest, cursor: active.start + insert.length };
}

export type PickerRow =
  | { kind: "member"; id: string; name: string; lead: boolean; status: string; busy: boolean }
  | { kind: "all"; id: "all"; count: number };

/** Members (leads first, then group order) whose id or name starts with the query, then @all. */
export function pickerRows(query: string, group: Group, names: Names, states: RoomMemberState[]): PickerRow[] {
  const q = query.toLowerCase();
  const byId = new Map(states.map((s) => [s.botId, s]));
  const members = leadsFirst(group);
  const rows: PickerRow[] = members
    .filter((id) => {
      if (!q) return true;
      const name = displayName(id, names).toLowerCase();
      return id.toLowerCase().startsWith(q) || name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q));
    })
    .map((id) => ({
      kind: "member" as const,
      id,
      name: displayName(id, names),
      lead: group.leads.includes(id),
      status: memberStatus(byId.get(id)),
      busy: memberBusy(byId.get(id)?.state),
    }));
  if (!q || "all".startsWith(q) || "everyone".startsWith(q)) rows.push({ kind: "all", id: "all", count: group.members.length });
  return rows;
}

// ---------- home / sidebar rows ----------

/** "Wallace: 6:30 is set…" → sender "Wallace" (drawn bold) and the rest. No sender: whole line. */
export function splitPreview(preview: string | null | undefined): { sender: string | null; rest: string } {
  if (!preview) return { sender: null, rest: "" };
  const match = /^([^:\n]{1,40}):\s(.*)$/s.exec(preview);
  return match ? { sender: match[1]!, rest: match[2]! } : { sender: null, rest: preview };
}

/** Members for the stacked avatar: the first lead last (drawn on top), up to two others before it (other leads first). */
export function avatarStack(group: { leads: string[]; members: string[] }): string[] {
  const order = leadsFirst(group);
  const front = order[0];
  if (!front) return [];
  return [...order.slice(1, 3), front];
}

/** Groups newest activity first; never-used groups after, by name. */
export function groupOrder<T extends { name: string; lastTs: string | null }>(groups: T[]): T[] {
  const t = (g: T) => (g.lastTs ? new Date(g.lastTs).getTime() || 0 : 0);
  return [...groups].sort((a, b) => t(b) - t(a) || a.name.localeCompare(b.name));
}

/** "3 bots · lead Wallace" / "3 bots · leads Wallace, Peggy" (leads hear every message). */
export function groupSubtitle(group: Group, names: Names): string {
  const leads = group.members.filter((id) => group.leads.includes(id));
  return `${group.members.length} bots · ${leads.length === 1 ? "lead" : "leads"} ${list(leads, names)}`;
}

/** "Wallace (lead), Scrat, Peggy"; every lead is marked, leads first. */
export function memberLine(group: Group, names: Names): string {
  return leadsFirst(group)
    .map((id) => (group.leads.includes(id) ? `${displayName(id, names)} (lead)` : displayName(id, names)))
    .join(", ");
}

// ---------- members edit (group info sheet) ----------

/** Limits of the groups file (§3.1); the server checks them again. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 8;

/** `lead`: toggle whether `bot` is a lead. */
export type MemberOp = { kind: "add" | "remove" | "lead"; bot: string };

/** The members and leads after one edit, or why it cannot be made (same rules as the server). */
export function applyMemberOp(group: Group, op: MemberOp): { members: string[]; leads: string[] } | { error: string } {
  const has = group.members.includes(op.bot);
  switch (op.kind) {
    case "add":
      if (has) return { error: "Already a member." };
      if (group.members.length >= MAX_MEMBERS) return { error: `A group has at most ${MAX_MEMBERS} members.` };
      return { members: [...group.members, op.bot], leads: [...group.leads] };
    case "remove": {
      const why = removeBlocked(group, op.bot);
      return why
        ? { error: why }
        : { members: group.members.filter((m) => m !== op.bot), leads: group.leads.filter((l) => l !== op.bot) };
    }
    case "lead": {
      if (!has) return { error: "Only a member can lead." };
      const why = leadToggleBlocked(group, op.bot);
      if (why) return { error: why };
      const leads = group.leads.includes(op.bot) ? group.leads.filter((l) => l !== op.bot) : [...group.leads, op.bot];
      return { members: [...group.members], leads: group.members.filter((m) => leads.includes(m)) };
    }
  }
}

/** Why `bot`'s lead toggle cannot be flipped now (null: it can): the last lead stays a lead. */
export function leadToggleBlocked(group: Group, bot: string): string | null {
  if (group.leads.length === 1 && group.leads[0] === bot) return "A group needs at least one lead.";
  return null;
}

/** Why `bot` cannot be removed now (null: it can). */
export function removeBlocked(group: Group, bot: string): string | null {
  if (!group.members.includes(bot)) return "Not a member.";
  if (group.leads.length === 1 && group.leads[0] === bot) return "Make someone else a lead first.";
  if (group.members.length <= MIN_MEMBERS) return `A group needs at least ${MIN_MEMBERS} members.`;
  return null;
}

/** Bots that can be added: on the host, not in the group; by name. Empty when the group is full. */
export function addableBots<B extends { id: string; name: string }>(group: Group, bots: readonly B[]): B[] {
  if (group.members.length >= MAX_MEMBERS) return [];
  return bots.filter((b) => !group.members.includes(b.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where "scroll to the newest line" should rest. On iOS the host gives the transcript's ScrollView
 * header D's room as a native top content inset (`topInset`), but `scrollToEnd` clamps its offset at
 * 0, so a thread shorter than the screen ended up `topInset` points too high, its first line under
 * the header (build 28). Returns the offset to `scrollTo`, or null when `scrollToEnd` is right
 * (no inset, or content taller than the view).
 */
export function newestScrollOffset(input: { contentHeight: number; viewportHeight: number; topInset: number }): number | null {
  const { contentHeight, viewportHeight, topInset } = input;
  if (topInset <= 0 || viewportHeight <= 0) return null;
  const end = contentHeight - viewportHeight;
  if (end >= 0) return null;
  return Math.max(end, -topInset);
}
