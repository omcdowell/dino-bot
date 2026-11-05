import { describe, expect, it } from "vitest";

import {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
  parsePairingOfferFromUrl,
} from "./connection-offer.js";

function encodeBase64UrlNoPadUtf8(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("connection offer", () => {
  it("decodes base64url JSON payloads", () => {
    const payload = {
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.paseo.sh:443" },
    };

    expect(decodeOfferFragmentPayload(encodeBase64UrlNoPadUtf8(JSON.stringify(payload)))).toEqual(
      payload,
    );
  });

  it("parses connection offers from QR-style URLs", () => {
    const offer = ConnectionOfferSchema.parse({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.paseo.sh:443" },
    });
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parseConnectionOfferFromUrl(`https://app.paseo.sh/#offer=${encoded}`)).toEqual(offer);
  });

  it("leaves relay TLS unset when absent", () => {
    expect(
      ConnectionOfferSchema.parse({
        v: 2,
        serverId: "server-123",
        daemonPublicKeyB64: "pubkey",
        relay: { endpoint: "relay.example.com:80" },
      }),
    ).toEqual({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:80" },
    });
  });

  it("round-trips relay TLS in offers without rejecting extra relay fields", () => {
    const offer = ConnectionOfferSchema.parse({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:443", useTls: true, extra: "future" },
    });
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parseConnectionOfferFromUrl(`https://app.paseo.sh/#offer=${encoded}`)).toEqual({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:443", useTls: true },
    });
  });

  it("returns null when the URL has no offer fragment", () => {
    expect(parseConnectionOfferFromUrl("https://app.paseo.sh/pair")).toBeNull();
  });

  it("parses a direct (v3) offer with its endpoints and password", () => {
    const offer = {
      v: 3,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      endpoints: ["box.tail1.ts.net:6767", "100.64.0.7:6767", "192.168.1.20:6767"],
      password: "secret",
    };
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parsePairingOfferFromUrl(`paseo://pair#offer=${encoded}`)).toEqual({
      kind: "direct",
      offer,
    });
  });

  it("still reads relay (v2) offers through the pairing parser", () => {
    const offer = {
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.paseo.sh:443" },
    };
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parsePairingOfferFromUrl(`https://app.paseo.sh/#offer=${encoded}`)).toEqual({
      kind: "relay",
      offer,
    });
  });

  it("rejects a direct offer without endpoints, and keeps v2 parsing strict", () => {
    const empty = encodeBase64UrlNoPadUtf8(
      JSON.stringify({ v: 3, serverId: "s", daemonPublicKeyB64: "k", endpoints: [] }),
    );
    expect(() => parsePairingOfferFromUrl(`paseo://pair#offer=${empty}`)).toThrow();
    const direct = encodeBase64UrlNoPadUtf8(
      JSON.stringify({ v: 3, serverId: "s", daemonPublicKeyB64: "k", endpoints: ["h:1"] }),
    );
    expect(() => parseConnectionOfferFromUrl(`paseo://pair#offer=${direct}`)).toThrow();
  });
});
