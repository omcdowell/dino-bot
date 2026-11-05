import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DM_MAX_BODY, DmIdSchema, DmKindSchema, DmMessageSchema, DmStatusValueSchema, USER } from "./dm-schema";

/** Bot folder id; validated again on the server before it touches the filesystem. */
const BotIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "not a bot id");
const Ts = z.string();

/** A ledger message as seen from one bot, with its latest delivery status joined in. */
export const DmViewSchema = DmMessageSchema.extend({
  /** "out" when the viewed bot sent it, "in" otherwise. */
  direction: z.enum(["in", "out"]),
  status: DmStatusValueSchema.nullable(),
  status_detail: z.string().nullable(),
});
export type DmView = z.infer<typeof DmViewSchema>;

export const DmThreadSummarySchema = z.object({
  thread: DmIdSchema,
  subject: z.string(),
  /** The other parties in the thread, in order of first appearance. */
  parties: z.array(z.string()),
  /** Kind of the root message (or the earliest one held). */
  kind: DmKindSchema,
  count: z.number(),
  first_ts: Ts,
  last_ts: Ts,
  last_from: z.string(),
  last_status: DmStatusValueSchema.nullable(),
  max_hop: z.number(),
  has_escalate: z.boolean(),
  /** A message asked for a reply and nothing in the thread answers it yet. */
  awaiting_reply: z.boolean(),
  /** At least one message in the thread was refused or failed. */
  has_problem: z.boolean(),
});
export type DmThreadSummary = z.infer<typeof DmThreadSummarySchema>;

export const DmBotSummarySchema = z.object({
  botId: z.string(),
  total: z.number(),
  last_ts: Ts.nullable(),
});
export type DmBotSummary = z.infer<typeof DmBotSummarySchema>;

/** Lines the reader skipped, so the UI can say the ledger has damage. */
const SkippedSchema = z.object({ invalid: z.number(), unknown: z.number(), truncated: z.boolean() });

export const dmsSummaryRpc = defineRpc({
  name: "dms.summary",
  input: z.object({}),
  output: z.object({ bots: z.array(DmBotSummarySchema) }),
});

export const dmsThreadsRpc = defineRpc({
  name: "dms.threads",
  input: z.object({ botId: BotIdSchema }),
  output: z.object({ threads: z.array(DmThreadSummarySchema), skipped: SkippedSchema }),
});

export const dmsThreadRpc = defineRpc({
  name: "dms.thread",
  /** Give `threadId`, or `messageId` to open the thread holding that message (timeline cards know only the message). */
  input: z.object({ botId: BotIdSchema, threadId: DmIdSchema.optional(), messageId: DmIdSchema.optional() }),
  output: z.object({
    thread: DmThreadSummarySchema.nullable(),
    messages: z.array(DmViewSchema),
  }),
});

export const dmsReplyRpc = defineRpc({
  name: "dms.reply",
  input: z.object({ botId: BotIdSchema, threadId: DmIdSchema, text: z.string().min(1).max(DM_MAX_BODY) }),
  output: z.object({
    id: DmIdSchema,
    agentId: z.string(),
    /** False when the send worked but the ledger append did not; `warning` says why. */
    recorded: z.boolean(),
    warning: z.string().nullable(),
  }),
});

/** Sender id the plugin stamps on the owner's replies (and the recipient of `bot-dm user`). */
export { USER };
/** `origin` on ledger lines this plugin writes. */
export const DMS_ORIGIN = "paseo-bots/dms-1";
/** Prefix of the text a reply puts into the bot's chat. Never starts with "/" (that would interrupt). */
export const replyText = (threadId: string, text: string) => `Re dm ${threadId}: ${text}`;
