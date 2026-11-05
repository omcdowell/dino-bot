/**
 * bot-dm delivery rules (pure functions, no I/O).
 *
 * Allow-list on the owner's vertical chain (synthesis.md, the owner's decision 2):
 * - FC <-> PM: free (request, reply, info); `escalate` only towards FC.
 * - PM <-> PM: `request` and `info` (questions only) and `reply`; never `escalate`.
 * - `report`: only from `worker:<name>` senders, and workers may send nothing else (except
 *   `resume`, below).
 * - `resume`: a system nudge (no reply expected), only from the senders in SYSTEM_SENDERS, to any bot.
 *   System senders may also send `info` (a system notice, e.g. a worker stopped on an error).
 * - Schedule senders (`--from schedule:<id>`, stamped `worker:schedule.<id>`): `report` or `info`,
 *   only to the bot that owns the schedule; pair cap and rate limit apply as between bots.
 * Loop guards: hop cap 6 per thread; at most 10 DMs per pair of bots per 30 minutes, any thread,
 * FC and PM pairs alike (escalations to the FC exempt; worker: senders are not bots, so the pair
 * cap does not apply to them); 20 messages per hour per (sender, recipient), workers included; no
 * bare `reply` to a `reply`/`info` unless it was sent with expects-reply.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  BOT_NAME_RE,
  DM_MAX_BODY,
  DM_MAX_SUBJECT,
  WORKER_NAME_RE,
  type DmKind,
  type DmMessage,
  type DmRefusalCode,
  type DmStatus,
} from "../shared/dm-schema.ts";
import { isUserParty, userName } from "../shared/party.ts";

/** No default escalation bot: it is the `escalation` setting (server/settings.ts) or BOT_DM_FC. */
/** 2026-10-08: 6 (was 3), now that hops are counted honestly; the pair cap is the hard loop guard. */
export const HOP_CAP = 6;
export const RATE_LIMIT_PER_HOUR = 20;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
/** A DM sent without --re is threaded onto the latest DM with the same bot inside this window. */
export const THREAD_WINDOW_MS = 30 * 60 * 1000;
/** Backstop for lost threading: at most this many DMs between one pair of bots per window, any thread (FC and PM pairs alike; escalate exempt). */
export const PAIR_CAP = 10;
export const PAIR_WINDOW_MS = 30 * 60 * 1000;

/**
 * Senders allowed to send kind=resume (system nudges, not the owner, no reply expected). Add new
 * system senders here.
 */
export const SYSTEM_SENDERS: readonly string[] = ["worker:ratelimit-watchdog", "worker:stall-watch", "worker:push-slot"];
export const isSystemSender = (party: string) => SYSTEM_SENDERS.includes(party);

export type Refusal = { code: DmRefusalCode; reason: string; advice: string };

export const isWorker = (party: string) => WORKER_NAME_RE.test(party);

/**
 * Schedule senders: an agent Paseo launched for a schedule (new-agent target) reports to the bot
 * that owns the schedule. The CLI takes `--from schedule:<id>` and verifies it against the daemon's
 * run record; the stamped sender is `worker:schedule.<id>`, inside the worker namespace, so every
 * existing envelope parser (pi-optchat's memory tag included) reads it as a non-user sender. Herdr
 * workers may not use the `worker:schedule.` prefix. Schedule senders send only report or info.
 */
export const SCHEDULE_SENDER_PREFIX = "worker:schedule.";
/** Paseo schedule ids are 8 hex chars today; allow a little more, never path characters. */
export const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,54}$/;
export const SCHEDULE_KINDS: readonly DmKind[] = ["report", "info"];
export const scheduleSender = (scheduleId: string) => `${SCHEDULE_SENDER_PREFIX}${scheduleId}`;
export const isScheduleSender = (party: string) => party.startsWith(SCHEDULE_SENDER_PREFIX) && isWorker(party);

/**
 * The bot that owns a schedule, from the schedule's working folder as Paseo records it
 * (target.config.cwd): `<root>/<bot>` itself, or any folder under `<root>/<bot>-runs/` (a bot's
 * scratch folders for unattended runs, e.g. ~/bots/matilda-runs/mail-summary). `isBot` says
 * whether a folder name is a real bot (has an .optchat-profile). Anything else has no owner.
 */
export function scheduleOwner(cwd: string | null, root: string, isBot: (name: string) => boolean): string | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  const rel = relative(resolve(root), resolve(cwd));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const [top, ...rest] = rel.split(sep);
  if (!top) return null;
  if (!rest.length && isBotName(top) && isBot(top)) return top;
  if (top.endsWith("-runs")) {
    const bot = top.slice(0, -"-runs".length);
    if (isBotName(bot) && isBot(bot)) return bot;
  }
  return null;
}
export const isBotName = (party: string) => BOT_NAME_RE.test(party) && !isUserParty(party);

/** Kinds expect a reply by default; `--expects-reply` turns it on for the others. */
export function defaultExpectsReply(kind: DmKind): boolean {
  return kind === "request" || kind === "escalate";
}

/**
 * Allow-list check. `fc` is the Fat Controller's bot name. `scheduleOwnerName` is the bot that
 * owns the sender's schedule (schedule senders only).
 */
export function checkAllowed(from: string, to: string, kind: DmKind, fc: string, scheduleOwnerName?: string | null): Refusal | null {
  const refuse = (reason: string, advice: string): Refusal => ({ code: "not_allowed", reason, advice });
  if (isScheduleSender(from)) {
    const id = from.slice(SCHEDULE_SENDER_PREFIX.length);
    if (!SCHEDULE_KINDS.includes(kind)) {
      return refuse(`schedule senders may only send kind=report or kind=info, not ${kind}`, "Use --kind report (or --kind info).");
    }
    if (!scheduleOwnerName) return refuse(`schedule ${id} has no owning bot`, "Run the schedule in its bot's folder, ~/bots/<bot>.");
    if (to !== scheduleOwnerName) {
      return refuse(
        `schedule ${id} belongs to ${scheduleOwnerName}; a schedule run DMs only its own bot`,
        `Send it to ${scheduleOwnerName}: bot-dm ${scheduleOwnerName} --from schedule:${id} --kind report --file <path>.`,
      );
    }
    return null;
  }
  if (kind === "resume") {
    return isSystemSender(from)
      ? null
      : refuse(
          `kind=resume is reserved for system senders (${SYSTEM_SENDERS.join(", ")}), not ${from}`,
          isWorker(from) ? "Use --kind report." : "Use --kind info (or request, if you need an answer).",
        );
  }
  if (isSystemSender(from) && kind === "info") return null;
  if (isWorker(from)) {
    return kind === "report"
      ? null
      : refuse(`worker senders may only send kind=report, not ${kind}`, "Use --kind report.");
  }
  if (kind === "report") {
    return refuse(
      "kind=report is reserved for worker:<name> senders",
      "If this answers a DM, send it as --kind reply --re <that DM's id>; otherwise --kind info, with --re <id> if it follows up an earlier DM.",
    );
  }
  if (kind === "escalate" && !fc) {
    return refuse("no escalation bot is set on this host", `Ask ${userName()} directly instead (bot-dm user --text '…'), or DM the bot concerned with --kind request.`);
  }
  if (kind === "escalate" && to !== fc) {
    return refuse(`escalate goes only to ${fc}`, `Send the escalation to ${fc}: bot-dm ${fc} --kind escalate --text '…'.`);
  }
  if (fc && (from === fc || to === fc)) return null;
  // PM <-> PM
  if (kind === "request" || kind === "info" || kind === "reply") return null;
  return refuse(`PM to PM DMs may be request, info or reply, not ${kind}`, `Decisions go via ${fc}.`);
}

export type ReplyContext = {
  /** The message named by --re, as found in the sender's ledger. */
  parent: DmMessage;
  /** The sender of the new message. */
  from: string;
  to: string;
  kind: DmKind;
  /** Highest hop already recorded on the parent's thread (so --re to an early message cannot reset the count). */
  threadHop?: number;
};

/**
 * Threading: the new message's thread and hop, plus a refusal if it may not be sent (the refusal
 * record still carries the would-be thread/hop). Usage errors are thrown.
 */
export function checkReply(ctx: ReplyContext, fc: string, cap = HOP_CAP): { thread: string; hop: number; refusal: Refusal | null } {
  const { parent, from, to, kind } = ctx;
  const answering = parent.to === from;
  if (kind === "reply" && !(answering && parent.from === to)) {
    throw new UsageError(`--kind reply must answer a DM that ${to} sent to ${from}; ${parent.id} is from ${parent.from} to ${parent.to}`);
  }
  if (!answering && parent.from !== from) {
    throw new UsageError(`--re ${parent.id} is not a DM you sent or received`);
  }
  const thread = parent.thread;
  const hop = Math.max(parent.hop, ctx.threadHop ?? 0) + 1;
  // Only a bare `reply` to a no-answer DM is refused. Follow-ups (info/request with --re) stay on
  // the thread, so the hop cap below sees the true count.
  if (kind === "reply" && answering && (parent.kind === "reply" || parent.kind === "info") && !parent.expects_reply) {
    return { thread, hop, refusal: {
      code: "not_allowed",
      reason: `${parent.id} is a ${parent.kind} sent without expects-reply; it needs no reply`,
      advice: `If you only want to acknowledge it, send nothing. If you have something new for this thread, send it as --kind info --re ${parent.id} (or --kind request --re ${parent.id} if you need an answer). Keep --re: do not start a new thread for it.`,
    } };
  }
  if (hop > cap) {
    return { thread, hop, refusal: {
      code: "hop_cap",
      reason: `thread ${parent.thread} would reach hop ${hop}; the cap is ${cap}`,
      advice:
        !fc || from === fc
          ? `Stop the exchange here and decide, or ask ${userName()}.`
          : to === fc
            ? `Stop this thread. If something still needs ${fc}'s decision, send one escalate in a new thread that sums it up: bot-dm ${fc} --kind escalate --text 'Thread ${parent.thread} hit the hop cap; decision needed: …'.`
            : `Escalate to ${fc} in a new thread: bot-dm ${fc} --kind escalate --text 'Thread ${parent.thread} with ${to} hit the hop cap: …'.`,
    } };
  }
  return { thread, hop, refusal: null };
}

/** DMs between two bots (either direction, any thread) in the window that were not refused. */
export function countPair(records: Array<DmMessage | DmStatus>, a: string, b: string, now: number, windowMs = PAIR_WINDOW_MS): number {
  const refused = new Set(records.filter((r) => r.type === "status" && r.status === "refused").map((r) => r.id));
  const seen = new Set<string>();
  for (const r of records) {
    if (r.type !== "message" || refused.has(r.id)) continue;
    if (!((r.from === a && r.to === b) || (r.from === b && r.to === a))) continue;
    if (now - Date.parse(r.ts) < windowMs) seen.add(r.id);
  }
  return seen.size;
}

export function checkPair(count: number, from: string, to: string, kind: DmKind, fc: string, cap = PAIR_CAP): Refusal | null {
  if (kind === "escalate" || count < cap) return null;
  return {
    code: "hop_cap",
    reason: `already ${count} DMs between ${from} and ${to} in the last ${PAIR_WINDOW_MS / 60000} minutes (any thread); the limit is ${cap}`,
    advice:
      !fc || from === fc
        ? `Stop the exchange here and decide, or ask ${userName()}.`
        : to === fc
          ? `Stop this exchange. If something still needs ${fc}'s decision, send one escalate that sums it up (escalations are exempt from this limit): bot-dm ${fc} --kind escalate --text 'Our exchange hit the DM limit; decision needed: …'.`
          : `Escalate to ${fc} (escalations are exempt from this limit): bot-dm ${fc} --kind escalate --text 'Exchange with ${to} hit the DM limit: …'.`,
  };
}

const ID_TOKEN_RE = /\b[0-9A-HJKMNP-TV-Z]{8,26}\b/g;

export type Inferred = { parent: DmMessage; by: "mention" | "recent" };

/**
 * Thread for a DM sent without --re. `messages` are the sender's ledger messages (inbox and
 * outbox, refused ones already removed). First choice: a DM id (or an unambiguous prefix of at
 * least 8 chars) quoted in the body, exchanged with the same bot. Second: the latest DM that bot
 * sent the sender inside the window and that the sender has not written back on yet. The parent is the latest message on the chosen thread, so the hop count
 * continues from the true end of the thread. For kind=reply the parent must come from `to`.
 */
export function inferParent(
  messages: DmMessage[],
  from: string,
  to: string,
  kind: DmKind,
  body: string,
  now: number,
  windowMs = THREAD_WINDOW_MS,
): Inferred | null {
  if (kind === "escalate" || kind === "report" || kind === "resume") return null;
  const peer = messages.filter((m) => (m.from === from && m.to === to) || (m.from === to && m.to === from));
  if (!peer.length) return null;
  const eligible = (m: DmMessage) => kind !== "reply" || (m.from === to && m.to === from);
  const latestOn = (thread: string) =>
    peer.filter((m) => m.thread === thread && eligible(m)).sort((a, b) => a.ts.localeCompare(b.ts)).at(-1) ?? null;
  const mentioned: DmMessage[] = [];
  for (const token of new Set(body.toUpperCase().match(ID_TOKEN_RE) ?? [])) {
    const hits = peer.filter((m) => m.id.startsWith(token));
    if (hits.length === 1) mentioned.push(hits[0]!);
  }
  const byMention = mentioned
    .map((m) => latestOn(m.thread))
    .filter((m): m is DmMessage => m !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .at(-1);
  if (byMention) return { parent: byMention, by: "mention" };
  // Otherwise: the latest DM that `to` sent `from` inside the window and that `from` has not yet
  // written back on (an open question or task). A DM to a bot you have already answered starts a
  // new thread unless it quotes an id, so unrelated topics are not glued together.
  const open = peer
    .filter((m) => m.from === to && m.to === from && now - Date.parse(m.ts) < windowMs)
    .filter((m) => !peer.some((x) => x.from === from && x.thread === m.thread && x.ts > m.ts))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .at(-1);
  return open ? { parent: latestOn(open.thread) ?? open, by: "recent" } : null;
}

/** Highest hop recorded on a thread. */
export function threadHop(messages: DmMessage[], thread: string): number {
  return messages.filter((m) => m.thread === thread).reduce((max, m) => Math.max(max, m.hop), 0);
}

/** Messages from `from` to `to` in the last hour that were not refused. */
export function countRecent(
  outbox: Array<DmMessage | DmStatus>,
  from: string,
  to: string,
  now: number,
): number {
  const refused = new Set(outbox.filter((r) => r.type === "status" && r.status === "refused").map((r) => r.id));
  const seen = new Set<string>();
  for (const r of outbox) {
    if (r.type !== "message" || r.from !== from || r.to !== to || refused.has(r.id) || seen.has(r.id)) continue;
    if (now - Date.parse(r.ts) < RATE_WINDOW_MS) seen.add(r.id);
  }
  return seen.size;
}

export function checkRate(count: number, to: string): Refusal | null {
  return count >= RATE_LIMIT_PER_HOUR
    ? {
        code: "rate_limited",
        reason: `already ${count} DMs to ${to} in the last hour; the limit is ${RATE_LIMIT_PER_HOUR}`,
        advice: "Wait, or batch what you have into one message. If this is a loop, stop and escalate.",
      }
    : null;
}

export function checkSize(body: string): Refusal | null {
  return body.length > DM_MAX_BODY
    ? {
        code: "too_large",
        reason: `body is ${body.length} chars; the limit is ${DM_MAX_BODY}`,
        advice: "Write the content to a file and send its absolute path with --attach <path>.",
      }
    : null;
}

/** One line, at most DM_MAX_SUBJECT chars, from the first non-empty line of the body. */
export function deriveSubject(body: string): string {
  const first = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.length <= DM_MAX_SUBJECT ? first : `${first.slice(0, DM_MAX_SUBJECT - 1)}…`;
}

/** Body as stored in a refusal record: the schema caps bodies, so oversize ones are cut. */
export function clampBody(body: string): string {
  const marker = `\n[…cut: ${body.length} chars]`;
  return body.length <= DM_MAX_BODY ? body : body.slice(0, DM_MAX_BODY - marker.length) + marker;
}

export class UsageError extends Error {}
