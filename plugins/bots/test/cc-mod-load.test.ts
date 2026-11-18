// Claude Code refuses to load a hooks module that assigns to (or redeclares) the name of a function it hands `$`
// ("the function handed $ "run" is assigned to elsewhere"): the whole mod is then off, so a Claude Code bot's inbox
// gets no ack and nothing is delivered. Live on 18 Nov: the inbox mod's turn.step hook had a local `let run`.
//   npx tsx --test test/cc-mod-load.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const MODS = join(import.meta.dirname, "..", "claude-code");

/** Names of top-level functions that take `$` first, and every place a mod assigns or declares those names again. */
export function reusedDollarFunctions(source: string): string[] {
  const names = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(\s*\$\s*[,)]/gm)].map((m) => m[1]);
  const out: string[] = [];
  for (const name of names) {
    const esc = name.replace(/\$/g, "\\$");
    const declared = new RegExp(`\\b(?:let|const|var)\\s+${esc}\\b|\\(\\s*${esc}\\s*\\)\\s*=>|\\bfunction\\s*\\*?\\s*${esc}\\s*\\(`, "g");
    const assigned = new RegExp(`(?<![\\w$.])${esc}\\s*=(?!=|>)`, "g");
    const declarations = source.match(declared)?.length ?? 0;
    if (declarations > 1) out.push(`${name}: declared again`);
    if (assigned.test(source)) out.push(`${name}: assigned`);
  }
  return out;
}

describe("Claude Code mods load", () => {
  for (const mod of ["inbox", "trigger", "view"]) {
    it(`${mod}: no function handed $ is assigned or declared again`, () => {
      const source = readFileSync(join(MODS, mod, "hooks", "register.js"), "utf8");
      assert.deepEqual(reusedDollarFunctions(source), []);
    });
  }

  it("catches the 18 Nov inbox mod (a local `let run` next to function run($, job))", () => {
    const bad = "async function run($, job) {}\non('turn.step', async function* ($, e, next) {\n  let run = {}\n  run = 1\n})\n";
    assert.deepEqual(reusedDollarFunctions(bad), ["run: declared again", "run: assigned"]);
    assert.deepEqual(reusedDollarFunctions("async function run($, job) {}\nlet want = {}\nwant = 1\n"), []);
  });
});
