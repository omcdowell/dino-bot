import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One line about the bot's latest response: a chat reply, an error, or a DM it sent. */
export const BotPreviewSchema = z.object({
  kind: z.enum(["reply", "error", "dm"]),
  text: z.string(),
  ts: z.string(),
});
export type BotPreview = z.infer<typeof BotPreviewSchema>;

export const botsPreviewsRpc = defineRpc({
  name: "bots.previews",
  input: z.object({}),
  output: z.object({
    bots: z.array(
      z.object({
        botId: z.string(),
        preview: BotPreviewSchema.nullable(),
        /** Start of the current chat's latest turn (first timeline entry of that turn). */
        turnStartedAt: z.string().nullable(),
        /**
         * Last activity for the home's order: the newest chat message (prompt, reply, error) or DM
         * sent or received. Optional for older servers.
         */
        activityAt: z.string().nullable().optional(),
      }),
    ),
  }),
});

export const PREVIEWS_POLL_MS = 10_000;

/** PNG sizes the server renders from avatar.json (avatar-spec §4); the phone asks for one of them. */
export const AVATAR_PNG_SIZES = [64, 128, 512] as const;
export type AvatarPngSize = (typeof AVATAR_PNG_SIZES)[number];

export const botsAvatarRpc = defineRpc({
  name: "bots.avatar",
  input: z.object({
    botId: z.string(),
    /**
     * The PNG size the phone needs (64, 128 or 512 px square; AV1 renders these from avatar.json).
     * Absent: the full `avatar.png`, as before. Ignored for a plain avatar.png. Older servers ignore
     * it and send the full image (no `size` in the answer).
     */
    size: z.union([z.literal(64), z.literal(128), z.literal(512)]).optional(),
    /**
     * "json": the phone can draw this bot from its avatar.json with the pack it has (it checked
     * `Bot.avatarPack`), so send that (~300 B) instead of a PNG. A bot without avatar.json gets the
     * PNG (at `size`) instead.
     */
    format: z.enum(["png", "json"]).optional(),
  }),
  /**
   * `data:image/png;base64,…`, or null when the bot has no usable avatar image; `hash` is its
   * content hash (as `Bot.avatarHash`; optional for older servers). `size`: the render width sent
   * for a designed avatar; null or absent = the full avatar.png. `avatar`: the bot's avatar.json
   * (`format: "json"`; then `dataUri` is null).
   */
  output: z.object({
    dataUri: z.string().nullable(),
    hash: z.string().nullable().optional(),
    size: z.number().int().positive().nullable().optional(),
    avatar: z.unknown().optional(),
  }),
});
