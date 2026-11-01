// Tarball licence notices (build/notices.mjs): node --test test/notices.test.mjs
// Fake stage under ./.test-tmp-notices (never /tmp; its own folder: unit.test.mjs removes ./.test-tmp when it ends, which broke this file in a run of every file together): one part per kind, then the failure cases.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp-notices");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(join(TMP, "notices"), { recursive: true, force: true }));

function pkg(stage, where, json, files = {}) {
  const dir = join(stage, where);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

function fakeStage() {
  mkdirSync(join(TMP, "notices"), { recursive: true });
  const stage = mkdtempSync(join(TMP, "notices", "s-"));
  for (const f of ["LICENSE", "NOTICE"]) writeFileSync(join(stage, f), `top ${f}`);
  for (const part of ["node", "daemon", "pi", "optchat", "bots"]) {
    mkdirSync(join(stage, part), { recursive: true });
    writeFileSync(join(stage, part, "LICENSE"), `${part} licence`);
  }
  writeFileSync(join(stage, "daemon", "NOTICE"), "DinoBot\nCopyright 2026 omcdowell\nmodified version of Paseo");
  writeFileSync(join(stage, "optchat", "THIRD_PARTY_NOTICES.md"), "Victor Taelin's OptChat recipe");
  pkg(stage, "daemon/node_modules/left-pad", { name: "left-pad", version: "1.0.0", license: "MIT" }, { LICENSE: "Copyright (c) left-pad author" });
  pkg(stage, "daemon/node_modules/@getpaseo/server", { name: "@getpaseo/server", version: "0.11.2" });
  pkg(stage, "daemon/node_modules/sherpa-onnx-linux-x64", { name: "sherpa-onnx-linux-x64", version: "1.0.0", license: "Apache-2.0" });
  pkg(stage, "pi/node_modules/@earendil-works/pi-mcp", { name: "@earendil-works/pi-mcp", version: "1.0.0", license: "MIT" }, { "LICENSES/mcp-sdk.txt": "Copyright (c) 2024 Anthropic, PBC (bundled MCP SDK)" });
  pkg(stage, "daemon/node_modules/dual", { name: "dual", version: "1.0.0", license: "(MPL-2.0 OR Apache-2.0)" });
  const licences = join(stage, "..", `${stage.split("/").pop()}-lic`);
  cpSync(join(HERE, "build", "licences"), licences, { recursive: true });
  writeFileSync(join(licences, "node-LICENSE"), "Node.js is licensed for use as follows");
  return { stage, licences };
}

const run = ({ stage, licences }) => spawnSync(process.execPath, [join(HERE, "build", "notices.mjs"), stage, licences], { encoding: "utf8" });

describe("build/notices.mjs", () => {
  it("writes THIRD_PARTY_NOTICES.txt with every part and package", () => {
    const s = fakeStage();
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(join(s.stage, "THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const want of [
      "modified version of Paseo", // daemon NOTICE
      "Victor Taelin's OptChat recipe", // pi-optchat credit
      "Node.js is licensed for use as follows",
      "Mario Zechner", // pi
      "herdr", // herdr NOTICE
      "LGPL", // libheif-js
      "ONNX Runtime", // native lib inside sherpa-onnx
      "Copyright (c) left-pad author",
      "Anthropic, PBC (bundled MCP SDK)", // LICENSES/ dir inside a package
      "--- @getpaseo/server@0.11.2  (Apache-2.0)", // KNOWN: no license field
      "--- dual@1.0.0  (Apache-2.0)", // dual licence resolved
    ])
      assert.ok(out.includes(want), `missing: ${want}`);
  });

  it("refuses a proprietary or unknown package", () => {
    const s = fakeStage();
    pkg(s.stage, "daemon/node_modules/@anthropic-ai/claude-agent-sdk", { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.246", license: "SEE LICENSE IN README.md" });
    pkg(s.stage, "pi/node_modules/mystery", { name: "mystery", version: "1.0.0" });
    const r = run(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /claude-agent-sdk@0\.3\.246/);
    assert.match(r.stderr, /mystery@1\.0\.0 UNKNOWN/);
  });

  it("accepts the Claude Agent SDK placeholder", () => {
    const s = fakeStage();
    pkg(s.stage, "daemon/node_modules/@anthropic-ai/claude-agent-sdk", { name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-dinobot-stub", license: "Apache-2.0" });
    assert.equal(run(s).status, 0);
  });

  it("refuses a part without its LICENSE file", () => {
    const s = fakeStage();
    mkdirSync(join(s.stage, "herdr"));
    const r = run(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /herdr\/LICENSE/);
  });
});
