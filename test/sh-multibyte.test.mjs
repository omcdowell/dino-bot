// macOS /bin/sh (bash 3.2) in a UTF-8 locale reads the first byte of a multibyte character right after `$name` as part
// of the name: `"$_bar━"` died with "_bar\xe2: unbound variable" under `set -u` (the owner's Mac, v0.1.11 install.sh, the
// download bar). Every shipped shell script must brace such names: `"${_bar}━"`.
//   node --test test/sh-multibyte.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const HERE = join(import.meta.dirname, "..");

/** `$name` directly followed by a byte >= 0x80 (the start of a multibyte character). */
export const UNBRACED_BEFORE_MULTIBYTE = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u;

/** Tracked shell scripts: *.sh/*.bash, and files whose first line is a sh/bash shebang (not docs/perf, not deps). */
function shellScripts() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: HERE, encoding: "utf8" }).split("\0").filter(Boolean);
  return files.filter((f) => {
    if (/(^|\/)(node_modules|docs\/perf)\//.test(f)) return false;
    if (/\.(sh|bash)$/.test(f)) return true;
    try {
      const head = readFileSync(join(HERE, f)).subarray(0, 64).toString("latin1");
      return /^#!.*\b(ba)?sh\b/.test(head);
    } catch {
      return false;
    }
  });
}

describe("shell scripts: no $name right before a multibyte character (bash 3.2)", () => {
  it("the pattern catches the v0.1.11 bug and passes the fix", () => {
    assert.match('_bar="$_bar━"', UNBRACED_BEFORE_MULTIBYTE);
    assert.doesNotMatch('_bar="${_bar}━"', UNBRACED_BEFORE_MULTIBYTE);
    assert.doesNotMatch('echo "$a b ━"', UNBRACED_BEFORE_MULTIBYTE);
  });

  it("install.sh and every other tracked shell script are clean", () => {
    const scripts = shellScripts();
    assert.ok(scripts.includes("install.sh"), "install.sh is checked");
    const hits = [];
    for (const f of scripts) {
      readFileSync(join(HERE, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (UNBRACED_BEFORE_MULTIBYTE.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(hits, []);
  });
});
