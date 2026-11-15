// GitHub release notes: build/release-notes.sh prints a tag's short notes (release-notes/<tag>.md)
// plus a link to the full CHANGELOG.md, and fails when the file is missing or blank, so
// release.yml stops before building or publishing.
//   node --test test/release-notes.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "build", "release-notes.sh");
const TMP = join(ROOT, ".test-tmp-notes");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

const run = (tag, dir, repo = "o/r") =>
  spawnSync("sh", [SCRIPT, tag, repo], { encoding: "utf8", env: { ...process.env, ...(dir ? { RELEASE_NOTES_DIR: dir } : {}) } });
const notesDir = (files) => {
  const d = mkdtempSync(join(TMP, "t-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
};

describe("build/release-notes.sh", () => {
  it("prints the tag's notes without blank edges, then the full-changelog link at that tag", () => {
    const d = notesDir({ "v0.1.10.md": "\n### New\n- ten\n\n", "v0.1.1.md": "### Fixed\n- one\n" });
    assert.equal(run("v0.1.10", d).stdout, "### New\n- ten\n\nFull changelog: https://github.com/o/r/blob/v0.1.10/CHANGELOG.md\n");
    assert.equal(run("v0.1.1", d).stdout, "### Fixed\n- one\n\nFull changelog: https://github.com/o/r/blob/v0.1.1/CHANGELOG.md\n");
  });

  it("fails (exit 1, a message, no output) when the notes are missing or blank, or the tag is odd", () => {
    const d = notesDir({ "v0.2.0.md": " \n\n", "v0.1.1.md": "- one\n" });
    for (const tag of ["v0.1.2", "v0.2.0", "0.1.1", "../v0.1.1"]) {
      const r = run(tag, d);
      assert.equal(r.status, 1, tag);
      assert.equal(r.stdout, "", tag);
      assert.match(r.stderr, /release-notes/, tag);
    }
  });

  it("every v* tag and every notes file of this repo works, each short (at most 12 lines)", () => {
    const files = readdirSync(join(ROOT, "release-notes")).filter((f) => /^v\d.*\.md$/.test(f)).map((f) => f.slice(0, -3));
    assert.ok(files.length > 0);
    let tags = [];
    try {
      tags = execFileSync("git", ["-C", ROOT, "tag", "-l", "v[0-9]*"], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {}
    for (const v of new Set([...files, ...tags])) {
      const r = run(v);
      assert.equal(r.status, 0, `${v}: ${r.stderr}`);
      assert.ok(r.stdout.split("\n").length - 3 <= 12, `${v} notes are long`);
    }
  });
});
