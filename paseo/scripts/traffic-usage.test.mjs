import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkCutList, parseCutList } from "./traffic-check.mjs";
import { parseSince, readWindows, summarise } from "./traffic-usage.mjs";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function win(from, to, counts, final = false) {
  return {
    v: 1,
    from,
    to,
    final,
    in: {},
    inSession: {},
    out: {},
    outSession: {},
    outStream: {},
    outBinary: {},
    ...counts,
  };
}

function home(files) {
  const d = mkdtempSync(path.join(tmpdir(), "traffic-usage-"));
  dirs.push(d);
  mkdirSync(path.join(d, "runtime-metrics"));
  for (const [name, windows] of Object.entries(files)) {
    writeFileSync(
      path.join(d, "runtime-metrics", name),
      windows.map((w) => (typeof w === "string" ? w : JSON.stringify(w))).join("\n") + "\n",
    );
  }
  return d;
}

const H = (h) => `2026-11-20T${String(h).padStart(2, "0")}:00:00.000Z`;
const FIXTURE = {
  "traffic.1.jsonl": [win(H(0), H(1), { inSession: { old_request: 3 } })],
  "traffic.jsonl": [
    win(H(1), H(2), { in: { ping: 5, session: 2 }, inSession: { fetch_agents_request: 2 } }),
    '{"v":1,"from":"cut short',
    win(H(2), "2026-11-20T02:30:00.000Z", { outSession: { agent_stream: 4 } }, true),
  ],
};

test("summarise reads both files, skips a broken line and honours --since", () => {
  const s = summarise(readWindows(home(FIXTURE)), Date.parse(H(1)));
  assert.equal(s.windows, 2);
  assert.equal(s.stops, 1);
  assert.equal(s.from, H(1));
  assert.deepEqual(
    s.types.map((t) => `${t.channel}:${t.type}=${t.count}`),
    ["in:ping=5", "in:session=2", "inSession:fetch_agents_request=2", "outSession:agent_stream=4"],
  );
  assert.equal(
    summarise(readWindows(home(FIXTURE))).types.find((t) => t.type === "old_request").count,
    3,
  );
});

test("parseSince takes durations and dates", () => {
  const now = Date.parse(H(12));
  assert.equal(parseSince("2h", now), Date.parse(H(10)));
  assert.equal(parseSince("1d", now), now - 86_400_000);
  assert.equal(parseSince(H(3), now), Date.parse(H(3)));
  assert.throws(() => parseSince("soon", now));
});

test("a cut list fails on a live type, by bare name or channel", () => {
  const s = summarise(readWindows(home(FIXTURE)));
  const list = parseCutList(
    "# cut\nfetch_agents_request\nnever_sent # comment\n\nout:agent_stream\noutSession:agent_stream\n",
  );
  assert.deepEqual(list[2], { channel: "out", type: "agent_stream" });
  assert.deepEqual(
    checkCutList(list, s).map((h) => `${h.channel}:${h.type}`),
    ["inSession:fetch_agents_request", "outSession:agent_stream"],
  );
});

test("traffic-check exits 1 on live types, 0 on dead ones, 2 on too little data", () => {
  const d = home(FIXTURE);
  const script = path.join(import.meta.dirname, "traffic-check.mjs");
  const run = (list, ...args) =>
    spawnSync(process.execPath, [script, "-", "--home", d, ...args], {
      input: list,
      encoding: "utf8",
    });
  const live = run("ping\nnever_sent\n", "--min-hours", "1");
  assert.equal(live.status, 1, live.stderr);
  assert.match(live.stdout, /in:ping {2}5 messages/);
  assert.equal(run("never_sent\n", "--min-hours", "1").status, 0);
  assert.equal(run("never_sent\n").status, 2);
});
