import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanDescription,
  isSystemUnit,
  describeCalendar,
  describeSchedule,
  listSystemdTimers,
  parseShow,
  summariseCalendars,
  setTimerPaused,
  timersAnswer,
  type Systemctl,
} from "../server/systemd-timers";
import { botsTimersRpc, botsTimersSetRpc } from "../shared/timers-rpc";

// Captured on a dev host 2026-11-14 (unit names, descriptions and home anonymised) (`systemctl --user list-timers --all --output=json`,
// `list-unit-files --type=timer --output=json`, `show --timestamp=unix -p … -- <timers> <services>`).
const dir = join(__dirname, "fixtures", "systemd");
const LIST = readFileSync(join(dir, "list-timers.json"), "utf8");
const FILES = readFileSync(join(dir, "unit-files.json"), "utf8");
const SHOW = readFileSync(join(dir, "show.txt"), "utf8");

function fake(list = LIST, show = SHOW, files = FILES): Systemctl & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    if (args[0] === "list-timers") return list;
    if (args[0] === "list-unit-files") return files;
    return args[0] === "show" ? show : "";
  }) as Systemctl & { calls: string[][] };
  run.calls = calls;
  return run;
}

// The fixtures were captured on a dev host (names and paths anonymised: home /home/alice, uid 1000); pin both so the tests do not
// depend on who runs them.
const ALICE = { home: "/home/alice", uid: 1000 };
const ALL = { ...ALICE, includeAll: true };
const SYSTEM = [
  "launchpadlib-cache-clean", "snap.firmware-updater.firmware-notifier", "systemd-tmpfiles-clean",
  "ubuntu-insights-collect", "ubuntu-insights-upload",
];

const writes = (run: { calls: string[][] }) => run.calls.filter((c) => c[0] === "disable" || c[0] === "enable");

test("lists every user timer on the host, no allow-list: ours, snap, vendor, and disabled ones", async () => {
  const timers = await listSystemdTimers(fake(), ALICE);
  assert.equal(timers.length, 20); // 18 loaded + fc-emmet-checkin + systemd-tmpfiles-clean (disabled)
  const names = timers.map((t) => t.name);
  for (const name of [
    "fc-daily-standup", "matilda-mail-summary-check", "matilda-mailtriage", "x-reply-leads", "battery-watch",
    "snap.firmware-updater.firmware-notifier", "launchpadlib-cache-clean", "ubuntu-insights-upload",
    "fc-emmet-checkin", "systemd-tmpfiles-clean",
  ]) assert.ok(names.includes(name), name);
  for (const t of timers) assert.equal(botsTimersRpc.output.shape.timers.element.safeParse(t).success, true, t.unit);
});

test("listing is read-only: list-timers, list-unit-files, show timers, show their services", async () => {
  const run = fake();
  await listSystemdTimers(run);
  assert.deepEqual(run.calls.map((c) => c[0]), ["list-timers", "list-unit-files", "show", "show"]);
  assert.ok(run.calls[3].includes("fc-daily-standup.service"));
  assert.ok(run.calls[3].includes("snap.firmware-updater.firmware-notifier.service"));
  assert.deepEqual(writes(run), []);
});

test("row fields match the app's parseTimers: description, schedule, next/last run, state, result", async () => {
  const timers = await listSystemdTimers(fake(), ALICE);
  const by = (n: string) => timers.find((t) => t.name === n)!;
  assert.deepEqual(by("fc-daily-standup"), {
    unit: "fc-daily-standup.timer",
    name: "fc-daily-standup",
    description: "FC daily standup, 06:00 Asia/Singapore",
    schedule: "daily 06:00 Asia/Singapore",
    nextRunAt: "2026-11-14T22:00:00.000Z",
    lastRunAt: by("fc-daily-standup").lastRunAt,
    timerState: "active",
    lastResult: "ok",
    resultDetail: null,
    system: false,
  });
  assert.match(by("fc-daily-standup").lastRunAt ?? "", /^2026-11-13T22:00:0/);
  assert.equal(by("matilda-mail-summary-check").description, "Matilda mail summary watchdog, weekdays 02:30 UTC (after the 01:30 UTC backstop)");
  assert.equal(by("battery-watch").schedule, "every minute");
  assert.equal(by("herdr-gc-stale").schedule, "weekdays 09:49");
  assert.equal(by("snap.firmware-updater.firmware-notifier").schedule, "daily 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, 21:00");
  assert.match(by("study-reminders").schedule, /^\d+ one-off times$/);
  assert.equal(by("x-reply-leads").schedule, "weekdays 06:57, 19:57 Asia/Singapore");
  // Vendor unit quotes its Description=.
  assert.equal(by("ubuntu-insights-upload").description?.startsWith("Run Ubuntu-Insights upload"), true);
  // Disabled + stopped = paused, no next run; one never triggered = never.
  const checkin = by("fc-emmet-checkin");
  assert.deepEqual([checkin.timerState, checkin.nextRunAt], ["paused", null]);
  assert.equal(checkin.schedule, "daily 10:00, 22:00 Asia/Singapore");
  assert.equal(by("systemd-tmpfiles-clean").timerState, "paused");
  // Soonest first, no-next-run last.
  const nexts = timers.map((t) => t.nextRunAt ?? "\uffff");
  assert.deepEqual(nexts, [...nexts].sort());
  assert.equal(timers.at(-1)?.nextRunAt, null);
});

test("running service, stopped timer, failure without exit code, exit code", async () => {
  const list = JSON.stringify([
    { unit: "a.timer", activates: "a.service", next: 1791800000000000, last: 1791790000000000 },
    { unit: "b.timer", activates: "b.service", next: null, last: 1791790000000000 },
    { unit: "c.timer", activates: "c.service", next: 1791900000000000, last: 1791790000000000 },
  ]);
  const files = JSON.stringify([{ unit_file: "a.timer" }, { unit_file: "b.timer" }]);
  const show = [
    "Id=a.timer\nActiveState=active\nTimersMonotonic={ OnBootUSec=1min ; next_elapse=1min }",
    "Id=a.service\nActiveState=activating\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=@1791790000",
    "Id=b.timer\nActiveState=inactive\nUnitFileState=enabled\nTimersCalendar={ OnCalendar=Sat *-*-* 04:00:00 ; next_elapse=n/a }",
    "Id=b.service\nActiveState=failed\nResult=timeout\nExecMainStatus=0\nExecMainStartTimestamp=@1791790000",
    "Id=c.timer\nActiveState=active\nTimersCalendar={ OnCalendar=*-*-* 03:30:00 ; next_elapse=@1 }",
    "Id=c.service\nActiveState=failed\nResult=exit-code\nExecMainStatus=203",
  ].join("\n\n");
  const [a, c, b] = await listSystemdTimers(fake(list, show, files));
  assert.deepEqual([a.name, a.lastResult, a.schedule, a.timerState, a.description], ["a", "running", "OnBootUSec=1min", "active", null]);
  assert.deepEqual([b.name, b.lastResult, b.resultDetail, b.timerState, b.nextRunAt], ["b", "failed", "timeout", "inactive", null]);
  assert.equal(b.schedule, "Sat 04:00");
  assert.deepEqual([c.name, c.lastResult, c.resultDetail], ["c", "failed", "exit 203"]);
});

test("systemctl failure becomes an error answer, never a throw", async () => {
  const answer = await timersAnswer(async () => {
    throw new Error("Failed to connect to bus");
  });
  assert.deepEqual(answer.timers, []);
  assert.match(answer.error ?? "", /Failed to connect to bus/);
  assert.equal(botsTimersRpc.output.safeParse(answer).success, true);
  const ok = await timersAnswer(fake(), ALICE);
  assert.equal(ok.error, null);
  assert.equal(botsTimersRpc.output.safeParse(ok).success, true);
});

test("schedule and description helpers", () => {
  assert.equal(describeCalendar("*-*-* 03:30:00"), "daily 03:30");
  assert.equal(describeCalendar("Mon..Fri *-*-* 00:00:00 UTC"), "weekdays 00:00 UTC");
  assert.equal(describeCalendar("*-*-* *:00/5:00"), "every 5min");
  assert.equal(describeCalendar("*-*-01 04:00:00"), "*-*-01 04:00:00");
  assert.equal(
    describeSchedule(["{ OnCalendar=*-*-* 06:00:00 ; next_elapse=@1 }", "{ OnCalendar=*-*-* 18:00:00 ; next_elapse=@2 }"], []),
    "daily 06:00, 18:00",
  );
  assert.equal(summariseCalendars(["2026-11-16 23:25:00 UTC", "2026-11-15 05:50:00 UTC", "*-*-* 21:00:00", "*-*-* 03:00:00"]), "daily 03:00, 21:00, 2 one-off times");
  assert.equal(summariseCalendars(["*-*-01 04:00:00", "*-*-02 04:00:00", "*-*-03 04:00:00", "*-*-04 04:00:00"]), "*-*-01 04:00:00, *-*-02 04:00:00, *-*-03 04:00:00 +1 more");
  assert.equal(describeSchedule([], ["{ OnUnitInactiveUSec=1h ; next_elapse=1h }"]), "every 1h");
  assert.equal(cleanDescription('"Quoted thing"'), "Quoted thing");
  assert.equal(cleanDescription(""), null);
  assert.equal(cleanDescription(undefined), null);
  const units = parseShow("Id=x.timer\nTimersMonotonic=a\nTimersMonotonic=b\n\nId=y.timer\n");
  assert.deepEqual(units.get("x.timer")?.get("TimersMonotonic"), ["a", "b"]);
});

test("pause = disable --now, resume = enable --now (any user timer), then the fresh list", async () => {
  const run = fake();
  // A system timer can still be paused (the app offers it only once "Show all" lists it)…
  const paused = await setTimerPaused("snap.firmware-updater.firmware-notifier.timer", true, run, ALL);
  assert.equal(paused.error, null);
  assert.equal(paused.timers.length, 20);
  // …and also without includeAll (the old app has no toggle, but the name is still a real user timer);
  // the answer's list is then only yours.
  const resumed = await setTimerPaused("fc-emmet-checkin.timer", false, run, ALICE);
  assert.equal(resumed.timers.length, 15);
  assert.equal(resumed.error, null);
  assert.deepEqual(writes(run), [
    ["disable", "--now", "--", "snap.firmware-updater.firmware-notifier.timer"],
    ["enable", "--now", "--", "fc-emmet-checkin.timer"],
  ]);
  assert.equal(botsTimersSetRpc.output.safeParse(resumed).success, true);
});

test("set refuses names that are not an existing user .timer, and never writes", async () => {
  const run = fake();
  for (const unit of ["nope.timer", "fc-daily-standup.service", "fc-daily-standup", "-fc.timer", "a.timer; rm -rf ~", "../x.timer", ""]) {
    const answer = await setTimerPaused(unit, true, run, ALL);
    assert.match(answer.error ?? "", /not a timer unit name|no such user timer/, unit);
    assert.equal(answer.timers.length, 20, unit);
    assert.equal((await setTimerPaused(unit, true, run, ALICE)).timers.length, 15, unit);
  }
  assert.deepEqual(writes(run), []);
  // The RPC contract already rejects non-timer names before the handler.
  for (const unit of ["a.timer; rm -rf", "x.service", "-x.timer", "a b.timer"]) {
    assert.equal(botsTimersSetRpc.input.safeParse({ unit, paused: true }).success, false, unit);
  }
  assert.equal(botsTimersSetRpc.input.safeParse({ unit: "fc-daily-standup.timer", paused: false }).success, true);
  assert.equal(botsTimersSetRpc.input.safeParse({ unit: "dev-x\\x2dy.timer", paused: false }).success, true);
});

test("a failing systemctl write is an error answer with the current list", async () => {
  const base = fake();
  const run: Systemctl = async (args) => {
    if (args[0] === "enable") throw new Error("Unit has no installation config");
    return base(args);
  };
  const answer = await setTimerPaused("fc-emmet-checkin.timer", false, run, ALL);
  assert.match(answer.error ?? "", /could not resume fc-emmet-checkin\.timer: Unit has no installation config/);
  assert.equal(answer.timers.length, 20);
  assert.equal(botsTimersSetRpc.output.safeParse(answer).success, true);
});

test("system = unit file outside your home (distro /usr/lib, snap /etc/systemd/user), by location not name", async () => {
  const timers = await listSystemdTimers(fake(), ALICE);
  assert.deepEqual(timers.filter((t) => t.system).map((t) => t.name).sort(), SYSTEM);
  assert.equal(timers.filter((t) => !t.system).length, 15);
  for (const t of timers) assert.equal(typeof t.system, "boolean", t.unit);
  // Rule edges.
  assert.equal(isSystemUnit("/home/alice/.config/systemd/user/x.timer", ALICE), false);
  assert.equal(isSystemUnit("/home/alice/.local/share/systemd/user/x.timer", ALICE), false);
  assert.equal(isSystemUnit("/home/alice/code/units/x.timer", ALICE), false); // systemctl --user link
  assert.equal(isSystemUnit("/run/user/1000/systemd/transient/run-r1.timer", ALICE), false); // systemd-run
  assert.equal(isSystemUnit("/run/user/1001/systemd/transient/run-r1.timer", ALICE), true);
  assert.equal(isSystemUnit("/home/alicesse/.config/systemd/user/x.timer", ALICE), true); // prefix, not a dir
  assert.equal(isSystemUnit("/usr/lib/systemd/user/x.timer", ALICE), true);
  assert.equal(isSystemUnit("/lib/systemd/user/x.timer", ALICE), true);
  assert.equal(isSystemUnit("/etc/systemd/user/snap.x.timer", ALICE), true);
  assert.equal(isSystemUnit("/usr/local/lib/systemd/user/x.timer", ALICE), true);
  assert.equal(isSystemUnit("", ALICE), false); // cannot place it: show it
  assert.equal(isSystemUnit(undefined, ALICE), false);
  assert.equal(isSystemUnit("/home/alice/.config/systemd/user/x.timer", { home: "/home/alice/", uid: 1000 }), false);
});

test("bots.timers hides system timers unless includeAll (an app sending {} sees only yours)", async () => {
  const mine = await timersAnswer(fake(), ALICE);
  assert.equal(mine.timers.length, 15);
  assert.ok(mine.timers.every((t) => !t.system));
  assert.ok(mine.timers.some((t) => t.name === "fc-emmet-checkin")); // paused ones stay
  const all = await timersAnswer(fake(), ALL);
  assert.equal(all.timers.length, 20);
  assert.equal(all.timers.filter((t) => t.system).length, 5);
  assert.equal((await timersAnswer(fake(), { ...ALICE, includeAll: false })).timers.length, 15);
  // The contract: {} (current TestFlight app) and { includeAll } both valid, includeAll optional.
  assert.deepEqual(botsTimersRpc.input.parse({}), {});
  assert.deepEqual(botsTimersRpc.input.parse({ includeAll: true }), { includeAll: true });
  assert.equal(botsTimersRpc.input.safeParse({ includeAll: "yes" }).success, false);
  assert.equal(botsTimersSetRpc.input.safeParse({ unit: "a.timer", paused: true }).success, true);
  assert.equal(botsTimersSetRpc.input.safeParse({ unit: "a.timer", paused: true, includeAll: true }).success, true);
  assert.equal(botsTimersRpc.output.safeParse(all).success, true);
});
