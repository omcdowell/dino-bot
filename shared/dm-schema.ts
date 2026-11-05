/**
 * Bot-to-bot DM ledger schema (v1).
 *
 * One JSON object per line in `~/bots/<name>/dm/inbox.jsonl` and `outbox.jsonl`.
 * Written only by the `bot-dm` wrapper (bin/bot-dm.mjs); read by the plugin's DMs view.
 * Source of truth: research/bot-dms/reports/07-paseo-dms-tab.md §5.
 *
 * This file must stay erasable TypeScript (no enums, namespaces or parameter properties) and
 * import nothing but `zod`: Node runs it directly through type stripping when bot-dm imports it.
 */
import { z } from "zod";

export const DM_SCHEMA_VERSION = 1;
export const DM_ORIGIN = "bot-dm/1";

/**
 * `resume` is a system nudge (e.g. "the rate limit has reset, carry on"), sent only by the system
 * senders listed in bot-dm/policy.ts (SYSTEM_SENDERS). It expects no reply.
 */
export const DM_KINDS = ["request", "reply", "info", "escalate", "report", "resume"] as const;
/** `pushed`: a DM to the owner that paseo-apns accepted for his phone (no chat delivery). */
export const DM_STATUSES = ["queued", "steered", "started", "pushed", "failed", "refused"] as const;
/** Reason codes the wrapper writes into `status.detail` on refusal. Failures carry daemon text. */
export const DM_REFUSAL_CODES = [
  "unknown_recipient",
  "not_allowed",
  "rate_limited",
  "hop_cap",
  "too_large",
  /** DM to the owner: no phone has registered with paseo-apns. */
  "no_device",
  /** DM to the owner: the paseo-apns add-on is not installed, not running or not configured. */
  "push_unavailable",
] as const;

/** Body cap in characters. Larger content goes in `attachments` as absolute file paths. */
export const DM_MAX_BODY = 4000;
export const DM_MAX_SUBJECT = 80;
/** Rotate inbox.jsonl / outbox.jsonl to `<name>-YYYY-MM.jsonl` past this size. */
export const DM_ROTATE_BYTES = 5 * 1024 * 1024;

/** ULID: 26 chars of Crockford base32 (10 time + 16 random). */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The user as a DM party: sender of replies from the Paseo UI, recipient of `bot-dm user` (a push). */
export { USER } from "./party.ts";
import { USER, normalizeParties, normalizeParty } from "./party.ts";
/** Bot folder id under ~/bots; also "user" for replies sent from the Paseo UI. */
export const BOT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Herdr worker sender, e.g. "worker:wp1-bot-dm". */
export const WORKER_NAME_RE = /^worker:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const DmKindSchema = z.enum(DM_KINDS);
export const DmStatusValueSchema = z.enum(DM_STATUSES);
export const DmIdSchema = z.string().regex(ULID_RE, "not a ULID");
export const DmPartySchema = z
  .string()
  .refine((s) => BOT_NAME_RE.test(s) || WORKER_NAME_RE.test(s), "not a bot name, user or worker:<name>");
const IsoTs = z.iso.datetime({ offset: false });

export const DmMessageSchema = z.object({
  v: z.literal(DM_SCHEMA_VERSION),
  type: z.literal("message"),
  id: DmIdSchema,
  /** UTC ISO time of sending. */
  ts: IsoTs,
  from: DmPartySchema,
  to: DmPartySchema,
  kind: DmKindSchema,
  /** Id of the thread's root message (equals `id` on a root). */
  thread: DmIdSchema,
  /** Id this message answers, or null on a root. */
  re: DmIdSchema.nullable(),
  hop: z.number().int().min(1),
  subject: z.string().max(DM_MAX_SUBJECT),
  body: z.string().min(1).max(DM_MAX_BODY),
  /** Absolute paths. */
  attachments: z.array(z.string().startsWith("/")),
  expects_reply: z.boolean(),
  /** Paseo agent ids at send time; null for worker/operator senders or unresolved recipients. */
  from_agent_id: z.string().nullable(),
  to_agent_id: z.string().nullable(),
  /** Writer name and version, e.g. "bot-dm/1". */
  origin: z.string(),
});
export type DmMessage = z.infer<typeof DmMessageSchema>;

export const DmStatusSchema = z.object({
  v: z.literal(DM_SCHEMA_VERSION),
  type: z.literal("status"),
  id: DmIdSchema,
  ts: IsoTs,
  status: DmStatusValueSchema,
  /** Refusal code (DM_REFUSAL_CODES) or daemon error text; null otherwise. */
  detail: z.string().nullable(),
});
export type DmStatus = z.infer<typeof DmStatusSchema>;

export const DmRecordSchema = z.discriminatedUnion("type", [DmMessageSchema, DmStatusSchema]);
export type DmRecord = z.infer<typeof DmRecordSchema>;
export type DmKind = z.infer<typeof DmKindSchema>;
export type DmStatusValue = z.infer<typeof DmStatusValueSchema>;
export type DmRefusalCode = (typeof DM_REFUSAL_CODES)[number];

export type LedgerLine =
  | { ok: true; record: DmRecord }
  /** Valid JSON object of a type or version this reader does not know: skip silently. */
  | { ok: false; reason: "unknown" }
  /** Broken JSON or a known type that fails validation: count and skip. */
  | { ok: false; reason: "invalid"; error: string };

/** Parse one ledger line. Readers skip unknown types/versions so the schema can grow. */
export function parseLedgerLine(line: string): LedgerLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return { ok: false, reason: "invalid", error: `bad JSON: ${(error as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid", error: "not an object" };
  }
  const { v, type } = raw as { v?: unknown; type?: unknown };
  if (v !== DM_SCHEMA_VERSION || (type !== "message" && type !== "status")) {
    return typeof v === "number" && typeof type === "string"
      ? { ok: false, reason: "unknown" }
      : { ok: false, reason: "invalid", error: "missing v/type" };
  }
  // An alias of the user (an older id) reads as USER.
  const parsed = DmRecordSchema.safeParse(normalizeParties(raw as { from?: unknown; to?: unknown }));
  return parsed.success
    ? { ok: true, record: parsed.data }
    : { ok: false, reason: "invalid", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

// --- Envelope: the first line of the text delivered into the recipient's chat. ---------------
// `[dm <id> from <from> to <to> kind=<kind> hop=<n> re=<id|->]`
// It must stay the first line: a message starting with "/" makes Paseo's pi provider fall back
// to interrupt (report 05, gotcha 5).

export const DM_ENVELOPE_RE =
  /^\[dm (\S+) from (\S+) to (\S+) kind=([a-z]+) hop=(\d+) re=(\S+)(?: expects-reply)?\]/;

export type DmEnvelope = {
  id: string;
  from: string;
  to: string;
  kind: DmKind;
  hop: number;
  re: string | null;
  expects_reply: boolean;
};

export function formatEnvelope(e: DmEnvelope): string {
  return `[dm ${e.id} from ${e.from} to ${e.to} kind=${e.kind} hop=${e.hop} re=${e.re ?? "-"}${e.expects_reply ? " expects-reply" : ""}]`;
}

export function parseEnvelope(text: string): DmEnvelope | null {
  const m = DM_ENVELOPE_RE.exec(text);
  if (!m) return null;
  const kind = DmKindSchema.safeParse(m[4]);
  if (!kind.success) return null;
  // Same sender and recipient names the ledger accepts (pi-optchat's memory tag matches these too).
  if (!(BOT_NAME_RE.test(m[2]) || WORKER_NAME_RE.test(m[2])) || !BOT_NAME_RE.test(m[3])) return null;
  return {
    id: m[1],
    from: normalizeParty(m[2]),
    to: normalizeParty(m[3]),
    kind: kind.data,
    hop: Number(m[5]),
    re: m[6] === "-" ? null : m[6],
    expects_reply: m[0].endsWith(" expects-reply]"),
  };
}
