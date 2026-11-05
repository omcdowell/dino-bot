/**
 * `bot-dm user`: a DM to the owner himself, delivered as a push to his phone by the paseo-apns
 * add-on. Bots send these deliberately; nothing in Paseo pushes on agent events.
 *
 * The DM is recorded in the sender's outbox like any other DM, so it shows in that bot's DMs tab
 * (party "You"). Delivery is the push: status `pushed` on success, `refused` when the add-on
 * refuses (one push per 10 min per bot, no registered phone) or is missing, `failed` when Apple
 * took it for no device. Refused pushes are not queued. A worker's or schedule run's push uses its
 * bot's slot (`limitKey`), so launching workers does not get round the limit. A bot refused on the
 * limit gets one system DM when its slot reopens (server/push-slot-notify.ts; recorded here).
 *
 * Erasable TypeScript only: Node runs this file directly.
 */
import { DM_ORIGIN, DM_SCHEMA_VERSION, USER, type DmKind, type DmMessage, type DmStatus, type DmStatusValue } from "../shared/dm-schema.ts";
import { userName } from "../shared/party.ts";
import { appendRecord, lastStatus, ledgerPath, readRecords, withLocks } from "../server/ledger-write.ts";
import { checkRate, checkSize, countRecent, isScheduleSender, isSystemSender, isWorker, type Refusal } from "./policy.ts";
import type { PushOutcome, PushPort } from "./push.ts";
import { recordRefusal } from "../server/push-slot-notify.ts";

/** Kinds a DM to the owner may have. Replies to him go in the chat he is reading. */
export const USER_KINDS: readonly DmKind[] = ["info", "request", "report"];

export type ToUserResult = { exit: number; output: Record<string, unknown> };

export type ToUserInput = {
  id: string;
  now: Date;
  /** Stamped sender: bot name, worker:<name> or worker:schedule.<id>. */
  from: string;
  /** Whose 10-min slot the push uses when not `from`'s own: a worker's or schedule run's bot. Null: its own. */
  limitKey?: string | null;
  /** push-slots.jsonl: a bot's rate-limit refusal is recorded there for the slot-open notice. Null: not recorded. */
  slotsPath?: string | null;
  displayName: string;
  /** Sender's own chat (bots), for tap routing on the phone. */
  fromAgent: { id: string; workspaceId?: string | null } | null;
  fromDir: string;
  kind: DmKind;
  body: string;
  subject: string;
  attachments: string[];
  expectsReply: boolean;
  /** --id was given: a retry of an earlier send. */
  retry: boolean;
  dryRun: boolean;
  push: PushPort;
  clock: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
};

/** Who may push to the owner, and with which kinds. */
export function checkToUser(from: string, kind: DmKind): Refusal | null {
  if (isSystemSender(from)) {
    return {
      code: "not_allowed",
      reason: `${from} sends automatic notices; ${userName()} gets pushes only from deliberate DMs`,
      advice: "Send the notice to the bot that owns the work instead.",
    };
  }
  if (isWorker(from) && !isScheduleSender(from) && kind !== "report") {
    return { code: "not_allowed", reason: `workers send ${userName()} --kind report only, not ${kind}`, advice: "Use --kind report." };
  }
  if (!USER_KINDS.includes(kind)) {
    return {
      code: "not_allowed",
      reason: `kind=${kind} is not for ${userName()} (use ${USER_KINDS.join(", ")})`,
      advice: "Use --kind info, or --kind request if you need an answer.",
    };
  }
  return null;
}

/** "08:42 UTC (in 7 min)". */
export function slotText(retryAt: string, now: Date): string {
  const at = new Date(retryAt);
  if (Number.isNaN(at.getTime())) return retryAt;
  const mins = Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 60_000));
  return `${at.toISOString().slice(11, 16)} UTC (in ${mins} min)`;
}

type Who = { from: string; limitKey: string | null };

function refusalFor(outcome: Exclude<PushOutcome, { kind: "sent" } | { kind: "failed" }>, now: Date, who: Who, notice = false): Refusal & { retryAt?: string } {
  switch (outcome.kind) {
    case "rate_limited": {
      const key = who.limitKey ?? who.from;
      const whose =
        key !== who.from
          ? `workers count towards the bot that launched them (${key}), and its slot was used recently. ${key}'s next slot opens at`
          : isWorker(who.from)
            ? `${who.from} sent one recently. Its next slot opens at`
            : "yours (or one of your workers') went out recently. Your next slot opens at";
      return {
        code: "rate_limited",
        reason: `${userName()} gets at most one push per 10 minutes from each bot; ${whose} ${slotText(outcome.retryAt, now)}`,
        advice: notice
          ? "Not queued: nothing was pushed. You will get one system DM when your slot reopens; send again then only if it still matters, or leave it in your chat for when they look."
          : "Not queued: nothing was pushed. Send again after that only if it still matters, or leave it in your chat for when they look.",
        retryAt: outcome.retryAt,
      };
    }
    case "no_device":
      return {
        code: "no_device",
        reason: "no phone is registered for pushes yet (paseo-apns has no device token)",
        advice: `Nothing was pushed. Leave it in your chat; ${userName()}'s phone registers when they open the Paseo app.`,
      };
    case "unavailable":
      return {
        code: "push_unavailable",
        reason: outcome.message,
        advice: "Nothing was pushed. Leave it in your chat, and tell Emmet if pushes should be working.",
      };
  }
}

export async function sendToUser(input: ToUserInput): Promise<ToUserResult> {
  const { id, from, fromDir, kind, body, now } = input;
  const base = { id, from, to: USER, kind, agentId: null, recipientStatus: null };
  const status = (s: DmStatusValue, detail: string | null): DmStatus => ({
    v: DM_SCHEMA_VERSION,
    type: "status",
    id,
    ts: input.clock().toISOString(),
    status: s,
    detail,
  });
  const record: DmMessage = {
    v: DM_SCHEMA_VERSION,
    type: "message",
    id,
    ts: now.toISOString(),
    from,
    to: USER,
    kind,
    thread: id,
    re: null,
    hop: 1,
    subject: input.subject,
    body,
    attachments: input.attachments,
    expects_reply: input.expectsReply,
    from_agent_id: input.fromAgent?.id ?? null,
    to_agent_id: null,
    origin: DM_ORIGIN,
  };

  const refuse = (refusal: Refusal & { retryAt?: string }, written: boolean, dryRun = false): ToUserResult => {
    const output = {
      ok: false,
      ...base,
      thread: id,
      status: "refused",
      detail: refusal.code,
      reason: refusal.reason,
      advice: refusal.advice,
      ...(refusal.retryAt ? { retryAt: refusal.retryAt } : {}),
      ...(dryRun ? { dryRun: true } : {}),
      ...(written ? {} : { recorded: false }),
    };
    input.out(JSON.stringify(output));
    input.err(`bot-dm: refused (${refusal.code}): ${refusal.reason}. ${refusal.advice}`);
    return { exit: 3, output };
  };

  // ---- rules (no writes) -------------------------------------------------------------------
  const outbox = readRecords(ledgerPath(fromDir, "outbox"));
  const existing = outbox.find((r): r is DmMessage => r.type === "message" && r.id === id);
  if (existing) {
    const last = lastStatus(outbox, id);
    if (existing.to !== USER || existing.body !== body) {
      return refuse({ code: "not_allowed", reason: `id ${id} was already used for a different message`, advice: "Drop --id." }, false);
    }
    if (last?.status === "pushed") {
      const output = { ok: true, duplicate: true, ...base, status: "pushed" };
      input.out(JSON.stringify(output));
      return { exit: 0, output };
    }
  }
  const rule =
    checkToUser(from, kind) ??
    checkSize(body) ??
    (existing ? null : checkRate(countRecent(outbox as Array<DmMessage | DmStatus>, from, USER, now.getTime()), userName()));

  const limitKey = input.limitKey && input.limitKey !== from ? input.limitKey : null;
  const who: Who = { from, limitKey };
  const request = {
    sender: from,
    ...(limitKey ? { limitKey } : {}),
    title: input.displayName,
    body,
    data: {
      kind: "bot-dm",
      from,
      dmId: id,
      threadId: id,
      ...(input.fromAgent ? { agentId: input.fromAgent.id } : {}),
      ...(input.fromAgent?.workspaceId ? { workspaceId: input.fromAgent.workspaceId } : {}),
    },
  };

  if (input.dryRun) {
    if (rule) return refuse(rule, false, true);
    const st = await input.push.status(limitKey ?? from);
    const predicted: Exclude<PushOutcome, { kind: "sent" } | { kind: "failed" }> | null = !st.reachable
      ? { kind: "unavailable", message: st.message }
      : !st.configured
        ? { kind: "unavailable", message: "the paseo-apns add-on is running but not configured (no config.json)" }
        : st.devices === 0
          ? { kind: "no_device", message: "" }
          : st.nextSlotAt && Date.parse(st.nextSlotAt) > now.getTime()
            ? { kind: "rate_limited", retryAt: st.nextSlotAt, retryInSeconds: 0, message: "" }
            : null;
    if (predicted) return refuse(refusalFor(predicted, now, who), false, true);
    const output = { ok: true, dryRun: true, ...base, thread: id, push: request };
    input.out(JSON.stringify(output));
    return { exit: 0, output };
  }

  if (rule) {
    await withLocks([fromDir], () => {
      appendRecord(fromDir, "outbox", record, now);
      appendRecord(fromDir, "outbox", status("refused", rule.code), now);
    });
    return refuse(rule, true);
  }

  await withLocks([fromDir], () => {
    if (!existing) appendRecord(fromDir, "outbox", record, now);
    appendRecord(fromDir, "outbox", status("queued", null), now);
  });

  const outcome = await input.push.notify(request);
  if (outcome.kind === "sent") {
    const final = status("pushed", `${outcome.sent} device${outcome.sent === 1 ? "" : "s"}`);
    await withLocks([fromDir], () => appendRecord(fromDir, "outbox", final));
    const output = { ok: true, ...base, thread: id, status: "pushed", devices: outcome.sent, nextSlotAt: outcome.nextSlotAt, sentAt: final.ts, ...(existing ? { retry: true } : {}) };
    input.out(JSON.stringify(output));
    return { exit: 0, output };
  }
  if (outcome.kind === "failed") {
    const final = status("failed", outcome.message);
    await withLocks([fromDir], () => appendRecord(fromDir, "outbox", final));
    const output = { ok: false, ...base, thread: id, status: "failed", detail: outcome.message };
    input.out(JSON.stringify(output));
    input.err(`bot-dm: push ${id} to ${userName()} failed: ${outcome.message}. Retry later with --id ${id}, or leave it in your chat.`);
    return { exit: 1, output };
  }
  // A bot refused on its own slot is told once when it reopens (workers cannot receive DMs).
  let notice = false;
  if (outcome.kind === "rate_limited" && !limitKey && !isWorker(from) && input.slotsPath) {
    try {
      recordRefusal(input.slotsPath, { bot: from, at: now.toISOString(), retryAt: outcome.retryAt, dm: id });
      notice = true;
    } catch {
      // no notice then; the refusal still names the time
    }
  }
  const refusal = refusalFor(outcome, now, who, notice);
  await withLocks([fromDir], () => appendRecord(fromDir, "outbox", status("refused", refusal.code)));
  return refuse(refusal, true);
}
