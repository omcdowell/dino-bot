import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ApnsService } from "../server/service.ts";
import { loadSettings } from "../server/config.ts";
import { authorised, parseNotify } from "../server/endpoint.ts";
import { fakeApns, settings, tempDir, throwawayKey, TOKEN_A } from "./helpers.ts";

type T = Parameters<typeof tempDir>[0] & { after(fn: () => unknown): void };

async function running(t: T) {
  const dir = tempDir(t);
  const { keyPath } = throwawayKey(dir);
  const fake = await fakeApns(t);
  const state = join(dir, "state");
  const svc = new ApnsService({ settings: settings(state, keyPath), transport: fake.transport });
  const port = await svc.start();
  t.after(() => svc.stop());
  const token = readFileSync(join(state, "notify-token"), "utf8").trim();
  const call = (path: string, init: RequestInit = {}, auth: string | null = token) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) },
    });
  return { svc, state, token, call, fake };
}

const post = (body: unknown) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const msg = { sender: "helper", title: "Helper", body: "hello" };

test("creates the notify token 600 in a 700 dir, and refuses requests without it", async (t) => {
  const s = await running(t);
  assert.equal(statSync(join(s.state, "notify-token")).mode & 0o777, 0o600);
  assert.equal(statSync(s.state).mode & 0o777, 0o700);
  assert.match(s.token, /^[0-9a-f]{64}$/);
  assert.equal((await s.call("/status", {}, null)).status, 401);
  assert.equal((await s.call("/status", {}, "wrong")).status, 401);
  assert.equal((await s.call("/notify", post(msg), "x".repeat(64))).status, 401);
});

test("GET /status reports config, devices and the next slot", async (t) => {
  const s = await running(t);
  let body = await (await s.call("/status")).json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
  assert.equal(body.devices, 0);
  assert.equal(body.nextSlotAt, null);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  await s.call("/notify", post(msg));
  body = await (await s.call("/status")).json() as any;
  assert.equal(body.devices, 1);
  assert.deepEqual(body.environments, ["development"]);
  assert.ok(body.nextSlotAt);
});

test("POST /notify: 409 no device, 200 sent, 429 with Retry-After", async (t) => {
  const s = await running(t);
  let res = await s.call("/notify", post(msg));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as any).code, "no_device");
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  res = await s.call("/notify", post(msg));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).sent, 1);
  res = await s.call("/notify", post({ ...msg, sender: "worker:oauth-watch" }));
  assert.equal(res.status, 429);
  const limited = (await res.json()) as any;
  assert.equal(limited.code, "rate_limited");
  assert.ok(Number(res.headers.get("retry-after")) > 590);
  assert.equal(s.fake.seen.length, 1);
});

test("bad input: 400 for non-JSON and bad fields, 413 over 16 KB, 404 elsewhere", async (t) => {
  const s = await running(t);
  assert.equal((await s.call("/notify", post("{nope"))).status, 400);
  assert.equal((await s.call("/notify", post({ ...msg, sender: "bad sender!" }))).status, 400);
  assert.equal((await s.call("/notify", post({ ...msg, title: "" }))).status, 400);
  assert.equal((await s.call("/notify", post("x".repeat(20_000)))).status, 413);
  assert.equal((await s.call("/nothing")).status, 404);
});

test("parseNotify trims and accepts data/collapseId; caps data at 1 KB", () => {
  assert.deepEqual(parseNotify({ sender: "flint", title: " T ", body: " B ", data: { a: 1 }, collapseId: "k" }), {
    sender: "flint",
    title: "T",
    body: "B",
    data: { a: 1 },
    collapseId: "k",
  });
  assert.equal(typeof parseNotify({ ...msg, data: { big: "x".repeat(2000) } }), "string");
  assert.equal(typeof parseNotify({ ...msg, collapseId: "x".repeat(65) }), "string");
});

test("authorised: bearer only, constant-time compare", () => {
  assert.equal(authorised("Bearer abc", "abc"), true);
  assert.equal(authorised("bearer abc", "abc"), true);
  assert.equal(authorised("Basic abc", "abc"), false);
  assert.equal(authorised(undefined, "abc"), false);
});

test("loadSettings: defaults, validation and clamps; never touches the key path", (t) => {
  const dir = tempDir(t);
  let s = loadSettings({ PASEO_APNS_DIR: dir, PASEO_HOME: dir });
  assert.equal(s.apns, null);
  assert.equal(s.configError, "config.json missing");
  assert.equal(s.port, 6790);
  assert.equal(s.rateWindowMs, 600_000);
  assert.equal(s.perSender, false);
  assert.equal(s.jwtReuseMs, 40 * 60_000);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server-id"), "srv_abc\n");
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      keyPath: "/nonexistent/AuthKey_test-key.p8",
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
      topic: "com.example.app",
      port: 7001,
      rateLimit: { windowSeconds: 60, perSender: true },
      jwtReuseMinutes: 90,
    }),
  );
  s = loadSettings({ PASEO_APNS_DIR: dir, PASEO_HOME: dir });
  assert.deepEqual(s.apns, { keyPath: "/nonexistent/AuthKey_test-key.p8", keyId: "KEYID12345", teamId: "TEAMID1234", topic: "com.example.app" });
  assert.equal(s.port, 7001);
  assert.equal(s.rateWindowMs, 60_000);
  assert.equal(s.perSender, true);
  assert.equal(s.jwtReuseMs, 50 * 60_000, "clamped to 50 min");
  assert.equal(s.serverId, "srv_abc");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ keyPath: "relative.p8", keyId: "KEYID12345", teamId: "TEAMID1234", topic: "x" }));
  assert.equal(loadSettings({ PASEO_APNS_DIR: dir, PASEO_HOME: dir }).configError, "keyPath must be an absolute path");
});

test("parseNotify takes an optional limitKey (a sender name)", () => {
  assert.deepEqual(parseNotify({ ...msg, sender: "worker:w1", limitKey: "helper" }), { ...msg, sender: "worker:w1", limitKey: "helper" });
  assert.equal(typeof parseNotify({ ...msg, limitKey: "bad key!" }), "string");
});

test("GET /status?sender= answers for that sender", async (t) => {
  const s = await running(t);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  await s.call("/notify", post(msg));
  const body = (await (await s.call("/status?sender=helper")).json()) as any;
  assert.ok(body.nextSlotAt);
  assert.equal((await s.call("/status?sender=bad%20one")).status, 400);
});
