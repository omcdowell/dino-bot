import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parsePairingOfferFromUrl } from "@getpaseo/protocol/connection-offer";

import { buildDirectOfferEndpoints, getTailnetIp } from "./connection-offer.js";
import { DIRECT_OFFER_BASE_URL, generateLocalPairingOffer } from "./pairing-offer.js";

// Test homes go under the package (never /tmp: it is RAM on the dev host).
const homes: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(process.env.PASEO_TEST_TMP ?? process.cwd(), ".pair-direct-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("direct pairing offer (relay off)", () => {
  it("orders endpoints: extras, tailnet IP, .local, LAN IP, localhost", () => {
    expect(
      buildDirectOfferEndpoints({
        listenHost: "0.0.0.0",
        port: 6767,
        extra: ["box.tail1.ts.net:6767"],
        hostname: "box.home",
        tailnetIp: "100.64.0.7",
        lanIp: "192.168.1.20",
      }),
    ).toEqual([
      "box.tail1.ts.net:6767",
      "100.64.0.7:6767",
      "box.local:6767",
      "192.168.1.20:6767",
      "localhost:6767",
    ]);
  });

  it("offers only the bound address when the daemon listens on one", () => {
    expect(buildDirectOfferEndpoints({ listenHost: "100.64.0.7", port: 6767 })).toEqual([
      "100.64.0.7:6767",
      "localhost:6767",
    ]);
  });

  it("finds the tailnet address in the CGNAT range only", () => {
    const iface = (address: string) => ({
      address,
      family: "IPv4" as const,
      internal: false,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
    });
    expect(
      getTailnetIp({ eth0: [iface("192.168.1.20")], tailscale0: [iface("100.64.0.13")] }),
    ).toBe("100.64.0.13");
    expect(getTailnetIp({ eth0: [iface("100.20.0.1")] })).toBeNull();
  });

  it("builds a v3 offer with the password when the relay is off", async () => {
    const pairing = await generateLocalPairingOffer({
      paseoHome: tempHome(),
      relayEnabled: false,
      includeQr: false,
      direct: { listen: "127.0.0.1:6767", password: "pw", extraEndpoints: ["box.ts.net:6767"] },
    });
    expect(pairing.kind).toBe("direct");
    expect(pairing.url?.startsWith(`${DIRECT_OFFER_BASE_URL}/#offer=`)).toBe(true);
    const parsed = parsePairingOfferFromUrl(pairing.url!);
    expect(parsed?.kind).toBe("direct");
    if (parsed?.kind !== "direct") return;
    expect(parsed.offer.endpoints).toEqual(["box.ts.net:6767"]);
    expect(parsed.offer.password).toBe("pw");
    expect(parsed.offer.daemonPublicKeyB64.length).toBeGreaterThan(10);
  });

  it("Tailscale only: no offer without a tailnet endpoint (no LAN, .local or localhost)", async () => {
    const pairing = await generateLocalPairingOffer({
      paseoHome: tempHome(),
      relayEnabled: false,
      includeQr: false,
      direct: { listen: "192.168.1.20:6767", password: "pw" },
    });
    expect(pairing).toEqual({
      relayEnabled: false,
      url: null,
      qr: null,
      kind: "direct",
      reason: "no_tailnet",
    });
  });

  it("recognises tailnet endpoints", async () => {
    const { isTailnetEndpoint } = await import("./connection-offer.js");
    expect(isTailnetEndpoint("box.tail1234.ts.net:6767")).toBe(true);
    expect(isTailnetEndpoint("100.64.0.12:6767")).toBe(true);
    expect(isTailnetEndpoint("100.20.0.1:6767")).toBe(false);
    expect(isTailnetEndpoint("192.168.1.20:6767")).toBe(false);
    expect(isTailnetEndpoint("box.local:6767")).toBe(false);
    expect(isTailnetEndpoint("localhost:6767")).toBe(false);
  });

  it("still returns no offer with the relay off and no TCP listen address", async () => {
    const pairing = await generateLocalPairingOffer({
      paseoHome: tempHome(),
      relayEnabled: false,
      direct: { listen: "unix:///run/paseo.sock" },
    });
    expect(pairing).toEqual({ relayEnabled: false, url: null, qr: null });
  });
});

describe("directOfferBaseUrl", () => {
  it("keeps paseo://pair unless PASEO_PAIR_LINK_SCHEME names a valid scheme", async () => {
    const { directOfferBaseUrl } = await import("./pairing-offer.js");
    expect(directOfferBaseUrl({})).toBe("paseo://pair");
    expect(directOfferBaseUrl({ PASEO_PAIR_LINK_SCHEME: "DinoBot" })).toBe("dinobot://pair");
    expect(directOfferBaseUrl({ PASEO_PAIR_LINK_SCHEME: "bad scheme!" })).toBe("paseo://pair");
  });
});
