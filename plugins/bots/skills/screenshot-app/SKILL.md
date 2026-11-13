---
name: screenshot-app
description: Drive a headless browser (via Playwright) to screenshot the locally-running web app and inspect it yourself instead of asking the user. Use after a frontend/CSS/layout change to verify rendering, to see the running UI, to validate responsive/visual behavior, or whenever you'd otherwise round-trip to the user for a screenshot (e.g. over SSH).
compatibility: "Requires Node.js/npm (`npx`) and Playwright Chromium; first browser install may need network access and OS browser dependencies/sudo (`playwright install --with-deps`)."
---

# Screenshot the running app

Close the visual-verify loop yourself: drive a headless browser to screenshot the running app and Read the PNG back. Layout, CSS, container-query, and proportional-scaling bugs show up only visually — a green build won't catch them, and re-asking the user is slow (and impossible over SSH).

**Use Playwright.** It is the cross-platform way to do this: one API and one bundled browser that behave identically on macOS, Linux, Windows, and WSL. It handles the browser download, exact viewport sizing, zoom, interaction, and in-page measurement — sidestepping every platform-specific trap of launching a system browser yourself (window-size clamps, profile locks, unreachable debug ports). Reach for raw browser flags only if Playwright genuinely can't be installed (see Fallback).

**On WSL specifically: always use Playwright's bundled Linux Chromium — never drive the Windows `chrome.exe` over the WSL boundary.** The cross-boundary path gives unreachable CDP ports, viewport clamped to ~960px, and profile collisions. The bundled browser runs entirely inside the Linux filesystem and has none of these. Install it with deps so it actually launches:

```sh
npx -y playwright@latest install --with-deps chromium   # --with-deps pulls libasound2 etc.; skip it and you hit cryptic missing-.so errors
```

(No sudo? Run `npx playwright install-deps chromium` yourself or hand that one line to the user. The binary lives at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` — note `chrome-linux64`, not `chrome-linux`.) On WSL also launch with `chromium.launch({ args: ['--no-sandbox'] })`.

## 1. Serve the app

Start its dev/static server if needed (background it); note the port.

## 2. Install Playwright (once)

```sh
npx -y playwright@latest install --with-deps chromium   # downloads a known-good browser + system libs; no system browser required
```

If the browser still fails to launch complaining about missing system libraries, run `npx playwright install-deps chromium` (needs sudo) — or, if sudo isn't available to you, hand that one command to the user rather than retrying. (`ldd <browser-binary> | grep 'not found'` names the libs — e.g. `libasound.so.2` — if you'd rather install them individually.)

## 3. Capture

**Quick single shot** — the bundled CLI, no script needed:

```sh
npx playwright screenshot --viewport-size=1440,900 "http://localhost:PORT/" shot.png
```

**Scripted** — for size sweeps, interaction, or measurement:

```js
// Locate Playwright without making it a project dep: a prior `npx playwright`
// leaves a copy in the npx cache. Importing `'playwright'` by name fails from a
// standalone script, and the package is CommonJS — so resolve a path and grab
// the default export. (ESM ignores NODE_PATH and won't import the dir, only /index.js.)
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
function findPlaywright() {
  const local = join(process.cwd(), 'node_modules', 'playwright');
  if (existsSync(join(local, 'index.js'))) return local;
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx))
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, 'node_modules', 'playwright');
      if (existsSync(join(p, 'index.js'))) return p;
    }
  return null;                       // none cached → run `npx playwright install` first
}
const pw = await import(pathToFileURL(join(findPlaywright(), 'index.js')).href);
const chromium = pw.chromium ?? pw.default?.chromium;   // CJS default-export fallback

const browser = await chromium.launch({ args: ['--no-sandbox'] });  // --no-sandbox for WSL/CI
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('http://localhost:PORT/', { waitUntil: 'load' });   // NOT networkidle (see below)
await settle(page);                                                  // see §3a
await page.screenshot({ path: 'shot.png' });
await browser.close();
```

(If the app already vendors Playwright, `import { chromium } from 'playwright'` is fine — the locate dance is only for standalone scripts run outside the project.) Write the PNG where you can Read it; delete after. Then **Read it, inspect against intent, and iterate** until it's right.

## 3a. Wait correctly — `networkidle` is a trap on SPA/RN-web

**Don't use `waitUntil:'networkidle'` on a React/React-Native-web/animated app.** Those pages keep a socket or animation loop alive, so the page never goes idle and `goto` hangs until the 2-minute timeout (exit 143). Use `waitUntil:'load'` and then settle explicitly. Reserve `networkidle` for static/traditional sites.

A deterministic settle that fixes blank/half-painted/wrong-frame screenshots:

```js
async function settle(page, ms = 1000) {
  await page.evaluate(async () => {
    await document.fonts.ready;                          // webfonts loaded (else text reflows / mis-measures)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));  // 2 frames painted
  });
  await page.waitForTimeout(ms);                         // RN/reanimated transitions settle
}
```

Do a **fresh `page.goto` for each shot** rather than navigating within one page — leftover scroll/animation state from the previous capture contaminates the next.

**Fonts missing in headless** (emoji render as tofu boxes □, or text widths measure too narrow and truncate): the headless browser has no system fonts installed. Install the needed ones and rebuild the cache, then re-run:

```sh
mkdir -p ~/.local/share/fonts && cp YourFont.ttf NotoColorEmoji.ttf ~/.local/share/fonts/ && fc-cache -f
```

(Same root cause bites `mermaid-cli` and any other headless-Chromium renderer, not just this loop.)

## 4. Multi-size — and measure, don't eyeball

One fixed-size shot hides responsive/scaling bugs. After a layout/scaling change, sweep a few widths (e.g. 1920, 1366, 768) via `page.setViewportSize({ width, height })`; if the app has its own zoom/scale control, capture more than one level too (emulate page-zoom with a proportionally scaled viewport — 50% zoom ≈ 2× width/height). Playwright honors the exact viewport you set with no clamping, so a "1920" shot really is 1920.

To check a scaling invariant ("content-to-container ratio constant across sizes"), don't eyeball two PNGs your viewer rescaled to the same width — read the numbers in-page and compute the ratio in code:

```js
const m = await page.evaluate(() => {
  const el = document.querySelector('.thing');
  return { w: el.clientWidth, font: parseFloat(getComputedStyle(el).fontSize) };
});
```

## 5. Reaching JS-only states

To verify an interaction-reached state (toggled mode, open menu, grid/overview view):
- **Script the interaction** — `await page.keyboard.press('Control+-')`, `await page.click(sel)`, `await page.hover(sel)`, then screenshot. This is Playwright's core strength over flag-only capture.
- **Or** add a URL-addressable trigger — a hash/query param that enters the state on load (e.g. `#grid`). Doubles as a shareable deep-link and works with the quick CLI shot too. This also bypasses gates: a fresh browser has empty storage, so auth/onboarding-gated routes redirect — a `?demo=1`-style param that renders the signed-in state on load is more reliable than scripting a login.

**Deep-linking by hash alone is a same-document change** — `page.goto('…/#42')` won't re-navigate or scroll on first paint, and `scroll-snap` CSS fights `scrollIntoView`. Force a real load with a cache-busting query alongside the hash (`?s=42#42`), and after `settle()` re-assert the target on a `requestAnimationFrame` if the first attempt lands short.

## Fallback: system browser, no Playwright

Only if Playwright truly can't be installed, drive a system headless browser directly:

```sh
"$BROWSER" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --user-data-dir="$PROFILE" --window-size=1440,900 --virtual-time-budget=4000 \
  --screenshot="$OUT" "http://localhost:PORT/"
```

Probe for `$BROWSER` rather than assuming a path: `chromium` / `chromium-browser` / `google-chrome(-stable)` on `PATH`, macOS bundles under `/Applications/.../Contents/MacOS/`, or the Windows `.exe` under `/mnt/c/Program Files*/...` when on WSL (write `--screenshot` to a Windows path, Read back via `/mnt/c/...`). Caveats this fallback carries — all of which Playwright removes: pass a dedicated `--user-data-dir` (else it silently attaches to a running browser and writes nothing); `--screenshot` runs no JS, so use a URL trigger for JS-only states; and `--window-size` may be clamped to the display work area (notably the Windows browser invoked from WSL caps ~960px wide), so verify the page's real `innerWidth` before trusting a wide shot.
