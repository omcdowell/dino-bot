#!/usr/bin/env node
// Build the avatar options pack (shared/avatar/pack-v1.ts) from designer-b's chars.js.
//
//   node scripts/avatar/build-pack.mjs <path/to/designer-b/chars.js>      (or AVATAR_CHARS_JS=…)
//
// - Keeps what composeAvatarSvg needs: per character its id, name, body/details/eyes/accessory paths, and the
//   geometry designer-b measures at start-up with getBBox (body, accessory, each eye, naked figure, avatar square).
//   The bboxes are measured in Chromium (Playwright) exactly as designer-b does, so placement matches it.
// - Drops metadata (set, w, h), and shortens numbers losslessly (136.0 -> 136, 0.5 -> .5). The script checks
//   that every shortened path has the same bbox as the original.
// - Records the md5 of chars.js. Bump PACK_VERSION when the art or the option lists change.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadPlaywright } from "./playwright.mjs";

const PACK_VERSION = 1;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "shared", "avatar", "pack-v1.ts");
const src = process.argv[2] || process.env.AVATAR_CHARS_JS;
if (!src) { console.error("usage: build-pack.mjs <chars.js>"); process.exit(2); }
const js = readFileSync(src, "utf8");
const md5 = createHash("md5").update(js).digest("hex");

// ---- options, as designer-b app.js r9 ----
const PALETTE = [
  ["#9CC963", "Spring"], ["#95C4E7", "Mist"], ["#E8CF8C", "Sand"], ["#2B3318", "Dino ink"],
  ["#FF6A59", "Coral"], ["#F78DA7", "Pink"], ["#FF9A4D", "Tangerine"], ["#FECB3E", "Sunny"],
  ["#C77BD6", "Orchid"], ["#5FD3A6", "Sea glass"], ["#3EC3EA", "Lagoon"], ["#1572B4", "Deep"], ["#13202C", "Ink"],
];
const EYE_STYLES = [["original", "Original"], ["dot", "Dot"], ["pill", "Pill"], ["closed", "Closed"], ["happy", "Happy"], ["wide", "Wide"]];
// r8 duplicate eye options -> the one kept
const EYE_SAME = {
  "from:emmet-boxfish": "from:fc-jellyfish", "from:flint-seaslug": "from:fc-jellyfish", "from:bitzer-seal": "from:fc-jellyfish",
  "from:matilda-starfish": "from:fc-jellyfish", "from:wallace-snail": "from:fc-jellyfish", "from:peggy-pufferfish": "from:fc-jellyfish",
  ...Object.fromEntries(["octopus", "seahorse", "turtle", "clownfish", "manta", "hermit-crab", "axolotl", "anglerfish", "narwhal", "otter",
    "whale", "urchin", "nudibranch", "eel", "walrus", "penguin", "coral-polyp", "shrimp"].map((id) => ["from:" + id, "dot"])),
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// ---- lossless path shortening ----
// The source paths are absolute M/L/C/A/Z with at most 2 decimals. They are rewritten as relative commands
// (m/l/c/z; arcs stay absolute A), computed in exact hundredths so no rounding error builds up; numbers lose trailing zeros and the
// leading 0 (136.0 -> 136, 0.5 -> .5), and a minus sign doubles as the separator. About 30% smaller gzipped.
const fmt = (h) => { // h: integer hundredths
  let s = (h / 100).toFixed(2).replace(/\.?0+$/, "").replace(/^(-?)0\./, "$1.");
  return s === "-0" || s === "" ? "0" : s;
};
const joinNums = (nums) => nums.reduce((o, s, i) => o + (i && !s.startsWith("-") ? " " : "") + s, "");
const ARGS = { M: 2, L: 2, C: 6, A: 7 };
function shortPath(d) {
  const t = d.match(/[A-Za-z]|-?\d*\.?\d+/g);
  const hund = (s) => { const v = Math.round(parseFloat(s) * 100); if (Math.abs(v / 100 - parseFloat(s)) > 1e-9) throw new Error("more than 2 decimals: " + s); return v; };
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0, out = "";
  while (i < t.length) {
    let fresh = false;
    if (/[A-Za-z]/.test(t[i])) {
      cmd = t[i++];
      if (!/^[MLCAZ]$/.test(cmd)) throw new Error("unsupported path command " + cmd);
      if (cmd === "Z") { out += "z"; x = sx; y = sy; continue; }
      fresh = true;
    }
    const v = t.slice(i, i + ARGS[cmd]).map(hund); i += ARGS[cmd];
    let nums;
    // arcs stay absolute: their centre is solved from the end points, and a near-degenerate arc (a circle drawn as two
    // half arcs) can flip with float error in a relative end point
    if (cmd === "A") nums = [fmt(v[0]), fmt(v[1]), fmt(v[2]), String(v[3] / 100), String(v[4] / 100), fmt(v[5]), fmt(v[6])];
    else nums = v.map((h, k) => fmt(h - (k % 2 ? y : x)));
    const body = joinNums(nums);
    out += fresh ? (cmd === "A" ? "A" : cmd.toLowerCase()) + body : (body.startsWith("-") ? "" : " ") + body;
    x = v[ARGS[cmd] - 2]; y = v[ARGS[cmd] - 1];
    if (cmd === "M") { sx = x; sy = y; cmd = "L"; } // implicit pairs after m are l
  }
  return out;
}

const window = {};
new Function("window", js)(window);
const CH = window.CHARS;

// ---- geometry in Chromium (getBBox, as designer-b measure()) ----
const pw = await loadPlaywright();
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent('<svg id="m" width="400" height="400"></svg>');
const measured = await page.evaluate((chars) => {
  const NS = "http://www.w3.org/2000/svg", m = document.getElementById("m");
  const bb = (paths) => {
    m.innerHTML = "";
    const g = document.createElementNS(NS, "g");
    for (const [, d] of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); g.appendChild(p); }
    m.appendChild(g);
    const b = g.getBBox();
    return [b.x, b.y, b.width, b.height];
  };
  return chars.map((c) => ({
    body: bb(c.body),
    acc: c.accessory.length ? bb(c.accessory) : null,
    eyes: c.eyes.map((p) => bb([p])),
    naked: bb([...c.body, ...c.details, ...c.eyes]),
    all: [...c.body, ...c.details, ...c.eyes, ...c.accessory].map((p) => bb([p])),
  }));
}, CH.map((c) => ({ body: c.body, details: c.details, eyes: c.eyes, accessory: c.accessory })));
const shortened = CH.map((c) => ({
  body: c.body.map(([f, d]) => [f, shortPath(d)]), details: c.details.map(([f, d]) => [f, shortPath(d)]),
  eyes: c.eyes.map(([f, d]) => [f, shortPath(d)]), accessory: c.accessory.map(([f, d]) => [f, shortPath(d)]),
}));
const check = await page.evaluate((chars) => {
  const m = document.getElementById("m");
  return chars.map((c) => [...c.body, ...c.details, ...c.eyes, ...c.accessory].map(([, d]) => {
    m.innerHTML = `<path d="${d}"/>`; const b = m.firstChild.getBBox(); return [b.x, b.y, b.width, b.height];
  }));
}, shortened);
await browser.close();
check.forEach((list, i) => list.forEach((b, j) => {
  if (b.some((v, k) => Math.abs(v - measured[i].all[j][k]) > 0.01)) throw new Error(`shortened path changed bbox: ${CH[i].id} #${j}`);
}));

// ---- pack ----
const r3 = (v) => Math.round(v * 1000) / 1000;
const box = (b) => b.map(r3);
const characters = CH.map((c, i) => {
  const m = measured[i];
  // eyes sorted left to right (designer-b: .sort((a, b) => a.cx - b.cx)); keep the index into `eyes`
  const eyes = m.eyes.map((b, k) => [...b, k]).sort((a, b) => (a[0] + a[2] / 2) - (b[0] + b[2] / 2));
  // avatar square: the naked figure plus its own accessory, x1.26, a little extra headroom on top
  const n = { x: m.naked[0], y: m.naked[1], w: m.naked[2], h: m.naked[3] };
  let a = { ...n, cx: n.x + n.w / 2, cy: n.y + n.h / 2 };
  if (m.acc) {
    const x0 = Math.min(n.x, m.acc[0]), y0 = Math.min(n.y, m.acc[1]);
    const x1 = Math.max(n.x + n.w, m.acc[0] + m.acc[2]), y1 = Math.max(n.y + n.h, m.acc[1] + m.acc[3]);
    a = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  const s = Math.max(a.w, a.h) * 1.26;
  const frame = [a.cx - s / 2, a.cy - s / 2 - s * 0.05, s];
  const own = EYE_SAME["from:" + c.id] || "from:" + c.id;
  return {
    id: c.id, name: c.name, ...shortened[i], ownEyes: own,
    geo: { body: box(m.body), acc: m.acc && box(m.acc), eyes: eyes.map((e) => [...box(e.slice(0, 4)), e[4]]), naked: box(m.naked), frame: frame.map((v) => Math.round(v * 1e6) / 1e6) },
  };
});
const pack = {
  packVersion: PACK_VERSION,
  source: { file: basename(src), md5 },
  palette: PALETTE,
  eyes: EYE_STYLES.concat(CH.map((c) => ["from:" + c.id, c.name])).filter(([k]) => !EYE_SAME[k]),
  accessories: CH.filter((c) => c.accessory.length).map((c) => ({ id: slug(c.accName), name: c.accName, from: c.id })),
  characters,
};
const json = JSON.stringify(pack);
const ts = `// GENERATED by scripts/avatar/build-pack.mjs from designer-b ${pack.source.file} (md5 ${md5}). Do not edit.\n` +
  `// packVersion ${PACK_VERSION}: ${characters.length} characters, ${pack.eyes.length} eye options, ${pack.accessories.length} accessories, ${PALETTE.length} colours.\n` +
  `import type { AvatarPack } from "./pack";\n\n` +
  `/** The pack as JSON text (what the server sends when the app's pack is older). */\n` +
  `export const AVATAR_PACK_V1_JSON = ${JSON.stringify(json)};\n\n` +
  `export const AVATAR_PACK_V1: AvatarPack = JSON.parse(AVATAR_PACK_V1_JSON);\n`;
writeFileSync(OUT, ts);
const raw = Buffer.byteLength(json), gz = gzipSync(json, { level: 9 }).length;
const srcGz = gzipSync(js, { level: 9 }).length;
console.log(JSON.stringify({ out: OUT, packVersion: PACK_VERSION, md5, characters: characters.length, eyes: pack.eyes.length,
  accessories: pack.accessories.length, sourceBytes: js.length, sourceGzip: srcGz, packBytes: raw, packGzip: gz }));
