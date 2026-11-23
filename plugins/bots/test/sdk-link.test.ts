// One plugin SDK version: the bots plugin and the push add-on typecheck and test against the Paseo packages in this
// repo, never a separately installed npm copy (three bugs on 18–19 Nov came from an older copy's types and schema).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO = join(__dirname, "..", "..", "..");

for (const dir of ["plugins/bots", "addons/paseo-apns"]) {
  test(`${dir}: every @getpaseo/* dependency links the in-tree package`, () => {
    const pkg = JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8"));
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const sdk = Object.entries(deps).filter(([name]) => name.startsWith("@getpaseo/"));
    assert.ok(sdk.length > 0, "no @getpaseo/* dependency");
    for (const [name, spec] of sdk) {
      assert.equal(spec, `file:../../paseo/packages/${name.slice("@getpaseo/".length)}`, name);
    }
  });
}
