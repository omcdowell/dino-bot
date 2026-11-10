// AH1 checks for the designer's header and selected outline, in dark mode as the phone opens it from the home
// (the host's top inset applied, see host-rn.tsx):
//   node scripts/avatar/designer-web/build.mjs /tmp/ah-web && node scripts/avatar/designer-web/shoot-header.mjs /tmp/ah-web <outDir> [name] [hostInset]
// Prints one line per check; exits 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPlaywright } from "../playwright.mjs";

const web = resolve(process.argv[2] ?? "/tmp/ah-web");
const out = resolve(process.argv[3] ?? "ah-shots");
const name = process.argv[4] ?? "after";
const hostInset = Number(process.argv[5] ?? 124);
mkdirSync(out, { recursive: true });
const pw = await loadPlaywright();
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const tid = (id) => `[data-testid="${id}"]`;
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`file://${web}/index.html?bot=Emmet&theme=dark&hostInset=${hostInset}`);
await page.waitForSelector(tid("avatar-stage"));
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, `ah-${name}-dark-393.png`) });
// a close-up of the rows, for the outline
const rows = await page.locator(tid("avatar-row-character")).boundingBox();
await page.screenshot({ path: join(out, `ah-${name}-rows-zoom.png`), clip: { x: 0, y: rows.y - 4, width: 393, height: 380 } });

const save = await page.locator(tid("avatar-save")).boundingBox();
const stage = await page.locator(tid("avatar-stage")).boundingBox();
const gap = Math.round(stage.y - (save.y + save.height));
check(gap <= 24, `gap header -> preview ${gap} px (host inset ${hostInset})`);
check((await page.getByText("Avatar", { exact: true }).count()) === 0, "no \"Avatar\" title");
// selected outline: green bordered boxes inside each selected tile, and their width; the colour ring's width
const green = await page.evaluate(() => {
  const isGreen = (c) => /rgb\(156, 201, 99\)/i.test(c);
  // The declared width (Chromium snaps the computed border width to whole pixels, so 2.5 reads as 2).
  const rules = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules]; } catch { return []; } });
  const declared = (el) => {
    let w = el.style.borderTopWidth;
    if (!w) for (const r of rules) if (r.style?.borderTopWidth && r.selectorText && el.matches(r.selectorText)) w = r.style.borderTopWidth;
    return parseFloat(w) || 0;
  };
  const ring = (el) => {
    const s = getComputedStyle(el);
    return isGreen(s.borderTopColor) && parseFloat(s.borderTopWidth) > 0 ? declared(el) : 0;
  };
  const tile = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const widths = [el, ...el.querySelectorAll("*")].map(ring).filter(Boolean);
    return { rings: widths.length, width: widths[0] ?? 0, size: el.getBoundingClientRect().width };
  };
  const pick = (row) => [...document.querySelectorAll(`[data-testid="${row}"] [data-testid]`)].find((el) => ring(el));
  const out = {};
  for (const row of ["avatar-row-character", "avatar-row-eyes", "avatar-row-acc", "avatar-row-colour"]) {
    const el = pick(row);
    out[row] = el ? tile(`[data-testid="${el.dataset.testid}"]`) : null;
    if (el) out[row].id = el.dataset.testid;
  }
  const plain = [...document.querySelectorAll('[data-testid="avatar-row-character"] [data-testid^="avatar-char-"]')].find((el) => !ring(el));
  out.unselectedSize = plain?.getBoundingClientRect().width;
  out.unselectedWidth = plain ? declared(plain) : 0;
  return out;
});
const colourW = green["avatar-row-colour"]?.width;
for (const row of ["avatar-row-character", "avatar-row-eyes", "avatar-row-acc"]) {
  const t = green[row];
  check(!!t && t.rings === 1, `${row}: ${t?.rings ?? 0} green outline(s) on ${t?.id}`);
  check(!!t && t.width === colourW, `${row}: outline ${t?.width} px = colour ring ${colourW} px`);
}
check(green.unselectedSize === green["avatar-row-character"]?.size && green.unselectedWidth === colourW, `unselected tile same box (${green.unselectedSize} px, border ${green.unselectedWidth} px)`);
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await browser.close();
process.exit(failed ? 1 : 0);
