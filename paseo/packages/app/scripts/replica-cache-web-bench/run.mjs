// IndexedDB chat cache bench in Electron (the desktop app's storage engine).
// Usage (Mac): node packages/app/scripts/replica-cache-web-bench/run.mjs [MB=500] [runs=3]
// Fills a fresh profile to MB, then measures cold starts in new Electron processes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const targetMb = Number(process.argv[2] ?? 500);
const runs = Number(process.argv[3] ?? 3);
const esbuild = require("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "entry.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(here, "dist/entry.js"),
  logLevel: "warning",
});
const electron = require(
  require.resolve("electron", { paths: [path.join(here, "../../../desktop")] }),
);
const userData = mkdtempSync(path.join(tmpdir(), "paseo-idb-bench-"));
const phase = (name, arg = "0") => {
  const out = execFileSync(electron, [path.join(here, "main.cjs"), name, arg], {
    env: { ...process.env, BENCH_USER_DATA: userData },
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  const line = out.split("\n").find((entry) => entry.startsWith("BENCH"));
  if (!line?.startsWith("BENCH ")) throw new Error(line ?? out);
  const result = JSON.parse(line.slice(6));
  console.log(JSON.stringify(result));
  return result;
};
try {
  phase("fill", String(targetMb));
  for (let run = 0; run < runs; run += 1) phase("measure");
} finally {
  rmSync(userData, { recursive: true, force: true });
}
