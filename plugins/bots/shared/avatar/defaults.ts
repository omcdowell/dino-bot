/**
 * Default avatars (DA1): a new bot gets one of the pack's characters at random, in its default look (as the designer's
 * defaultLook: its own colours, eyes "original", its own accessory where it was drawn; a character with none stays
 * bare). Colour and accessories are never randomised. A bot that still has no avatar shows a stable default picked
 * from its id.
 *
 * Imports types only, so the installer (lib/bots.mjs) can load this file and pack-v1.ts with Node's type stripping.
 */
import type { AvatarPack } from "./pack";
import type { AvatarJson } from "./schema";

/** The default pool: every character in the pack (owner, 15 Nov: all 27, the 9 bot characters and the 18 reef ones). */
export function defaultAvatarCharacters(pack: AvatarPack): string[] {
  return pack.characters.map((c) => c.id);
}

/** A character in its default look as avatar.json (revision 0, so any save from the phone replaces it). */
export function defaultAvatarFor(pack: AvatarPack, characterId: string): AvatarJson {
  const c = pack.characters.find((x) => x.id === characterId);
  if (!c) throw new Error(`unknown character "${characterId}"`);
  const own = pack.accessories.find((a) => a.from === characterId);
  const accessories: AvatarJson["accessories"] = [];
  if (own && c.geo.acc) {
    // Its own accessory where it was drawn (compose.ts autoPlaceAccessory, own-accessory case).
    const [ax, ay, aw, ah] = c.geo.acc;
    const [fx, fy, fw] = c.geo.frame;
    accessories.push({ id: own.id, x: (ax + aw / 2 - fx) / fw, y: (ay + ah / 2 - fy) / fw, scale: aw / fw });
  }
  return { v: 1, packVersion: pack.packVersion, character: characterId, eyes: "original", accessories, revision: 0 };
}

/** One default avatar at random (`random` in [0, 1), as Math.random). */
export function randomDefaultAvatar(pack: AvatarPack, random: () => number = Math.random): AvatarJson {
  const ids = defaultAvatarCharacters(pack);
  const i = Math.min(ids.length - 1, Math.max(0, Math.floor(random() * ids.length)));
  return defaultAvatarFor(pack, ids[i]!);
}

/** FNV-1a 32-bit: stable across hosts and runs, no crypto import (the app shares this file). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The default avatar a bot without one shows: picked from its id, so it is the same on every list. */
export function stableDefaultAvatar(pack: AvatarPack, key: string): AvatarJson {
  const ids = defaultAvatarCharacters(pack);
  return defaultAvatarFor(pack, ids[fnv1a(key) % ids.length]!);
}
