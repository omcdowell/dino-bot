// build/prune-stage.mjs: what goes from a release stage's node_modules, and what must stay.
//   node --test test/prune.test.mjs   (temp dirs under ./.test-tmp-prune, never /tmp)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp-prune");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

function put(root, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), typeof body === "string" ? body : JSON.stringify(body));
  }
}

describe("build/prune-stage.mjs", () => {
  const stage = mkdtempSync(join(TMP, "s-"));
  put(stage, {
    // A top-level package: never touched (only node_modules trees are pruned).
    "pi/README.md": "pi docs, read by pi",
    "pi/dist/index.js": "",
    "pi/dist/index.js.map": "{}",
    "pi/dist/index.d.ts": "",
    // A dependency: maps, types, docs and an unreferenced src/test go; licences and code stay.
    "pi/node_modules/dep/package.json": { name: "dep", main: "dist/index.js" },
    "pi/node_modules/dep/dist/index.js": "module.exports = 1;",
    "pi/node_modules/dep/dist/index.js.map": "{}",
    "pi/node_modules/dep/dist/index.d.ts": "",
    "pi/node_modules/dep/dist/index.d.mts": "",
    "pi/node_modules/dep/README.md": "",
    "pi/node_modules/dep/CHANGELOG.md": "",
    "pi/node_modules/dep/LICENSE.md": "MIT",
    "pi/node_modules/dep/src/index.ts": "",
    "pi/node_modules/dep/test/a.js": "",
    // src named by package.json: stays.
    "daemon/node_modules/@s/entry/package.json": { name: "@s/entry", exports: { ".": "./src/index.js" } },
    "daemon/node_modules/@s/entry/src/index.js": "",
    // src imported from code outside it (JS or TS): stays.
    "daemon/node_modules/imp/package.json": { name: "imp", main: "index.js" },
    "daemon/node_modules/imp/index.js": "module.exports = require('./src/x.js');",
    "daemon/node_modules/imp/src/x.js": "",
    "pi-packages/node_modules/ext/package.json": { name: "ext", pi: { extensions: ["./index.ts"] } },
    "pi-packages/node_modules/ext/index.ts": "import { a } from './src/a.ts';",
    "pi-packages/node_modules/ext/src/a.ts": "",
    "pi-packages/node_modules/ext/skills/web/SKILL.md": "a pi skill",
    "pi-packages/node_modules/ext/skills/web/README.md": "kept: under skills/",
    // typescript and npm/node-gyp: kept whole.
    "daemon/node_modules/typescript/package.json": { name: "typescript", main: "lib/typescript.js" },
    "daemon/node_modules/typescript/lib/lib.es5.d.ts": "",
    "node/lib/node_modules/npm/package.json": { name: "npm" },
    "node/lib/node_modules/npm/node_modules/node-gyp/package.json": { name: "node-gyp" },
    "node/lib/node_modules/npm/node_modules/node-gyp/src/win_delay_load_hook.cc": "",
    // nested node_modules are pruned too.
    "daemon/node_modules/imp/node_modules/deep/package.json": { name: "deep" },
    "daemon/node_modules/imp/node_modules/deep/index.js.map": "{}",
  });

  it("--dry-run changes nothing", () => {
    const r = spawnSync(process.execPath, [join(HERE, "build", "prune-stage.mjs"), stage, "--dry-run"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would remove pi\/node_modules\/dep\/src/);
    assert.ok(existsSync(join(stage, "pi/node_modules/dep/src/index.ts")));
  });

  it("prunes what never runs, keeps licences, entry points, imports, skills and the compiler's data", () => {
    const r = spawnSync(process.execPath, [join(HERE, "build", "prune-stage.mjs"), stage], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^pruned \d+ files \+ 2 folders/);
    const gone = [
      "pi/node_modules/dep/dist/index.js.map", "pi/node_modules/dep/dist/index.d.ts", "pi/node_modules/dep/dist/index.d.mts",
      "pi/node_modules/dep/README.md", "pi/node_modules/dep/CHANGELOG.md", "pi/node_modules/dep/src", "pi/node_modules/dep/test",
      "daemon/node_modules/imp/node_modules/deep/index.js.map",
    ];
    const kept = [
      "pi/README.md", "pi/dist/index.js.map", "pi/dist/index.d.ts",
      "pi/node_modules/dep/dist/index.js", "pi/node_modules/dep/LICENSE.md",
      "daemon/node_modules/@s/entry/src/index.js", "daemon/node_modules/imp/src/x.js",
      "pi-packages/node_modules/ext/src/a.ts", "pi-packages/node_modules/ext/skills/web/SKILL.md", "pi-packages/node_modules/ext/skills/web/README.md",
      "daemon/node_modules/typescript/lib/lib.es5.d.ts", "node/lib/node_modules/npm/node_modules/node-gyp/src/win_delay_load_hook.cc",
    ];
    for (const p of gone) assert.ok(!existsSync(join(stage, p)), `should be gone: ${p}`);
    for (const p of kept) assert.ok(existsSync(join(stage, p)), `should stay: ${p}`);
  });
});
