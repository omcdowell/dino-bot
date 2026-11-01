/**
 * composeAvatarSvg(avatar, pack) -> SVG markup. One pure function for the server (rendered to PNG with resvg)
 * and the app (react-native-svg SvgXml). Ported from designer-b app.js r9 (`avatarSVG`, `eyesMarkup`,
 * `autoPlace`, `accGroup`, `recolour`) and draws the same picture for the same choices. No DOM: the geometry
 * designer-b measures with getBBox comes precomputed in the pack.
 *
 * The SVG has a transparent background and a square viewBox (the avatar square).
 */
import type { AvatarPack, PackBox, PackCharacter } from "./pack";
import { packIndex } from "./pack";
import type { AvatarAccessory, AvatarJson } from "./schema";

/** The parts of avatar.json the picture depends on. */
export type AvatarLook = Pick<AvatarJson, "character" | "eyes" | "accessories"> & { colour?: string };

export interface ComposeOptions {
  /** "full" (default): the avatar square with accessories. "face": eye close-up, no accessories (Eyes row tiles).
   *  "naked": the figure without accessories, cropped tight (Character row tiles). */
  view?: "full" | "face" | "naked";
  /** Adds width/height attributes (px). Without it the SVG scales to its container. */
  size?: number;
}

interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number }
const box = ([x, y, w, h]: PackBox | number[]): Box => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const NS = "http://www.w3.org/2000/svg";

function char(pack: AvatarPack, id: string): PackCharacter {
  const c = packIndex(pack).character.get(id);
  if (!c) throw new Error(`unknown character "${id}"`);
  return c;
}

/* ---------- colour (designer-b recolour) ---------- */
function hexToHsl(h: string): [number, number, number] {
  const r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let H = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    H = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    H *= 60;
  }
  return [H, s, l];
}
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const recCache = new Map<string, string>();
/** Map a body/detail fill onto the target colour, keeping its offset from the dominant body colour. Near-white,
 *  near-black and far-off-hue fills (bellies, stripes, outlines) stay as drawn. No target = as drawn. */
export function recolour(fill: string, dom: string, target: string | undefined): string {
  if (!target) return fill;
  const key = fill + dom + target;
  const hit = recCache.get(key);
  if (hit) return hit;
  const [fh, fs, fl] = hexToHsl(fill), [dh, ds, dl] = hexToHsl(dom), [th, ts, tl] = hexToHsl(target);
  let out = fill;
  const keep = fs < 0.18 || fl > 0.9 || fl < 0.13 || (hueDist(fh, dh) > 45 && fs > 0.18 && ds > 0.18);
  if (!keep) out = hslToHex(th + (fh - dh) * 0.5, clamp(ts * (ds > 0.05 ? fs / ds : 1), 0, 1), clamp(tl + (fl - dl), 0.06, 0.95));
  recCache.set(key, out);
  return out;
}

/* ---------- parts ---------- */
const P = (f: string, d: string) => `<path fill="${f}" fill-rule="evenodd" d="${d}"/>`;
const n = (v: number, digits = 3) => String(Math.round(v * 10 ** digits) / 10 ** digits);

function eyesMarkup(pack: AvatarPack, c: PackCharacter, opt: string): string {
  const boxes = c.geo.eyes.map(box);
  if (!boxes.length) return "";
  if (opt === "original") return c.eyes.map(([f, d]) => P(f, d)).join("");
  const ink = c.eyes.length ? c.eyes[0][0] : "#1d1d1f";
  const bodyW = c.geo.body[2];
  const size = (b: Box) => Math.max(6, Math.min(Math.max(b.w, b.h), bodyW * 0.12));
  if (opt.startsWith("from:")) {
    const sc = char(pack, opt.slice(5));
    const src = sc.geo.eyes.map((e) => ({ ...box(e), path: sc.eyes[e[4]] }));
    return boxes.map((tb, i) => {
      const sb = src[Math.min(i, src.length - 1)];
      const k = size(tb) / Math.max(sb.w, sb.h, 1);
      return `<g transform="translate(${n(tb.cx)} ${n(tb.cy)}) scale(${k.toFixed(3)}) translate(${n(-sb.cx)} ${n(-sb.cy)})">${P(sb.path[0], sb.path[1])}</g>`;
    }).join("");
  }
  return boxes.map((b) => {
    const s = size(b), x = b.cx, y = b.cy;
    switch (opt) {
      case "dot": return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(s * 0.42)}" fill="${ink}"/>`;
      case "wide": return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(s * 0.6)}" fill="${ink}"/><circle cx="${n(x + s * 0.2)}" cy="${n(y - s * 0.22)}" r="${n(s * 0.19)}" fill="#fff"/>`;
      case "pill": return `<rect x="${n(x - s * 0.24)}" y="${n(y - s * 0.55)}" width="${n(s * 0.48)}" height="${n(s * 1.1)}" rx="${n(s * 0.24)}" fill="${ink}"/>`;
      case "closed": return `<path d="M${n(x - s * 0.55)} ${n(y - s * 0.12)} Q${n(x)} ${n(y + s * 0.55)} ${n(x + s * 0.55)} ${n(y - s * 0.12)}" fill="none" stroke="${ink}" stroke-width="${n(s * 0.22)}" stroke-linecap="round"/>`;
      case "happy": return `<path d="M${n(x - s * 0.55)} ${n(y + s * 0.2)} Q${n(x)} ${n(y - s * 0.5)} ${n(x + s * 0.55)} ${n(y + s * 0.2)}" fill="none" stroke="${ink}" stroke-width="${n(s * 0.22)}" stroke-linecap="round"/>`;
    }
    return "";
  }).join("");
}

/** Where an accessory lands when first added to a character (designer-b autoPlace), in avatar.json units. Its own
 *  accessory sits where it was drawn; a borrowed one keeps its offset from the eye midpoint on its owner, scaled by
 *  body size, clamped to touch the body and to stay inside the avatar square. */
export function autoPlaceAccessory(pack: AvatarPack, characterId: string, accessoryId: string): AvatarAccessory {
  const acc = packIndex(pack).accessory.get(accessoryId);
  if (!acc) throw new Error(`unknown accessory "${accessoryId}"`);
  const tc = char(pack, characterId), sc = char(pack, acc.from);
  const sa = box(sc.geo.acc!), [fx, fy, fw] = tc.geo.frame;
  let x: number, y: number, k: number;
  if (acc.from === characterId) { x = sa.cx; y = sa.cy; k = 1; }
  else {
    const sb = box(sc.geo.body), tb = box(tc.geo.body);
    k = Math.sqrt((tb.w / sb.w) * (tb.h / sb.h));
    const em = (c: PackCharacter) => {
      const e = c.geo.eyes.map(box);
      if (!e.length) { const b = box(c.geo.body); return { x: b.cx, y: b.cy }; }
      return { x: e.reduce((a, b) => a + b.cx, 0) / e.length, y: e.reduce((a, b) => a + b.cy, 0) / e.length };
    };
    const se = em(sc), te = em(tc);
    x = te.x + (sa.cx - se.x) * k; y = te.y + (sa.cy - se.y) * k;
    const hw = (sa.w * k) / 2, hh = (sa.h * k) / 2;
    x = clamp(x, tb.x - hw * 0.6, tb.x + tb.w + hw * 0.6);
    y = clamp(y, tb.y - hh * 0.55, tb.y + tb.h + hh * 0.6);
    const m = fw * 0.01;
    if (hw * 2 < fw) x = clamp(x, fx + hw + m, fx + fw - hw - m);
    if (hh * 2 < fw) y = clamp(y, fy + hh + m, fy + fw - hh - m);
  }
  return { id: accessoryId, x: (x - fx) / fw, y: (y - fy) / fw, scale: (sa.w * k) / fw };
}

function accGroup(pack: AvatarPack, c: PackCharacter, a: AvatarAccessory): string {
  const acc = packIndex(pack).accessory.get(a.id);
  if (!acc) throw new Error(`unknown accessory "${a.id}"`);
  const src = char(pack, acc.from), sa = box(src.geo.acc!), [fx, fy, fw] = c.geo.frame;
  const px = fx + a.x * fw, py = fy + a.y * fw, s = (a.scale * fw) / sa.w, r = a.rotation ?? 0;
  return `<g transform="translate(${px.toFixed(2)} ${py.toFixed(2)}) rotate(${r.toFixed(1)}) scale(${s.toFixed(4)}) translate(${(-sa.cx).toFixed(2)} ${(-sa.cy).toFixed(2)})">` +
    src.accessory.map(([f, d]) => P(f, d)).join("") + "</g>";
}

const svgOpen = (vb: number[], size?: number) =>
  `<svg xmlns="${NS}"${size ? ` width="${size}" height="${size}"` : ""} viewBox="${vb.map((v) => v.toFixed(1)).join(" ")}" preserveAspectRatio="xMidYMid meet">`;

/** The avatar as SVG markup (transparent background). Throws on an id the pack does not have (validate first with
 *  parseAvatar). */
export function composeAvatarSvg(avatar: AvatarLook, pack: AvatarPack, opts: ComposeOptions = {}): string {
  const view = opts.view ?? "full";
  const c = char(pack, avatar.character), dom = c.body[0][0];
  const body = c.body.map(([f, d]) => P(recolour(f, dom, avatar.colour), d)).join("");
  const det = c.details.map(([f, d]) => P(recolour(f, dom, avatar.colour), d)).join("");
  const eyes = eyesMarkup(pack, c, avatar.eyes);
  let vb: number[], accs = "";
  if (view === "face" && c.geo.eyes.length) {
    const e = c.geo.eyes.map(box);
    const x0 = Math.min(...e.map((b) => b.x)), x1 = Math.max(...e.map((b) => b.x + b.w));
    const y0 = Math.min(...e.map((b) => b.y)), y1 = Math.max(...e.map((b) => b.y + b.h));
    const s = Math.max((x1 - x0) * 1.7, (y1 - y0) * 3.2, c.geo.body[2] * 0.38);
    vb = [(x0 + x1) / 2 - s / 2, (y0 + y1) / 2 - s / 2, s, s];
  } else if (view === "naked") {
    const a = box(c.geo.naked), s = Math.max(a.w, a.h) * 1.08;
    vb = [a.cx - s / 2, a.cy - s / 2, s, s];
  } else {
    const [fx, fy, fw] = c.geo.frame;
    vb = [fx, fy, fw, fw];
    accs = avatar.accessories.map((a) => accGroup(pack, c, a)).join("");
  }
  return svgOpen(vb, opts.size) + body + det + eyes + accs + "</svg>";
}

/** One accessory on its own, cropped to it (Accessories row tiles). */
export function composeAccessorySvg(pack: AvatarPack, accessoryId: string, size?: number): string {
  const acc = packIndex(pack).accessory.get(accessoryId);
  if (!acc) throw new Error(`unknown accessory "${accessoryId}"`);
  const src = char(pack, acc.from), a = box(src.geo.acc!), s = Math.max(a.w, a.h) * 1.12;
  return svgOpen([a.cx - s / 2, a.cy - s / 2, s, s], size) + src.accessory.map(([f, d]) => P(f, d)).join("") + "</svg>";
}

/** Keep an accessory's centre inside the avatar square (designer-b keepInFrame), in avatar.json units. */
export function keepInFrame(a: AvatarAccessory): AvatarAccessory {
  return { ...a, x: clamp(a.x, 0, 1), y: clamp(a.y, 0, 1) };
}
