import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PANE_LINES,
  ccSessionBusy,
  herdrErrorReader,
  paneStopError,
  readSessionError,
  sessionErrorReader,
  sessionStopError,
} from "../server/worker-errors";
import {
  GRACE_MS,
  MAX_AGE_MS,
  WorkersService,
  appendRegistry,
  resolveWorker,
  type HerdrAgent,
  type LaunchRecord,
} from "../server/workers";
import { outstandingCount, stalledCount } from "../shared/workers-rpc";
import type { StallError } from "../server/worker-errors";

const T0 = Date.parse("2026-10-10T03:04:03.839Z");
/** A reader's answer as an error (or null); "working" fails the test. */
const asStop = async (answer: Promise<StallError | "working" | null>) => {
  const value = await answer;
  assert.notEqual(value, "working");
  return value as StallError | null;
};
const iso = (ms: number) => new Date(ms).toISOString();

/** pi session lines shaped like the chat-prefetch-build incident (2026-10-10). */
const assistant = (at: number, stopReason: string, extra: object = {}) =>
  JSON.stringify({
    type: "message",
    id: `a${at}`,
    timestamp: iso(at),
    message: { role: "assistant", content: [], stopReason, ...extra },
  });
const toolResult = (at: number) =>
  JSON.stringify({ type: "message", id: `t${at}`, timestamp: iso(at), message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
const user = (at: number, text: string) =>
  JSON.stringify({ type: "message", id: `u${at}`, timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }] } });
const contextEdit = (at: number) => JSON.stringify({ type: "context_edit", id: `c${at}`, timestamp: iso(at), replacement: null });
const timedOut = (at: number) => assistant(at, "error", { errorMessage: "Request timed out." });

const incident = [
  JSON.stringify({ type: "session", id: "s", timestamp: iso(T0) }),
  assistant(T0 + 60_000, "toolUse"),
  toolResult(T0 + 61_000),
  // pi's retries: each failed attempt is a message, then a context_edit drops it from context
  timedOut(T0 + 600_000),
  contextEdit(T0 + 600_001),
  timedOut(T0 + 612_000),
  contextEdit(T0 + 612_001),
  timedOut(T0 + 627_000),
  contextEdit(T0 + 627_001),
  timedOut(T0 + 667_743),
];

test("session: a turn that died on an API error (after pi's retries) is a stop on that error", () => {
  assert.deepEqual(sessionStopError(incident), { message: "Request timed out.", at: iso(T0 + 667_743), source: "session" });
  // non-message entries after the error (custom, context_edit, model_change) do not hide it
  assert.equal(sessionStopError([...incident, contextEdit(T0 + 700_000), '{"type":"custom"}'])?.message, "Request timed out.");
  // the other errors seen in pi sessions: 429, 401, overloaded, connection, aborted
  for (const errorMessage of ['429 {"type":"error","error":{"type":"rate_limit_error"}}', "401 {\"error\":\"unauthorized\"}", "Connection error."]) {
    assert.equal(sessionStopError([assistant(T0, "error", { errorMessage })])?.message, errorMessage);
  }
  assert.equal(sessionStopError([assistant(T0, "aborted", { errorMessage: "Operation aborted" })])?.message, "Operation aborted");
  // no errorMessage: the stop reason stands in
  assert.equal(sessionStopError([assistant(T0, "error")])?.message, "error");
  // long messages are clipped to one line
  const long = sessionStopError([assistant(T0, "error", { errorMessage: `x\n${"y".repeat(1000)}` })])!;
  assert.ok(long.message.length <= 300 && !long.message.includes("\n"));
});

test("session: not an error stop when anything came after the error, or the turn ended normally", () => {
  // a retry that finally succeeded
  assert.equal(sessionStopError([...incident, assistant(T0 + 700_000, "toolUse")]), null);
  // mid-turn: a tool is running or just returned
  assert.equal(sessionStopError([...incident, assistant(T0 + 700_000, "toolUse"), toolResult(T0 + 701_000)]), null);
  // the bot already resumed it (a new prompt)
  assert.equal(sessionStopError([...incident, user(T0 + 1_050_000, "Carry on")]), null);
  // normal end of turn
  assert.equal(sessionStopError([assistant(T0, "stop")]), null);
  // nothing to go on: unknown, not an error
  assert.equal(sessionStopError([]), null);
  assert.equal(sessionStopError([contextEdit(T0), "{torn"]), null);
});

test("session file: read from its tail; a missing file is no error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "werr-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, incident.join("\n") + "\n");
  assert.equal((await asStop(readSessionError(path)))?.at, iso(T0 + 667_743));
  assert.equal(await readSessionError(join(dir, "missing.jsonl")), null);
});

test("pane fallback: only error-shaped lines near the bottom count", () => {
  const screen = (bottom: string[]) => ["$ npm test", "ok 12 tests", ...bottom, "────", "~/code/x", "↑90 ↓52k claude-opus-5-5"].join("\n");
  assert.equal(paneStopError(screen(["Error: Request timed out"]))?.message, "Error: Request timed out");
  assert.equal(paneStopError(screen(["Retry failed after 3 attempts"]))?.message, "Retry failed after 3 attempts");
  assert.equal(paneStopError(screen(["⚠ 429 Too Many Requests: rate limit"]))?.source, "pane");
  assert.equal(paneStopError(screen(["API Error: 529 overloaded"]))?.message, "API Error: 529 overloaded");
  assert.equal(paneStopError(screen(["Operation aborted"]))?.at, null);
  // ordinary output is not an error, even when it mentions codes or the word error in passing
  assert.equal(paneStopError(screen(["Done. Report sent.", "no errors found in 429 files"])), null);
  // Claude Code still retrying (live pane, 2.1.323): not stopped; once the retries are used up, the error line is
  const retrying = "✻ 429 Number of request tokens has exceeded your per-minute rate limit · Retrying in 11s · attempt 6/10";
  assert.equal(paneStopError(screen([retrying])), null);
  assert.equal(paneStopError(screen(["● API Error: Repeated 529 Overloaded errors. The API is at capacity", retrying])), null);
  assert.match(paneStopError(screen([retrying, "● API Error: Request rejected (429) · Number of request tokens has exceeded your per-minute rate limit"]))!.message, /429/);
  // an error far above the bottom (scrolled away, the agent carried on) does not count
  const filler = Array.from({ length: PANE_LINES + 5 }, (_, i) => `line ${i}`);
  assert.equal(paneStopError(["Error: Request timed out", ...filler].join("\n")), null);
});

test("herdrErrorReader: the session file wins; the pane is read only without one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "werr-"));
  const session = join(dir, "s.jsonl");
  writeFileSync(session, incident.join("\n") + "\n");
  const ok = join(dir, "ok.jsonl");
  writeFileSync(ok, [...incident, assistant(T0 + 700_000, "stop")].join("\n") + "\n");
  // fake herdr: `agent read <pane> …` prints an error screen and logs the call
  const log = join(dir, "calls.log");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\nprintf 'working...\\nError: Request timed out\\n───\\n'\n`);
  chmodSync(bin, 0o755);
  const read = herdrErrorReader({ PASEO_BOTS_HERDR: bin });
  const agent = (session: HerdrAgent["agent_session"]): HerdrAgent => ({ name: "w", pane_id: "w85:p1", agent_status: "idle", agent_session: session });
  assert.equal((await asStop(read(agent({ kind: "path", value: session }))))?.source, "session");
  // the session says it ended fine: the pane is not consulted
  assert.equal(await read(agent({ kind: "path", value: ok })), null);
  // no session (another agent kind): the pane
  assert.deepEqual(await read(agent(null)), { message: "Error: Request timed out", at: null, source: "pane" });
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["agent read w85:p1 --source recent --lines 50"]);
  // session-only reader never runs herdr
  assert.equal(await sessionErrorReader(agent(null)), null);
  assert.equal((await asStop(sessionErrorReader(agent({ kind: "path", value: session }))))?.message, "Request timed out.");
});

// Claude Code transcripts: tails of real worker transcripts (copies, long strings shortened by the copy).
//   worker-overloaded-529: probe worker (launch.sh --engine cc, Claude Code 2.1.323) against an API that answers 529
//   worker-rate-limit-429: the same worker prompted again against 429 rate_limit_error, after Claude Code's 10 retries
//   rate-limit-429: an older session (2.1.186) stopped by the proxy's 429 rate limit
//   worker-finished: a CC worker (emmet-setup-flow-v0113) that reported and ended its turn normally
const ccLines = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "cc-transcripts", `${name}.jsonl`), "utf8").split("\n").filter((l) => l.trim());
const ccUser = (at: number, text: string, extra: object = {}) =>
  JSON.stringify({ type: "user", isSidechain: false, timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const ccAssistant = (at: number, text: string, extra: object = {}) =>
  JSON.stringify({ type: "assistant", isSidechain: false, timestamp: iso(at), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] }, ...extra });

test("Claude Code transcript: a turn that died on an API error is a stop on that error (429, 529 overloaded)", () => {
  const overloaded = sessionStopError(ccLines("worker-overloaded-529"))!;
  assert.equal(overloaded.source, "session");
  assert.match(overloaded.message, /^API Error: Repeated 529 Overloaded errors/);
  assert.ok(overloaded.at && !Number.isNaN(Date.parse(overloaded.at)));
  const limited = sessionStopError(ccLines("worker-rate-limit-429"))!;
  assert.match(limited.message, /429/);
  assert.match(limited.message, /rate limit/i);
  // the status goes in front when the text does not carry it (the proxy's 429 text has no number)
  const proxy = sessionStopError(ccLines("rate-limit-429"))!;
  assert.match(proxy.message, /^429 API Error: Server is temporarily limiting requests/);
  assert.equal(proxy.at, "2026-06-23T20:32:22.374Z");
  // entries Claude Code writes after the error (turn_duration, last-prompt, cost-state, …) do not hide it
  assert.equal(sessionStopError([...ccLines("worker-overloaded-529"), '{"type":"last-prompt"}', '{"type":"cost-state"}'])?.message, overloaded.message);
  // Esc (interrupt), as pi's "aborted"
  const interrupted = sessionStopError([ccAssistant(T0, "Working on it"), ccUser(T0 + 1000, "[Request interrupted by user]")])!;
  assert.deepEqual(interrupted, { message: "Request interrupted by user", at: iso(T0 + 1000), source: "session" });
  assert.equal(sessionStopError([ccUser(T0, "[Request interrupted by user for tool use]")])?.message, "Request interrupted by user");
});

test("Claude Code transcript: not an error stop after a normal end, a later reply, a new prompt or mid-turn", () => {
  // a worker that reported and ended its turn
  assert.equal(sessionStopError(ccLines("worker-finished")), null);
  const died = ccLines("worker-overloaded-529");
  // the bot resumed it: a new prompt after the error
  assert.equal(sessionStopError([...died, ccUser(T0, "Carry on")]), null);
  // it got going again: a real reply after the error
  assert.equal(sessionStopError([...died, ccUser(T0, "Carry on"), ccAssistant(T0 + 1000, "Done.")]), null);
  // mid-turn: a tool result is the last message
  const toolResult = JSON.stringify({ type: "user", timestamp: iso(T0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
  assert.equal(sessionStopError([...died, ccUser(T0, "Carry on"), toolResult]), null);
  // a subagent's API error (sidechain) is not the worker's stop
  assert.equal(sessionStopError([ccAssistant(T0, "Done."), ccAssistant(T0 + 1, "API Error: 529", { isSidechain: true, isApiErrorMessage: true })]), null);
});

test("herdr reports no session for Claude Code: the transcript recorded at launch is read, not the pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "werr-"));
  const transcript = join(dir, "cc.jsonl");
  writeFileSync(transcript, ccLines("worker-rate-limit-429").join("\n") + "\n");
  const log = join(dir, "calls.log");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\nprintf 'nothing to see\\n'\n`);
  chmodSync(bin, 0o755);
  const cc: HerdrAgent = { name: "w", pane_id: "w85:p1", agent_status: "idle", agent_session: null };
  const read = herdrErrorReader({ PASEO_BOTS_HERDR: bin });
  assert.equal((await asStop(read(cc, transcript)))?.source, "session");
  assert.equal((await asStop(sessionErrorReader(cc, transcript)))?.source, "session");
  assert.throws(() => readFileSync(log), /ENOENT/, "the pane is not read when a transcript is known");
  // herdr's own path (pi) wins over a recorded one; relative paths are ignored
  const pi = join(dir, "pi.jsonl");
  writeFileSync(pi, incident.join("\n") + "\n");
  assert.equal((await asStop(sessionErrorReader({ ...cc, agent_session: { kind: "path", value: pi } }, transcript)))?.message, "Request timed out.");
  assert.equal(await sessionErrorReader(cc, "cc.jsonl"), null);
  // a recorded transcript that does not exist: the pane after all
  assert.deepEqual(await read(cc, join(dir, "missing.jsonl")), null);
  assert.equal(readFileSync(log, "utf8").trim(), "agent read w85:p1 --source recent --lines 50");
});

test("Claude Code retrying (herdr says idle, its session record says busy) is working, not finished or stalled", async () => {
  // Measured live: during Claude Code's own 429 retries herdr shows the claude agent idle, the pane's bottom line is
  // "429 … rate limit · Retrying in 11s · attempt 6/10" (the pane check called that stalled) and the transcript
  // ends on the user prompt. Claude Code's <config>/sessions/<pid>.json says busy.
  const config = mkdtempSync(join(tmpdir(), "cc-config-"));
  const id = "ca2a49c7-309a-4fdf-8db3-12c2b01e3194";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(config, "projects", "-tmp-ccfx-probe-cwd"), { recursive: true });
  mkdirSync(join(config, "sessions"));
  const transcript = join(config, "projects", "-tmp-ccfx-probe-cwd", `${id}.jsonl`);
  const lines = ccLines("worker-rate-limit-429");
  const retrying = lines.slice(0, lines.findIndex((l) => JSON.parse(l).isApiErrorMessage === true));
  writeFileSync(transcript, retrying.join("\n") + "\n");
  const record = (status: string, pid = process.pid) =>
    writeFileSync(join(config, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: "/tmp/ccfx/probe/cwd", kind: "interactive", name: "ccp2stall-probe", status }));
  const cc: HerdrAgent = { name: "ccp2stall-probe", pane_id: "wHJ:p1", agent_status: "idle", agent_session: null };
  // no session record (Claude Code gone, or an older one): no error known
  assert.equal(await sessionErrorReader(cc, transcript), null);
  record("busy");
  assert.equal(await sessionErrorReader(cc, transcript), "working");
  const ctx = { now: T0 + 20 * 60_000, doneAt: null, reportAt: null, agents: [cc] };
  const w = launch("ccp2stall-probe", T0, { pane: "wHJ:p1", session: transcript });
  const view = await resolveWorker(w, { ...ctx, readError: sessionErrorReader });
  assert.equal(view.state, "running");
  assert.equal(view.herdr, "idle");
  // a mid-job report, then retrying: still running
  assert.equal((await resolveWorker(w, { ...ctx, reportAt: T0 + 1000, readError: sessionErrorReader })).state, "running");
  // retries used up: the error lands in the transcript and the record goes idle; now stalled
  writeFileSync(transcript, lines.join("\n") + "\n");
  record("idle");
  const stalled = await resolveWorker(w, { ...ctx, readError: sessionErrorReader });
  assert.equal(stalled.state, "stalled");
  assert.match(stalled.error!.message, /429/);
  // a busy record whose process is gone does not count
  writeFileSync(transcript, retrying.join("\n") + "\n");
  rmSync(join(config, "sessions", `${process.pid}.json`));
  record("busy", 2 ** 22 + 12345);
  assert.equal(await sessionErrorReader(cc, transcript), null);
  // pi sessions are never looked up there
  assert.equal(await ccSessionBusy(join(config, "sessions", "x.jsonl")), false);
});

const launch = (worker: string, at: number, extra: Partial<LaunchRecord> = {}): LaunchRecord => ({
  v: 1,
  type: "launch",
  ts: iso(at),
  worker,
  pane: "w85:p1",
  agent: "agent-emmet",
  bot: null,
  ...extra,
});
const herdr = (name: string | null, pane: string, status: string): HerdrAgent => ({ name, pane_id: pane, agent_status: status });
const ERR: StallError = { message: "Request timed out.", at: iso(T0 + 667_743), source: "session" };

test("resolveWorker: idle/done past grace with an error after launch is stalled, not finished", async () => {
  const now = T0 + 20 * 60_000;
  const agents = [herdr("chat-prefetch-build", "w85:p1", "done")];
  const ctx = { now, doneAt: null, reportAt: null, agents, readError: async () => ERR };
  const view = await resolveWorker(launch("chat-prefetch-build", T0), ctx);
  assert.equal(view.state, "stalled");
  assert.equal(view.reason, undefined);
  assert.equal(view.pane, "w85:p1");
  assert.equal(view.herdr, "done");
  assert.deepEqual(view.error, ERR);
  assert.equal((await resolveWorker(launch("chat-prefetch-build", T0), { ...ctx, agents: [herdr("chat-prefetch-build", "w85:p1", "idle")] })).state, "stalled");
  // pane-only errors carry no time and still count
  assert.equal((await resolveWorker(launch("chat-prefetch-build", T0), { ...ctx, readError: async () => ({ ...ERR, at: null, source: "pane" as const }) })).state, "stalled");
});

test("resolveWorker: what still counts as finished (or running) despite an error", async () => {
  const now = T0 + 20 * 60_000;
  const agents = [herdr("chat-prefetch-build", "w85:p1", "idle")];
  let reads = 0;
  const readError = async () => {
    reads++;
    return ERR;
  };
  const base = { now, doneAt: null, reportAt: null, agents, readError };
  const w = launch("chat-prefetch-build", T0);
  // `bot-worker done` clears it
  assert.equal((await resolveWorker(w, { ...base, doneAt: now - 1000 })).reason, "done");
  // pane closed
  assert.equal((await resolveWorker(w, { ...base, agents: [] })).reason, "gone");
  // too old
  assert.equal((await resolveWorker(w, { ...base, now: T0 + MAX_AGE_MS + 1 })).reason, "expired");
  // herdr down: unknown, as before
  assert.equal((await resolveWorker(w, { ...base, agents: null })).state, "unknown");
  assert.equal(reads, 0, "the session is read only for idle workers (with or without a report)");
  // it reported after the error (the error is from before the report)
  assert.equal((await resolveWorker(w, { ...base, reportAt: T0 + 700_000 })).reason, "reported");
  // reported, error with no time (pane output): cannot tell which came first, so the report wins
  assert.equal(
    (await resolveWorker(w, { ...base, reportAt: T0 + 1000, readError: async () => ({ ...ERR, at: null, source: "pane" as const }) })).reason,
    "reported",
  );
  // within the grace period an idle worker is still running (not yet prompted)
  assert.equal((await resolveWorker(w, { ...base, now: T0 + GRACE_MS - 1 })).state, "running");
  // an error from before this launch belongs to an earlier task in the pane
  assert.equal((await resolveWorker(w, { ...base, readError: async () => ({ ...ERR, at: iso(T0 - 1000) }) })).reason, "idle");
  // no error: finished idle as before
  assert.equal((await resolveWorker(w, { ...base, readError: async () => null })).reason, "idle");
  // a failing reader is no error
  assert.equal((await resolveWorker(w, { ...base, readError: async () => Promise.reject(new Error("x")) })).reason, "idle");
  // working or blocked: the session is not read
  reads = 0;
  assert.equal((await resolveWorker(w, { ...base, agents: [herdr("chat-prefetch-build", "w85:p1", "working")] })).state, "running");
  assert.equal(reads, 0);
});

test("resolveWorker: a mid-job report, then prompted again and died on an API error, is stalled", async () => {
  const now = T0 + 20 * 60_000;
  const w = launch("settings-back", T0);
  const ctx = { now, doneAt: null, reportAt: T0 + 60_000, agents: [herdr("settings-back", "w85:p1", "done")], readError: async () => ERR };
  const view = await resolveWorker(w, ctx);
  assert.equal(view.state, "stalled");
  assert.deepEqual(view.error, ERR);
  // still working (pi retrying): running, the session is not read
  let reads = 0;
  const working = await resolveWorker(w, {
    ...ctx,
    agents: [herdr("settings-back", "w85:p1", "working")],
    readError: async () => {
      reads++;
      return ERR;
    },
  });
  assert.equal(working.state, "running");
  assert.equal(reads, 0);
  // a report after the error clears it
  assert.equal((await resolveWorker(w, { ...ctx, reportAt: T0 + 700_000 })).reason, "reported");
});

test("resolveWorker: the launch's recorded session is handed to the reader (Claude Code workers)", async () => {
  const seen: Array<string | null | undefined> = [];
  const readError = async (_agent: HerdrAgent, session?: string | null) => {
    seen.push(session);
    return session ? ERR : null;
  };
  const ctx = { now: T0 + 20 * 60_000, doneAt: null, reportAt: null, agents: [herdr("cc-w", "w85:p1", "idle")], readError };
  assert.equal((await resolveWorker(launch("cc-w", T0, { session: "/x/cc.jsonl" }), ctx)).state, "stalled");
  assert.equal((await resolveWorker(launch("cc-w", T0), ctx)).reason, "idle");
  assert.deepEqual(seen, ["/x/cc.jsonl", null]);
});

test("WorkersService: a stalled worker is listed as stalled for its bot; it is not outstanding", async () => {
  const base = mkdtempSync(join(tmpdir(), "werr-"));
  const registry = join(base, "bot-dm", "launches.jsonl");
  appendRegistry(registry, launch("chat-prefetch-build", T0));
  appendRegistry(registry, launch("sidebar-sort", T0, { pane: "w86:p1" }));
  const service = new WorkersService({
    registryPath: registry,
    workersRoot: join(base, "bot-dm", "workers"),
    now: () => T0 + 20 * 60_000,
    listHerdr: async () => [herdr("chat-prefetch-build", "w85:p1", "done"), herdr("sidebar-sort", "w86:p1", "working")],
    readError: async (agent) => (agent.pane_id === "w85:p1" ? ERR : null),
  });
  const { bots } = await service.byBot([{ id: "emmet-brickowski", cwd: "/bots/emmet", agentId: "agent-emmet" }], (id) =>
    id === "agent-emmet" ? "emmet-brickowski" : null,
  );
  const workers = bots[0]!.workers;
  assert.deepEqual(
    workers.map((w) => [w.worker, w.state]),
    [
      ["chat-prefetch-build", "stalled"],
      ["sidebar-sort", "running"],
    ],
  );
  assert.equal(outstandingCount(workers), 1);
  assert.equal(stalledCount(workers), 1);
});
