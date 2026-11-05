/**
 * Group chat router (U1): pure rules, no clock, no randomness, no I/O. Plan §2 U1, §3.5.
 *
 * - the owner: every message wakes every lead (they hear everything and may PASS), plus the members he @names;
 *   @all/@everyone -> every member. Non-leads answer the owner only when @named (or @all).
 * - Bot message with no @name -> nobody. Bot @name -> named members except the sender, only while
 *   msg.hop < HOP_CAP and the room's bot-initiated wakes in the last RATE_WINDOW_MS < RATE_CAP.
 * - the owner is never capped. System lines wake nobody.
 * - Tasks (`@Name task:`; a run `@a @b`, `@a, @b`, `@a and @b task:` tasks each of them): the owner's always go out. Any lead bot may assign too, to a member its reply woke
 *   (so hop/rate caps apply), never to itself, a non-member or @all, at most LEAD_ASSIGN_CAP per
 *   LEAD_ASSIGN_WINDOW_MS per room (shared by all leads; one task per member tasked, so a part for N members is N). Any other bot's `task:` is not sent (reason `not_lead`).
 * - Every target is queued; `deliverable` drains a bot's queue only when it is idle, as one digest.
 */
import {
  DIGEST_MAX_BYTES,
  DIGEST_MAX_MSGS,
  HOP_CAP,
  LEAD_ASSIGN_CAP,
  LEAD_ASSIGN_WINDOW_MS,
  USER,
  RATE_CAP,
  RATE_WINDOW_MS,
  ROUTER_LOG_KEEP,
  SYSTEM,
  type AssignRefusal,
  type Group,
  type RoomMessage,
  type RoomRefusal,
  type RouteResult,
  type RouterState,
} from "./schema";

export type Mentions = {
  /** Members mentioned, in first-mention order, deduped. Includes the sender if they named themselves. */
  bots: string[];
  /** @all or @everyone was used. */
  all: boolean;
  /** Some member is assigned a task by syntax (§3.5). Sender is not checked here; `route` applies it to the owner only. */
  task: boolean;
  /** Members the task syntax applies to (subset of `bots`). */
  tasked: string[];
  /** Known bots (keys of `names`) that were mentioned but are not members. */
  nonMembers: string[];
  /** Known non-members (keys of `names`) the task syntax was used on. */
  taskedNonMembers: string[];
  /** "@all task:" or "@everyone task:" was used (never assigns). */
  taskAll: boolean;
};

const ALL_WORDS = new Set(["all", "everyone"]);
// "@" must not follow a word char, dot, @ or similar (so email@x.com is not a mention).
const MENTION_RE = /(^|[^A-Za-z0-9_.@+\-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const TASK_AFTER_RE = /^[\s,:;-]*task\s*:/i;
const TASK_LINE_RE = /^\s*task\s*:/i;
/**
 * What may stand between two @mentions of one run (`@a @b`, `@a, @b`, `@a and @b`, `@a, & @b`). Every member in the
 * run just before `task:` is tasked with that part; `ownTask` / `stripMentions` (server/rooms/assign.ts) use the
 * same source so the router and the part split agree.
 */
export const MENTION_RUN_SEP = "[ \\t]*[,;:]?[ \\t]*(?:(?:and|&)[ \\t]+)?";
const RUN_SEP_RE = new RegExp(`^${MENTION_RUN_SEP}$`, "i");

function firstName(display: string | undefined): string | undefined {
  const w = display?.trim().split(/\s+/)[0];
  return w ? w.toLowerCase() : undefined;
}

/** token (lowercase) -> bot id, for members and for other known bots. */
function lookup(group: Group, names: Record<string, string>) {
  const member = new Map<string, string>();
  const other = new Map<string, string>();
  // Ids win over first names; members win over non-members.
  for (const id of group.members) member.set(id.toLowerCase(), id);
  for (const id of group.members) {
    const f = firstName(names[id]);
    if (f && !member.has(f)) member.set(f, id);
  }
  const nonMembers = Object.keys(names).filter((id) => !group.members.includes(id)).sort();
  for (const id of nonMembers) if (!member.has(id.toLowerCase())) other.set(id.toLowerCase(), id);
  for (const id of nonMembers) {
    const f = firstName(names[id]);
    if (f && !member.has(f) && !other.has(f)) other.set(f, id);
  }
  return { member, other };
}

/**
 * @id or @FirstNameOfDisplayName, case-insensitive, word-bounded; @all and @everyone;
 * non-members ignored (reported in `nonMembers` when they are known bots).
 * `names`: bot id -> display name (members and, optionally, other bots).
 */
export function parseMentions(text: string, group: Group, names: Record<string, string>): Mentions {
  const { member, other } = lookup(group, names);
  const bots: string[] = [];
  const nonMembers: string[] = [];
  const tasked: string[] = [];
  const taskedNonMembers: string[] = [];
  let all = false;
  let taskAll = false;
  const push = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const line of text.split("\n")) {
    // Runs of mentions (`@a @b`, `@a, @b`, `@a and @b`); a run directly before `task:` tasks every name in it.
    const runs: { kind: "all" | "member" | "other" | "unknown"; id: string; at: number; end: number }[][] = [];
    MENTION_RE.lastIndex = 0;
    for (let m = MENTION_RE.exec(line); m; m = MENTION_RE.exec(line)) {
      const token = m[2].replace(/[-_]+$/, "").toLowerCase();
      const at = m.index + m[1].length;
      const end = m.index + m[0].length;
      const id = member.get(token);
      const o = other.get(token);
      const kind = ALL_WORDS.has(token) ? "all" : id ? "member" : o ? "other" : "unknown";
      if (kind === "all") all = true;
      else if (kind === "member") push(bots, id!);
      else if (kind === "other") push(nonMembers, o!);
      const item = { kind, id: id ?? o ?? token, at, end } as const;
      const run = runs.at(-1);
      const prev = run?.at(-1);
      if (run && prev && RUN_SEP_RE.test(line.slice(prev.end, at))) run.push(item);
      else runs.push([item]);
    }
    for (const run of runs) {
      if (!TASK_AFTER_RE.test(line.slice(run.at(-1)!.end))) continue;
      for (const item of run) {
        if (item.kind === "all") taskAll = true;
        else if (item.kind === "member") push(tasked, item.id);
        else if (item.kind === "other") push(taskedNonMembers, item.id);
      }
    }
  }
  // A line starting "task:" in a message that names exactly one member (and not @all).
  if (!all && bots.length === 1 && text.split("\n").some((l) => TASK_LINE_RE.test(l)) && !tasked.includes(bots[0])) {
    tasked.push(bots[0]);
  }
  return { bots, all, task: tasked.length > 0, tasked, nonMembers, taskedNonMembers, taskAll };
}

/** Wakes inside the rate window ending at `now`. */
export function liveWakes(wakes: number[], now: number): number[] {
  return wakes.filter((t) => t > now - RATE_WINDOW_MS && t <= now);
}

/**
 * Route one room message. The caller has already given it an id/ts and will append `result.message`
 * to the ledger and persist `result.state`. `names` (bot id -> display name) enables @FirstName.
 */
export function route(
  group: Group,
  msg: RoomMessage,
  state: RouterState,
  now: number,
  names: Record<string, string> = {},
): RouteResult {
  const to: string[] = [];
  const refused: RoomRefusal[] = [];
  let assign: string[] = [];
  const assignRefused: AssignRefusal[] = [];
  let wakes = liveWakes(state.wakes, now);
  let assigns = (state.assigns ?? []).filter((t) => t > now - LEAD_ASSIGN_WINDOW_MS && t <= now);

  if (msg.from === USER) {
    const m = parseMentions(msg.text, group, names);
    for (const b of m.nonMembers) refused.push({ bot: b, reason: "not_member" });
    if (m.all) to.push(...group.members);
    else to.push(...m.bots, ...group.leads.filter((l) => !m.bots.includes(l)));
    // Assign toggle (msg.task): every member named by @name gets it as a task (not @all, not the lead by default).
    assign = msg.task ? [...m.tasked, ...m.bots.filter((b) => !m.tasked.includes(b))] : m.tasked.slice();
  } else if (msg.from !== SYSTEM) {
    const m = parseMentions(msg.text, group, names);
    for (const b of m.nonMembers) refused.push({ bot: b, reason: "not_member" });
    const named = m.all ? group.members.slice() : m.bots;
    for (const b of named) {
      if (b === msg.from) {
        if (!m.all) refused.push({ bot: b, reason: "self" });
        continue;
      }
      if (msg.hop >= HOP_CAP) {
        refused.push({ bot: b, reason: "hop_cap" });
        continue;
      }
      if (wakes.length >= RATE_CAP) {
        refused.push({ bot: b, reason: "rate_cap" });
        continue;
      }
      wakes = [...wakes, now];
      to.push(b);
    }
    // Tasks from a bot: only a lead's, to members its reply woke, within the room's lead cap.
    const lead = group.leads.includes(msg.from);
    if (m.taskAll) assignRefused.push({ bot: "all", reason: lead ? "all" : "not_lead" });
    for (const b of m.taskedNonMembers) assignRefused.push({ bot: b, reason: lead ? "not_member" : "not_lead" });
    for (const b of m.tasked) {
      if (!lead) assignRefused.push({ bot: b, reason: "not_lead" });
      else if (b === msg.from) assignRefused.push({ bot: b, reason: "self" });
      else if (!to.includes(b)) {
        const why = refused.find((r) => r.bot === b)?.reason;
        assignRefused.push({ bot: b, reason: why === "rate_cap" ? "rate_cap" : "hop_cap" });
      } else if (assigns.length >= LEAD_ASSIGN_CAP) assignRefused.push({ bot: b, reason: "assign_cap" });
      else {
        assigns = [...assigns, now];
        assign.push(b);
      }
    }
  }

  const message: RoomMessage = { ...msg, to: to.slice() };
  if (refused.length) message.refused = refused.map((r) => ({ ...r }));
  else delete message.refused;

  const seq = state.seq + 1;
  const log = [...state.log, { seq, msg: message }].slice(-ROUTER_LOG_KEEP);
  const queues: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(state.queues)) queues[k] = v.slice();
  for (const b of to) queues[b] = [...(queues[b] ?? []), message.id];
  // Own lines never enter a bot's digest, so the cursor only moves on delivery.
  const cursor = { ...state.cursor };

  const next: RouterState = { v: 1, seq, log, queues, cursor, wakes };
  if (assigns.length || state.assigns) next.assigns = assigns;
  return { message, to, refused, assign, assignRefused, state: next };
}

/**
 * `bot-room post` caps, checked before a main-chat post is routed. Its hop is the --re message's hop + 1: over
 * HOP_CAP it is refused (at exactly HOP_CAP it may be posted, but, as any bot line at the cap, wakes nobody). It
 * takes one slot of the room's RATE_CAP bot wakes per RATE_WINDOW_MS (`countMainPost`); a full window refuses it.
 */
export function mainPostRefusal(parentHop: number, state: RouterState, now: number): "hop_cap" | "rate_cap" | null {
  if (parentHop + 1 > HOP_CAP) return "hop_cap";
  if (liveWakes(state.wakes, now).length >= RATE_CAP) return "rate_cap";
  return null;
}

/** The router state with one main-chat post counted in the rate window. */
export function countMainPost(state: RouterState, now: number): RouterState {
  return { ...state, wakes: [...liveWakes(state.wakes, now), now] };
}

/** UTF-8 byte length without Buffer/TextEncoder (runs in the client too). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Bytes a message costs in a digest: "<id>  <hh:mmZ> <from>: <text>". */
function cost(m: RoomMessage): number {
  return utf8Bytes(m.text) + utf8Bytes(m.from) + 40;
}

/** Cut a text to at most `max` UTF-8 bytes, adding "…" when cut. */
function clip(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (utf8Bytes(out + ch) > max - 3) break;
    out += ch;
  }
  return out + "…";
}

/**
 * Drain `bot`'s queue as one digest when it is idle. Busy, or nothing queued -> empty digest, state unchanged.
 * The digest is the room messages the bot has not seen since its last delivery (its own room lines left out; its
 * main chat's `bot-room post` lines kept, as context),
 * oldest first, at most DIGEST_MAX_MSGS / DIGEST_MAX_BYTES. Messages addressed to the bot are kept first;
 * other room lines fill what is left, newest first. When older lines are cut, the digest starts with a
 * system line "…n earlier" (id `cut:<n>`), which counts toward the 20.
 */
export function deliverable(state: RouterState, bot: string, busy: boolean): { digest: RoomMessage[]; state: RouterState } {
  const queued = state.queues[bot] ?? [];
  if (busy || queued.length === 0) return { digest: [], state };

  const since = state.cursor[bot] ?? 0;
  const firstSeq = state.log.length ? state.log[0].seq : state.seq + 1;
  const lost = Math.max(0, firstSeq - since - 1); // fell out of the router log
  // The bot's own room replies are in its room session already; its main chat's posts (`via: "main"`) are not, so
  // they come along as context (never queued: they never wake their own bot).
  const unseen = state.log.filter((e) => e.seq > since && (e.msg.from !== bot || e.msg.via === "main"));
  const q = new Set(queued);
  const addressed = unseen.filter((e) => q.has(e.msg.id));
  const context = unseen.filter((e) => !q.has(e.msg.id));

  const pick = (maxMsgs: number) => {
    const keep = new Set<number>();
    let bytes = 0;
    for (const list of [addressed, context]) {
      for (let i = list.length - 1; i >= 0 && keep.size < maxMsgs; i--) {
        const c = cost(list[i].msg);
        if (bytes + c > DIGEST_MAX_BYTES) continue;
        keep.add(list[i].seq);
        bytes += c;
      }
    }
    return unseen.filter((e) => keep.has(e.seq));
  };
  let chosen = pick(DIGEST_MAX_MSGS);
  // Something is cut: leave the 20th slot for the "…n earlier" line.
  if (chosen.length < unseen.length || lost > 0) chosen = pick(DIGEST_MAX_MSGS - 1);

  let digest: RoomMessage[] = chosen.map((e) => e.msg);
  if (digest.length === 0 && addressed.length) {
    // A single addressed message larger than the byte cap: deliver it clipped.
    const e = addressed[addressed.length - 1];
    digest = [{ ...e.msg, text: clip(e.msg.text, DIGEST_MAX_BYTES - utf8Bytes(e.msg.from) - 40) }];
    chosen = [e];
  }
  const cut = unseen.length - chosen.length + lost;
  if (cut > 0) {
    const head = chosen[0]?.msg ?? unseen[unseen.length - 1].msg;
    digest = [
      { v: 1, id: `cut:${cut}`, ts: head.ts, group: head.group, from: SYSTEM, text: `…${cut} earlier`, hop: 0, to: [] },
      ...digest,
    ];
  }

  const queues: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(state.queues)) if (k !== bot) queues[k] = v.slice();
  const cursor = { ...state.cursor, [bot]: state.seq };
  return { digest, state: { ...state, log: state.log.slice(), wakes: state.wakes.slice(), queues, cursor } };
}

/**
 * Hop for `bot`'s reply to `digest`: max hop of the digest lines addressed to it, plus one.
 * Context lines (not addressed to the bot) do not count, so overheard bot talk cannot push a reply into the cap.
 */
export function replyHop(digest: RoomMessage[], bot: string): number {
  let max = 0;
  for (const m of digest) if (m.to.includes(bot) && m.hop > max) max = m.hop;
  return max + 1;
}
