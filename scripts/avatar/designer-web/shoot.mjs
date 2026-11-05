// Drives the avatar designer web harness in Chromium (touch) and WebKit: screenshots + interaction checks.
//   node scripts/avatar/designer-web/build.mjs /tmp/av3-web && node scripts/avatar/designer-web/shoot.mjs /tmp/av3-web <outDir>
// Prints one line per check; exits 1 when a check fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPlaywright } from "../playwright.mjs";

const web = resolve(process.argv[2] ?? "/tmp/av3-web");
const out = resolve(process.argv[3] ?? "av3-shots");
mkdirSync(out, { recursive: true });
const pw = await loadPlaywright();
const log = [];
let failed = 0;
const check = (ok, what) => {
  const line = `${ok ? "ok  " : "FAIL"} ${what}`;
  log.push(line);
  console.log(line);
  if (!ok) failed++;
};
const url = (q = "") => `file://${web}/index.html?${q.includes("bot=") ? "" : "bot=Emmet"}${q}`;
const tid = (id) => `[data-testid="${id}"]`;

async function open(browser, { width = 390, height = 844, q = "" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: browser.browserType().name() === "chromium" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url(q));
  await page.waitForSelector(tid("avatar-stage"));
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const box = (page, id) => page.locator(tid(id)).first().boundingBox();
const saveNow = async (page) => {
  await page.locator(tid("avatar-save")).tap();
  return page.evaluate(() => window.__saved.at(-1));
};
/** Touch sequence through CDP (Chromium): points are [[x, y], ...] per step. */
async function touch(page, steps) {
  const cdp = await page.context().newCDPSession(page);
  const tp = (pts) => pts.map(([x, y], id) => ({ x, y, id }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(steps[0]) });
  for (const s of steps.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(s) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(120);
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a.map((p, k) => [p[0] + ((b[k][0] - p[0]) * i) / n, p[1] + ((b[k][1] - p[1]) * i) / n]));

const chromium = await pw.chromium.launch();

// ---- 1. first open, light + dark, small screen
for (const [name, opts] of [
  ["1-open-light-390", {}],
  ["2-open-dark-390", { q: "&theme=dark" }],
  ["3-open-light-320", { width: 320, height: 568 }],
]) {
  const { ctx, page, errors } = await open(chromium, opts);
  await page.screenshot({ path: join(out, `av3-${name}.png`) });
  check(errors.length === 0, `${name}: no page errors ${errors.join(" | ")}`);
  const sb = await box(page, "avatar-stage"), sh = await box(page, "avatar-shuffle");
  check(sh.x + sh.width <= (opts.width ?? 390), `${name}: Shuffle fits (${Math.round(sh.x + sh.width)} <= ${opts.width ?? 390})`);
  check(sb.width > 100, `${name}: stage ${Math.round(sb.width)} px`);
  check((await page.locator(tid("avatar-icon48")).count()) === 0 && (await page.getByText("48 px").count()) === 0, `${name}: no 48 px preview in the header`);
  await ctx.close();
}

// ---- 2. interactions (Chromium touch)
{
  const { ctx, page, errors } = await open(chromium);
  // order of the hero buttons: fullscreen, undo, shuffle
  const xs = await Promise.all(["avatar-fullscreen", "avatar-undo", "avatar-shuffle"].map(async (id) => (await box(page, id)).x));
  check(xs[0] < xs[1] && xs[1] < xs[2], "hero buttons in order Fullscreen · Undo · Shuffle");
  // eyes row: the pack's 9 options minus the character's own look
  const eyes = await page.locator(`${tid("avatar-row-eyes")} [data-testid^="avatar-eyes-"]`).count();
  check(eyes >= 8 && eyes <= 9, `eyes row has ${eyes} tiles (9 options, own look hidden)`);
  check((await page.locator(`${tid("avatar-row-character")} [data-testid^="avatar-char-"]`).count()) === 27, "27 characters");
  check((await page.getByText("Details").count()) === 0, "no Details toggle");
  const us = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="avatar-designer"]').parentElement).userSelect);
  check(us === "none", `no text selection on the designer (user-select: ${us})`);

  // no tile pop: adding an accessory changes nothing in the Character / Eyes rows and only the tapped tile in Accessories
  await page.evaluate(() => {
    window.__mut = { char: 0, eyes: 0, acc: new Set() };
    const watch = (sel, f) => new MutationObserver((ms) => ms.forEach(f)).observe(document.querySelector(sel), { subtree: true, childList: true, attributes: true, characterData: true });
    watch('[data-testid="avatar-row-character-tiles"]', () => window.__mut.char++);
    watch('[data-testid="avatar-row-eyes-tiles"]', () => window.__mut.eyes++);
    watch('[data-testid="avatar-row-acc-tiles"]', (m) => {
      const t = (m.target.nodeType === 1 ? m.target : m.target.parentElement).closest("[data-testid^='avatar-acc-']");
      window.__mut.acc.add(t ? t.dataset.testid : "row");
    });
  });
  await page.locator(tid("avatar-acc-acorn")).scrollIntoViewIfNeeded();
  await page.locator(tid("avatar-acc-acorn")).tap();
  await page.waitForTimeout(250);
  const mut = await page.evaluate(() => ({ char: window.__mut.char, eyes: window.__mut.eyes, acc: [...window.__mut.acc] }));
  check(mut.char === 0 && mut.eyes === 0, `tap on an accessory tile leaves the Character and Eyes tiles untouched (${mut.char}, ${mut.eyes} mutations)`);
  check(mut.acc.every((t) => ["avatar-acc-acorn", "avatar-acc-box-cap", "avatar-acc-none"].includes(t)), `only the tapped / previously current tiles change: ${mut.acc.join(", ")}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(tid("avatar-stage")).scrollIntoViewIfNeeded();
  check((await page.locator(tid("avatar-stage-delete")).count()) === 1, "added accessory is selected (× shown)");
  check((await page.getByText("1 on · ", { exact: false }).count()) === 0 && (await page.getByText("Acorn selected", { exact: false }).count()) === 1, "counter: Acorn selected");
  await page.screenshot({ path: join(out, "av3-4-acorn-added.png") });
  let saved = await saveNow(page);
  const acorn0 = saved.accessories.find((a) => a.id === "acorn");
  check(!!acorn0 && saved.accessories.length === 2, `save writes 2 accessories (${JSON.stringify(saved).length} B)`);

  // drag the acorn by touch
  const sb = await box(page, "avatar-stage");
  const at = [sb.x + acorn0.x * sb.width, sb.y + acorn0.y * sb.height];
  await touch(page, lerp([at], [[at[0] + 30, at[1] - 20]], 8));
  saved = await saveNow(page);
  let acorn = saved.accessories.find((a) => a.id === "acorn");
  check(Math.abs(acorn.x - acorn0.x - 30 / sb.width) < 0.01 && Math.abs(acorn.y - acorn0.y + 20 / sb.height) < 0.01, `drag moves it (${acorn0.x.toFixed(3)},${acorn0.y.toFixed(3)} -> ${acorn.x.toFixed(3)},${acorn.y.toFixed(3)})`);
  await page.screenshot({ path: join(out, "av3-5-acorn-dragged.png") });

  // Save is not exempt from tap-off, so the acorn is deselected now: select it again by touching it
  await touch(page, [[[sb.x + acorn.x * sb.width, sb.y + acorn.y * sb.height]]]);
  check((await page.locator(tid("avatar-stage-delete")).count()) === 1, "Save deselected; a touch on the accessory selects it again");
  // pinch: spread and turn two fingers anywhere on the stage (fingers need not be on the accessory)
  const c = [sb.x + sb.width / 2, sb.y + sb.height / 2];
  await touch(page, lerp([[c[0] - 20, c[1]], [c[0] + 20, c[1]]], [[c[0] - 28, c[1] - 8], [c[0] + 28, c[1] + 8]], 8));
  saved = await saveNow(page);
  const pinched = saved.accessories.find((a) => a.id === "acorn");
  check(pinched.scale > acorn.scale * 1.2 && (pinched.rotation ?? 0) > 10, `pinch resizes and turns (scale ${acorn.scale} -> ${pinched.scale}, rotation ${pinched.rotation})`);
  await page.screenshot({ path: join(out, "av3-6-acorn-pinched.png") });

  // tap off (empty corner of the stage) deselects
  await touch(page, [[[sb.x + 6, sb.y + sb.height - 6]]]);
  check((await page.locator(tid("avatar-stage-delete")).count()) === 0, "tap off the accessory on the stage deselects");
  // tap an accessory on the stage selects it; a tap elsewhere on the page deselects
  await touch(page, [[[sb.x + pinched.x * sb.width, sb.y + pinched.y * sb.height]]]);
  check((await page.locator(tid("avatar-stage-delete")).count()) === 1, "tap on the accessory selects it");
  await page.locator(tid("avatar-tip")).tap();
  check((await page.locator(tid("avatar-stage-delete")).count()) === 0, "tap elsewhere on the page deselects");

  // undo walks back the pinch (Save was tapped since, but taps add no undo step)
  await page.locator(tid("avatar-undo")).tap();
  saved = await saveNow(page);
  check(Math.abs(saved.accessories.find((a) => a.id === "acorn").scale - acorn.scale) < 1e-4, "undo reverts the pinch");

  // fullscreen arrange view
  await page.locator(tid("avatar-fullscreen")).tap();
  await page.waitForSelector(tid("avatar-fs"));
  const title = await page.locator(tid("avatar-fs-title")).innerText();
  check(title === "Emmet", `fullscreen title is the bot name (${title})`);
  check(await page.locator(tid("avatar-fs-up")).isDisabled(), "buttons disabled with nothing selected");
  await page.locator(tid("avatar-fs-prev")).tap();
  for (const act of ["right", "right", "up", "rotr", "rotr", "bigger"]) await page.locator(tid(`avatar-fs-${act}`)).tap();
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(out, "av3-7-fullscreen.png") });
  const hint = await page.locator(tid("avatar-fs-hint")).innerText();
  check(/selected: drag, pinch, or use the buttons/.test(hint), `fullscreen hint: ${hint}`);
  // hold to repeat
  const r0 = await page.locator(tid("avatar-fs-right")).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r0.x + 20, y: r0.y + 20 }] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.locator(tid("avatar-fs-done")).tap();
  await page.waitForSelector(tid("avatar-designer"));
  saved = await saveNow(page);
  check(saved.accessories.some((a) => (a.rotation ?? 0) === 10), `fullscreen buttons turned an accessory 10° (${JSON.stringify(saved.accessories.map((a) => [a.id, a.x, a.rotation ?? 0]))})`);
  // stage pop: pressing and holding the big stage does not change its size
  await page.locator(tid("avatar-fullscreen")).tap();
  const s0 = await box(page, "avatar-stage-big");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: s0.x + 10, y: s0.y + 10 }] });
  await page.waitForTimeout(300);
  const s1 = await box(page, "avatar-stage-big");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  check(s0.width === s1.width && s0.x === s1.x && s0.y === s1.y, `holding the big stage does not move or scale it (${s0.width} / ${s1.width})`);
  // fullscreen with an accessory selected for the shot
  await page.locator(tid("avatar-fs-prev")).tap();
  await page.screenshot({ path: join(out, "av3-8-fullscreen-selected.png") });
  await page.locator(tid("avatar-fs-done")).tap();

  // shuffle (local, valid), then a coloured, turned look in dark for the shots
  for (let i = 0; i < 5; i++) await page.locator(tid("avatar-shuffle")).tap();
  saved = await saveNow(page);
  check(typeof saved.character === "string" && saved.v === 1 && saved.packVersion === 1, `shuffle gives a valid avatar.json (${saved.character}, ${saved.eyes}, ${saved.colour ?? "original"})`);
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

// ---- 3. a dressed avatar in dark, and the colour / eyes rows
{
  const look = { v: 1, packVersion: 1, character: "turtle", eyes: "happy", colour: "#C77BD6", accessories: [{ id: "top-hat", x: 0.5, y: 0.17, scale: 0.36, rotation: -12 }, { id: "bow-tie", x: 0.52, y: 0.62, scale: 0.22 }], revision: 3 };
  const { ctx, page, errors } = await open(chromium, { q: `&theme=dark&bot=Rexy&look=${encodeURIComponent(JSON.stringify(look))}` });
  await page.screenshot({ path: join(out, "av3-9-dressed-dark.png") });
  const saved = await saveNow(page);
  check(saved.character === "turtle" && saved.accessories[0].rotation === -12, "opens on a saved avatar.json and saves it back unchanged");
  await page.locator(tid("avatar-fullscreen")).tap();
  check((await page.locator(tid("avatar-fs-title")).innerText()) === "Rexy", "fullscreen title follows the bot name");
  await page.locator(tid("avatar-fs-prev")).tap();
  await page.screenshot({ path: join(out, "av3-10-fullscreen-dark.png") });
  check(errors.length === 0, `dark: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await chromium.close();

// ---- 4. WebKit (closest to iOS Safari here): renders, taps add / select
try {
  const webkit = await pw.webkit.launch();
  const { ctx, page, errors } = await open(webkit, { width: 393, height: 659 });
  await page.locator(tid("avatar-acc-acorn")).tap();
  await page.waitForTimeout(200);
  check((await page.locator(tid("avatar-stage-delete")).count()) === 1, "webkit: tapping an accessory tile adds and selects it");
  await page.screenshot({ path: join(out, "av3-11-webkit-393.png") });
  await page.locator(tid("avatar-fullscreen")).tap();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, "av3-12-webkit-fullscreen.png") });
  check(errors.length === 0, `webkit: no page errors ${errors.join(" | ")}`);
  await ctx.close();
  await webkit.close();
} catch (e) {
  check(false, `webkit run: ${e.message.split("\n")[0]}`);
}

writeFileSync(join(out, "av3-log.txt"), log.join("\n") + "\n");
console.log(`${failed ? failed + " FAILED" : "all ok"}; shots in ${out}`);
process.exit(failed ? 1 : 0);
