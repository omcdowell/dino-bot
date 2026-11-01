/**
 * Designed avatars on the host (AV1): `~/bots/<bot>/avatar.json` is the source of truth; the server renders
 * it with resvg into content-addressed PNGs and keeps `avatar.png` in step, so everything that reads
 * avatar.png (bots, bot-room, desktop, notifications) keeps working.
 *
 *   <bot>/avatar.json                 the phone's last accepted save (old one kept as avatar.json.bak)
 *   <bot>/avatar.png                  copy of the 512 px render (old one kept as avatar.png.bak)
 *   <bot>/avatars/<hash>-<size>.png   64, 128 and 512 px; <hash> = avatarJsonHash (canonical JSON, no revision)
 *
 * Only the current and the previous picture's renders are kept. A bot without avatar.json behaves as before.
 */
import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import {
  AVATAR_PACK,
  AVATAR_PACK_JSON,
  canonicalAvatarJson,
  composeAvatarSvg,
  type AvatarJson,
  type AvatarPack,
} from "../shared/avatar";

export const AVATAR_JSON_FILE = "avatar.json";
export const AVATAR_RENDER_DIR = "avatars";
export const AVATAR_SIZES = [64, 128, 512] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];
/** The render copied to avatar.png. */
export const AVATAR_PNG_SIZE: AvatarSize = 512;
/** Pictures whose renders stay on disk: the current one and the one before. */
export const KEEP_RENDERS = 2;

/** Content hash of the picture (sha256 of the canonical JSON, 16 base64url chars): same picture, same hash. */
export function avatarJsonHash(avatar: AvatarJson): string {
  return createHash("sha256").update(canonicalAvatarJson(avatar)).digest("base64url").slice(0, 16);
}

export function renderFileName(hash: string, size: AvatarSize): string {
  return `${hash}-${size}.png`;
}

const RENDER_NAME_RE = /^([A-Za-z0-9_-]{16})-(\d+)\.png$/;

/** SVG markup -> PNG bytes, `size` px wide (the SVG is square). */
export type AvatarRenderer = (svg: string, size: number) => Buffer | Promise<Buffer>;

let resvg: Promise<AvatarRenderer> | null = null;
/** The part of resvg-js used here. */
type ResvgClass = new (svg: string, options: object) => { render(): { asPng(): Uint8Array } };
/**
 * A variable, so the type checker does not follow the import: importing resvg-js's types into a server
 * module flips the project's timer and fetch globals to the DOM ones (the tests import it freely).
 */
const RESVG_MODULE: string = "@resvg/resvg-js";

/**
 * resvg-js, loaded on first use so a host without the native module still starts (only a save fails).
 * No system fonts: the avatars have no text, and loading them costs ~40 ms per render.
 */
export function resvgRenderer(): Promise<AvatarRenderer> {
  resvg ??= import(RESVG_MODULE)
    .then(({ Resvg }: { Resvg: ResvgClass }) => (svg: string, size: number) =>
      Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render().asPng()),
    )
    .catch((error: unknown) => {
      resvg = null;
      throw error;
    });
  return resvg;
}

export interface AvatarRender {
  hash: string;
  pngs: Record<AvatarSize, Buffer>;
  /** Wall time for compose + the three renders. */
  ms: number;
}

/** composeAvatarSvg -> PNGs at 64, 128 and 512. `avatar` must already be valid for `pack`. */
export async function renderAvatar(avatar: AvatarJson, render: AvatarRenderer, pack: AvatarPack = AVATAR_PACK): Promise<AvatarRender> {
  const started = performance.now();
  const svg = composeAvatarSvg(avatar, pack);
  const pngs = {} as Record<AvatarSize, Buffer>;
  for (const size of AVATAR_SIZES) pngs[size] = await render(svg, size);
  return { hash: avatarJsonHash(avatar), pngs, ms: performance.now() - started };
}

/** Deletes renders (and stray temp files) in `dir` whose hash is not in `keep`. Returns the names removed. */
export async function pruneRenders(dir: string, keep: ReadonlyArray<string | null | undefined>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const kept = new Set(keep.filter((h): h is string => !!h));
  const removed: string[] = [];
  for (const name of names) {
    const match = RENDER_NAME_RE.exec(name);
    const stale = match ? !kept.has(match[1]!) : name.endsWith(".tmp");
    if (!stale) continue;
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch {
      // gone already
    }
  }
  return removed;
}

/** Outcome of a save; `stale` and `invalid` leave every file as it was. */
export type SaveAvatarResult =
  | { ok: true; reason: "saved"; revision: number; hash: string; unchanged: boolean; renderMs: number | null }
  | { ok: false; reason: "stale"; revision: number; hash: string | null }
  | { ok: false; reason: "invalid"; error: string; packVersion: number };

let packGz: { packVersion: number; data: string; bytes: number; rawBytes: number; sha256: string } | null = null;

/** The pack this host ships, gzipped (level 9) and base64, computed once. */
export function packGzip(pack: AvatarPack = AVATAR_PACK, json: string = AVATAR_PACK_JSON) {
  if (packGz && packGz.packVersion === pack.packVersion) return packGz;
  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  packGz = {
    packVersion: pack.packVersion,
    data: gz.toString("base64"),
    bytes: gz.length,
    rawBytes: Buffer.byteLength(json, "utf8"),
    sha256: createHash("sha256").update(json).digest("hex"),
  };
  return packGz;
}
