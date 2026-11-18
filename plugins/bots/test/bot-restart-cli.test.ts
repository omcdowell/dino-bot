// bot-restart with fake paseo, systemctl, herdr and launchctl on PATH. Never runs a real restart or reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxBotSession, makeExec, run, type Deps } from "../bot-restart/cli";

const FAKES: Record<string, string> = {
  paseo: `#!/bin/bash
echo "paseo $*" >> "$FAKE/calls"
case "$1 $2" in
  "ls -g") n=$(( $(cat "$FAKE/lscount" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE/lscount"
           if [ -f "$FAKE/ls.$n.json" ]; then cat "$FAKE/ls.$n.json"; else cat "$FAKE/ls.json"; fi ;;
  "plugin reload") exit $(cat "$FAKE/reload-exit" 2>/dev/null || echo 0) ;;
  "plugin ls") cat "$FAKE/plugins.json" ;;
  "agent reload") exit 0 ;;
  *) exit 9 ;;
esac`,
  systemctl: `#!/bin/bash
echo "systemctl $*" >> "$FAKE/calls"
case "$2" in
  is-active) if grep -qx "$3" "$FAKE/active" 2>/dev/null; then echo active; else echo inactive; exit 3; fi ;;
  show) cat "$FAKE/mainpid" ;;
  restart) [ -f "$FAKE/restart-same-pid" ] || echo 2222 > "$FAKE/mainpid" ;;
  *) exit 9 ;;
esac`,
  herdr: `#!/bin/bash
[ -f "$FAKE/herdr.json" ] || exit 1
echo "herdr $*" >> "$FAKE/calls"
exec node -e '
const fs = require("fs"), f = process.env.FAKE + "/herdr.json";
let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { process.stdout.write(fs.readFileSync(f, "utf8")); process.exit(0); }
(() => {
const [a, b, c] = process.argv.slice(1), list = j.result?.agents ?? [];
if (a === "agent" && b === "list") return console.log(JSON.stringify(j));
if (a === "agent" && b === "get") { const x = list.find((x) => x.name === c); if (!x) process.exit(1); return console.log(JSON.stringify({ result: { agent: x } })); }
if (a === "tab" && b === "close") { j.result.agents = list.filter((x) => x.tab_id !== c); fs.writeFileSync(f, JSON.stringify(j)); return console.log("{}"); }
process.exit(9);
})();
' "$@"`,
  launchctl: `#!/bin/bash
echo "launchctl $*" >> "$FAKE/calls"
[ -f "$FAKE/launchd" ] || exit 113
[ "$1" = print ] && echo "state = running"
exit 0`,
};

const bot = (name: string, status = "idle", provider = "optchat/anthropic/claude-opus-5-5", id = `${name.toLowerCase()}-0000-0000`) => ({
  id,
  shortId: id.slice(0, 7),
  name,
  provider,
  status,
});
const IDLE = [bot("Flint"), bot("Yoda", "idle", "optchat-cc/claude-opus-5-5"), bot("Viva", "idle", "pi/anthropic/claude-sonnet-5-5")];

function harness(opts: { platform?: NodeJS.Platform; session?: string | null; alive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "br-"));
  const fake = join(root, "fake");
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(fake);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), `${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(fake, "active"), "paseo.service\n");
  writeFileSync(join(fake, "mainpid"), "1111\n");
  writeFileSync(join(fake, "ls.json"), JSON.stringify(IDLE));
  writeFileSync(join(fake, "plugins.json"), JSON.stringify([{ id: "bots", status: "running" }, { id: "apns", status: "running" }]));
  writeFileSync(join(fake, "herdr.json"), JSON.stringify({ result: { agents: [{ name: "cc-yoda", agent_status: "done" }, { name: "wp-x", agent_status: "working" }] } }));
  const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE: fake, XDG_STATE_HOME: state, HOME: root };
  let now = Date.parse("2026-11-18T07:00:00.000Z");
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    env,
    platform: opts.platform ?? "linux",
    uid: 1000,
    pid: 4321,
    now: () => new Date(now),
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    exec: makeExec(env),
    botSession: () => opts.session ?? null,
    alive: () => opts.alive ?? false,
  };
  return {
    deps,
    out,
    err,
    sleeps,
    fake,
    state,
    set: (file: string, data: unknown) => writeFileSync(join(fake, file), typeof data === "string" ? data : JSON.stringify(data)),
    calls: () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []),
    acted: () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []).filter((c) => / restart | reload |kickstart/.test(`${c} `)),
    log: () => readFileSync(join(state, "bot-restart", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    result: () => JSON.parse(out.at(-1)!),
  };
}

test("refused from a bot's own session, before anything is read or done", async () => {
  const h = harness({ session: "PASEO_AGENT_ID is set" });
  assert.equal(await run(["daemon"], h.deps), 3);
  assert.match(h.err[0]!, /refused.*bot-restart/);
  assert.deepEqual(h.calls(), []);
});

test("bot-session marker: env, the daemon's cgroup, or an ancestor with PASEO_AGENT_ID", () => {
  const procs: Record<string, string> = {
    "/proc/50/cgroup": "0::/user.slice/user@1000.service/app.slice/herdrd.service\n",
    "/proc/50/stat": "50 (bash) S 40 50 50",
    "/proc/40/environ": "HOME=/h\0PATH=/bin\0",
    "/proc/40/stat": "40 (node (x)) S 30 40 40",
    "/proc/30/environ": "PASEO_AGENT_ID=abc\0HOME=/h\0",
    "/proc/30/stat": "30 (pi) S 1 30 30",
    "/proc/60/cgroup": "0::/user.slice/user@1000.service/app.slice/paseo.service\n",
    "/proc/70/cgroup": "0::/x\n",
    "/proc/70/stat": "70 (bash) S 40 70 70",
  };
  const read = (p: string) => {
    if (!(p in procs)) throw new Error("ENOENT");
    return procs[p]!;
  };
  assert.equal(linuxBotSession({ PASEO_AGENT_ID: "x" }, 1, read), "PASEO_AGENT_ID is set");
  assert.equal(linuxBotSession({ PASEO_AGENT_ID: " " }, 99, read), null);
  assert.match(linuxBotSession({}, 60, read)!, /daemon's service/);
  assert.match(linuxBotSession({}, 50, read)!, /ancestor process 30/);
  procs["/proc/30/environ"] = "HOME=/h\0";
  assert.equal(linuxBotSession({}, 50, read), null);
});

test("dry run: says what it would do and who is busy; does nothing", async () => {
  const h = harness();
  h.set("ls.json", [bot("Flint", "running"), ...IDLE.slice(1)]);
  assert.equal(await run(["daemon", "--dry-run"], h.deps), 0);
  const r = h.result();
  assert.equal(r.dryRun, true);
  assert.equal(r.would, "systemctl --user restart paseo.service");
  assert.deepEqual(r.busyNow, ["Flint(running)"]);
  assert.deepEqual(h.acted(), []);
  assert.equal(existsSync(join(h.state, "bot-restart", "log.jsonl")), false);
});

test("daemon: idle twice, restarts once, checks the new MainPID and that the daemon answers, logs", async () => {
  const h = harness();
  assert.equal(await run(["daemon", "--gap", "10"], h.deps), 0);
  assert.deepEqual(h.acted(), ["systemctl --user restart paseo.service"]);
  const r = h.result();
  assert.equal(r.ok, true);
  assert.match(r.verified, /paseo\.service active, MainPID 1111 -> 2222; daemon answers \(3 agents\)/);
  assert.equal(h.sleeps[0], 10_000);
  assert.deepEqual(h.log().map((l) => l.ok), [true]);
  assert.equal(existsSync(join(h.state, "bot-restart", "lock")), false, "lock released");
});

test("daemon: the product's dinobot.service; none active or both active is an error, not a guess", async () => {
  const h = harness();
  h.set("active", "dinobot.service\n");
  assert.equal(await run(["daemon"], h.deps), 0);
  assert.deepEqual(h.acted(), ["systemctl --user restart dinobot.service"]);
  const none = harness();
  none.set("active", "");
  assert.equal(await run(["daemon"], none.deps), 1);
  assert.match(none.err[0]!, /no active paseo.service or dinobot.service/);
  const both = harness();
  both.set("active", "paseo.service\ndinobot.service\n");
  assert.equal(await run(["daemon"], both.deps), 1);
  assert.match(both.err[0]!, /give --service/);
  assert.deepEqual([...none.acted(), ...both.acted()], []);
});

test("daemon: not back (same MainPID) is a failure", async () => {
  const h = harness();
  h.set("restart-same-pid", "1");
  assert.equal(await run(["daemon"], h.deps), 1);
  assert.equal(h.result().ok, false);
  assert.match(h.result().verified, /MainPID 1111 -> 1111/);
});

test("waits: busy bots, a bot busy again between the two checks, then idle", async () => {
  const h = harness();
  h.set("ls.1.json", [bot("Flint", "running"), ...IDLE.slice(1)]); // busy
  h.set("ls.2.json", IDLE); // idle ...
  h.set("ls.3.json", [bot("Flint"), bot("Yoda", "running", "optchat-cc/claude-opus-5-5")]); // ... but busy at the second check
  // ls.4, ls.5: idle twice
  assert.equal(await run(["plugin", "--gap", "5"], h.deps), 0);
  assert.deepEqual(h.acted(), ["paseo plugin reload bots"]);
  assert.equal(h.sleeps.slice(0, 4).every((s) => s === 5000), true);
  assert.ok(h.sleeps.length >= 4);
});

test("a non-bot agent mid-turn holds a daemon restart but not a plugin reload", async () => {
  const busyPi = [bot("Flint"), bot("Viva", "running", "pi/anthropic/claude-sonnet-5-5")];
  const d = harness();
  d.set("ls.json", busyPi);
  assert.equal(await run(["daemon", "--dry-run"], d.deps), 0);
  assert.deepEqual(d.result().busyNow, ["Viva(running)"]);
  const p = harness();
  p.set("ls.json", busyPi);
  assert.equal(await run(["plugin", "--dry-run"], p.deps), 0);
  assert.deepEqual(p.result().busyNow, []);
});

test("Claude Code TUIs (cc-*) busy in herdr count; herdr unreadable is reported", async () => {
  const h = harness();
  h.set("herdr.json", { result: { agents: [{ name: "cc-yoda", agent_status: "working" }] } });
  assert.equal(await run(["plugin", "--dry-run"], h.deps), 0);
  assert.deepEqual(h.result().busyNow, ["cc-yoda(working)"]);
  const n = harness();
  n.set("herdr.json", "not json");
  assert.equal(await run(["plugin", "--dry-run"], n.deps), 0);
  assert.match(n.result().ccState, /unknown/);
});

test("timeout: bots stay busy, exits 5 and does nothing", async () => {
  const h = harness();
  h.set("ls.json", [bot("Flint", "running")]);
  assert.equal(await run(["daemon", "--timeout", "2m", "--gap", "15"], h.deps), 5);
  assert.deepEqual(h.acted(), []);
  const r = h.result();
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after 120s; still busy: Flint\(running\); nothing done/);
  assert.equal(h.log()[0].ok, false);
});

test("paseo ls failing counts as busy (never acts blind)", async () => {
  const h = harness();
  h.set("ls.json", "garbage");
  assert.equal(await run(["plugin", "--timeout", "30"], h.deps), 5);
  assert.deepEqual(h.acted(), []);
});

test("lock: a live holder refuses a second run; a stale lock is taken over", async () => {
  const live = harness({ alive: true });
  mkdirSync(join(live.state, "bot-restart"), { recursive: true });
  writeFileSync(join(live.state, "bot-restart", "lock"), "999\n");
  assert.equal(await run(["plugin"], live.deps), 4);
  assert.match(live.err[0]!, /another bot-restart is running \(pid 999\)/);
  assert.deepEqual(live.acted(), []);
  const stale = harness({ alive: false });
  mkdirSync(join(stale.state, "bot-restart"), { recursive: true });
  writeFileSync(join(stale.state, "bot-restart", "lock"), "999\n");
  assert.equal(await run(["plugin"], stale.deps), 0);
});

test("plugin: named plugin; a reload that fails or a plugin not running after it is a failure", async () => {
  const h = harness();
  assert.equal(await run(["plugin", "apns"], h.deps), 0);
  assert.deepEqual(h.acted(), ["paseo plugin reload apns"]);
  assert.equal(h.result().verified, "plugin apns running");
  const f = harness();
  f.set("reload-exit", "1");
  assert.equal(await run(["plugin"], f.deps), 1);
  const e = harness();
  e.set("plugins.json", [{ id: "bots", status: "error", error: "boom" }]);
  assert.equal(await run(["plugin"], e.deps), 1);
  assert.match(e.result().verified, /bots error \(error: boom\)/);
  assert.equal(await run(["plugin", "Bad/Name"], h.deps), 2);
});

test("agents: all OptChat bots, or named ones by name, short id or id; unknown names refused", async () => {
  const h = harness();
  assert.equal(await run(["agents", "all"], h.deps), 0);
  assert.deepEqual(h.acted(), ["paseo agent reload flint-0000-0000", "paseo agent reload yoda-0000-0000"]);
  assert.equal(h.result().verified, "2 agents back");
  const n = harness();
  assert.equal(await run(["agents", "yoda", "flint-0"], n.deps), 0);
  assert.deepEqual(n.acted(), ["paseo agent reload yoda-0000-0000", "paseo agent reload flint-0000-0000"]);
  const u = harness();
  assert.equal(await run(["agents", "nobody"], u.deps), 2);
  assert.equal(await run(["agents"], u.deps), 2);
  assert.deepEqual(u.acted(), []);
});

test("macOS: launchd app.dinobot.daemon when that job exists, else 'not supported here'; other systems refused", async () => {
  const m = harness({ platform: "darwin" });
  m.set("launchd", "1");
  assert.equal(await run(["daemon"], m.deps), 0);
  assert.deepEqual(m.acted(), ["launchctl kickstart -k gui/1000/app.dinobot.daemon"]);
  assert.match(m.result().verified, /app\.dinobot\.daemon running/);
  const none = harness({ platform: "darwin" });
  assert.equal(await run(["daemon"], none.deps), 1);
  assert.match(none.err[0]!, /not supported here: no launchd job gui\/1000\/app\.dinobot\.daemon/);
  const w = harness({ platform: "win32" });
  assert.equal(await run(["daemon"], w.deps), 1);
  assert.match(w.err[0]!, /not supported here \(win32\)/);
});

test("usage errors exit 2", async () => {
  const h = harness();
  assert.equal(await run([], h.deps), 2);
  assert.equal(await run(["reboot"], h.deps), 2);
  assert.equal(await run(["daemon", "--timeout", "soon"], h.deps), 2);
  assert.equal(await run(["--help"], h.deps), 0);
  assert.match(h.out[0]!, /^Usage: bot-restart/);
});

test("bin: --help works; refused when PASEO_AGENT_ID is set", () => {
  const bin = join(import.meta.dirname, "..", "bin", "bot-restart.mjs");
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "" } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: bot-restart/);
  const refused = spawnSync(process.execPath, [bin, "plugin", "--dry-run"], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "abc" } });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /refused/);
});

test("agents <names>: waits only for the named bots; agents all waits for every bot", async () => {
  const fleet = [bot("Flint"), bot("Scrat", "running"), bot("Yoda", "idle", "optchat-cc/claude-opus-5-5")];
  const n = harness();
  n.set("ls.json", fleet);
  n.set("herdr.json", { result: { agents: [{ name: "cc-yoda", agent_status: "done" }, { name: "cc-other", agent_status: "working" }] } });
  assert.equal(await run(["agents", "flint", "yoda"], n.deps), 0);
  assert.deepEqual(n.acted(), ["paseo agent reload flint-0000-0000", "paseo agent reload yoda-0000-0000"]);
  const busyYoda = harness();
  busyYoda.set("ls.json", fleet);
  busyYoda.set("herdr.json", { result: { agents: [{ name: "cc-yoda", agent_status: "working" }] } });
  assert.equal(await run(["agents", "yoda", "--dry-run"], busyYoda.deps), 0);
  assert.deepEqual(busyYoda.result().busyNow, ["cc-yoda(working)"]);
  const all = harness();
  all.set("ls.json", fleet);
  assert.equal(await run(["agents", "all", "--timeout", "30"], all.deps), 5);
  assert.match(all.result().error, /still busy: Scrat\(running\)/);
  assert.deepEqual(all.acted(), []);
});

test("--now: a named bot stuck mid-turn is reloaded at once and logged as forced; refused for all, daemon and plugin", async () => {
  const h = harness();
  h.set("ls.1.json", [bot("Scrat", "running"), bot("Flint")]); // resolving the name
  h.set("ls.2.json", [bot("Scrat", "running"), bot("Flint")]); // busy at the start
  h.set("ls.json", [bot("Scrat"), bot("Flint")]); // back after the reload
  assert.equal(await run(["agents", "scrat", "--now"], h.deps), 0);
  assert.deepEqual(h.acted(), ["paseo agent reload scrat-0000-0000"]);
  const r = h.result();
  assert.equal(r.forced, true);
  assert.deepEqual(r.busyAtStart, ["Scrat(running)"]);
  assert.equal(h.log()[0].forced, true);
  assert.equal(h.sleeps.filter((s) => s === 15_000).length, 0, "no idle wait");
  for (const argv of [["agents", "all", "--now"], ["daemon", "--now"], ["plugin", "--now"]]) {
    const x = harness();
    assert.equal(await run(argv, x.deps), 2, argv.join(" "));
    assert.match(x.err[0]!, /--now is only for named agents/);
    assert.deepEqual(x.acted(), []);
  }
});

// Claude Code bots: `agents` closes the TUI's herdr tab, then reloads the agent (the reload alone keeps the old TUI).
const ccBot = (status = "idle") => ({ ...bot("Yoda", status, "optchat-cc/claude-opus-5-5"), cwd: "~/bots/yoda" });
const tui = (status = "done") => ({ name: "cc-yoda", agent_status: status, tab_id: "wH8:t1", pane_id: "wH8:p1" });

test("CC bot idle: closes its TUI tab, then reloads; old TUI gone, agent idle; says the TUI starts on the next message", async () => {
  const h = harness();
  h.set("ls.json", [ccBot(), bot("Flint")]);
  h.set("herdr.json", { result: { agents: [tui(), { name: "wp-x", agent_status: "working", tab_id: "w1:t1", pane_id: "w1:p1" }] } });
  assert.equal(await run(["agents", "yoda"], h.deps), 0);
  const calls = h.calls().filter((c) => /tab close|agent reload/.test(c));
  assert.deepEqual(calls, ["herdr tab close wH8:t1", "paseo agent reload yoda-0000-0000"]);
  const r = h.result();
  assert.equal(r.ok, true);
  assert.match(r.cc, /Yoda: tui closed; a fresh one starts on the reload or the bot's next message/);
  assert.match(r.verified, /1 agents back; old tui gone: cc-yoda/);
});

test("CC bot busy then idle: waits on its TUI, then closes it", async () => {
  const h = harness();
  h.set("ls.json", [ccBot()]);
  h.set("herdr.json", { result: { agents: [tui("working")] } });
  let polls = 0;
  const sleep = h.deps.sleep;
  h.deps.sleep = async (ms) => {
    if (++polls === 2) h.set("herdr.json", { result: { agents: [tui("done")] } });
    return sleep(ms);
  };
  assert.equal(await run(["agents", "yoda", "--gap", "5"], h.deps), 0);
  assert.ok(polls >= 3, "waited");
  assert.ok(h.calls().includes("herdr tab close wH8:t1"));
});

test("CC bot without a running TUI: nothing to close, still a success", async () => {
  const h = harness();
  h.set("ls.json", [ccBot()]);
  h.set("herdr.json", { result: { agents: [] } });
  assert.equal(await run(["agents", "yoda"], h.deps), 0);
  assert.equal(h.calls().some((c) => c.includes("tab close")), false);
  assert.match(h.result().cc, /Yoda: no tui was running; one starts on the bot's next message/);
});

test("a CC bot listed running after the reload is not verified (nothing should have woken it)", async () => {
  const h = harness();
  h.set("ls.json", [ccBot("running")]);
  h.set("ls.1.json", [ccBot()]);
  h.set("ls.2.json", [ccBot()]);
  h.set("ls.3.json", [ccBot()]);
  h.set("herdr.json", { result: { agents: [tui()] } });
  assert.equal(await run(["agents", "yoda"], h.deps), 1);
  assert.match(h.result().verified, /not back: Yoda/);
});

test("agents all with one CC and two pi bots: one tab closed, three reloads; dry run names the herdr command; --now as for pi", async () => {
  const fleet = [ccBot(), bot("Flint"), bot("Scrat")];
  const d = harness();
  d.set("ls.json", fleet);
  d.set("herdr.json", { result: { agents: [tui()] } });
  assert.equal(await run(["agents", "all", "--dry-run"], d.deps), 0);
  assert.match(d.result().would, /^herdr tab close wH8:t1 \(cc-yoda, its Claude Code TUI\), then paseo agent reload yoda-00 \(Yoda\); paseo agent reload flint-0 \(Flint\); paseo agent reload scrat-0 \(Scrat\)$/);
  assert.equal(d.calls().some((c) => c.includes("tab close")), false);
  const h = harness();
  h.set("ls.json", fleet);
  h.set("herdr.json", { result: { agents: [tui()] } });
  assert.equal(await run(["agents", "all"], h.deps), 0);
  assert.deepEqual(
    h.calls().filter((c) => /tab close|agent reload/.test(c)),
    ["herdr tab close wH8:t1", "paseo agent reload yoda-0000-0000", "paseo agent reload flint-0000-0000", "paseo agent reload scrat-0000-0000"],
  );
  assert.match(h.result().verified, /3 agents back; old tui gone: cc-yoda/);
  const n = harness();
  n.set("herdr.json", { result: { agents: [tui("working")] } });
  // --now: no wait; the stuck TUI is closed at once (verification then waits for the agent to be idle).
  n.set("ls.2.json", [ccBot("running")]);
  n.set("ls.json", [ccBot()]);
  assert.equal(await run(["agents", "yoda", "--now"], n.deps), 0);
  assert.equal(n.result().forced, true);
  assert.ok(n.calls().includes("herdr tab close wH8:t1"));
});
