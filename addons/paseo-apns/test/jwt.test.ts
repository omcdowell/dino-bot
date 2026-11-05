import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApnsKeyError, MIN_REFRESH_MS, ProviderToken } from "../server/jwt.ts";
import { decodeJwt, tempDir, throwawayKey } from "./helpers.ts";

test("mints an ES256 JWT with kid/iss/iat that verifies with the key's public half", (t) => {
  const dir = tempDir(t);
  const { keyPath, publicKey } = throwawayKey(dir);
  const token = new ProviderToken({ keyPath, keyId: "TESTKEY001", teamId: "TESTTEAM01", reuseMs: 40 * 60_000, now: () => 1_700_000_000_000 });
  const jwt = decodeJwt(token.get());
  assert.deepEqual(jwt.header, { alg: "ES256", kid: "TESTKEY001" });
  assert.deepEqual(jwt.claims, { iss: "TESTTEAM01", iat: 1_700_000_000 });
  assert.equal(jwt.signature.length, 64, "raw r||s, not DER");
  assert.ok(verify("sha256", Buffer.from(jwt.input), { key: publicKey, dsaEncoding: "ieee-p1363" }, jwt.signature));
});

test("reuses the token inside reuseMs and reads the key only when minting", (t) => {
  const dir = tempDir(t);
  const { keyPath } = throwawayKey(dir);
  let now = 0;
  let reads = 0;
  const token = new ProviderToken({
    keyPath,
    keyId: "TESTKEY001",
    teamId: "TESTTEAM01",
    reuseMs: 40 * 60_000,
    now: () => now,
    readKey: (p) => {
      reads++;
      return readFileSync(p);
    },
  });
  const first = token.get();
  now = 39 * 60_000;
  assert.equal(token.get(), first);
  assert.equal(reads, 1);
  now = 40 * 60_000;
  assert.notEqual(token.get(), first);
  assert.equal(reads, 2);
});

test("refresh() refuses inside 20 minutes (TooManyProviderTokenUpdates) and mints after", (t) => {
  const dir = tempDir(t);
  const { keyPath } = throwawayKey(dir);
  let now = 0;
  const token = new ProviderToken({ keyPath, keyId: "TESTKEY001", teamId: "TESTTEAM01", reuseMs: 40 * 60_000, now: () => now });
  const first = token.get();
  now = MIN_REFRESH_MS - 1;
  assert.equal(token.refresh(), null);
  now = MIN_REFRESH_MS;
  const second = token.refresh();
  assert.ok(second && second !== first);
});

test("a missing key surfaces only its error code", (t) => {
  const dir = tempDir(t);
  const token = new ProviderToken({ keyPath: join(dir, "absent.p8"), keyId: "TESTKEY001", teamId: "TESTTEAM01", reuseMs: 1 });
  assert.throws(
    () => token.get(),
    (e: unknown) => e instanceof ApnsKeyError && e.code === "ENOENT" && !e.message.includes(dir),
  );
});

test("a malformed key surfaces an OpenSSL code, never the file content", (t) => {
  const dir = tempDir(t);
  const keyPath = join(dir, "bad.p8");
  writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nSECRETBYTES\n-----END PRIVATE KEY-----\n");
  const token = new ProviderToken({ keyPath, keyId: "TESTKEY001", teamId: "TESTTEAM01", reuseMs: 1 });
  assert.throws(
    () => token.get(),
    (e: unknown) => e instanceof ApnsKeyError && /^ERR_/.test(e.code) && !e.message.includes("SECRETBYTES"),
  );
});
