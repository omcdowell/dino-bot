// Cross-process lock test (was research scratch/wp3/p3-crosslock.mts). bot-dm runs as its own Node
// process; the plugin's dms.reply runs inside the Paseo daemon. Both use server/ledger-write.ts, and
// this checks that the lock on `dm/.lock` really serialises two processes, not just two callers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLedgerLine, type DmMessage } from "../shared/dm-schema";
import { appendLedgerRecord } from "../server/ledger-write";

const WRITER = join(__dirname, "../server/ledger-write.ts");
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const id = (prefix: string, i: number) => `01K6ZQ5V8M000000000000${prefix}${ALPHA[Math.floor(i / 32)]}${ALPHA[i % 32]}`;

function record(msgId: string, origin: string): DmMessage {
  return {
    v: 1, type: "message", id: msgId, ts: new Date().toISOString(), from: "tmp-fc", to: "tmp-beta",
    kind: "info", thread: msgId, re: null, hop: 1, subject: "", body: "x".repeat(3000), attachments: [],
    expects_reply: false, from_agent_id: null, to_agent_id: null, origin,
  };
}

/** Run a script in a separate Node process (type stripping, as bot-dm runs). Resolves on exit. */
function child(dir: string, source: string, onStdout?: (line: string) => void): Promise<void> {
  const file = join(dir, `child-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(file, `import { appendRecord, withLocks } from ${JSON.stringify(WRITER)};\n${source}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", file], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    proc.stdout.on("data", (chunk) => String(chunk).split("\n").filter(Boolean).forEach((l) => onStdout?.(l)));
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}`))));
  });
}

test("the plugin's append waits while a bot-dm process holds the dm lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "xlock-"));
  const dir = join(root, "dm");
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = child(
    root,
    `await withLocks([${JSON.stringify(dir)}], async () => { console.log("locked"); await new Promise((r) => setTimeout(r, 700)); });`,
    (line) => line === "locked" && locked(),
  );
  await isLocked;
  const started = Date.now();
  await appendLedgerRecord(dir, "inbox", record(id("PA", 0), "paseo-bots/dms-1"));
  const waited = Date.now() - started;
  await holder;
  assert.ok(waited >= 400, `append waited only ${waited} ms`);
});

test("bot-dm processes and plugin appends interleave without torn or lost lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "xlock-"));
  const dir = join(root, "dm");
  const rec = record.toString();
  const children = [0, 1].map((c) =>
    child(
      root,
      `const record = ${rec};\nconst ALPHA = ${JSON.stringify(ALPHA)};\n` +
        `const id = ${id.toString()};\n` +
        `for (let i = 0; i < 10; i++) await withLocks([${JSON.stringify(dir)}], () => appendRecord(${JSON.stringify(dir)}, "inbox", record(id("B${c}", i), "bot-dm/1")));`,
    ),
  );
  const plugin = Array.from({ length: 20 }, (_, i) => appendLedgerRecord(dir, "inbox", record(id("PA", i), "paseo-bots/dms-1")));
  await Promise.all([...children, ...plugin]);
  const lines = readFileSync(join(dir, "inbox.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 40);
  assert.ok(lines.every((l) => parseLedgerLine(l).ok));
  assert.equal(new Set(lines.map((l) => JSON.parse(l).id)).size, 40);
});
