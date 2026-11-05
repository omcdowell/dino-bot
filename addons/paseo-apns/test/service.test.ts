import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { loadSettings } from "../server/config.ts";
import { join } from "node:path";
import { ApnsService } from "../server/service.ts";
import { RateLimiter } from "../server/rate-limit.ts";
import { fakeApns, settings, tempDir, throwawayKey, TOKEN_A, TOKEN_B, type Responder } from "./helpers.ts";

type T = Parameters<typeof tempDir>[0] & { after(fn: () => unknown): void };

async function service(t: T, opts: { responder?: Responder; over?: Parameters<typeof settings>[2]; now?: { now: number } } = {}) {
  const dir = tempDir(t);
  const { keyPath } = throwawayKey(dir);
  const fake = await fakeApns(t, opts.responder);
  const clock = opts.now ?? { now: Date.parse("2026-10-10T08:00:00Z") };
  const svc = new ApnsService({ settings: settings(join(dir, "state"), keyPath, opts.over), transport: fake.transport, now: () => clock.now, retryDelayMs: () => 1 });
  t.after(() => svc.stop());
  return { svc, dir: join(dir, "state"), clock, ...fake };
}

const logOf = (dir: string) =>
  readFileSync(join(dir, "push-log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const msg = { sender: "helper", title: "Helper", body: "OAuth token expires in 2 h", data: { kind: "bot-dm", dmId: "X" } };

test("no registered device: refused with no_device, logged, no APNs call", async (t) => {
  const s = await service(t);
  const out = await s.svc.notify(msg);
  assert.equal(out.code, "no_device");
  assert.equal(s.seen.length, 0);
  assert.equal(logOf(s.dir).at(-1).event, "refused");
});

test("not configured: refused with not_configured", async (t) => {
  const s = await service(t, { over: { apns: null, configError: "config.json missing" } });
  const out = await s.svc.notify(msg);
  assert.equal(out.code, "not_configured");
  assert.match((out as { message: string }).message, /config.json missing/);
});

test("register rejects a foreign topic and accepts ours; store and log are 600, dir 700", async (t) => {
  const s = await service(t);
  assert.equal(s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.other.app" }).ok, false);
  const ok = s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app", name: "iPhone" });
  assert.deepEqual(ok, { ok: true, devices: 1, reason: null });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" }); // refresh, no duplicate
  assert.equal(s.svc.devices.list().length, 1);
  assert.equal(statSync(join(s.dir, "devices.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.dir, "push-log.jsonl")).mode & 0o777, 0o600);
  assert.equal(statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(logOf(s.dir).filter((e) => e.event === "registered").length, 1, "re-register is not logged again");
});

test("sends to every device, data gets kind/serverId, logged with token tails only", async (t) => {
  const s = await service(t);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  s.svc.register({ token: TOKEN_B, environment: "production", topic: "com.example.app" });
  const out = await s.svc.notify(msg);
  assert.equal(out.ok, true);
  assert.equal((out as { sent: number }).sent, 2);
  assert.equal(s.seen.length, 2);
  const body = JSON.parse(s.seen[0]!.body);
  assert.deepEqual(body.body, { kind: "bot-dm", serverId: "srv_test", dmId: "X", source: "paseo-apns" });
  const log = readFileSync(join(s.dir, "push-log.jsonl"), "utf8");
  assert.ok(!log.includes(TOKEN_A) && !log.includes(TOKEN_B), "full tokens never logged");
  assert.ok(log.includes("…aaaaaaaa"));
  assert.equal(logOf(s.dir).at(-1).event, "sent");
});

test("global rate limit: second push inside 10 min is refused with the next slot, across senders", async (t) => {
  const s = await service(t);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  assert.equal((await s.svc.notify(msg)).ok, true);
  s.clock.now += 4 * 60_000;
  const out = await s.svc.notify({ ...msg, sender: "flint" });
  assert.equal(out.code, "rate_limited");
  const r = out as { retryAt: string; retryInSeconds: number; message: string };
  assert.equal(r.retryAt, "2026-10-10T08:10:00.000Z");
  assert.equal(r.retryInSeconds, 360);
  assert.match(r.message, /next slot at 2026-10-10T08:10:00.000Z/);
  assert.equal(s.seen.length, 1, "refused, not queued");
  const refused = logOf(s.dir).at(-1);
  assert.equal(refused.event, "refused");
  assert.equal(refused.sender, "flint");
  s.clock.now += 6 * 60_000;
  assert.equal((await s.svc.notify({ ...msg, sender: "flint" })).ok, true);
});

test("perSender option: senders get their own windows", async (t) => {
  const s = await service(t, { over: { perSender: true } });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  assert.equal((await s.svc.notify(msg)).ok, true);
  assert.equal((await s.svc.notify({ ...msg, sender: "flint" })).ok, true);
  assert.equal((await s.svc.notify(msg)).code, "rate_limited");
});

test("the limit survives a restart (restored from the log)", async (t) => {
  const s = await service(t);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  await s.svc.notify(msg);
  const again = new ApnsService({ settings: s.svc.options.settings, transport: s.transport, now: () => s.clock.now + 60_000 });
  assert.equal((await again.notify(msg)).code, "rate_limited");
});

test("410 drops the token and logs it; nothing delivered gives the slot back", async (t) => {
  const s = await service(t, { responder: () => ({ status: 410, reason: "Unregistered" }) });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  const out = await s.svc.notify(msg);
  assert.equal(out.code, "apns_failed");
  assert.equal(s.svc.devices.list().length, 0);
  assert.ok(logOf(s.dir).some((e) => e.event === "token-dropped" && e.device === "…aaaaaaaa"));
  assert.equal(logOf(s.dir).at(-1).event, "failed");
  s.svc.register({ token: TOKEN_B, environment: "development", topic: "com.example.app" });
  assert.notEqual((await s.svc.notify(msg)).code, "rate_limited", "slot was returned");
});

test("key error: refused with the code only, slot returned, no APNs call", async (t) => {
  const dir = tempDir(t);
  const fake = await fakeApns(t);
  const svc = new ApnsService({ settings: settings(dir, join(dir, "missing.p8")), transport: fake.transport });
  t.after(() => svc.stop());
  svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  const out = await svc.notify(msg);
  assert.deepEqual(out, { ok: false, code: "key_error", message: "APNs key could not be used (ENOENT)" });
  assert.equal(fake.seen.length, 0);
  assert.equal(svc.limiter.check("helper", Date.now()).ok, true);
});

test("revoke removes the device", async (t) => {
  const s = await service(t);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  assert.deepEqual(s.svc.revoke(TOKEN_A), { ok: true, removed: true });
  assert.deepEqual(s.svc.revoke(TOKEN_A), { ok: true, removed: false });
  assert.equal(s.svc.devices.list().length, 0);
});

test("RateLimiter.take give-back does not undo a newer slot", () => {
  const l = new RateLimiter(1000, false);
  const back = l.take("a", 0);
  l.take("a", 5000);
  back();
  assert.equal(l.check("a", 5500).ok, false);
});

// ---- per-bot limit --------------------------------------------------------------------

test("perSender: a refusal gives that sender's own slot, not another sender's", async (t) => {
  const s = await service(t, { over: { perSender: true } });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  assert.equal((await s.svc.notify(msg)).ok, true); // helper 08:00
  s.clock.now += 3 * 60_000;
  assert.equal((await s.svc.notify({ ...msg, sender: "flint" })).ok, true); // flint 08:03
  s.clock.now += 2 * 60_000;
  const out = (await s.svc.notify({ ...msg, sender: "flint" })) as { code: string; retryAt: string; message: string };
  assert.equal(out.code, "rate_limited");
  assert.equal(out.retryAt, "2026-10-10T08:13:00.000Z");
  assert.match(out.message, /one push per 10 min per sender \(flint\); next slot at 2026-10-10T08:13:00.000Z/);
  assert.doesNotMatch(out.message, /all/);
  const helper = (await s.svc.notify(msg)) as { retryAt: string };
  assert.equal(helper.retryAt, "2026-10-10T08:10:00.000Z");
});

test("perSender: limitKey charges a worker's push to its launching bot", async (t) => {
  const s = await service(t, { over: { perSender: true } });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  assert.equal((await s.svc.notify(msg)).ok, true);
  const worker = await s.svc.notify({ ...msg, sender: "worker:fix-x", limitKey: "helper" });
  assert.equal(worker.code, "rate_limited", "a worker cannot dodge its bot's limit");
  const refused = logOf(s.dir).at(-1);
  assert.equal(refused.sender, "worker:fix-x");
  assert.equal(refused.limitKey, "helper");
  assert.equal((await s.svc.notify({ ...msg, sender: "worker:loose" })).ok, true, "an unattributed worker is its own sender");
});

test("perSender: restore after a reload keys each slot by sender (and limitKey)", async (t) => {
  const s = await service(t, { over: { perSender: true } });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  await s.svc.notify(msg); // helper 08:00
  s.clock.now += 3 * 60_000;
  await s.svc.notify({ ...msg, sender: "worker:w1", limitKey: "flint" }); // flint's slot 08:03
  const again = new ApnsService({ settings: s.svc.options.settings, transport: s.transport, now: () => s.clock.now + 60_000 });
  assert.equal(((await again.notify(msg)) as { retryAt: string }).retryAt, "2026-10-10T08:10:00.000Z");
  assert.equal(((await again.notify({ ...msg, sender: "flint" })) as { retryAt: string }).retryAt, "2026-10-10T08:13:00.000Z");
  assert.equal(again.limiter.check("worker:w1", s.clock.now + 60_000).ok, true, "slot was keyed on flint, not the worker");
  assert.equal((await again.notify({ ...msg, sender: "matilda" })).ok, true);
});

test("status(sender) gives that sender's next slot in perSender mode", async (t) => {
  const s = await service(t, { over: { perSender: true } });
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  await s.svc.notify(msg);
  assert.equal(s.svc.status("helper").nextSlotAt, "2026-10-10T08:10:00.000Z");
  assert.equal(s.svc.status("flint").nextSlotAt, null);
  assert.equal(s.svc.status().nextSlotAt, null);
});

// ---- local mode (no remote push) ------------------------------------------------------------

test("local mode: alerts are refused with push_off; the sync still answers the busy bots with pushes: false", async (t) => {
  const dir = tempDir(t);
  const svc = new ApnsService({ settings: { ...settings(dir, "/nonexistent.p8"), mode: "local", apns: null } });
  t.after(() => svc.stop());
  const result = await svc.notify(msg);
  assert.equal(result.ok, false);
  assert.equal(result.code, "push_off");
  svc.liveActivity.setBots([{ id: "b1", name: "Helper", working: true, workers: 0, since: 1 }]);
  const answer = svc.liveActivitySync({ installId: "install-1", environment: "production", topic: "com.example.app", startToken: null, activities: [] });
  assert.equal(answer.ok, true);
  assert.equal(answer.pushes, false);
  assert.equal((answer.state as { bots: unknown[] } | null)?.bots.length, 1);
  assert.equal(svc.status().mode, "local");
  assert.equal(svc.status().pushes, false);
});

test("loadSettings: no config.json means local mode; config.json without mode stays apns", (t) => {
  const dir = tempDir(t);
  assert.equal(loadSettings({ PASEO_APNS_DIR: dir, PASEO_HOME: dir }).mode, "local");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ mode: "local" }));
  const local = loadSettings({ PASEO_APNS_DIR: dir, PASEO_HOME: dir });
  assert.equal(local.mode, "local");
  assert.equal(local.configError, null);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ keyPath: "/k.p8", keyId: "KEYID12345", teamId: "TEAMID1234", topic: "com.example.app" }));
  assert.equal(loadSettings({ PASEO_APNS_DIR: dir, PASEO_HOME: dir }).mode, "apns");
});
