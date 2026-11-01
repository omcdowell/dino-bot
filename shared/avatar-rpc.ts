/**
 * Designed avatars (AV1): save and read `avatar.json`, and the options pack for apps with an older one.
 * The PNGs themselves come from `bots.avatar` (shared/home-rpc.ts) with an optional `size`.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BOT_ID_RE } from "./rooms/schema";
import { AvatarJsonSchema } from "./avatar/schema";

const BotIdSchema = z.string().regex(BOT_ID_RE, "not a bot id");

/** Render widths the host keeps for a designed avatar. */
export const AvatarSizeSchema = z.union([z.literal(64), z.literal(128), z.literal(512)]);

/**
 * Outcome of a save. Only `ok` changed anything (`unchanged`: a resend of the stored save, nothing written).
 * - `stale`: the host has this revision or a newer one (`revision`, `hash`: the stored save). Drop the queued save.
 * - `invalid`: an id the host's pack does not have, or a newer pack than the host's (`packVersion`).
 */
export const SaveAvatarResultSchema = z.discriminatedUnion("reason", [
  z.object({
    ok: z.literal(true),
    reason: z.literal("saved"),
    revision: z.number(),
    /** Content hash of the picture: `bots.list` avatarHash and the render file names. */
    hash: z.string(),
    unchanged: z.boolean(),
    renderMs: z.number().nullable(),
  }),
  z.object({ ok: z.literal(false), reason: z.literal("stale"), revision: z.number(), hash: z.string().nullable() }),
  z.object({ ok: z.literal(false), reason: z.literal("invalid"), error: z.string(), packVersion: z.number() }),
]);
export type SaveAvatarResultWire = z.infer<typeof SaveAvatarResultSchema>;

/** Save `~/bots/<bot>/avatar.json` and render its PNGs (64, 128, 512; avatar.png = the 512). */
export const botsAvatarSaveRpc = defineRpc({
  name: "bots.avatar-save",
  input: z.object({ botId: BotIdSchema, avatar: AvatarJsonSchema }),
  output: SaveAvatarResultSchema,
});

/**
 * The stored avatar.json (null: the bot has none). `live`: avatar.png is still its render (false after a
 * picture upload or a hand edit of avatar.png); `hash`: its content hash.
 */
export const botsAvatarJsonRpc = defineRpc({
  name: "bots.avatar-json",
  input: z.object({ botId: BotIdSchema }),
  output: z.object({ avatar: AvatarJsonSchema.nullable(), hash: z.string().nullable(), live: z.boolean() }),
});

/** The host's options pack version; an app with an older pack fetches `bots.avatar-pack` once. */
export const botsAvatarPackVersionRpc = defineRpc({
  name: "bots.avatar-pack-version",
  input: z.object({}),
  output: z.object({ packVersion: z.number() }),
});

/**
 * The host's options pack, for an app whose bundled pack is older (`bots.list` `avatarPackVersion` > the
 * app's; fetched once in the background, kept on the phone and used from the next open). `have`: the app's
 * pack version; when it is not older, `data` / `json` are null (nothing to download).
 * - `format` "gzip-base64" (default, AV1): `data` is the pack gzipped, base64.
 * - `format` "json" (the phone, AV4): `json` is the pack as JSON text (no gunzip on the phone); `data` is null.
 * `sha256` is of the JSON text; `bytes` is the gzip size, `rawBytes` the JSON size.
 */
export const botsAvatarPackRpc = defineRpc({
  name: "bots.avatar-pack",
  input: z.object({ have: z.number().int().optional(), format: z.enum(["gzip-base64", "json"]).optional() }),
  output: z.object({
    packVersion: z.number(),
    encoding: z.enum(["gzip-base64", "json"]),
    data: z.string().nullable(),
    json: z.string().nullable().optional(),
    bytes: z.number(),
    rawBytes: z.number(),
    sha256: z.string(),
  }),
});
