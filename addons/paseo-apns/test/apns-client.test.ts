import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { ApnsSender, buildPayload, MAX_PAYLOAD_BYTES } from "../server/apns-client.ts";
import { ProviderToken } from "../server/jwt.ts";
import { decodeJwt, fakeApns, tempDir, throwawayKey, TOKEN_A, type Responder } from "./helpers.ts";

async function setup(t: Parameters<typeof tempDir>[0] & { after(fn: () => unknown): void }, responder?: Responder, nowRef = { now: 1_700_000_000_000 }) {
  const dir = tempDir(t);
  const { keyPath, publicKey } = throwawayKey(dir);
  const fake = await fakeApns(t, responder);
  let mints = 0;
  const token = new ProviderToken({
    keyPath,
    keyId: "TESTKEY001",
    teamId: "TESTTEAM01",
    reuseMs: 40 * 60_000,
    now: () => nowRef.now,
    readKey: (p) => {
      mints++;
      return readFileSync(p);
    },
  });
  const sender = new ApnsSender({ transport: fake.transport, token, topic: "com.example.app", now: () => nowRef.now, retryDelayMs: () => 1 });
  return { ...fake, sender, publicKey, mints: () => mints, nowRef };
}

const payload = buildPayload({ title: "Helper", body: "OAuth expires in 2 h", data: { kind: "bot-dm", from: "helper" } });

test("POSTs /3/device/<token> with the APNs headers and a verifiable bearer JWT", async (t) => {
  const s = await setup(t);
  const out = await s.sender.send("development", TOKEN_A, payload, "oauth-1");
  assert.deepEqual(out, { status: "sent", apnsId: "id-1" });
  const [req] = s.seen;
  assert.equal(req!.path, `/3/device/${TOKEN_A}`);
  assert.equal(req!.headers[":method"], "POST");
  assert.equal(req!.headers["apns-topic"], "com.example.app");
  assert.equal(req!.headers["apns-push-type"], "alert");
  assert.equal(req!.headers["apns-priority"], "10");
  assert.equal(req!.headers["apns-collapse-id"], "oauth-1");
  assert.equal(Number(req!.headers["apns-expiration"]), 1_700_000_000 + 86_400);
  const jwt = decodeJwt(String(req!.headers.authorization).replace(/^bearer /, ""));
  assert.equal(jwt.header.kid, "TESTKEY001");
  assert.equal(jwt.claims.iss, "TESTTEAM01");
  assert.ok(verify("sha256", Buffer.from(jwt.input), { key: s.publicKey, dsaEncoding: "ieee-p1363" }, jwt.signature));
});

test("payload: alert + default sound, no badge, data under top-level body (expo-notifications)", async (t) => {
  const s = await setup(t);
  await s.sender.send("development", TOKEN_A, payload);
  const body = JSON.parse(s.seen[0]!.body);
  assert.deepEqual(body, {
    aps: { alert: { title: "Helper", body: "OAuth expires in 2 h" }, sound: "default" },
    body: { kind: "bot-dm", from: "helper" },
  });
  assert.equal("badge" in body.aps, false);
});

test("reuses one JWT across sends (one key read)", async (t) => {
  const s = await setup(t);
  await s.sender.send("development", TOKEN_A, payload);
  await s.sender.send("development", TOKEN_A, payload);
  await s.sender.send("production", TOKEN_A, payload);
  assert.equal(s.mints(), 1);
  assert.equal(s.seen[0]!.headers.authorization, s.seen[2]!.headers.authorization);
});

test("410 Unregistered and 400 BadDeviceToken/DeviceTokenNotForTopic drop the token", async (t) => {
  const reasons = [
    { status: 410, reason: "Unregistered" },
    { status: 400, reason: "BadDeviceToken" },
    { status: 400, reason: "DeviceTokenNotForTopic" },
  ];
  const s = await setup(t, (_r, n) => reasons[n - 1]!);
  for (const r of reasons) {
    assert.deepEqual(await s.sender.send("development", TOKEN_A, payload), { status: "dropped", reason: r.reason, http: r.status });
  }
});

test("other 400s fail without dropping or retrying", async (t) => {
  const s = await setup(t, () => ({ status: 400, reason: "PayloadTooLarge" }));
  assert.deepEqual(await s.sender.send("development", TOKEN_A, payload), { status: "failed", reason: "PayloadTooLarge", http: 400, retried: false });
  assert.equal(s.seen.length, 1);
});

test("403 ExpiredProviderToken: mints a new JWT once (if 20 min have passed) and retries", async (t) => {
  const nowRef = { now: 0 };
  const s = await setup(t, (_r, n) => (n === 2 ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 }), nowRef);
  await s.sender.send("development", TOKEN_A, payload); // mint 1
  nowRef.now = 25 * 60_000;
  const out = await s.sender.send("development", TOKEN_A, payload);
  assert.equal(out.status, "sent");
  assert.equal(s.mints(), 2);
  assert.notEqual(s.seen[1]!.headers.authorization, s.seen[2]!.headers.authorization);
});

test("403 ExpiredProviderToken inside 20 min: no re-mint, fails", async (t) => {
  const s = await setup(t, () => ({ status: 403, reason: "ExpiredProviderToken" }));
  const out = await s.sender.send("development", TOKEN_A, payload);
  assert.deepEqual(out, { status: "failed", reason: "ExpiredProviderToken", http: 403, retried: false });
  assert.equal(s.mints(), 1);
});

test("403 InvalidProviderToken fails without retry", async (t) => {
  const s = await setup(t, () => ({ status: 403, reason: "InvalidProviderToken" }));
  assert.equal((await s.sender.send("development", TOKEN_A, payload)).status, "failed");
  assert.equal(s.seen.length, 1);
});

test("5xx retries once, then reports failure", async (t) => {
  const s = await setup(t, () => ({ status: 503, reason: "ServiceUnavailable" }));
  assert.deepEqual(await s.sender.send("development", TOKEN_A, payload), { status: "failed", reason: "ServiceUnavailable", http: 503, retried: true });
  assert.equal(s.seen.length, 2);
});

test("5xx then 200 succeeds on the retry", async (t) => {
  const s = await setup(t, (_r, n) => (n === 1 ? { status: 500, reason: "InternalServerError" } : { status: 200 }));
  assert.equal((await s.sender.send("development", TOKEN_A, payload)).status, "sent");
});

test("429 TooManyRequests fails without retry", async (t) => {
  const s = await setup(t, () => ({ status: 429, reason: "TooManyRequests" }));
  assert.equal((await s.sender.send("development", TOKEN_A, payload)).status, "failed");
  assert.equal(s.seen.length, 1);
});

test("network failure retries once, then fails with the error code", async (t) => {
  const dir = tempDir(t);
  const { keyPath } = throwawayKey(dir);
  const { Http2Transport } = await import("../server/apns-client.ts");
  const transport = new Http2Transport({ origins: { development: "http://127.0.0.1:1" }, timeoutMs: 500 });
  t.after(() => transport.close());
  const sender = new ApnsSender({
    transport,
    token: new ProviderToken({ keyPath, keyId: "TESTKEY001", teamId: "TESTTEAM01", reuseMs: 1e9 }),
    topic: "com.example.app",
    retryDelayMs: () => 1,
  });
  const out = await sender.send("development", TOKEN_A, payload);
  assert.equal(out.status, "failed");
  assert.equal((out as { retried: boolean }).retried, true);
  assert.equal((out as { http: number | null }).http, null);
});

test("buildPayload stays within 4096 bytes for a 4000-char multibyte body", () => {
  const json = buildPayload({ title: "T".repeat(300), body: "é".repeat(4000), data: { kind: "bot-dm" } });
  assert.ok(Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES);
  const parsed = JSON.parse(json);
  assert.ok(parsed.aps.alert.body.endsWith("…"));
  assert.equal(parsed.aps.alert.title.length, 120);
});
