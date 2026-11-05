import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BOT_ID_RE, GROUP_ID_RE, GROUP_MAX_MEMBERS } from "./rooms/schema";
import { AGENTS_MD_MAX, HomeStateSchema, ItemKeySchema, NAME_MAX } from "./manage";
import { TEMPLATE_IDS } from "./templates";
import { AvatarJsonSchema } from "./avatar/schema";

const NameSchema = z.string().trim().min(1, "Give it a name.").max(NAME_MAX);
const BotIdSchema = z.string().regex(BOT_ID_RE, "not a bot id");
/** `data:image/png;base64,…` from the app's image picker. */
const AvatarSchema = z.string().startsWith("data:image/png;base64,").max(1_100_000);

/** Pins and archive state (`~/bots/.home.json`; with no file: the featured bot pinned, nothing archived). */
export const homeStateRpc = defineRpc({
  name: "home.state",
  input: z.object({}),
  output: HomeStateSchema,
});

export const homePinRpc = defineRpc({
  name: "home.pin",
  input: z.object({ key: ItemKeySchema, pinned: z.boolean() }),
  output: HomeStateSchema,
});

export const homeArchiveRpc = defineRpc({
  name: "home.archive",
  input: z.object({ key: ItemKeySchema, archived: z.boolean() }),
  output: HomeStateSchema,
});

/** The bot's AGENTS.md (OptChat profile) with its mtime, for the edit sheet. */
export const botsAgentsMdRpc = defineRpc({
  name: "bots.agents-md",
  input: z.object({ botId: BotIdSchema }),
  output: z.object({ text: z.string(), mtimeMs: z.number().nullable() }),
});

/**
 * Files only: `~/bots/<id>/` (profile marker, .bot.json, dm/, avatar.png) and the profile's AGENTS.md.
 * `missing` lists the fleet steps the plugin does not do.
 */
export const botsCreateRpc = defineRpc({
  name: "bots.create",
  input: z.object({
    name: NameSchema,
    /** Full AGENTS.md (Advanced). Empty: the host builds it from `template` and `purpose`. */
    agentsMd: z.string().max(AGENTS_MD_MAX),
    avatar: AvatarSchema.optional(),
    /** A designed avatar (avatar.json, AV1), rendered on the host. Not together with `avatar`. Older hosts ignore it. */
    avatarJson: AvatarJsonSchema.optional(),
    /** Starter template id (shared/templates.ts); release/app hosts. Older hosts ignore it. */
    template: z.enum(TEMPLATE_IDS).optional(),
    /** One line: what the bot is for. Goes into AGENTS.md. */
    purpose: z.string().max(500).optional(),
    /** The chat model, e.g. { provider: "optchat/anthropic/claude-sonnet-5-5", thinkingOptionId: "medium" }. */
    chat: z.object({ provider: z.string().min(1).max(200), thinkingOptionId: z.string().max(40).optional() }).optional(),
    /** Start the first chat now and send the intro prompt, so the bot says hello. */
    intro: z.boolean().optional(),
  }),
  output: z.object({ botId: z.string(), missing: z.array(z.string()), agentId: z.string().nullish() }),
});

/**
 * Delete bot: archives its chats, moves its folder and OptChat profile to `~/bots/.trash/` (nothing
 * is erased) and drops its pin. `confirmName` must equal the bot's display name (typed by the user).
 * Refused while a group has the bot as a member.
 */
export const botsDeleteRpc = defineRpc({
  name: "bots.delete",
  input: z.object({ botId: BotIdSchema, confirmName: z.string() }),
  output: z.object({ ok: z.literal(true), trash: z.string(), archivedChats: z.number() }),
});

/**
 * Edit a bot. Only the fields sent change. `agentsMd.baseMtimeMs` is the mtime the sheet loaded; the
 * write is refused when the file changed since (the bot may have edited it).
 */
export const botsUpdateRpc = defineRpc({
  name: "bots.update",
  input: z.object({
    botId: BotIdSchema,
    name: NameSchema.optional(),
    agentsMd: z.object({ text: z.string().max(AGENTS_MD_MAX), baseMtimeMs: z.number().nullable() }).optional(),
    avatar: AvatarSchema.optional(),
    /**
     * A designed avatar (avatar.json, AV1). Not together with `avatar`. Refused (error) when the host has a newer
     * revision; the designer's own save path is `bots.avatar-save`, which answers that as a result.
     */
    avatarJson: AvatarJsonSchema.optional(),
  }),
  /** `avatarHash`: the designed avatar's content hash, when `avatarJson` was sent. */
  output: z.object({ ok: z.literal(true), avatarHash: z.string().optional() }),
});

/** New group in `~/bots/.groups.json` (same checks as the members editor). */
export const roomsCreateRpc = defineRpc({
  name: "rooms.create",
  input: z.object({
    name: NameSchema,
    members: z.array(BotIdSchema).min(1).max(GROUP_MAX_MEMBERS + 1),
    leads: z.array(BotIdSchema).max(GROUP_MAX_MEMBERS + 1),
  }),
  output: z.object({ groupId: z.string() }),
});

export const roomsRenameRpc = defineRpc({
  name: "rooms.rename",
  input: z.object({ groupId: z.string().regex(GROUP_ID_RE, "not a group id"), name: NameSchema }),
  output: z.object({ ok: z.literal(true) }),
});

/** OptChat thinking levels (pi-optchat `THINKING`). */
export const COMPACTOR_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CompactorSchema = z.object({
  /** Pi provider, e.g. "anthropic" or "openrouter". */
  provider: z.string().min(1),
  /** Pi model id, e.g. "claude-sonnet-5-5" or "z-ai/glm-5.3". */
  model: z.string().min(1),
  thinking: z.enum(COMPACTOR_THINKING),
});
export type Compactor = z.infer<typeof CompactorSchema>;

/** The bot's compaction model (OptChat profile config.json `compactor`; `isDefault` when it has none). */
export const botsCompactorRpc = defineRpc({
  name: "bots.compactor",
  input: z.object({ botId: BotIdSchema }),
  output: CompactorSchema.extend({ isDefault: z.boolean() }),
});

/** Sets the compaction model; every other key of config.json stays. Used from the next summary. */
export const botsSetCompactorRpc = defineRpc({
  name: "bots.set-compactor",
  input: z.object({ botId: BotIdSchema, compactor: CompactorSchema }),
  output: CompactorSchema.extend({ isDefault: z.boolean() }),
});
