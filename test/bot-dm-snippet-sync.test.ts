import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(__dirname, "..", "bin", "bot-dm-snippet-sync");
const SNIPPET = readFileSync(join(__dirname, "..", "docs", "bot-dm-agents-snippet.md"), "utf8").trimEnd();
const BLOCK = `<!-- bot-dm:begin v1 -->\n${SNIPPET}\n<!-- bot-dm:end -->\n`;

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function profiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "snippet-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "AGENTS.md"), text, { mode: 0o640 });
  }
  mkdirSync(join(dir, "no-agents"));
  return dir;
}

test("appends the block once, keeps the rest byte for byte, and is idempotent", () => {
  const dir = profiles({ a: "# A\n\nfacts\n", b: "# B\nno final newline." });
  assert.equal(run("--profiles", dir).out, "a: appended\nb: appended\n");
  assert.equal(readFileSync(join(dir, "a", "AGENTS.md"), "utf8"), `# A\n\nfacts\n\n${BLOCK}`);
  assert.equal(readFileSync(join(dir, "b", "AGENTS.md"), "utf8"), `# B\nno final newline.\n\n${BLOCK}`);
  assert.equal(statSync(join(dir, "a", "AGENTS.md")).mode & 0o777, 0o640);
  assert.equal(run("--profiles", dir).out, "a: unchanged\nb: unchanged\n");
});

test("replaces an older block in place, leaving text after it alone", () => {
  const dir = profiles({ a: "# A\n<!-- bot-dm:begin v0 -->\nold text\n<!-- bot-dm:end -->\n## Later\nkept\n" });
  assert.equal(run("--profiles", dir, "a").out, "a: replaced\n");
  assert.equal(readFileSync(join(dir, "a", "AGENTS.md"), "utf8"), `# A\n${BLOCK}## Later\nkept\n`);
});

test("--dry-run writes nothing; an unknown profile fails", () => {
  const dir = profiles({ a: "# A\n" });
  assert.equal(run("--profiles", dir, "--dry-run").out, "a: appended (dry run)\n");
  assert.equal(readFileSync(join(dir, "a", "AGENTS.md"), "utf8"), "# A\n");
  assert.equal(run("--profiles", dir, "nobody").code, 1);
});

test("the snippet says what the rollout brief requires and not the overrides", () => {
  assert.match(SNIPPET, /^## Bot-to-bot DMs\n/);
  for (const needle of ["never use `paseo send`", "--re <id>", "escalation bot", "6 hops", "never the user's approval", "bot-dm user --text", "--from worker:<name> --kind report", "bot-worker add <name>", "in your own shell, not in the worker's pane"]) {
    assert.ok(SNIPPET.toLowerCase().includes(needle.toLowerCase()), needle);
  }
  assert.doesNotMatch(SNIPPET, /BOT_DM_/);
});
