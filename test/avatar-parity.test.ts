// AV2 parity without a browser: composeAvatarSvg against designer-b ?r9's own avatarSVG for the same choices,
// both rendered with resvg at 256 px. The fixture is written by `scripts/avatar/parity.mjs --fixture` (which also
// runs the Chromium-vs-resvg comparison and the sheet); see research/friend/report-avatar-pack.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { AVATAR_PACK, composeAvatarSvg, parseAvatar } from "../shared/avatar";

const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "avatar", "designer-r9.json"), "utf8")) as {
  packMd5: string;
  cases: Array<{ name: string; avatar: unknown; exported: unknown; designerSvg: string }>;
};
const SIZE = 256, THRESH = 40;
const render = (svg: string) => new Resvg(svg, { fitTo: { mode: "width", value: SIZE }, background: "#ffffff" }).render().pixels;
function differs(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length);
  let bad = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > THRESH) bad++;
  return bad / (a.length / 4);
}

test("parity fixture is for this pack's source art", () => {
  assert.equal(fx.packMd5, AVATAR_PACK.source.md5);
  assert.ok(fx.cases.length >= 6);
  const eyes = new Set(fx.cases.map((c) => (c.avatar as { eyes: string }).eyes));
  for (const [id] of AVATAR_PACK.eyes) assert.ok(eyes.has(id), `eye option ${id} covered`);
});

for (const c of fx.cases) {
  test(`parity: ${c.name}`, () => {
    const exact = parseAvatar(c.avatar, AVATAR_PACK), exported = parseAvatar(c.exported, AVATAR_PACK);
    assert.ok(exact.ok && exported.ok);
    const ref = render(c.designerSvg);
    // full-precision placement: the same picture (sub-pixel float noise only)
    assert.ok(differs(ref, render(composeAvatarSvg(exact.avatar, AVATAR_PACK))) < 0.0005, "exact");
    // designer-b's own avatar.json export (3 decimals) still matches within anti-aliasing
    assert.ok(differs(ref, render(composeAvatarSvg(exported.avatar, AVATAR_PACK))) < 0.005, "exported");
  });
}
