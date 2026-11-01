// Find a Playwright install for the avatar build/parity scripts (build-time only, not a dependency).
// Order: PLAYWRIGHT_PATH, a local `playwright` package, then any copy in the npx cache whose browser exists.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [];
  if (process.env.PLAYWRIGHT_PATH) tries.push(process.env.PLAYWRIGHT_PATH);
  tries.push("playwright");
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) tries.push(join(npx, d, "node_modules", "playwright"));
  for (const p of tries) {
    try {
      const pw = req(p);
      if (existsSync(pw.chromium.executablePath())) return pw;
    } catch {}
  }
  throw new Error("Playwright with an installed Chromium not found (set PLAYWRIGHT_PATH)");
}
