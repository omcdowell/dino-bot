/**
 * `avatar.json`: what the phone saves for a bot's avatar (~200-300 bytes). Stored at `~/bots/<bot>/avatar.json`
 * (source of truth); the server renders the PNGs from it.
 *
 *   { v: 1, packVersion, character, eyes, colour?, accessories: [{ id, x, y, scale, rotation? }], revision }
 *
 * - `character`, `eyes`, accessory `id`s and `colour` are ids from the options pack named by `packVersion`.
 *   `colour` absent = the character's own colours. `eyes` "original" = its own eyes.
 * - Accessory units (as designer-b's avatar.json): x, y = the accessory's centre as 0-1 of the avatar square;
 *   scale = accessory width / avatar width; rotation = degrees clockwise (absent = 0). Later layers draw on top.
 * - `revision` counts up with each save; the server keeps a save only if its revision is above the stored one,
 *   so a resend of an older queued save can never overwrite a newer one.
 */
import { z } from "zod";
import { type AvatarPack, packIndex } from "./pack";

export const AVATAR_JSON_VERSION = 1;
export const MAX_ACCESSORIES = 24;

const unit = z.number().finite().min(0).max(1);

export const AvatarAccessorySchema = z.object({
  id: z.string().min(1).max(64),
  x: unit,
  y: unit,
  scale: z.number().finite().gt(0).max(10),
  rotation: z.number().finite().min(-180).max(180).optional(),
});

export const AvatarJsonSchema = z.object({
  v: z.literal(AVATAR_JSON_VERSION),
  packVersion: z.number().int().min(1),
  character: z.string().min(1).max(64),
  eyes: z.string().min(1).max(80),
  colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  accessories: z.array(AvatarAccessorySchema).max(MAX_ACCESSORIES),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type AvatarAccessory = z.infer<typeof AvatarAccessorySchema>;
export type AvatarJson = z.infer<typeof AvatarJsonSchema>;

/** The schema plus the pack check: every id must exist in `pack`, and the avatar may not need a newer pack. */
export function avatarSchemaFor(pack: AvatarPack) {
  const ix = packIndex(pack);
  return AvatarJsonSchema.superRefine((a, ctx) => {
    if (a.packVersion > pack.packVersion)
      ctx.addIssue({ code: "custom", path: ["packVersion"], message: `needs pack ${a.packVersion}, have ${pack.packVersion}` });
    if (!ix.character.has(a.character)) ctx.addIssue({ code: "custom", path: ["character"], message: `unknown character "${a.character}"` });
    if (!ix.eyes.has(a.eyes)) ctx.addIssue({ code: "custom", path: ["eyes"], message: `unknown eyes "${a.eyes}"` });
    if (a.colour !== undefined && !ix.colours.has(a.colour.toUpperCase()))
      ctx.addIssue({ code: "custom", path: ["colour"], message: `unknown colour "${a.colour}"` });
    a.accessories.forEach((acc, i) => {
      if (!ix.accessory.has(acc.id)) ctx.addIssue({ code: "custom", path: ["accessories", i, "id"], message: `unknown accessory "${acc.id}"` });
    });
  });
}

export type ParseAvatarResult = { ok: true; avatar: AvatarJson } | { ok: false; error: string };

/** Validate an `avatar.json` value against a pack. */
export function parseAvatar(input: unknown, pack: AvatarPack): ParseAvatarResult {
  const r = avatarSchemaFor(pack).safeParse(input);
  if (r.success) return { ok: true, avatar: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "avatar"}: ${i.message}`).join("; ") };
}

/** True when `incoming` may replace `stored` (no stored avatar, or a higher revision). */
export function isNewerRevision(incoming: Pick<AvatarJson, "revision">, stored: Pick<AvatarJson, "revision"> | null | undefined): boolean {
  return !stored || incoming.revision > stored.revision;
}

/**
 * The avatar as JSON text with a fixed key order and no optional keys at their defaults, so the same avatar always
 * gives the same bytes (hash it for content-addressed PNG names). `revision` is left out: a resave of the same
 * picture keeps its hash.
 */
export function canonicalAvatarJson(a: AvatarJson): string {
  return JSON.stringify({
    v: a.v,
    packVersion: a.packVersion,
    character: a.character,
    eyes: a.eyes,
    ...(a.colour ? { colour: a.colour.toUpperCase() } : {}),
    accessories: a.accessories.map((x) => ({ id: x.id, x: x.x, y: x.y, scale: x.scale, ...(x.rotation ? { rotation: x.rotation } : {}) })),
  });
}
