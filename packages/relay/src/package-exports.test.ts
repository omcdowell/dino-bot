import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PACKAGE_ROOT = path.resolve(THIS_DIR, "..");

interface PackageManifest {
  exports: Record<string, Record<string, string>>;
}

function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(path.join(RELAY_PACKAGE_ROOT, "package.json"), "utf8"));
}

function listPublishedFiles(): Set<string> {
  if (!existsSync(path.join(RELAY_PACKAGE_ROOT, "dist/index.js"))) {
    execFileSync("npm", ["run", "build"], { cwd: RELAY_PACKAGE_ROOT, stdio: "inherit" });
  }
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: RELAY_PACKAGE_ROOT,
    encoding: "utf8",
  });
  // npm <= 11 prints an array of packs; npm 12 an object keyed by package name.
  const parsed = JSON.parse(output) as
    | Array<{ files: Array<{ path: string }> }>
    | Record<string, { files: Array<{ path: string }> }>;
  const [pack] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  return new Set(pack.files.map((file) => file.path));
}

function listExportTargets(manifest: PackageManifest): Array<{ label: string; file: string }> {
  const targets: Array<{ label: string; file: string }> = [];
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    for (const [condition, target] of Object.entries(conditions)) {
      targets.push({ label: `${subpath} [${condition}] -> ${target}`, file: target.slice(2) });
    }
  }
  return targets;
}

describe("published relay package", () => {
  it("ships every file its exports map resolves to, for every condition", () => {
    const published = listPublishedFiles();
    const missing = listExportTargets(readManifest())
      .filter((target) => !published.has(target.file))
      .map((target) => target.label);

    expect(missing).toEqual([]);
  });
});
