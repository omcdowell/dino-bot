// The public repo must carry no friend-test page and no real Tailscale address (and none of this
// computer's own details): build/public-check.mjs over this repo's own tree, and its rules.
//   node --test test/public-tree.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkTree, realTailnetIp } from "../build/public-check.mjs";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".test-tmp-public");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const none = { needles: [], patterns: [], allow: [] };
// Built from parts, so this file does not trip its own check.
const REAL = ["100", "88", "1", "2"].join(".");

describe("public tree", () => {
  it("this repo has no FRIEND-SETUP.md, no real Tailscale address, none of this computer's details", () => {
    const files = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n");
    assert.ok(!files.some((f) => /(^|\/)friend-setup\.md$/i.test(f)), "FRIEND-SETUP.md is tracked");
    const problems = checkTree(ROOT);
    assert.deepEqual(problems.map((p) => `${p.file}:${p.line} ${p.why}`), []);
  });

  it("flags a friend page anywhere and a 100.x tailnet address; allows the test blocks", () => {
    const d = mkdtempSync(join(TMP, "t-"));
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs", "FRIEND-SETUP.md"), "hi\n");
    writeFileSync(join(d, "a.md"), `listen ${REAL}:6767\nfixture 100.64.0.7 and 100.127.255.254\n`);
    writeFileSync(join(d, "b.txt"), "range 100.64.0.0/10, docs 100.101.102.103, not tailnet 100.20.1.1 or 10.100.1.1\n");
    const got = checkTree(d, none).map((p) => `${p.file}:${p.line} ${p.why}`).sort();
    assert.deepEqual(got, [`a.md:1 Tailscale address ${REAL}`, "docs/FRIEND-SETUP.md:0 friend-test page"]);
  });

  it("flags this computer's details and private patterns without echoing them; honours the allow list", () => {
    const d = mkdtempSync(join(TMP, "t-"));
    writeFileSync(join(d, "x.sh"), "ssh box-one.example\ncd /home/someone/code\nminimal box-onex\n");
    const needles = [
      { kind: "this tailnet's host name", re: /(?<![\w-])box-one(?![\w-])/i },
      { kind: "this computer's home folder", re: /\/home\/someone/i },
    ];
    const patterns = [{ n: 3, re: /minimal/i }];
    const got = checkTree(d, { needles, patterns, allow: [] }).map((p) => `${p.line} ${p.why}`);
    assert.deepEqual(got, ["1 this tailnet's host name", "2 this computer's home folder", "3 private pattern (line 3 of the patterns file)"]);
    assert.equal(checkTree(d, { needles, patterns, allow: [{ file: /^x\.sh$/, why: "private pattern" }] }).length, 2);
  });

  it("realTailnetIp: CGNAT only, minus the documentation/test blocks", () => {
    assert.equal(realTailnetIp(88, 1, 2), true);
    assert.equal(realTailnetIp(64, 1, 0), true);
    assert.equal(realTailnetIp(64, 0, 7), false);
    assert.equal(realTailnetIp(127, 255, 1), false);
    assert.equal(realTailnetIp(101, 102, 103), false);
    assert.equal(realTailnetIp(63, 1, 1), false);
    assert.equal(realTailnetIp(128, 1, 1), false);
  });
});
