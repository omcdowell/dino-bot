import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BotSchema = z.object({
  /** Folder name under the bots root, e.g. "bitzer". */
  id: z.string(),
  /** Paseo project name when set, else derived from the folder. */
  name: z.string(),
  /** Absolute folder path; also the agent's working directory. */
  cwd: z.string(),
  /** Lucide icon name. */
  icon: z.string(),
  order: z.number(),
  /**
   * Icon image for the phone home: `.bot.json` "avatar", a PNG path (absolute, `~/`, or relative to
   * the bot folder). Null: the home draws the Lucide `icon` instead.
   */
  avatar: z.string().nullable().default(null),
  /**
   * Content hash of the avatar PNG (sha256, 16 base64url chars); null when there is no usable
   * image. The phone keys its device copy by it and asks for the bytes only when it changes.
   * Optional: older servers do not send it.
   */
  avatarHash: z.string().nullable().optional(),
  /**
   * `packVersion` of the bot's avatar.json (the designer's save); null or absent when it has none
   * (an uploaded PNG, or an older server). With a pack at least this new the phone draws the avatar
   * from that JSON (`bots.avatar` format "json") instead of fetching a PNG.
   */
  avatarPack: z.number().int().min(1).nullable().optional(),
  /**
   * Shown large at the top of the phone home: `.bot.json` "featured": true, else the one bot with
   * the lowest `order` (when no other bot shares it).
   */
  featured: z.boolean().default(false),
  /** The bot's current chat, if it has one. */
  agentId: z.string().nullable(),
});
export type Bot = z.infer<typeof BotSchema>;

export const botsListRpc = defineRpc({
  name: "bots.list",
  input: z.object({}),
  output: z.object({
    bots: z.array(BotSchema),
    /** The server's avatar options pack version; newer than the app's: the app fetches it once (`bots.avatar-pack`). */
    avatarPackVersion: z.number().int().min(1).optional(),
  }),
});

export const botsOpenRpc = defineRpc({
  name: "bots.open",
  input: z.object({ botId: z.string() }),
  output: z.object({ agentId: z.string(), created: z.boolean() }),
});

export const botsNewChatRpc = defineRpc({
  name: "bots.new-chat",
  input: z.object({ botId: z.string() }),
  output: z.object({ agentId: z.string(), archived: z.number() }),
});

/**
 * Bot chats whose "New reply" flag is owed only to turns that a bot DM started (server/dm-turns.ts).
 * The row hides the green dot for these.
 */
export const botsQuietRpc = defineRpc({
  name: "bots.quiet",
  input: z.object({}),
  output: z.object({ agentIds: z.array(z.string()) }),
});

export const QUIET_POLL_MS = 10_000;

/** Label stamped on every chat this plugin creates. */
export const BOT_LABEL = "bot";
/**
 * Paseo per-agent send behaviour (msg-ticks): bot chats queue messages while the bot works;
 * each message can still be forced in (steer) from the app.
 */
export const SEND_BEHAVIOR_LABEL = "paseo.send-behavior";
/**
 * Paseo keep-live label (chat-prefetch): the app keeps chats labelled "1" synced in the
 * background so opening one shows the latest messages at once. Set on each bot's current chat,
 * "0" on its older chats (the update API merges labels and cannot remove one).
 */
export const KEEP_LIVE_LABEL = "paseo.keep-live";
/** Paseo provider id of the OptChat provider (custom provider extending pi). */
export const OPTCHAT_PROVIDER = "optchat";
