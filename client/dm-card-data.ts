import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import { DM_KINDS, parseEnvelope } from "../shared/dm-schema";

export const DM_CARD_KIND = "dm-card";
export const DM_CARD_VERSION = 1;

export const DmCardSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(DM_KINDS),
  hop: z.number(),
  re: z.string().nullable(),
  expects_reply: z.boolean(),
  body: z.string(),
  /** bot-dm's second-line note when it says more than the card header (resume nudges, schedule runs); shown muted. */
  note: z.string().nullable().optional(),
});
export type DmCardData = z.infer<typeof DmCardSchema>;

/** A `[dm …]` user message as card data, or null for anything else (the owner's own messages stay as they are). */
/** The last line bot-dm appends to delivered DMs (the command to answer); not part of the body. */
export const REPLY_HINT_RE = /\n?\((?:To answer|No answer needed\. To add to this thread): bot-dm [^\n]*\)\s*$/;

/**
 * The note bot-dm puts on the second line of a delivered DM (who sent it, not the owner). Sender notes
 * repeat the card header ("DM from …"), so the card hides them; resume and schedule notes carry
 * more (automatic nudge, schedule name), so the card shows them muted above the body.
 */
export const SENDER_NOTE_RE = /^\((?:Message from the bot |Report from your worker )[^\n]*\)$/;
export const INFO_NOTE_RE = /^\((?:System nudge from |Report from a run of your Paseo schedule )[^\n]*\)$/;

export function dmCardData(text: string): DmCardData | null {
  const envelope = parseEnvelope(text);
  if (!envelope) return null;
  const newline = text.indexOf("\n");
  let rest = newline === -1 ? "" : text.slice(newline + 1);
  let note: string | null = null;
  const end = rest.indexOf("\n");
  const second = end === -1 ? rest : rest.slice(0, end);
  if (SENDER_NOTE_RE.test(second) || INFO_NOTE_RE.test(second)) {
    if (INFO_NOTE_RE.test(second)) note = second.slice(1, -1);
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  return { ...envelope, ...(note ? { note } : {}), body: rest.replace(REPLY_HINT_RE, "").trim() };
}

/** Option C: restyle bot DMs in a bot's main chat so they no longer look as if the owner typed them. */
export const dmCardTransformer: PluginTimelineTransformerContribution<"user_message"> = {
  id: "dm-card",
  query: { itemType: "user_message" },
  transform({ item }) {
    const data = dmCardData(item.text);
    if (!data) return undefined;
    return { items: [{ type: "plugin", kind: DM_CARD_KIND, version: DM_CARD_VERSION, data }] };
  },
};

