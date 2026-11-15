import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import {
  mintPairingTicket,
  PAIRING_TICKET_TTL_MS,
  PairingTicketVerifier,
  rotatePairingTicketKey,
} from "./pairing-tickets.js";
import { resolveSessionAdmission } from "./session-admission-auth.js";

const HASH = "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-pairing-tickets-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function verifier(paseoHome: string, clock: { now: number }) {
  return new PairingTicketVerifier({ paseoHome, now: () => clock.now });
}

describe("pairing tickets", () => {
  test("a fresh ticket admits one device; the key file is mode 600 and holds no ticket", () => {
    const dir = home();
    const clock = { now: 1_000_000 };
    const { ticket, expiresAt } = mintPairingTicket(dir, { now: clock.now });
    expect(ticket).toMatch(/^ppt1\.[0-9a-z]+\.[\w-]+\.[\w-]+$/);
    expect(expiresAt).toBe(1_000_000 + PAIRING_TICKET_TTL_MS);
    expect(PAIRING_TICKET_TTL_MS).toBe(10 * 60 * 1000);
    expect(statSync(path.join(dir, "pairing-ticket-key")).mode & 0o777).toBe(0o600);
    expect(verifier(dir, clock).check(ticket, "cid_phone")).toEqual({ ok: true });
  });

  test("expires after 10 minutes", () => {
    const dir = home();
    const clock = { now: 1_000_000 };
    const { ticket } = mintPairingTicket(dir, { now: clock.now });
    const v = verifier(dir, clock);
    clock.now += PAIRING_TICKET_TTL_MS;
    expect(v.check(ticket, "cid_phone")).toEqual({ ok: false, reason: "expired" });
  });

  test("is refused for a second device, also after a daemon restart; the first may retry", () => {
    const dir = home();
    const clock = { now: 1_000_000 };
    const { ticket } = mintPairingTicket(dir, { now: clock.now });
    const v = verifier(dir, clock);
    expect(v.check(ticket, "cid_phone").ok).toBe(true);
    expect(v.check(ticket, "cid_phone").ok).toBe(true);
    expect(v.check(ticket, "cid_other")).toEqual({ ok: false, reason: "used" });
    const restarted = verifier(dir, clock);
    expect(restarted.check(ticket, "cid_other")).toEqual({ ok: false, reason: "used" });
    expect(restarted.check(ticket, "cid_phone").ok).toBe(true);
    const used = path.join(dir, "pairing-tickets-used.json");
    expect(statSync(used).mode & 0o777).toBe(0o600);
    expect(readFileSync(used, "utf8")).not.toContain(ticket.split(".")[3]);
  });

  test("each QR gets its own ticket: two devices pair with two codes", () => {
    const dir = home();
    const clock = { now: 1_000_000 };
    const a = mintPairingTicket(dir, { now: clock.now }).ticket;
    const b = mintPairingTicket(dir, { now: clock.now }).ticket;
    expect(a).not.toBe(b);
    const v = verifier(dir, clock);
    expect(v.check(a, "cid_phone").ok).toBe(true);
    expect(v.check(b, "cid_ipad").ok).toBe(true);
  });

  test("refuses forged, tampered, overlong or foreign tickets", () => {
    const dir = home();
    const clock = { now: 1_000_000 };
    const v = verifier(dir, clock);
    const { ticket } = mintPairingTicket(dir, { now: clock.now });
    const [p, exp, nonce, mac] = ticket.split(".") as [string, string, string, string];
    expect(v.check(`${p}.${exp}.${nonce}.${mac.slice(0, -2)}AA`, "c").ok).toBe(false);
    expect(
      v.check(`${p}.${(Number.parseInt(exp, 36) + 1).toString(36)}.${nonce}.${mac}`, "c").ok,
    ).toBe(false);
    expect(v.check("garbage", "c")).toEqual({ ok: false, reason: "invalid" });
    const other = mintPairingTicket(home(), { now: clock.now }).ticket;
    expect(v.check(other, "c")).toEqual({ ok: false, reason: "invalid" });
    // A ticket minted with a lifetime past the cap is capped at mint time.
    const long = mintPairingTicket(dir, { now: clock.now, ttlMs: 24 * 60 * 60 * 1000 });
    expect(long.expiresAt - clock.now).toBe(60 * 60 * 1000);
  });

  test("rotating the key voids every unused ticket", () => {
    const dir = home();
    const clock = { now: 1_000_000 };
    const v = verifier(dir, clock);
    const { ticket } = mintPairingTicket(dir, { now: clock.now });
    rotatePairingTicketKey(dir);
    expect(v.check(ticket, "cid_phone")).toEqual({ ok: false, reason: "invalid" });
    expect(v.check(mintPairingTicket(dir, { now: clock.now }).ticket, "cid_phone").ok).toBe(true);
  });

  test("no key file (never minted): every ticket is refused", () => {
    const clock = { now: 1_000_000 };
    const v = verifier(home(), clock);
    const foreign = mintPairingTicket(home(), { now: clock.now }).ticket;
    expect(v.check(foreign, "c")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("hello admission with a pairing ticket", () => {
  test("a valid ticket admits the owner; a refused one is pairing_ticket_invalid", async () => {
    const ok = await resolveSessionAdmission({
      credential: { kind: "pairingTicket", ticket: "ppt1.x.y.z" },
      passwordHash: HASH,
      localCredential: null,
      transport: "direct",
      verifyPairingTicket: () => true,
    });
    expect(ok).toEqual({
      admission: { principalId: "owner", permissions: OWNER_PERMISSIONS },
      method: "pairingTicket",
    });
    const refused = await resolveSessionAdmission({
      credential: { kind: "pairingTicket", ticket: "ppt1.x.y.z" },
      passwordHash: HASH,
      localCredential: null,
      transport: "direct",
      verifyPairingTicket: () => false,
    });
    expect(refused).toEqual({ rejection: "pairing_ticket_invalid" });
    const noVerifier = await resolveSessionAdmission({
      credential: { kind: "pairingTicket", ticket: "ppt1.x.y.z" },
      passwordHash: HASH,
      localCredential: null,
      transport: "direct",
    });
    expect(noVerifier).toEqual({ rejection: "pairing_ticket_invalid" });
  });

  test("a device token is reported as such", async () => {
    const resolved = await resolveSessionAdmission({
      credential: { kind: "sessionToken", token: "pst1.a.b" },
      passwordHash: HASH,
      localCredential: null,
      transport: "direct",
      verifySessionToken: () => ({
        principalId: "owner",
        permissions: OWNER_PERMISSIONS,
        renew: false,
        device: true,
      }),
    });
    expect(resolved).toMatchObject({ method: "sessionToken", deviceToken: true });
  });
});
