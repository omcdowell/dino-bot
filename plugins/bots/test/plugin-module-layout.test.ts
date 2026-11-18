/**
 * Paseo's plugin compiler (paseo/packages/server/src/server/plugins/compiler.ts) refuses a plugin module outside
 * client/, server/ or shared/ ("Plugin modules belong in client/, server/, or shared/"), and then the whole bots
 * plugin fails to load at daemon start. tsx runs such imports fine, so the rest of this suite cannot see it: on
 * 18 Nov server/cc/history-reload.ts imported ../../bot-dm/paseo and every Claude Code bot went down on the restart.
 * This walks the server entry's relative imports and fails on any module outside those folders.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["client", "server", "shared"];

function resolveModule(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const path of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(path) && path.match(/\.tsx?$/)) return path;
  }
  return null;
}

function relativeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specs = [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]!);
  return specs.map((spec) => resolveModule(file, spec)).filter((p): p is string => p !== null);
}

test("the server bundle's modules are all in client/, server/ or shared/ (Paseo's plugin compiler rule)", () => {
  const entry = join(ROOT, "index.server.ts");
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const outside: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    for (const dep of relativeImports(file)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const top = relative(ROOT, dep).split("/")[0]!;
      if (!ALLOWED.includes(top)) outside.push(`${relative(ROOT, file)} -> ${relative(ROOT, dep)}`);
      queue.push(dep);
    }
  }
  assert.ok(seen.size > 20, `walked only ${seen.size} modules`);
  assert.deepEqual(outside, []);
});
