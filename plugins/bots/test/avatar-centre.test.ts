// AC1: avatars centred by visual weight (shared/avatar/centre.ts). Checked against resvg's own pixels at 512 px:
// the point CENTRE_RULE names (halfway between the alpha bounding-box centre and the alpha-weighted centroid)
// must land on the middle of the square.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import {
  AVATAR_PACK,
  CENTRE_RULE,
  avatarViewBox,
  canonicalAvatarJson,
  composeAvatarSvg,
  defaultAvatarFor,
  frameToView,
  pathPolygons,
  viewToFrame,
  type AvatarJson,
  type AvatarPack,
} from "../shared/avatar";
import { avatarJsonHash } from "../server/avatar-store";
import { designerSvgs, stageLayerBox, stageToFrame } from "../client/avatar-designer-svg";
import { layerBox } from "../client/avatar-designer-state";

const SIZE = 512;
const TOL = 1.5;

function measure(svg: string) {
  const px = new Resvg(svg, { fitTo: { mode: "width", value: SIZE }, font: { loadSystemFonts: false } }).render().pixels;
  let w = 0, sx = 0, sy = 0, x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const a = px[(y * SIZE + x) * 4 + 3]!;
      if (!a) continue;
      w += a; sx += a * (x + 0.5); sy += a * (y + 0.5);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  const bx = (x0 + x1 + 1) / 2, by = (y0 + y1 + 1) / 2, b = CENTRE_RULE.blend;
  return { dx: bx + b * (sx / w - bx) - SIZE / 2, dy: by + b * (sy / w - by) - SIZE / 2, box: [x0, y0, x1 + 1, y1 + 1] };
}

const design = (over: Partial<AvatarJson>): AvatarJson => ({
  v: 1, packVersion: 1, character: "axolotl", eyes: "pill", accessories: [], revision: 1, ...over,
});
const frameOf = (id: string) => AVATAR_PACK.characters.find((c) => c.id === id)!.geo.frame;
const inFrame = (a: AvatarJson, pack: AvatarPack = AVATAR_PACK) => {
  const [x, y, s] = pack.characters.find((c) => c.id === a.character)!.geo.frame;
  return composeAvatarSvg(a, pack, { viewBox: [x, y, s] });
};

/** Deliberately off-centre: an otter (long tail one side) with a big hat pushed to the bottom-right corner. */
const OFF = design({ character: "otter", eyes: "dot", accessories: [{ id: "beanie", x: 0.88, y: 0.86, scale: 0.3, rotation: 20 }] });

test("pathPolygons: a square and a cubic", () => {
  const [sq] = pathPolygons("M10 10h20v20H10z");
  assert.deepEqual(sq, [[10, 10], [30, 10], [30, 30], [10, 30]]);
  const [cv] = pathPolygons("m0 0c0 10 10 10 10 0z");
  assert.equal(cv!.length, 9);
  assert.deepEqual(cv!.at(-1), [10, 0]);
});

test("the off-centre fixture is off-centre in the old frame and centred within 1.5 px at 512 after", () => {
  assert.ok(AVATAR_PACK.accessories.some((a) => a.id === "beanie"));
  const before = measure(inFrame(OFF));
  assert.ok(Math.hypot(before.dx, before.dy) > 20, `before: ${before.dx.toFixed(1)}, ${before.dy.toFixed(1)}`);
  const after = measure(composeAvatarSvg(OFF, AVATAR_PACK));
  assert.ok(Math.abs(after.dx) <= TOL && Math.abs(after.dy) <= TOL, `after: ${after.dx.toFixed(2)}, ${after.dy.toFixed(2)}`);
});

test("every character's default avatar is centred within 1.5 px at 512, never clipped", () => {
  for (const c of AVATAR_PACK.characters) {
    const m = measure(composeAvatarSvg(defaultAvatarFor(AVATAR_PACK, c.id), AVATAR_PACK));
    assert.ok(Math.abs(m.dx) <= TOL && Math.abs(m.dy) <= TOL, `${c.id}: ${m.dx.toFixed(2)}, ${m.dy.toFixed(2)}`);
    assert.ok(m.box[0]! > 0 && m.box[1]! > 0 && m.box[2]! < SIZE && m.box[3]! < SIZE, `${c.id} touches the edge: ${m.box}`);
  }
});

test("moved, not scaled, when it fits: the square stays the frame's size", () => {
  for (const c of AVATAR_PACK.characters) {
    const [, , s] = avatarViewBox(AVATAR_PACK, defaultAvatarFor(AVATAR_PACK, c.id));
    assert.equal(s, c.geo.frame[2], c.id);
  }
});

test("scaled down only when moving it would clip: a huge accessory at the edge stays inside the square", () => {
  const big = design({ accessories: [{ id: "sprout", x: 1, y: 0, scale: 0.9, rotation: 0 }] });
  const [, , s] = avatarViewBox(AVATAR_PACK, big);
  assert.ok(s > frameOf("axolotl")[2], "grew");
  const m = measure(composeAvatarSvg(big, AVATAR_PACK));
  assert.ok(m.box[0]! > 0 && m.box[1]! > 0 && m.box[2]! < SIZE && m.box[3]! < SIZE, `clipped: ${m.box}`);
});

test("an already-centred picture stays put", () => {
  // A pack whose frame is already where centring puts it: centring must not move or scale it.
  const look = defaultAvatarFor(AVATAR_PACK, "walrus");
  const view = avatarViewBox(AVATAR_PACK, look);
  const pack: AvatarPack = structuredClone(AVATAR_PACK);
  const c = pack.characters.find((x) => x.id === "walrus")!;
  const old = c.geo.frame;
  c.geo.frame = [view[0], view[1], view[2]];
  // accessory positions are frame-relative: re-express the same placement in the moved frame
  const moved = { ...look, accessories: look.accessories.map((a) => ({ ...a, x: (old[0] + a.x * old[2] - view[0]) / view[2], y: (old[1] + a.y * old[2] - view[1]) / view[2] })) };
  const again = avatarViewBox(pack, moved);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(again[i]! - view[i]!) < 0.05, `${again} vs ${view}`);
  const m = measure(composeAvatarSvg(moved, pack));
  assert.ok(Math.abs(m.dx) <= TOL && Math.abs(m.dy) <= TOL);
});

test("accessories keep their place on the character: only the viewBox changes", () => {
  const strip = (svg: string) => svg.replace(/viewBox="[^"]*"/, "");
  assert.equal(strip(composeAvatarSvg(OFF, AVATAR_PACK)), strip(inFrame(OFF)));
  assert.notEqual(composeAvatarSvg(OFF, AVATAR_PACK), inFrame(OFF));
});

test("same design, same picture and hash; the hash names the centred drawing", () => {
  const a = design({ colour: "#9CC963", accessories: [{ id: "sprout", x: 0.5514, y: 0.6465, scale: 0.192, rotation: 7 }] });
  const b = JSON.parse(JSON.stringify(a)) as AvatarJson;
  assert.equal(avatarJsonHash(a), avatarJsonHash(b));
  assert.equal(avatarJsonHash(a), avatarJsonHash({ ...b, revision: 9 }));
  assert.equal(composeAvatarSvg(a, AVATAR_PACK), composeAvatarSvg(b, AVATAR_PACK));
  const plain = createHash("sha256").update(canonicalAvatarJson(a)).digest("base64url").slice(0, 16);
  assert.notEqual(avatarJsonHash(a), plain, "render version mixed in, so phones drop pre-centring copies");
});

test("designer stage: same picture as the save, held still while a finger is down, points map both ways", () => {
  const look = { character: OFF.character, eyes: OFF.eyes, accessories: OFF.accessories };
  const live = designerSvgs(AVATAR_PACK, look);
  assert.equal(live.full, composeAvatarSvg(OFF, AVATAR_PACK));
  const moved = { ...look, accessories: [{ ...look.accessories[0]!, x: 0.2 }] };
  const held = designerSvgs(AVATAR_PACK, moved, live.view);
  assert.deepEqual(held.view, live.view);
  assert.notDeepEqual(designerSvgs(AVATAR_PACK, moved).view, live.view);
  const c = AVATAR_PACK.characters.find((x) => x.id === "otter")!;
  const [u, v] = frameToView(c, live.view, 0.3, 0.7);
  const [fu, fv] = viewToFrame(c, live.view, u, v);
  assert.ok(Math.abs(fu - 0.3) < 1e-9 && Math.abs(fv - 0.7) < 1e-9);
  const sb = stageLayerBox(AVATAR_PACK, look, live.view, 0)!, fb = layerBox(AVATAR_PACK, look, 0)!;
  const [hu, hv] = stageToFrame(AVATAR_PACK, "otter", live.view, sb.cx, sb.cy);
  assert.ok(Math.abs(hu - fb.cx) < 1e-9 && Math.abs(hv - fb.cy) < 1e-9);
});
