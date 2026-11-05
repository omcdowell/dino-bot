#!/usr/bin/env -S npx tsx
// Parity check: composeAvatarSvg (rendered with resvg, as the server will) against designer-b ?r9 (its own
// avatarSVG, drawn by Chromium) for the same choices.
//
//   npx tsx scripts/avatar/parity.mjs [--url http://127.0.0.1:8791/?r9] [--out dir] [--star dir]
//
// Per case: designer-b is loaded with the state in localStorage, its own avatar.json export (avatarJson()) is
// converted to our avatar.json, and three 512 px pictures are compared on white:
//   D  designer-b avatarSVG in Chromium       C  composeAvatarSvg in Chromium       R  composeAvatarSvg in resvg
// D vs C isolates the composer (same renderer); D vs R is the end-to-end check (renderer anti-aliasing differs).
// A pixel "differs" when any channel is more than 40/255 apart. Writes parity.json and av2-parity.png.
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoPlaceAccessory, composeAvatarSvg } from "../../shared/avatar/compose.ts";
import { AVATAR_PACK_V1 as AVATAR_PACK } from "../../shared/avatar/pack-v1.ts";
import { parseAvatar } from "../../shared/avatar/schema.ts";
import { loadPlaywright } from "./playwright.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg("--url", "http://127.0.0.1:8791/?r9");
const OUT = arg("--out", "scratch/av2");
const STAR = arg("--star", null);
const FIXTURE = arg("--fixture", null);   // write the hand cases (avatar + designer-b SVG) for test/avatar-parity.test.ts
const SIZE = 512, THRESH = 40;
mkdirSync(OUT, { recursive: true });

const L = (id, dx = 0, dy = 0, ds = 1, dr = 0) => ({ id, dx, dy, ds, dr });
/** Hand-picked cases (on the sheet): every eye option once, colours, accessories moved / scaled / turned / borrowed / stacked. */
const CASES = [
  { name: "emmet default", char: "emmet-boxfish", color: "original", eyes: "original", accs: [L("box-cap")] },
  { name: "fc dot coral, hat moved+scaled", char: "fc-jellyfish", color: "#FF6A59", eyes: "dot", accs: [L("top-hat", 0.05, -0.03, 1.3)] },
  { name: "scrat pill lagoon, +headphones turned", char: "scrat-crab", color: "#3EC3EA", eyes: "pill", accs: [L("acorn"), L("headphones", 0, 0, 0.8, 15)] },
  { name: "octopus closed sunny, sun hat big", char: "octopus", color: "#FECB3E", eyes: "closed", accs: [L("sun-hat", -0.1, 0, 1.5, -20), L("glasses")] },
  { name: "tweety happy, borrowed hat+bow tie", char: "tweety-squid", color: "original", eyes: "happy", accs: [L("bobble-hat"), L("bow-tie", 0.04, 0.06, 1.2)] },
  { name: "whale wide ink, rod small", char: "whale", color: "#13202C", eyes: "wide", accs: [L("sailor-hat"), L("fishing-rod", 0.1, 0, 0.6)] },
  { name: "axolotl fc-eyes orchid", char: "axolotl", color: "#C77BD6", eyes: "from:fc-jellyfish", accs: [L("daisy"), L("scarf")] },
  { name: "shrimp scrat-eyes sea glass, satchel x2 45deg", char: "shrimp", color: "#5FD3A6", eyes: "from:scrat-crab", accs: [L("satchel", 0.1, 0.1, 2, 45)] },
  { name: "bitzer tweety-eyes pink, 3 layers", char: "bitzer-seal", color: "#F78DA7", eyes: "from:tweety-squid", accs: [L("beanie"), L("round-glasses"), L("striped-scarf", 0, -0.02, 0.9, -8)] },
  { name: "anglerfish dot deep, none", char: "anglerfish", color: "#1572B4", eyes: "dot", accs: [] },
];
/** Sweep (numbers only): every character with its own accessory, cycling eye options and colours. */
const EYES = AVATAR_PACK.eyes.map(([id]) => id), COLS = ["original", ...AVATAR_PACK.palette.map(([h]) => h)];
const SWEEP = AVATAR_PACK.characters.map((c, i) => {
  const own = AVATAR_PACK.accessories.find((a) => a.from === c.id);
  return { name: `sweep ${c.id}`, char: c.id, color: COLS[i % COLS.length], eyes: EYES[i % EYES.length], accs: own ? [L(own.id)] : [], sweep: true };
});

/** avatar.json from the designer state, placing layers with our autoPlaceAccessory (full precision). */
const fromState = (st) => ({
  v: 1, packVersion: AVATAR_PACK.packVersion, character: st.char, eyes: st.eyes,
  ...(st.color !== "original" ? { colour: st.color } : {}),
  accessories: st.accs.map((a) => {
    const p = autoPlaceAccessory(AVATAR_PACK, st.char, a.id);
    return { id: a.id, x: p.x + a.dx, y: p.y + a.dy, scale: p.scale * a.ds, ...(a.dr ? { rotation: a.dr } : {}) };
  }),
  revision: 1,
});
/** Designer-b's own avatar.json export (3 decimals), in our shape. */
const toOurs = (j) => ({
  v: 1, packVersion: AVATAR_PACK.packVersion, character: j.base,
  eyes: j.eyes.style === "borrowed" ? "from:" + j.eyes.from : j.eyes.style,
  ...(j.color.mode === "recolour" ? { colour: j.color.fill } : {}),
  accessories: j.accessories.map((a) => ({ id: a.id, x: a.x, y: a.y, scale: a.scale, ...(a.rotation ? { rotation: a.rotation } : {}) })),
  revision: 1,
});
const resvgPng = (svg) => new Resvg(svg, { fitTo: { mode: "width", value: SIZE }, background: "#ffffff" }).render().asPng();
const dataUrl = (buf) => "data:image/png;base64," + Buffer.from(buf).toString("base64");

const pw = await loadPlaywright();
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
await page.goto(URL_);

async function chromiumShot(svg) {
  await page.evaluate(([svg, size]) => {
    let el = document.getElementById("__par");
    if (!el) { el = document.createElement("div"); el.id = "__par"; document.body.appendChild(el); }
    el.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;background:#fff;z-index:2147483647;line-height:0`;
    el.innerHTML = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
  }, [svg, SIZE]);
  return page.locator("#__par").screenshot();
}
async function diff(a, b) {
  return page.evaluate(async ([a, b, t]) => {
    const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = ia.width, h = ia.height, cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, w, h).data;
    cx.clearRect(0, 0, w, h); cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, w, h).data;
    const out = cx.createImageData(w, h); let bad = 0, sum = 0;
    for (let i = 0; i < da.length; i += 4) {
      const m = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      sum += (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])) / 3;
      if (m > t) bad++;
      // red: differs; grey: below the threshold (x4 so faint anti-aliasing shows)
      const g = 255 - Math.min(255, m * 4);
      if (m > t) { out.data[i] = 230; out.data[i + 1] = 0; out.data[i + 2] = 0; } else { out.data[i] = g; out.data[i + 1] = g; out.data[i + 2] = g; }
      out.data[i + 3] = 255;
    }
    cx.putImageData(out, 0, 0);
    return { differs: bad / (w * h), meanAbs: sum / (w * h), img: cv.toDataURL("image/png") };
  }, [a, b, THRESH]);
}

const results = [];
for (const cs of [...CASES, ...SWEEP]) {
  const state = { char: cs.char, color: cs.color, eyes: cs.eyes, details: true, accs: cs.accs, accsBy: {} };
  await page.evaluate((s) => localStorage.setItem("avatarMockB2", JSON.stringify(s)), state);
  await page.reload();
  await page.waitForFunction(() => window.__avatarMock);
  const got = await page.evaluate(() => ({ svg: window.__avatarMock.avatarSVG(window.__avatarMock.state), json: window.__avatarMock.avatarJson(), st: window.__avatarMock.state }));
  if (got.st.char !== cs.char || got.st.eyes !== cs.eyes) throw new Error("designer did not take the state: " + cs.name);
  // our placement must agree with designer-b's export (which rounds to 3 decimals)
  const exported = toOurs(got.json), avatar = fromState(got.st);
  const v = parseAvatar(avatar, AVATAR_PACK), ve = parseAvatar(exported, AVATAR_PACK);
  if (!ve.ok) throw new Error(cs.name + " (designer export): " + ve.error);
  if (exported.eyes !== avatar.eyes || exported.colour !== avatar.colour) throw new Error(cs.name + ": eyes/colour mismatch");
  const placeDelta = Math.max(0, ...avatar.accessories.flatMap((a, i) => ["x", "y", "scale"].map((k) => Math.abs(a[k] - exported.accessories[i][k]))),
    ...avatar.accessories.map((a, i) => Math.abs((a.rotation ?? 0) - (exported.accessories[i].rotation ?? 0))));
  if (!v.ok) throw new Error(cs.name + ": " + v.error);
  const svg = composeAvatarSvg(v.avatar, AVATAR_PACK);
  const D = await chromiumShot(got.svg), C = await chromiumShot(svg), R = resvgPng(svg);
  const dc = await diff(dataUrl(D), dataUrl(C)), dr = await diff(dataUrl(D), dataUrl(R));
  results.push({ name: cs.name, sweep: !!cs.sweep, avatar: exported, bytes: JSON.stringify(exported).length, placeDelta,
    composer: { differs: dc.differs, meanAbs: dc.meanAbs }, endToEnd: { differs: dr.differs, meanAbs: dr.meanAbs },
    designerSvg: got.svg, exactAvatar: avatar,
    imgs: cs.sweep ? null : { D: dataUrl(D), R: dataUrl(R), diff: dr.img } });
  console.log(cs.name.padEnd(48), "place", placeDelta.toFixed(4), "composer", (dc.differs * 100).toFixed(3) + "%", "end-to-end", (dr.differs * 100).toFixed(3) + "%", "mean", dr.meanAbs.toFixed(2));
}

// sheet
const pct = (v) => (v * 100).toFixed(2) + "%";
const rows = results.filter((r) => r.imgs).map((r) => `<div class="row"><div class="lab"><b>${r.name}</b><br>${r.avatar.character} · ${r.avatar.eyes} · ${r.avatar.colour || "original"} · ${r.avatar.accessories.length} acc<br>composer ${pct(r.composer.differs)} · end-to-end ${pct(r.endToEnd.differs)}</div>` +
  `<img src="${r.imgs.D}"><img src="${r.imgs.R}"><img src="${r.imgs.diff}"></div>`).join("");
const html = `<style>body{margin:0;padding:16px;font:14px -apple-system,system-ui,sans-serif;background:#F7F8F5;color:#13202C}
h1{font-size:20px;margin:0 0 4px}.sub{margin:0 0 12px;color:#555}.row{display:flex;gap:10px;align-items:center;margin:0 0 10px}
.lab{width:260px}img{width:200px;height:200px;border:1px solid #ccc;background:#fff}.hd{display:flex;gap:10px;margin-left:270px;font-weight:600}.hd span{width:202px}</style>
<h1>AV2 parity: composeAvatarSvg + resvg vs designer-b ?r9</h1><p class="sub">512 px on white · a pixel differs when a channel is &gt;${THRESH}/255 apart · composer = same renderer (Chromium), end-to-end = designer in Chromium vs ours in resvg</p>
<div class="hd"><span>designer-b ?r9 (Chromium)</span><span>composeAvatarSvg (resvg)</span><span>difference (red = differs)</span></div>${rows}`;
const sp = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
await sp.setContent(html);
const sheet = join(OUT, "av2-parity.png");
await sp.screenshot({ path: sheet, fullPage: true });
await browser.close();

const max = (k, f) => Math.max(...results.filter(f).map((r) => r[k].differs));
const summary = {
  url: URL_, size: SIZE, threshold: THRESH, cases: results.length, sheetCases: CASES.length,
  composerMaxDiffers: max("composer", () => true), endToEndMaxDiffers: max("endToEnd", () => true),
  endToEndMaxMeanAbs: Math.max(...results.map((r) => r.endToEnd.meanAbs)),
  maxPlacementDeltaVsDesignerExport: Math.max(...results.map((r) => r.placeDelta)),
  avatarJsonBytes: { min: Math.min(...results.map((r) => r.bytes)), max: Math.max(...results.map((r) => r.bytes)) },
};
writeFileSync(join(OUT, "parity.json"), JSON.stringify({ summary, results: results.map(({ imgs, designerSvg, exactAvatar, ...r }) => r) }, null, 2));
if (FIXTURE) writeFileSync(FIXTURE, JSON.stringify({
  comment: "designer-b ?r9 avatarSVG for the AV2 hand cases (scripts/avatar/parity.mjs --fixture). avatar = full-precision placement; exported = designer-b's own 3-decimal export.",
  packMd5: AVATAR_PACK.source.md5,
  cases: results.filter((r) => !r.sweep).map((r) => ({ name: r.name, avatar: r.exactAvatar, exported: r.avatar, designerSvg: r.designerSvg.replace(/ class="[^"]*"| data-i="\d+"/g, "") })),
}) + "\n");
console.log(JSON.stringify(summary));
if (STAR) { mkdirSync(STAR, { recursive: true }); copyFileSync(sheet, join(STAR, "★ av2-parity.png")); }
