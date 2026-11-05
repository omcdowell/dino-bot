// AV3: the designer's state (rows, undo, shuffle, gestures, hit tests) and how it uses composeAvatarSvg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AVATAR_PACK,
  autoPlaceAccessory,
  composeAccessorySvg,
  composeAvatarSvg,
  eyeOptionsFor,
  parseAvatar,
} from "../shared/avatar";
import {
  HISTORY_MAX,
  NUDGE_COALESCE_MS,
  SCALE_MAX,
  STEP,
  accessoryCounts,
  addAccessory,
  applyGesture,
  boxCorner,
  counters,
  createDesigner,
  cycleSelection,
  defaultLook,
  deleteSelected,
  deselect,
  hints,
  hitTest,
  layerBox,
  lookFromAvatar,
  normaliseRotation,
  nudge,
  pickCharacter,
  removeAllAccessories,
  select,
  setColour,
  setEyes,
  shownEyes,
  shuffle,
  toAvatarJson,
  undo,
} from "../client/avatar-designer-state";
import { designerSvgs, tileSvgs } from "../client/avatar-designer-svg";

const pack = AVATAR_PACK;
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};

test("default look: Emmet in his own box cap where it was drawn (designer-b DEFAULT)", () => {
  const look = defaultLook(pack);
  assert.equal(look.character, "emmet-boxfish");
  assert.deepEqual(look.accessories, [autoPlaceAccessory(pack, "emmet-boxfish", "box-cap")]);
});

test("layers belong to one character: switching parks them and brings the other's back (designer-b r7)", () => {
  let d = createDesigner(defaultLook(pack));
  d = pickCharacter(d, pack, "whale");
  assert.deepEqual(d.state.look.accessories, []);
  d = addAccessory(d, pack, "top-hat");
  assert.equal(d.sel, 0);
  d = pickCharacter(d, pack, "emmet-boxfish");
  assert.equal(d.sel, -1, "switching character deselects");
  assert.deepEqual(d.state.look.accessories.map((a) => a.id), ["box-cap"]);
  d = pickCharacter(d, pack, "whale");
  assert.deepEqual(d.state.look.accessories.map((a) => a.id), ["top-hat"]);
  assert.equal(pickCharacter(d, pack, "whale"), d, "same character: no change, no undo step");
  assert.equal(pickCharacter(d, pack, "nope"), d);
});

test("undo walks back every change; selection is not history; no-op taps add no step", () => {
  let d = createDesigner(defaultLook(pack));
  d = setColour(d, "#FF6A59");
  d = setEyes(d, "dot");
  d = addAccessory(d, pack, "acorn");
  assert.equal(d.history.length, 3);
  const before = d;
  d = select(d, 0);
  d = deselect(d);
  assert.equal(d.history.length, 3);
  assert.equal(setEyes(d, "dot").history.length, 3, "same eyes again: no step");
  d = undo(d);
  assert.deepEqual(d.state.look.accessories.map((a) => a.id), ["box-cap"]);
  d = undo(undo(d));
  assert.deepEqual(d.state.look, defaultLook(pack));
  assert.equal(undo(d), d, "nothing to undo");
  assert.notEqual(before, d);
});

test("history is capped", () => {
  let d = createDesigner(defaultLook(pack));
  for (let i = 0; i < HISTORY_MAX + 20; i++) d = setColour(d, i % 2 ? "#FF6A59" : "#9CC963");
  assert.equal(d.history.length, HISTORY_MAX);
});

test("accessory row: add selects the new layer, None removes all, × removes the selected one", () => {
  let d = createDesigner(defaultLook(pack));
  d = addAccessory(d, pack, "box-cap");
  assert.deepEqual(accessoryCounts(d.state.look), { "box-cap": 2 });
  assert.equal(d.sel, 1);
  assert.equal(counters(pack, d).accessories, "2 on · Box cap selected");
  d = deleteSelected(d);
  assert.equal(d.sel, -1);
  assert.equal(d.state.look.accessories.length, 1);
  assert.equal(deleteSelected(d), d, "nothing selected");
  d = removeAllAccessories(d);
  assert.equal(counters(pack, d).accessories, "None");
  assert.equal(removeAllAccessories(d), d);
  assert.equal(hints(pack, d).tip, "");
});

test("fullscreen buttons: move, turn, resize within limits; a held button is one undo step", () => {
  let d = select(createDesigner(defaultLook(pack)), 0);
  const a0 = d.state.look.accessories[0]!;
  d = nudge(d, pack, "right", true, 1000);
  d = nudge(d, pack, "right", false, 1070);
  d = nudge(d, pack, "right", false, 1140);
  assert.equal(d.history.length, 1, "held: one step");
  assert.ok(Math.abs(d.state.look.accessories[0]!.x - (a0.x + 3 * STEP.move)) < 1e-9);
  d = nudge(d, pack, "rotr", false, 1140 + NUDGE_COALESCE_MS + 1);
  assert.equal(d.history.length, 2, "idle too long: new step");
  assert.equal(d.state.look.accessories[0]!.rotation, STEP.rot);
  d = nudge(d, pack, "rotl", true, 5000);
  assert.equal(d.state.look.accessories[0]!.rotation, undefined, "back to 0: no rotation key");
  for (let i = 0; i < 100; i++) d = nudge(d, pack, "bigger", false, 6000);
  assert.ok(Math.abs(d.state.look.accessories[0]!.scale - a0.scale * SCALE_MAX) < 1e-9, "capped at 5x");
  for (let i = 0; i < 100; i++) d = nudge(d, pack, "up", false, 6000);
  assert.equal(d.state.look.accessories[0]!.y, 0, "centre stays in the square");
  assert.equal(nudge(deselect(d), pack, "up", true, 7000).history.length, deselect(d).history.length, "no selection: no-op");
});

test("gestures: drag + pinch relative to the start; one undo step per gesture", () => {
  let d = select(createDesigner(defaultLook(pack)), 0);
  const start = { ...d.state.look.accessories[0]! };
  d = applyGesture(d, pack, start, { dx: 0.01, dy: 0 }, true);
  d = applyGesture(d, pack, start, { dx: 0.05, dy: -0.02, scale: 1.5, rotation: 200 }, false);
  assert.equal(d.history.length, 1);
  const a = d.state.look.accessories[0]!;
  assert.ok(Math.abs(a.x - (start.x + 0.05)) < 1e-9);
  assert.ok(Math.abs(a.scale - start.scale * 1.5) < 1e-9);
  assert.equal(a.rotation, -160, "rotation kept in (-180, 180]");
  assert.deepEqual(undo(d).state.look.accessories[0], start);
  assert.equal(normaliseRotation(540), 180);
  assert.equal(normaliseRotation(-190), 170);
});

test("next-accessory button cycles backwards and wraps", () => {
  let d = createDesigner(defaultLook(pack));
  d = addAccessory(addAccessory(d, pack, "acorn"), pack, "bow");
  assert.equal(d.sel, 2);
  assert.equal(cycleSelection(d).sel, 1);
  assert.equal(cycleSelection(deselect(d)).sel, 2);
  assert.equal(cycleSelection(select(d, 0)).sel, 2);
});

test("eyes row: the character's own look is hidden and marks Original", () => {
  const turtle = pack.characters.find((c) => c.id === "turtle")!;
  const rowIds = eyeOptionsFor(pack, "turtle").map(([id]) => id);
  assert.ok(!rowIds.includes(turtle.ownEyes));
  assert.equal(shownEyes(pack, { character: "turtle", eyes: turtle.ownEyes }), "original");
  let d = createDesigner({ character: "turtle", eyes: turtle.ownEyes, accessories: [] });
  assert.equal(counters(pack, d).eyes, "Original");
  d = setEyes(d, "happy");
  assert.equal(counters(pack, d).eyes, "Happy");
  assert.ok(eyeOptionsFor(pack, "emmet-boxfish").length <= 9);
});

test("counters: character position, colour name", () => {
  const d = createDesigner({ character: pack.characters.at(-1)!.id, colour: "#ff6a59", eyes: "original", accessories: [] });
  const c = counters(pack, d);
  assert.equal(c.character, `${pack.characters.at(-1)!.name} · ${pack.characters.length} / ${pack.characters.length}`);
  assert.equal(c.colour, "Coral");
});

test("shuffle is local, picks valid options, deselects, and is one undo step", () => {
  let d = createDesigner(defaultLook(pack));
  const rng = seeded(7);
  for (let i = 0; i < 200; i++) {
    d = select(d, 0);
    d = shuffle(d, pack, rng);
    assert.equal(d.sel, -1);
    const json = toAvatarJson(d.state.look, pack, 1);
    const r = parseAvatar(json, pack);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.ok(eyeOptionsFor(pack, json.character).some(([id]) => id === json.eyes));
  }
  assert.ok(d.history.length > 0);
});

test("hit test: the top-most layer under the finger, honouring rotation; corner of the box for ×", () => {
  let d = createDesigner(defaultLook(pack));
  d = addAccessory(d, pack, "box-cap"); // same place, on top
  const look = d.state.look;
  const b = layerBox(pack, look, 1)!;
  assert.equal(hitTest(pack, look, b.cx, b.cy), 1, "top-most first");
  assert.equal(hitTest(pack, look, b.cx + b.w / 2 + 0.01, b.cy), -1);
  assert.equal(hitTest(pack, look, 0.02, 0.98), -1, "off every accessory");
  // turn the top layer 90°: a point just past its half width but inside its half height (now vertical) hits
  const turned = { ...look, accessories: [{ ...look.accessories[1]!, rotation: 90 }] };
  const tb = layerBox(pack, turned, 0)!;
  assert.ok(tb.w > tb.h);
  assert.equal(hitTest(pack, turned, tb.cx, tb.cy + tb.h / 2 + (tb.w - tb.h) / 4), 0);
  assert.equal(hitTest(pack, turned, tb.cx + tb.h / 2 + (tb.w - tb.h) / 4, tb.cy), -1);
  const corner = boxCorner({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.1, rotation: 0 });
  assert.deepEqual(corner, { x: 0.6, y: 0.45 });
  const c90 = boxCorner({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.1, rotation: 90 });
  assert.ok(Math.abs(c90.x - 0.55) < 1e-9 && Math.abs(c90.y - 0.6) < 1e-9);
});

test("avatar.json: 4 decimals, rotation only when turned, valid against the pack, round-trips", () => {
  let d = createDesigner(defaultLook(pack));
  d = setColour(d, "#FF6A59");
  d = select(d, 0);
  d = nudge(d, pack, "rotr", true, 0);
  d = nudge(d, pack, "bigger", true, 0);
  const json = toAvatarJson(d.state.look, pack, 3);
  assert.equal(json.revision, 3);
  assert.equal(json.packVersion, pack.packVersion);
  for (const a of json.accessories) for (const v of [a.x, a.y, a.scale]) assert.equal(Math.round(v * 1e4) / 1e4, v);
  assert.equal(json.accessories[0]!.rotation, 5);
  assert.ok(parseAvatar(json, pack).ok);
  assert.ok(JSON.stringify(json).length < 320, `small: ${JSON.stringify(json).length} B`);
  const back = lookFromAvatar(json, pack)!;
  assert.deepEqual(toAvatarJson(back, pack, 3), json);
  assert.equal(lookFromAvatar({ ...json, character: "nope" }, pack), null);
  assert.equal(lookFromAvatar({ ...json, packVersion: pack.packVersion + 1 }, pack), null);
  const plain = toAvatarJson(defaultLook(pack), pack, 1);
  assert.equal("colour" in plain, false);
  assert.equal("rotation" in plain.accessories[0]!, false);
});

test("composer usage: the stage draws exactly what Save writes (composeAvatarSvg of the saved avatar.json)", () => {
  let d = createDesigner(defaultLook(pack));
  d = pickCharacter(d, pack, "turtle");
  d = addAccessory(d, pack, "top-hat");
  d = setEyes(d, "from:scrat-crab");
  d = setColour(d, "#3EC3EA");
  d = select(d, 0);
  d = nudge(d, pack, "rotl", true, 0);
  const svgs = designerSvgs(pack, d.state.look);
  const saved = toAvatarJson(d.state.look, pack, 9);
  // what the server will render from the saved JSON (4-decimal rounding moves nothing visible)
  assert.equal(svgs.full, composeAvatarSvg(saved, pack));
  assert.match(svgs.full, /^<svg /);
  assert.match(svgs.full, /rotate\(-5\.0\)/);
});

test("composer usage: tiles (naked characters in the colour, face close-ups for eyes, accessories alone)", () => {
  const look = { character: "emmet-boxfish", colour: "#FF6A59", eyes: "happy", accessories: [] };
  const t = tileSvgs(pack, look);
  assert.equal(t.characters.length, pack.characters.length);
  assert.equal(
    t.characters.find((x) => x.id === "whale")!.xml,
    composeAvatarSvg({ character: "whale", colour: "#FF6A59", eyes: "original", accessories: [] }, pack, { view: "naked" }),
  );
  const rowEyes = eyeOptionsFor(pack, "emmet-boxfish");
  assert.deepEqual(t.eyes.map((x) => x.id), rowEyes.map(([id]) => id));
  assert.equal(
    t.eyes.find((x) => x.id === "dot")!.xml,
    composeAvatarSvg({ ...look, eyes: "dot" }, pack, { view: "face" }),
  );
  assert.equal(t.accessories.length, pack.accessories.length);
  assert.equal(t.accessories[0]!.xml, composeAccessorySvg(pack, pack.accessories[0]!.id));
  // tiles are cached by what they show: the same colour gives the same objects (no re-render, no tile pop)
  assert.equal(tileSvgs(pack, { ...look, eyes: "dot" }).characters, t.characters);
  assert.equal(tileSvgs(pack, { ...look, accessories: [{ id: "bow", x: 0.5, y: 0.5, scale: 0.2 }] }).eyes, t.eyes);
  assert.notEqual(tileSvgs(pack, { ...look, colour: undefined }).characters, t.characters);
});

test("the designer is bundled-pack only: no fetch / network in the designer files", () => {
  for (const f of ["avatar-designer-state.ts", "avatar-designer-svg.ts", "avatar-designer.tsx"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "client", f), "utf8");
    assert.doesNotMatch(src, /\bfetch\(|useRpc|XMLHttpRequest/, f);
  }
});
