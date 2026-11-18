/**
 * Centring by visual weight (AC1, 17 Nov: "avatars are centrally weighted automatically on save").
 *
 * The pack frame (geo.frame) puts the figure 5% of the square low (build-pack.mjs "headroom on top") and leaves
 * room for the character's own accessory whether it is worn or not, so saved avatars sat 17-65 px low at 512 and up
 * to ~40 px to one side. avatarViewBox picks the full view's viewBox instead: same size as the frame, moved so the
 * composition's centre (CENTRE_RULE) is the middle of the square, and grown (the picture scaled down) only when
 * the moved picture would otherwise run off an edge.
 *
 * Applied at render: avatar.json stays the user's design (accessory x / y / scale are still in frame units, so
 * nothing moves relative to the character), and every drawer (server PNGs, phone from JSON, designer stage)
 * gets the same picture from composeAvatarSvg.
 *
 * The weight is measured from the pack's own path data, no DOM and no native code (it runs in the app): body and
 * detail paths plus each accessory (with its translate / rotate / scale) are flattened to polygons, filled even-odd
 * into a coarse mask (GRID cells on the long side, union of all paths), and the centroid is the mean of the filled
 * cells. Eyes are left out: they sit on the body and add no area. The bounding box comes from the polygon points.
 *
 * Pure; one result per look is cached.
 */
import type { AvatarPack, PackCharacter, PackPath } from "./pack";
import { packIndex } from "./pack";
import type { AvatarAccessory } from "./schema";

/**
 * Where the middle of the square goes: BLEND of the way from the bounding-box centre to the alpha-weighted
 * centroid (0 = bounding box, 1 = centroid). 0.5: the centroid alone pulls a bottom-heavy figure so far up that its
 * margins look lopsided (walrus: 49 px above, 128 below) and pushes long tails / hats off the round crops; the box
 * alone ignores a heavy body under a thin antenna or tail. Halfway reads as centred on both.
 */
export const CENTRE_RULE = { blend: 0.5 } as const;
/** Mask resolution (cells on the long side of the content box). 128: centroid within ~0.3 px at 512. */
const GRID = 128;
/** Least clear margin kept on each side when moving the picture, as a share of the square. */
const EDGE = 0.02;

type Pt = [number, number];
type Poly = Pt[];
/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (SVG matrix order). */
type Mat = [number, number, number, number, number, number];
const apply = (m: Mat, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* ---------- path data -> polygons ---------- */
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const CURVE_STEPS = 8;
const polyCache = new WeakMap<object, Map<string, Poly[]>>();

/** Subpaths of an SVG path as polygons (curves flattened; arcs as their chord: only eyes use them). */
export function pathPolygons(d: string): Poly[] {
  const out: Poly[] = [];
  let cur: Poly = [];
  let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, prev = "";
  const close = () => { if (cur.length > 2) out.push(cur); cur = []; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS, u = 1 - t;
      cur.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey]);
    }
    cx = x2; cy = y2; x = ex; y = ey;
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    cubic(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), ex + (2 / 3) * (x1 - ex), ey + (2 / 3) * (y1 - ey), ex, ey);
    cx = x1; cy = y1;
  };
  for (const seg of d.match(/[a-zA-Z][^a-zA-Z]*/g) ?? []) {
    const cmd = seg[0]!, rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const a = (seg.slice(1).match(NUM) ?? []).map(Number);
    if (C === "Z") { close(); x = sx; y = sy; prev = C; continue; }
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[C] ?? 0;
    if (!arity) continue;
    for (let i = 0; i + arity <= a.length; i += arity) {
      const v = a.slice(i, i + arity);
      const ox = rel ? x : 0, oy = rel ? y : 0;
      const k = C === "M" && i > 0 ? "L" : C;
      if (k !== "M" && cur.length === 0) cur.push([x, y]);
      switch (k) {
        case "M": close(); x = v[0]! + ox; y = v[1]! + oy; sx = x; sy = y; cur.push([x, y]); break;
        case "L": x = v[0]! + ox; y = v[1]! + oy; cur.push([x, y]); break;
        case "H": x = v[0]! + (rel ? x : 0); cur.push([x, y]); break;
        case "V": y = v[0]! + (rel ? y : 0); cur.push([x, y]); break;
        case "C": cubic(v[0]! + ox, v[1]! + oy, v[2]! + ox, v[3]! + oy, v[4]! + ox, v[5]! + oy); break;
        case "S": {
          const r = prev === "C" || prev === "S";
          cubic(r ? 2 * x - cx : x, r ? 2 * y - cy : y, v[0]! + ox, v[1]! + oy, v[2]! + ox, v[3]! + oy);
          break;
        }
        case "Q": quad(v[0]! + ox, v[1]! + oy, v[2]! + ox, v[3]! + oy); break;
        case "T": {
          const r = prev === "Q" || prev === "T";
          quad(r ? 2 * x - cx : x, r ? 2 * y - cy : y, v[0]! + ox, v[1]! + oy);
          break;
        }
        case "A": x = v[5]! + ox; y = v[6]! + oy; cur.push([x, y]); break;
      }
      prev = k;
    }
  }
  close();
  return out;
}

function partPolygons(pack: AvatarPack, paths: PackPath[]): Poly[][] {
  let cache = polyCache.get(pack);
  if (!cache) polyCache.set(pack, (cache = new Map()));
  return paths.map(([, d]) => {
    let hit = cache!.get(d);
    if (!hit) cache!.set(d, (hit = pathPolygons(d)));
    return hit;
  });
}

/* ---------- accessory transform (as compose.ts accGroup) ---------- */
function accMatrix(pack: AvatarPack, c: PackCharacter, a: AvatarAccessory): { m: Mat; paths: PackPath[] } {
  const acc = packIndex(pack).accessory.get(a.id);
  if (!acc) throw new Error(`unknown accessory "${a.id}"`);
  const src = packIndex(pack).character.get(acc.from)!;
  const [sx, sy, sw, sh] = src.geo.acc!;
  const [fx, fy, fw] = c.geo.frame;
  // accGroup rounds its numbers into the SVG; use the same values so the measure matches the drawing.
  const px = +(fx + a.x * fw).toFixed(2), py = +(fy + a.y * fw).toFixed(2);
  const s = +((a.scale * fw) / sw).toFixed(4), r = (+(a.rotation ?? 0).toFixed(1) * Math.PI) / 180;
  const tx = -+(sx + sw / 2).toFixed(2), ty = -+(sy + sh / 2).toFixed(2);
  const cos = Math.cos(r) * s, sin = Math.sin(r) * s;
  // translate(px py) rotate(r) scale(s) translate(tx ty)
  return { m: [cos, sin, -sin, cos, cos * tx - sin * ty + px, sin * tx + cos * ty + py], paths: src.accessory };
}

/* ---------- measure ---------- */
export interface AvatarWeight {
  /** Bounding box of the drawn shapes [x0, y0, x1, y1], character units. */
  box: [number, number, number, number];
  /** Alpha-weighted centroid (filled area), character units. */
  centroid: Pt;
}

/** Bounding box and centroid of the full picture (figure + accessories), in character units. */
export function avatarWeight(pack: AvatarPack, look: { character: string; accessories: AvatarAccessory[] }): AvatarWeight {
  const c = packIndex(pack).character.get(look.character);
  if (!c) throw new Error(`unknown character "${look.character}"`);
  const shapes: Poly[][] = []; // one entry per path (even-odd within it, union across paths)
  for (const p of partPolygons(pack, [...c.body, ...c.details])) shapes.push(p);
  for (const a of look.accessories) {
    const { m, paths } = accMatrix(pack, c, a);
    for (const p of partPolygons(pack, paths)) shapes.push(p.map((poly) => poly.map((pt) => apply(m, pt))));
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const poly of s) for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const cell = Math.max(x1 - x0, y1 - y0) / GRID;
  const cols = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((y1 - y0) / cell) + 1;
  const mask = new Uint8Array(cols * rows);
  const xs: number[] = [];
  for (const s of shapes) {
    for (let r = 0; r < rows; r++) {
      const yc = y0 + (r + 0.5) * cell;
      xs.length = 0;
      for (const poly of s) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [ax, ay] = poly[j]!, [bx, by] = poly[i]!;
          if ((ay > yc) !== (by > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5)), to = Math.min(cols - 1, Math.floor((xs[k + 1]! - x0) / cell - 0.5));
        for (let q = from; q <= to; q++) mask[r * cols + q] = 1;
      }
    }
  }
  let n = 0, mx = 0, my = 0;
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) if (mask[r * cols + q]) { n++; mx += q; my += r; }
  const centroid: Pt = n ? [x0 + (mx / n + 0.5) * cell, y0 + (my / n + 0.5) * cell] : [(x0 + x1) / 2, (y0 + y1) / 2];
  return { box: [x0, y0, x1, y1], centroid };
}

const viewCache = new WeakMap<object, Map<string, [number, number, number]>>();

/**
 * The full view's viewBox [x, y, size] in character units: the frame's size, centred on CENTRE_RULE's point,
 * grown only as much as needed to keep EDGE clear on every side. Cached per pack and look.
 */
export function avatarViewBox(pack: AvatarPack, look: { character: string; accessories: AvatarAccessory[] }): [number, number, number] {
  let cache = viewCache.get(pack);
  if (!cache) viewCache.set(pack, (cache = new Map()));
  const key = CENTRE_RULE.blend + "|" + look.character + "|" + look.accessories.map((a) => `${a.id},${a.x},${a.y},${a.scale},${a.rotation ?? 0}`).join(";");
  const hit = cache.get(key);
  if (hit) return hit;
  const c = packIndex(pack).character.get(look.character);
  if (!c) throw new Error(`unknown character "${look.character}"`);
  const fw = c.geo.frame[2];
  const { box: [x0, y0, x1, y1], centroid } = avatarWeight(pack, look);
  const tx = (x0 + x1) / 2 + CENTRE_RULE.blend * (centroid[0] - (x0 + x1) / 2);
  const ty = (y0 + y1) / 2 + CENTRE_RULE.blend * (centroid[1] - (y0 + y1) / 2);
  const reach = Math.max(tx - x0, x1 - tx, ty - y0, y1 - ty);
  const size = Math.max(fw, (2 * reach) / (1 - 2 * EDGE));
  const view: [number, number, number] = [tx - size / 2, ty - size / 2, size];
  if (cache.size > 256) cache.clear();
  cache.set(key, view);
  return view;
}

/** Avatar.json units (0-1 of the pack frame) -> 0-1 of the shown square `view`; and back. For the designer stage. */
export function frameToView(c: PackCharacter, view: readonly [number, number, number], u: number, v: number): Pt {
  const [fx, fy, fw] = c.geo.frame;
  return [(fx + u * fw - view[0]) / view[2], (fy + v * fw - view[1]) / view[2]];
}
export function viewToFrame(c: PackCharacter, view: readonly [number, number, number], u: number, v: number): Pt {
  const [fx, fy, fw] = c.geo.frame;
  return [(view[0] + u * view[2] - fx) / fw, (view[1] + v * view[2] - fy) / fw];
}
