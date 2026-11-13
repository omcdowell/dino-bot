// Pairing QR: terminal rendering and the PNG.  node --test test/qr.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { pictureOpener, qrPngPath, removeQrPng, renderModules, showPairingQr, writeQrPng } from "../lib/qr.mjs";
import { layout } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-qr"); // own dir: test files run in parallel
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const fakeLayout = () => layout({ HOME: mkdtempSync(join(TMP, "qr-")) });

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
/** Parse rendered lines back into cells {ch, fg, bg} (256-colour numbers). */
function cells(lines) {
  return lines.map((line) => {
    const out = [];
    let fg = null;
    let bg = null;
    for (const m of line.matchAll(/\u001b\[([0-9;]*)m|([^\u001b])/gu)) {
      if (m[2]) {
        out.push({ ch: m[2], fg, bg });
        continue;
      }
      const codes = m[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 0) fg = bg = null;
        else if (codes[i] === 38) (fg = codes[i + 2]), (i += 2);
        else if (codes[i] === 48) (bg = codes[i + 2]), (i += 2);
      }
    }
    return out;
  });
}
/** Modules back from the cells: top/bottom colour of each cell (16 = dark). */
function decodeCells(grid) {
  const rows = [];
  for (const row of grid) {
    const top = [];
    const bottom = [];
    for (const { ch, fg, bg } of row) {
      if (ch === " ") top.push(bg === 16), bottom.push(bg === 16);
      else if (ch === "▀") top.push(fg === 16), bottom.push(bg === 16);
      else if (ch === "▄") top.push(bg === 16), bottom.push(fg === 16);
      else throw new Error(`unexpected glyph ${ch}`);
    }
    rows.push(top, bottom);
  }
  return rows;
}

// A deterministic pseudo-random 25x25 matrix (mulberry32), about half dark like a QR code.
const SIZE = 25;
let seed = 7;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const DARK = Array.from({ length: SIZE * SIZE }, () => rand() < 0.5);
const dark = (r, c) => DARK[r * SIZE + c];

describe("terminal QR", () => {
  const { lines, columns } = renderModules(SIZE, dark);

  it("draws every module exactly (two per cell, quiet zone 4 all round)", () => {
    const got = decodeCells(cells(lines));
    for (let r = -4; r < SIZE + 4; r++)
      for (let c = -4; c < SIZE + 4; c++) {
        const want = r >= 0 && r < SIZE && c >= 0 && c < SIZE && dark(r, c);
        assert.equal(got[r + 4][c + 4], want, `module ${r},${c}`);
      }
    assert.equal(columns, SIZE + 8);
    assert.ok(lines.every((l) => [...strip(l)].length === columns));
  });

  it("uses only pure black/white (256-colour 16 and 231), never ANSI 47/30", () => {
    for (const l of lines) {
      assert.doesNotMatch(l, /\u001b\[(?:[0-9;]*;)?(?:47|30)m/);
      for (const m of l.matchAll(/\u001b\[([0-9;]*)m/g)) {
        if (m[1] === "0") continue;
        assert.match(m[1], /^(38;5;(16|231);)?48;5;(16|231)$/, m[1]);
      }
      assert.ok(l.endsWith("\u001b[0m"));
    }
  });

  it("only mixed cells use a glyph, and its background matches the module across the gap where possible", () => {
    const grid = cells(lines);
    const mod = decodeCells(grid);
    let mixed = 0;
    let both = 0;
    grid.forEach((row, i) =>
      row.forEach((cell, c) => {
        const top = mod[2 * i][c];
        const bottom = mod[2 * i + 1][c];
        if (top === bottom) return assert.equal(cell.ch, " ");
        mixed++;
        const above = i > 0 ? mod[2 * i - 1][c] : false;
        const below = 2 * i + 2 < mod.length ? mod[2 * i + 2][c] : false;
        const bgDark = cell.bg === 16;
        // The background colour must equal the module next to the glyph-free edge.
        if (cell.ch === "▀") assert.equal(bgDark, bottom);
        else assert.equal(bgDark, top);
        if ((cell.ch === "▀" && above === bottom) || (cell.ch === "▄" && below === top)) both++;
      }),
    );
    assert.ok(mixed > 0);
    assert.ok(both / mixed > 0.6, `${both}/${mixed} mixed cells safe at both edges`);
  });
});

describe("QR picture", () => {
  const stubQrcode = {
    create: () => ({ modules: { size: SIZE, get: (r, c) => (dark(r, c) ? 1 : 0) } }),
    toBuffer: async (url, opts) => Buffer.from(JSON.stringify({ url, opts })),
  };

  it("writes a PNG of the link, mode 0600, in the private DinoBot dir; quiet zone 4, black on white", async () => {
    const L = fakeLayout();
    const path = await writeQrPng(stubQrcode, L, "dinobot://pair/#offer=x");
    assert.equal(path, join(L.root, "pairing-qr.png"));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const { url, opts } = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(url, "dinobot://pair/#offer=x");
    assert.equal(opts.type, "png");
    assert.equal(opts.margin, 4);
    assert.ok(opts.scale >= 8);
    assert.deepEqual(opts.color, { dark: "#000000ff", light: "#ffffffff" });
  });

  it("removes it after pairing (and a stale one on the next run)", async () => {
    const L = fakeLayout();
    assert.equal(removeQrPng(L), false);
    await writeQrPng(stubQrcode, L, "dinobot://pair/#offer=x");
    assert.equal(removeQrPng(L), true);
    assert.equal(existsSync(qrPngPath(L)), false);
  });

  it("opens it in Preview on a Mac and says so under the code", async () => {
    const L = fakeLayout();
    const launched = [];
    const shown = await showPairingQr(L, "dinobot://pair/#offer=x", { qrcode: stubQrcode, platform: "darwin", env: {}, launch: (cmd, args) => launched.push([cmd, ...args]) });
    assert.deepEqual(launched, [["open", qrPngPath(L)]]);
    assert.equal(shown.opened, "Preview");
    assert.match(shown.hint, /^Can't scan it\? A picture of this code is open in Preview/);
    assert.ok(strip(shown.text).split("\n").every((l) => [...l].length <= 90));
  });

  it("prints the path instead when it must not open (Linux without a desktop, SSH, --yes)", async () => {
    const launched = [];
    const launch = (...a) => launched.push(a);
    for (const opts of [
      { platform: "linux", env: {} },
      { platform: "darwin", env: { SSH_CONNECTION: "1 2 3 4" } },
      { platform: "darwin", env: {}, open: false },
    ]) {
      const L = fakeLayout();
      const shown = await showPairingQr(L, "dinobot://pair/#offer=x", { qrcode: stubQrcode, launch, ...opts });
      assert.equal(shown.opened, null);
      assert.equal(shown.hint, `Can't scan it? A picture of this code is at ${qrPngPath(L)}`);
      assert.equal(statSync(shown.path).mode & 0o777, 0o600);
    }
    assert.deepEqual(launched, []);
  });

  it("picks xdg-open with a Linux desktop and wslview on WSL", () => {
    const has = () => true;
    assert.equal(pictureOpener({ platform: "linux", env: { DISPLAY: ":0" }, has }).cmd, "xdg-open");
    assert.equal(pictureOpener({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, has }).cmd, "xdg-open");
    assert.equal(pictureOpener({ platform: "linux", env: {}, wsl: { version: 2 }, has }).cmd, "wslview");
    assert.equal(pictureOpener({ platform: "linux", env: { DISPLAY: ":0" }, has: () => false }), null);
    assert.equal(pictureOpener({ platform: "win32", env: {}, has }), null);
  });
});

// With the real qrcode package (when paseo's node_modules are installed): the terminal modules are
// exactly the code's, and the PNG is a real PNG of it.
const qrcode = (() => {
  for (const base of [join(import.meta.dirname, "..", "paseo", "packages", "server", "package.json"), join(import.meta.dirname, "..", "paseo", "package.json")]) {
    try {
      return createRequire(base)("qrcode");
    } catch {}
  }
  return null;
})();

describe("with the qrcode package", { skip: qrcode ? false : "paseo/node_modules not installed" }, () => {
  const url = `dinobot://pair/#offer=${Buffer.from(JSON.stringify({ v: 3, serverId: "srv_abcdefghijkl", daemonPublicKeyB64: "A".repeat(44), endpoints: ["box.tail1a2b3c.ts.net:6767", "100.101.102.103:6767"], password: "p".repeat(24) })).toString("base64url")}`;
  it("renders the same modules as the code, within 90 columns", async () => {
    const { renderTerminalQr } = await import("../lib/qr.mjs");
    const { lines, columns } = renderTerminalQr(qrcode, url);
    const qr = qrcode.create(url, { errorCorrectionLevel: "M" });
    const mod = decodeCells(cells(lines));
    for (let r = 0; r < qr.modules.size; r++) for (let c = 0; c < qr.modules.size; c++) assert.equal(mod[r + 4][c + 4], qr.modules.get(r, c) === 1);
    assert.ok(columns <= 90, `${columns} columns`);
  });
  it("writes a real PNG", async () => {
    const path = await writeQrPng(qrcode, fakeLayout(), url);
    assert.deepEqual([...readFileSync(path).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});
