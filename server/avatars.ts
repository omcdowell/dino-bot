/**
 * Bot icon images for the phone home. `.bot.json` "avatar" names a PNG; the client cannot read
 * files, so the server hands it over as a data URI (cached by path, mtime and size).
 *
 * Each avatar also has a content hash. `bots.list` sends it with every bot (`avatarHash`) and the
 * phone keys its device copy by it, so an unchanged avatar is never sent again (avatar-reload,
 * 2026-10-12: avatars took seconds to come back after the phone was away).
 *
 * A designed avatar (avatar.json, server/avatar-store.ts) is hashed by its JSON instead, the name of its
 * content-addressed renders, and can be sent at 64, 128 or 512 px.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AvatarJsonSchema, type AvatarJson } from "../shared/avatar";
import {
  AVATAR_JSON_FILE,
  AVATAR_PNG_SIZE,
  AVATAR_RENDER_DIR,
  avatarJsonHash,
  renderFileName,
  type AvatarSize,
} from "./avatar-store";

/** Same cap as an upload from the app (shared/manage.ts AVATAR_UPLOAD_MAX). */
export const AVATAR_MAX_BYTES = 768 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Absolute path of an avatar: `~/…` from home, relative from the bot folder. */
export function avatarPath(avatar: string, botCwd: string, home = homedir()): string {
  if (avatar === "~" || avatar.startsWith("~/")) return join(home, avatar.slice(1));
  return isAbsolute(avatar) ? avatar : resolve(botCwd, avatar);
}

export interface Avatar {
  /** `data:image/png;base64,…`; null when missing, too large, or not a PNG. */
  dataUri: string | null;
  /** sha256 of the PNG bytes (16 base64url chars); null when there is no usable image. */
  hash: string | null;
}

const NONE: Avatar = { dataUri: null, hash: null };

export interface BotAvatarRef {
  avatar: string | null;
  cwd: string;
}

export interface BotAvatar extends Avatar {
  /** Width of the PNG sent when it is a designed avatar's render; null for a plain avatar.png or none. */
  size: AvatarSize | null;
}

export class AvatarsService {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; avatar: Avatar }>();
  private readonly designs = new Map<string, { mtimeMs: number; size: number; hash: string | null; avatar: AvatarJson | null }>();

  /** The PNG as a data URI with its content hash, read again only when the file changed. */
  async read(path: string): Promise<Avatar> {
    let info;
    try {
      info = await stat(path);
    } catch {
      this.cache.delete(path);
      return NONE;
    }
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.avatar;
    let avatar = NONE;
    if (info.isFile() && info.size <= AVATAR_MAX_BYTES) {
      try {
        const bytes = await readFile(path);
        if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
          avatar = {
            dataUri: `data:image/png;base64,${bytes.toString("base64")}`,
            hash: createHash("sha256").update(bytes).digest("base64url").slice(0, 16),
          };
        }
      } catch {
        avatar = NONE;
      }
    }
    this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, avatar });
    return avatar;
  }

  /** The PNG as a data URI; null when missing, too large, or not a PNG. */
  async dataUri(path: string): Promise<string | null> {
    return (await this.read(path)).dataUri;
  }

  /** Content hash of the avatar (one stat when unchanged); null when there is no usable image. */
  async hash(path: string): Promise<string | null> {
    return (await this.read(path)).hash;
  }

  /** Hash of `<dir>/avatar.json` (avatarJsonHash), read again only when the file changed; null without one. */
  private async designHash(dir: string): Promise<string | null> {
    return (await this.design(dir))?.hash ?? null;
  }

  /** `<dir>/avatar.json` parsed, with its hash; read again only when the file changed; null without a valid one. */
  private async design(dir: string): Promise<{ hash: string; avatar: AvatarJson } | null> {
    const path = join(dir, AVATAR_JSON_FILE);
    let info;
    try {
      info = await stat(path);
    } catch {
      this.designs.delete(path);
      return null;
    }
    const hit = this.designs.get(path);
    if (!hit || hit.mtimeMs !== info.mtimeMs || hit.size !== info.size) {
      let avatar: AvatarJson | null = null;
      try {
        const parsed = AvatarJsonSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        avatar = parsed.success ? parsed.data : null;
      } catch {
        avatar = null;
      }
      this.designs.set(path, { mtimeMs: info.mtimeMs, size: info.size, hash: avatar ? avatarJsonHash(avatar) : null, avatar });
    }
    const entry = this.designs.get(path)!;
    return entry.hash && entry.avatar ? { hash: entry.hash, avatar: entry.avatar } : null;
  }

  /**
   * A bot's avatar. When the bot has a designed avatar (avatar.json) and avatar.png is still its 512 px render,
   * the hash is the design's (the render file names) and `size` picks the render sent (64, 128 or 512).
   * Otherwise (no avatar.json, another .bot.json avatar, or avatar.png replaced since): avatar.png as before.
   */
  async forBot(bot: BotAvatarRef, size?: AvatarSize): Promise<BotAvatar> {
    if (!bot.avatar) return { ...NONE, size: null };
    const path = avatarPath(bot.avatar, bot.cwd);
    const png = await this.read(path);
    if (!png.hash || path !== join(bot.cwd, "avatar.png")) return { ...png, size: null };
    const design = await this.designHash(bot.cwd);
    if (!design) return { ...png, size: null };
    const renders = join(bot.cwd, AVATAR_RENDER_DIR);
    const full = await this.read(join(renders, renderFileName(design, AVATAR_PNG_SIZE)));
    if (full.hash !== png.hash) return { ...png, size: null };
    if (size && size !== AVATAR_PNG_SIZE) {
      const sized = await this.read(join(renders, renderFileName(design, size)));
      if (sized.dataUri) return { dataUri: sized.dataUri, hash: design, size };
    }
    return { dataUri: png.dataUri, hash: design, size: AVATAR_PNG_SIZE };
  }

  /**
   * The bot's avatar.json when the phone may draw it instead of a PNG: avatar.png is still its render (as forBot),
   * so the JSON and the PNGs are the same picture under the same hash. Null otherwise.
   */
  async designForBot(bot: BotAvatarRef): Promise<{ hash: string; avatar: AvatarJson } | null> {
    const png = await this.forBot(bot);
    if (png.size === null || !png.hash) return null;
    const design = await this.design(bot.cwd);
    return design && design.hash === png.hash ? design : null;
  }

  /** The hash `bots.list` sends for this bot (see forBot). */
  async hashForBot(bot: BotAvatarRef): Promise<string | null> {
    return (await this.forBot(bot)).hash;
  }
}

/**
 * Bots with the content hash of their avatar (`avatarHash`), for `bots.list`, and `avatarPack`: the packVersion of
 * a designed avatar the phone may draw from avatar.json (designForBot), null otherwise.
 */
export async function withAvatarHashes<T extends BotAvatarRef>(
  bots: readonly T[],
  avatars: Pick<AvatarsService, "hashForBot"> & Partial<Pick<AvatarsService, "designForBot">>,
): Promise<Array<T & { avatarHash: string | null; avatarPack: number | null }>> {
  return Promise.all(
    bots.map(async (bot) => {
      if (!bot.avatar) return { ...bot, avatarHash: null, avatarPack: null };
      const design = avatars.designForBot ? await avatars.designForBot(bot) : null;
      const avatarHash = design ? design.hash : await avatars.hashForBot(bot);
      return { ...bot, avatarHash, avatarPack: design ? design.avatar.packVersion : null };
    }),
  );
}

/**
 * `bots.avatar` for one bot (index.server.ts): format "json" sends the avatar.json when the phone may draw it
 * (designForBot), else the PNG of `size` (forBot).
 */
export async function avatarAnswer(
  avatars: Pick<AvatarsService, "forBot" | "designForBot">,
  bot: BotAvatarRef | undefined,
  request: { size?: AvatarSize; format?: "png" | "json" },
): Promise<{ dataUri: string | null; hash: string | null; size?: AvatarSize | null; avatar?: AvatarJson }> {
  if (!bot?.avatar) return { dataUri: null, hash: null, size: null };
  if (request.format === "json") {
    const design = await avatars.designForBot(bot);
    if (design) return { dataUri: null, hash: design.hash, avatar: design.avatar };
  }
  return avatars.forBot(bot, request.size);
}
