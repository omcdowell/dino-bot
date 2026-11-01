// AV2: the avatar options pack, the avatar.json schema, and composeAvatarSvg (shared/avatar/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import {
  AVATAR_PACK,
  AVATAR_PACK_JSON,
  AVATAR_PACK_VERSION,
  type AvatarJson,
  autoPlaceAccessory,
  canonicalAvatarJson,
  composeAccessorySvg,
  composeAvatarSvg,
  eyeOptionsFor,
  isNewerRevision,
  keepInFrame,
  packIndex,
  parseAvatar,
  recolour,
} from "../shared/avatar";

const base: AvatarJson = {
  v: 1,
  packVersion: 1,
  character: "emmet-boxfish",
  eyes: "original",
  accessories: [{ id: "box-cap", x: 0.5, y: 0.2, scale: 0.3 }],
  revision: 1,
};
const pixels = (svg: string, size = 64) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
const opaque = (img: { pixels: Buffer }) => { let n = 0; for (let i = 3; i < img.pixels.length; i += 4) if (img.pixels[i] > 0) n++; return n; };

test("pack: version 1, all 27 characters, the 9 r9 eye options, 23 accessories, 13 colours, source md5", () => {
  assert.equal(AVATAR_PACK_VERSION, 1);
  assert.equal(AVATAR_PACK.characters.length, 27);
  assert.deepEqual(AVATAR_PACK.eyes.map(([id]) => id), [
    "original", "dot", "pill", "closed", "happy", "wide", "from:fc-jellyfish", "from:scrat-crab", "from:tweety-squid",
  ]);
  assert.ok(!AVATAR_PACK.eyes.some(([id]) => /oval/.test(id)), "no oval eye");
  assert.equal(AVATAR_PACK.accessories.length, 23);
  assert.equal(AVATAR_PACK.palette.length, 13);
  assert.match(AVATAR_PACK.source.md5, /^[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(AVATAR_PACK_JSON), AVATAR_PACK);
  // the lookalike accessories are all there (glasses, round glasses, bow tie, striped bow tie, scarf, striped scarf)
  for (const id of ["glasses", "round-glasses", "bow-tie", "striped-bow-tie", "scarf", "striped-scarf", "bow", "yellow-bow"])
    assert.ok(packIndex(AVATAR_PACK).accessory.has(id), id);
});

test("pack: under ~100 KB gzipped; only renderer data (no set/w/h metadata); paths are short m/l/c/z/A", () => {
  const gz = gzipSync(AVATAR_PACK_JSON, { level: 9 }).length;
  assert.ok(gz < 100 * 1024, `gzip ${gz}`);
  for (const c of AVATAR_PACK.characters) {
    assert.deepEqual(Object.keys(c).sort(), ["accessory", "body", "details", "eyes", "geo", "id", "name", "ownEyes"]);
    for (const [f, d] of [...c.body, ...c.details, ...c.eyes, ...c.accessory]) {
      assert.match(f, /^#[0-9a-f]{6}$/i);
      assert.match(d, /^m[0-9.\- mlczA]+$/);
      assert.ok(!/\d\.\d{3}/.test(d), "at most 2 decimals");
    }
    assert.equal(c.geo.eyes.length, c.eyes.length);
    assert.equal(c.geo.acc === null, c.accessory.length === 0);
    assert.ok(AVATAR_PACK.eyes.some(([id]) => id === c.ownEyes) || c.ownEyes.startsWith("from:"), c.id);
  }
  for (const a of AVATAR_PACK.accessories) assert.ok(packIndex(AVATAR_PACK).character.get(a.from)!.accessory.length, a.id);
});

test("pack: a character's own eye look is hidden from its Eyes row", () => {
  assert.equal(eyeOptionsFor(AVATAR_PACK, "emmet-boxfish").length, 8);
  assert.ok(!eyeOptionsFor(AVATAR_PACK, "emmet-boxfish").some(([id]) => id === "from:fc-jellyfish"));
  assert.ok(!eyeOptionsFor(AVATAR_PACK, "octopus").some(([id]) => id === "dot"));
});

test("schema: a good avatar parses; extra keys are dropped", () => {
  const r = parseAvatar({ ...base, colour: "#9cc963", junk: 1 }, AVATAR_PACK);
  assert.ok(r.ok);
  assert.ok(!("junk" in r.avatar));
  assert.equal(r.avatar.colour, "#9cc963");
  assert.ok(JSON.stringify(base).length < 300);
});

test("schema: unknown character, eyes, accessory or colour for the pack are rejected", () => {
  const bad = (patch: object, what: RegExp) => {
    const r = parseAvatar({ ...base, ...patch }, AVATAR_PACK);
    assert.ok(!r.ok, JSON.stringify(patch));
    assert.match(r.error, what);
  };
  bad({ character: "griffin" }, /character: unknown character "griffin"/);
  bad({ eyes: "oval" }, /eyes: unknown eyes/);
  bad({ eyes: "from:octopus" }, /unknown eyes/); // a dropped duplicate (looks like Dot) is not an option
  bad({ accessories: [{ id: "crown", x: 0.5, y: 0.5, scale: 0.2 }] }, /accessories\.0\.id: unknown accessory/);
  bad({ colour: "#123456" }, /colour: unknown colour/);
  bad({ packVersion: 2 }, /needs pack 2/);
  bad({ v: 2 }, /v/);
  bad({ revision: -1 }, /revision/);
  bad({ revision: 1.5 }, /revision/);
  bad({ accessories: [{ id: "box-cap", x: 1.2, y: 0.5, scale: 0.2 }] }, /accessories\.0\.x/);
  bad({ accessories: [{ id: "box-cap", x: 0.5, y: 0.5, scale: 0 }] }, /accessories\.0\.scale/);
  bad({ accessories: Array.from({ length: 25 }, () => base.accessories[0]) }, /accessories/);
  assert.ok(!parseAvatar(null, AVATAR_PACK).ok);
  assert.ok(!parseAvatar({ ...base, character: undefined }, AVATAR_PACK).ok);
});

test("schema: a save replaces the stored one only with a higher revision", () => {
  assert.ok(isNewerRevision({ revision: 1 }, null));
  assert.ok(isNewerRevision({ revision: 3 }, { revision: 2 }));
  assert.ok(!isNewerRevision({ revision: 2 }, { revision: 2 }));
  assert.ok(!isNewerRevision({ revision: 1 }, { revision: 2 }));
});

test("schema: canonical JSON is the same for the same picture (key order, revision, default rotation, colour case)", () => {
  const a = canonicalAvatarJson(base);
  const shuffled = { revision: 9, accessories: [{ scale: 0.3, rotation: 0, y: 0.2, x: 0.5, id: "box-cap" }], eyes: "original", character: "emmet-boxfish", packVersion: 1, v: 1 } as AvatarJson;
  assert.equal(canonicalAvatarJson(shuffled), a);
  assert.equal(canonicalAvatarJson({ ...base, colour: "#9cc963" }), canonicalAvatarJson({ ...base, colour: "#9CC963" }));
  assert.notEqual(canonicalAvatarJson({ ...base, eyes: "dot" }), a);
  assert.notEqual(canonicalAvatarJson({ ...base, packVersion: 2 }), a);
});

test("compose: pure and deterministic; a square viewBox on the avatar square; layers in order", () => {
  const svg = composeAvatarSvg(base, AVATAR_PACK);
  assert.equal(composeAvatarSvg(base, AVATAR_PACK), svg);
  const c = packIndex(AVATAR_PACK).character.get("emmet-boxfish")!;
  const [fx, fy, fw] = c.geo.frame;
  assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fx.toFixed(1)} ${fy.toFixed(1)} ${fw.toFixed(1)} ${fw.toFixed(1)}"`));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(!/class=|<rect class="hit"/.test(svg), "no designer UI");
  assert.equal((svg.match(/<g transform=/g) || []).length, 1);
  assert.match(composeAvatarSvg(base, AVATAR_PACK, { size: 128 }), /^<svg [^>]*width="128" height="128"/);
  const two = composeAvatarSvg({ ...base, accessories: [base.accessories[0], { id: "top-hat", x: 0.5, y: 0.1, scale: 0.3 }] }, AVATAR_PACK);
  assert.ok(two.indexOf(c.accessory[0][1]) < two.indexOf(packIndex(AVATAR_PACK).character.get("fc-jellyfish")!.accessory[0][1]));
});

test("compose: accessory transform puts its centre at (x, y) of the avatar square at the asked width, turned", () => {
  const c = packIndex(AVATAR_PACK).character.get("octopus")!, src = packIndex(AVATAR_PACK).character.get("fc-jellyfish")!;
  const [fx, fy, fw] = c.geo.frame, [ax, ay, aw, ah] = src.geo.acc!;
  const svg = composeAvatarSvg({ ...base, character: "octopus", accessories: [{ id: "top-hat", x: 0.25, y: 0.75, scale: 0.5, rotation: -30 }] }, AVATAR_PACK);
  const m = svg.match(/<g transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\) scale\(([-\d.]+)\) translate\(([-\d.]+) ([-\d.]+)\)">/)!;
  assert.ok(m);
  assert.ok(Math.abs(+m[1] - (fx + 0.25 * fw)) < 0.01 && Math.abs(+m[2] - (fy + 0.75 * fw)) < 0.01);
  assert.equal(+m[3], -30);
  assert.ok(Math.abs(+m[4] * aw - 0.5 * fw) < 0.01 * fw);
  assert.ok(Math.abs(+m[5] + (ax + aw / 2)) < 0.01 && Math.abs(+m[6] + (ay + ah / 2)) < 0.01);
});

test("compose: every character with every eye option and colour renders (resvg), and the eyes change the picture", () => {
  for (const [i, c] of AVATAR_PACK.characters.entries()) {
    const seen = new Set<string>();
    for (const [eyes] of AVATAR_PACK.eyes) seen.add(composeAvatarSvg({ character: c.id, eyes, accessories: [] }, AVATAR_PACK));
    assert.equal(seen.size, AVATAR_PACK.eyes.length, c.id);
    // one resvg render per character, cycling eyes and colours (resvg takes ~50 ms a picture)
    const [eyes] = AVATAR_PACK.eyes[i % AVATAR_PACK.eyes.length], [hex] = AVATAR_PACK.palette[i % AVATAR_PACK.palette.length];
    assert.ok(opaque(pixels(composeAvatarSvg({ character: c.id, eyes, colour: hex, accessories: [] }, AVATAR_PACK), 32)) > 100, c.id);
  }
  for (const a of AVATAR_PACK.accessories) assert.ok(opaque(pixels(composeAccessorySvg(AVATAR_PACK, a.id), 32)) > 20, a.id);
});

test("compose: Original eyes are the drawn paths; colours repaint the body only; no colour = as drawn", () => {
  const c = packIndex(AVATAR_PACK).character.get("emmet-boxfish")!;
  const svg = composeAvatarSvg(base, AVATAR_PACK);
  for (const [f, d] of [...c.body, ...c.details, ...c.eyes]) assert.ok(svg.includes(`<path fill="${f}" fill-rule="evenodd" d="${d}"/>`));
  const coral = composeAvatarSvg({ ...base, colour: "#FF6A59" }, AVATAR_PACK);
  assert.ok(!coral.includes(`fill="${c.body[0][0]}"`));
  for (const [f] of c.eyes) assert.ok(coral.includes(`fill="${f}"`));
  assert.equal(recolour("#abcdef", "#abcdef", undefined), "#abcdef");
  assert.equal(recolour("#ffffff", "#8a7bd6", "#FF6A59"), "#ffffff"); // near-white belly stays
});

test("compose: tile views (face, naked) leave accessories out; unknown ids throw", () => {
  for (const view of ["face", "naked"] as const) {
    const svg = composeAvatarSvg(base, AVATAR_PACK, { view });
    assert.ok(!svg.includes("<g transform"), view);
  }
  assert.throws(() => composeAvatarSvg({ ...base, character: "griffin" }, AVATAR_PACK), /unknown character/);
  assert.throws(() => composeAvatarSvg({ ...base, accessories: [{ id: "crown", x: 0, y: 0, scale: 1 }] }, AVATAR_PACK), /unknown accessory/);
});

test("autoPlaceAccessory: its own accessory sits as drawn; a borrowed one lands inside the avatar square", () => {
  const c = packIndex(AVATAR_PACK).character.get("emmet-boxfish")!;
  const [fx, fy, fw] = c.geo.frame, [ax, ay, aw, ah] = c.geo.acc!;
  const own = autoPlaceAccessory(AVATAR_PACK, "emmet-boxfish", "box-cap");
  assert.ok(Math.abs(own.x - (ax + aw / 2 - fx) / fw) < 1e-9 && Math.abs(own.y - (ay + ah / 2 - fy) / fw) < 1e-9);
  assert.ok(Math.abs(own.scale - aw / fw) < 1e-9);
  for (const ch of AVATAR_PACK.characters) for (const a of AVATAR_PACK.accessories) {
    const p = autoPlaceAccessory(AVATAR_PACK, ch.id, a.id);
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && p.scale > 0, `${a.id} on ${ch.id}`);
    assert.ok(parseAvatar({ ...base, character: ch.id, accessories: [p] }, AVATAR_PACK).ok);
  }
  assert.deepEqual(keepInFrame({ id: "box-cap", x: 1.3, y: -0.2, scale: 0.3 }), { id: "box-cap", x: 1, y: 0, scale: 0.3 });
});
