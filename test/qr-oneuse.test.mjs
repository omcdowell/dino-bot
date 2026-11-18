// QR2: the pairing code carries a one-use ticket (10 minutes, one device) and, during the
// transition, the password too; `dinobot devices` lists and unpairs devices.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { devices } from "../lib/cli.mjs";
import { offerUrl, pairingCodeNote, pairingOffer, pairingQrMode } from "../lib/offer.mjs";
// The daemon's own ticket code (TypeScript, type-stripped by Node): what `pair` mints with.
import { mintPairingTicket, PairingTicketVerifier } from "../paseo/packages/server/src/server/pairing-tickets.ts";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "qr2-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const identity = { serverId: "srv_1", daemonPublicKeyB64: "key" };
const endpoints = ["box.tail1.ts.net:6767", "100.64.0.7:6767"];
const decode = (url) => JSON.parse(Buffer.from(url.split("#offer=")[1], "base64url").toString("utf8"));

describe("pairing code contents (QR2)", () => {
  it("product.json is ticket-only; DINOBOT_PAIRING_QR=ticket+password switches one computer back", () => {
    const product = JSON.parse(readFileSync(new URL("../lib/product.json", import.meta.url), "utf8"));
    assert.equal(product.pairingQr, "ticket");
    assert.equal(pairingQrMode({}), "ticket");
    assert.equal(pairingQrMode({ DINOBOT_PAIRING_QR: "ticket+password" }), "ticket+password");
    assert.equal(pairingQrMode({ DINOBOT_PAIRING_QR: "ticket" }), "ticket");
    assert.equal(pairingQrMode({ DINOBOT_PAIRING_QR: "nonsense" }), "ticket+password");
  });

  it("ticket+password override: a fresh ticket plus the password (apps without tickets still pair)", async () => {
    const home = tmp();
    const r = await pairingOffer("/nowhere", home, { identity, endpoints, password: "pw", env: { DINOBOT_PAIRING_QR: "ticket+password" }, mint: async (h) => mintPairingTicket(h) });
    assert.equal(r.mode, "ticket+password");
    const back = decode(offerUrl(r.offer));
    assert.match(back.pairingTicket, /^ppt1\./);
    assert.equal(back.password, "pw");
    assert.deepEqual(back.endpoints, endpoints);
  });

  it("ticket mode: never the password; each code its own ticket; the daemon accepts it for one device", async () => {
    const home = tmp();
    const env = { DINOBOT_PAIRING_QR: "ticket" };
    const mint = async (h) => mintPairingTicket(h);
    const a = await pairingOffer("/nowhere", home, { identity, endpoints, password: "pw", env, mint });
    const b = await pairingOffer("/nowhere", home, { identity, endpoints, password: "pw", env, mint });
    const ta = decode(offerUrl(a.offer));
    assert.equal(ta.password, undefined);
    assert.notEqual(ta.pairingTicket, decode(offerUrl(b.offer)).pairingTicket);
    assert.ok(a.expiresAt - Date.now() <= 10 * 60_000 && a.expiresAt - Date.now() > 9 * 60_000);
    const daemon = new PairingTicketVerifier({ paseoHome: home });
    assert.deepEqual(daemon.check(ta.pairingTicket, "cid_phone"), { ok: true });
    assert.deepEqual(daemon.check(ta.pairingTicket, "cid_other"), { ok: false, reason: "used" });
    assert.match(pairingCodeNote("ticket", { productId: "dinobot" }), /once, for 10 minutes.*dinobot pair/);
  });

  it("a daemon without ticket support: the password-only code every app can use", async () => {
    const r = await pairingOffer("/nowhere", tmp(), { identity, endpoints, password: "pw", env: { DINOBOT_PAIRING_QR: "ticket" }, mint: async () => { throw new Error("no module"); } });
    assert.equal(r.mode, "password");
    assert.deepEqual(decode(offerUrl(r.offer)), { v: 3, ...identity, endpoints, password: "pw" });
  });
});

describe("dinobot devices", () => {
  const setup = () => {
    const root = tmp();
    const L = { state: join(root, "state.json"), app: join(root, "app"), paseoHome: join(root, ".paseo") };
    writeFileSync(L.state, "{}");
    const now = Date.UTC(2026, 10, 15);
    const day = 86_400_000;
    const rows = [
      { clientId: "cid_phone", label: "app 0.1.4, from 100.64.0.9", device: true, issuedAt: now - 2 * day, expiresAt: now + 178 * day },
      { clientId: "cid_old", label: null, device: false, issuedAt: now, expiresAt: now + day },
    ];
    const revoked = [];
    let text = "";
    const deps = { out: { write: (s) => { text += s; } }, list: async () => rows, revoke: async (_app, _home, target) => revoked.push(target), now };
    return { L, deps, revoked, text: () => text };
  };

  it("lists paired devices, numbered", async () => {
    const t = setup();
    await devices(t.L, {}, t.deps);
    assert.match(t.text(), /1\. cid_phone {2}app 0\.1\.4, from 100\.64\.0\.9 {2}active 2 days ago; stays paired while used \(unused 178 more days ends it\)/);
    assert.match(t.text(), /2\. cid_old {2}active today; older app: signs in with the password/);
    assert.deepEqual(t.revoked, []);
  });

  it("--revoke N / clientId unpairs one; --revoke-all unpairs every device", async () => {
    const t = setup();
    await devices(t.L, { revoke: "1" }, t.deps);
    await devices(t.L, { revoke: "cid_old" }, t.deps);
    await devices(t.L, { "revoke-all": true }, t.deps);
    assert.deepEqual(t.revoked, [["cid_phone"], ["cid_old"], "all"]);
    await assert.rejects(devices(t.L, { revoke: "9" }, t.deps), /no paired device 9/);
  });
});
