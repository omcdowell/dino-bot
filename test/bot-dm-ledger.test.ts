import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DM_ROTATE_BYTES, parseLedgerLine, type DmStatus } from "../shared/dm-schema.ts";
import { appendRecord, findMessage, ledgerFiles, ledgerPath, readRecords, withLocks } from "../server/ledger-write.ts";

const status = (n: number): DmStatus => ({
  v: 1,
  type: "status",
  id: `01K6ZQ5V8M${String(n).padStart(16, "0")}`,
  ts: "2026-10-08T05:00:00.000Z",
  status: "queued",
  detail: null,
});

test("dm dir is 0700, ledger files 0600, one record per line", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "dm-")), "bot", "dm");
  await withLocks([dir], () => {
    appendRecord(dir, "outbox", status(1));
    appendRecord(dir, "outbox", status(2));
  });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(ledgerPath(dir, "outbox")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, ".lock")).mode & 0o777, 0o600);
  assert.deepEqual(readRecords(ledgerPath(dir, "outbox")).map((r) => r.id), [status(1).id, status(2).id]);
});

test("a torn last line from a crashed writer does not swallow the next record", () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  writeFileSync(ledgerPath(dir, "inbox"), '{"v":1,"type":"stat');
  appendRecord(dir, "inbox", status(3));
  const lines = readFileSync(ledgerPath(dir, "inbox"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(parseLedgerLine(lines[1]).ok);
});

test("rotation: past 5 MB the file moves to <name>-YYYY-MM.jsonl, then .2, and lookups still find old records", () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  const now = new Date("2026-10-08T05:00:00Z");
  appendRecord(dir, "outbox", status(1), now);
  truncateSync(ledgerPath(dir, "outbox"), DM_ROTATE_BYTES); // pad with NULs past the limit
  appendRecord(dir, "outbox", status(2), now);
  assert.ok(existsSync(join(dir, "outbox-2026-10.jsonl")));
  assert.deepEqual(readRecords(ledgerPath(dir, "outbox")).map((r) => r.id), [status(2).id]);
  truncateSync(ledgerPath(dir, "outbox"), DM_ROTATE_BYTES);
  appendRecord(dir, "outbox", status(3), now);
  assert.ok(existsSync(join(dir, "outbox-2026-10.2.jsonl")));
  assert.deepEqual(
    ledgerFiles(dir, "outbox").map((p) => p.split("/").pop()),
    ["outbox.jsonl", "outbox-2026-10.2.jsonl", "outbox-2026-10.jsonl"],
  );
});

test("findMessage looks in inbox and outbox, including rotated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  const fixture = readFileSync(join(__dirname, "fixtures/dm/bitzer/dm/inbox.jsonl"), "utf8").split("\n")[0];
  appendFileSync(join(dir, "inbox-2026-09.jsonl"), `${fixture}\n`);
  assert.equal(findMessage(dir, "01K6ZQ5V8M0000000000000001")?.kind, "request");
  assert.equal(findMessage(dir, "01K6ZQ5V8M0000000000000002"), null);
});

test("concurrent writers under flock never interleave or lose lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  const writers = 6;
  const each = 40;
  const script = `
    import { appendRecord, withLocks } from ${JSON.stringify(join(__dirname, "../server/ledger-write.ts"))};
    const [dir, w, n] = process.argv.slice(2);
    const body = "x".repeat(3000);
    for (let i = 0; i < Number(n); i++) {
      await withLocks([dir], () => appendRecord(dir, "inbox", {
        v: 1, type: "message", id: "01K6ZQ5V8M" + String(Number(w) * 1000 + i).padStart(16, "0"),
        ts: new Date().toISOString(), from: "worker:w" + w, to: "bitzer", kind: "report",
        thread: "01K6ZQ5V8M" + String(Number(w) * 1000 + i).padStart(16, "0"), re: null, hop: 1,
        subject: "s", body, attachments: [], expects_reply: false, from_agent_id: null,
        to_agent_id: null, origin: "test" }));
    }`;
  const file = join(dir, "writer.mts");
  writeFileSync(file, script);
  await Promise.all(
    Array.from({ length: writers }, (_, w) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", file, join(dir, "dm"), String(w), String(each)], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exit ${code}`))));
      }),
    ),
  );
  const lines = readFileSync(ledgerPath(join(dir, "dm"), "inbox"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, writers * each);
  assert.ok(lines.every((l) => parseLedgerLine(l).ok));
  assert.equal(new Set(lines.map((l) => JSON.parse(l).id)).size, writers * each);
  assert.deepEqual(readdirSync(join(dir, "dm")).sort(), [".lock", "inbox.jsonl"]);
});

test("withLocks serialises holders and releases on throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  const order: string[] = [];
  const a = withLocks([dir], async () => {
    order.push("a-in");
    await new Promise((r) => setTimeout(r, 150));
    order.push("a-out");
  });
  await new Promise((r) => setTimeout(r, 30));
  const b = withLocks([dir], () => order.push("b"));
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-in", "a-out", "b"]);
  await assert.rejects(withLocks([dir], () => { throw new Error("boom"); }), /boom/);
  await withLocks([dir, dir], () => order.push("again")); // duplicate dirs are fine
  assert.equal(order.at(-1), "again");
});

// macOS has no util-linux `flock`: there the lock is taken with perl's flock(2) (perl ships with
// macOS). It must exclude flock(1) holders on Linux-style writers too, so both take flock(2).
test("withLocks on macOS (no flock command) takes the same flock(2) lock, via perl", { skip: !existsSync("/usr/bin/flock") }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dm-"));
  const lock = join(dir, ".lock");
  // A PATH like a Mac's: sh and perl, no flock.
  const bin = mkdtempSync(join(tmpdir(), "macbin-"));
  for (const tool of ["sh", "perl"]) symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim(), join(bin, tool));
  const savedPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = savedPath; });
  const tryFlock = () =>
    new Promise<number | null>((resolve) => {
      spawn("/usr/bin/flock", ["-n", lock, "/bin/true"]).on("exit", resolve);
    });
  const order: string[] = [];
  const a = withLocks(
    [dir],
    async () => {
      order.push("a-in");
      order.push(`flock-while-held:${await tryFlock()}`);
      await new Promise((r) => setTimeout(r, 150));
      order.push("a-out");
    },
    10,
    "darwin",
  );
  await new Promise((r) => setTimeout(r, 60));
  const b = withLocks([dir, dir], () => order.push("b"), 10, "darwin");
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-in", "flock-while-held:1", "a-out", "b"]);
  assert.equal(await tryFlock(), 0);
  await assert.rejects(withLocks([dir], () => { throw new Error("boom"); }, 10, "darwin"), /boom/);
  assert.equal(await tryFlock(), 0);
});
