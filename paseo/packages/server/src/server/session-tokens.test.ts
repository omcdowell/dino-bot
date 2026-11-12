import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { resolveSessionAdmission } from "./session-admission-auth.js";
import { SessionTokenStore } from "./session-tokens.js";

const HASH_A = "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "$2b$12$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = { principalId: "owner", permissions: OWNER_PERMISSIONS };
const PHONE = { clientId: "clsk_phone", channel: "direct:protected" };
const HOUR = 60 * 60 * 1000;

function harness(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000_000;
  let passwordHash: string | undefined = HASH_A;
  const store = new SessionTokenStore({
    getPasswordHash: () => passwordHash,
    now: () => now,
    ...options,
  });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
    setPasswordHash: (hash: string | undefined) => {
      passwordHash = hash;
    },
  };
}

describe("session tokens", () => {
  test("a token issued to a device admits that device again", () => {
    const { store } = harness();
    const issued = store.issue(OWNER, PHONE);
    expect(issued?.token).toMatch(/^pst1\.[\w-]+\.[\w-]+$/);
    expect(store.verify(issued!.token, PHONE)).toEqual({ ...OWNER, renew: false });
  });

  test("is refused for another clientId, another channel, or a tampered secret", () => {
    const { store } = harness();
    const { token } = store.issue(OWNER, PHONE)!;
    expect(store.verify(token, { ...PHONE, clientId: "clsk_other" })).toBeNull();
    expect(store.verify(token, { ...PHONE, channel: "direct:none" })).toBeNull();
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(store.verify(tampered, PHONE)).toBeNull();
    expect(store.verify("pst1.nope.nope", PHONE)).toBeNull();
    expect(store.verify("garbage", PHONE)).toBeNull();
    expect(store.verify(token, PHONE)).not.toBeNull();
  });

  test("expires after its lifetime and asks for renewal in its second half", () => {
    const { store, advance } = harness({ ttlMs: 24 * HOUR });
    const { token, expiresAt } = store.issue(OWNER, PHONE)!;
    expect(expiresAt).toBe(1_000_000 + 24 * HOUR);
    advance(11 * HOUR);
    expect(store.verify(token, PHONE)?.renew).toBe(false);
    advance(2 * HOUR);
    expect(store.verify(token, PHONE)?.renew).toBe(true);
    advance(11 * HOUR);
    expect(store.verify(token, PHONE)).toBeNull();
    expect(store.size).toBe(0);
  });

  test("a password change invalidates every token", () => {
    const { store, setPasswordHash } = harness();
    const { token } = store.issue(OWNER, PHONE)!;
    setPasswordHash(HASH_B);
    expect(store.verify(token, PHONE)).toBeNull();
    // Removing the password also ends token admission (and issuing).
    setPasswordHash(undefined);
    expect(store.verify(token, PHONE)).toBeNull();
    expect(store.issue(OWNER, PHONE)).toBeNull();
  });

  test("a daemon restart (new store, new key) invalidates every token", () => {
    const first = harness();
    const { token } = first.store.issue(OWNER, PHONE)!;
    const restarted = harness();
    expect(restarted.store.verify(token, PHONE)).toBeNull();
  });

  test("tokens can be revoked per device or all at once", () => {
    const { store } = harness();
    const phone = store.issue(OWNER, PHONE)!.token;
    const laptop = store.issue(OWNER, {
      clientId: "clsk_laptop",
      channel: "relay:protected",
    })!.token;
    expect(store.revokeClient("clsk_phone")).toBe(true);
    expect(store.revokeClient("clsk_phone")).toBe(false);
    expect(store.verify(phone, PHONE)).toBeNull();
    expect(
      store.verify(laptop, { clientId: "clsk_laptop", channel: "relay:protected" }),
    ).not.toBeNull();
    store.revokeAll();
    expect(
      store.verify(laptop, { clientId: "clsk_laptop", channel: "relay:protected" }),
    ).toBeNull();
  });

  test("a new token for a device replaces its previous one", () => {
    const { store } = harness();
    const first = store.issue(OWNER, PHONE)!.token;
    const second = store.issue(OWNER, PHONE)!.token;
    expect(store.verify(first, PHONE)).toBeNull();
    expect(store.verify(second, PHONE)).not.toBeNull();
    expect(store.size).toBe(1);
  });

  test("keeps at most maxEntries tokens, dropping the oldest", () => {
    const { store } = harness({ maxEntries: 2 });
    const a = store.issue(OWNER, { clientId: "a", channel: "direct:none" })!.token;
    const b = store.issue(OWNER, { clientId: "b", channel: "direct:none" })!.token;
    const c = store.issue(OWNER, { clientId: "c", channel: "direct:none" })!.token;
    expect(store.size).toBe(2);
    expect(store.verify(a, { clientId: "a", channel: "direct:none" })).toBeNull();
    expect(store.verify(b, { clientId: "b", channel: "direct:none" })).not.toBeNull();
    expect(store.verify(c, { clientId: "c", channel: "direct:none" })).not.toBeNull();
  });
});

describe("hello admission with a session token", () => {
  test("admits a valid token without the password and reports the method", async () => {
    const { store } = harness();
    const { token } = store.issue(OWNER, PHONE)!;
    const resolved = await resolveSessionAdmission({
      credential: { kind: "sessionToken", token },
      passwordHash: HASH_A,
      localCredential: null,
      transport: "direct",
      verifySessionToken: (presented) => store.verify(presented, PHONE),
    });
    expect(resolved).toMatchObject({
      admission: { principalId: "owner" },
      method: "sessionToken",
      renewToken: false,
    });
  });

  test("refuses an unknown token as session_token_invalid, not as a wrong password", async () => {
    const { store } = harness();
    const resolved = await resolveSessionAdmission({
      credential: { kind: "sessionToken", token: "pst1.x.y" },
      passwordHash: HASH_A,
      localCredential: null,
      transport: "direct",
      verifySessionToken: (presented) => store.verify(presented, PHONE),
    });
    expect(resolved).toEqual({ rejection: "session_token_invalid" });
  });

  test("refuses a token when the daemon has no verifier", async () => {
    expect(
      await resolveSessionAdmission({
        credential: { kind: "sessionToken", token: "pst1.x.y" },
        passwordHash: HASH_A,
        localCredential: null,
        transport: "relay",
      }),
    ).toEqual({ rejection: "session_token_invalid" });
  });
});

describe("session tokens across a restart (RU1)", () => {
  function persisted() {
    const dir = mkdtempSync(path.join(tmpdir(), "session-tokens-"));
    const file = path.join(dir, "session-tokens.json");
    let now = 1_000_000;
    let passwordHash: string | undefined = HASH_A;
    const errors: string[] = [];
    const open = () =>
      new SessionTokenStore({
        getPasswordHash: () => passwordHash,
        now: () => now,
        persistPath: file,
        onPersistError: (_error, action) => errors.push(action),
      });
    return {
      dir,
      file,
      errors,
      open,
      advance: (ms: number) => {
        now += ms;
      },
      setPasswordHash: (hash: string | undefined) => {
        passwordHash = hash;
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("a token issued before a restart still admits the device after it", () => {
    const t = persisted();
    try {
      const issued = t.open().issue(OWNER, PHONE);
      const restarted = t.open();
      expect(restarted.verify(issued!.token, PHONE)).toEqual({ ...OWNER, renew: false });
      expect(restarted.verify(issued!.token, { ...PHONE, clientId: "clsk_other" })).toBeNull();
      expect(t.errors).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("the file is mode 600 and holds no token secret", () => {
    const t = persisted();
    try {
      const issued = t.open().issue(OWNER, PHONE);
      const secret = issued!.token.split(".")[2]!;
      expect(statSync(t.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(t.file, "utf8")).not.toContain(secret);
    } finally {
      t.cleanup();
    }
  });

  test("the key is written at the first start, before any token", () => {
    const t = persisted();
    try {
      t.open();
      const key = JSON.parse(readFileSync(t.file, "utf8")).key;
      const issued = t.open().issue(OWNER, PHONE);
      expect(JSON.parse(readFileSync(t.file, "utf8")).key).toBe(key);
      expect(t.open().verify(issued!.token, PHONE)).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a password change, expiry or revocation still ends a persisted token", () => {
    const t = persisted();
    try {
      const first = t.open().issue(OWNER, PHONE)!;
      t.setPasswordHash(HASH_B);
      expect(t.open().verify(first.token, PHONE)).toBeNull();
      t.setPasswordHash(HASH_A);
      const second = t.open().issue(OWNER, PHONE)!;
      const store = t.open();
      expect(store.revokeClient(PHONE.clientId)).toBe(true);
      expect(t.open().verify(second.token, PHONE)).toBeNull();
      const third = t.open().issue(OWNER, PHONE)!;
      t.advance(25 * HOUR);
      expect(t.open().verify(third.token, PHONE)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a corrupt file is replaced; the password path still works", () => {
    const t = persisted();
    try {
      writeFileSync(t.file, "{not json", { mode: 0o600 });
      const store = t.open();
      expect(t.errors).toEqual(["load"]);
      const issued = store.issue(OWNER, PHONE)!;
      expect(t.open().verify(issued.token, PHONE)).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });
});
