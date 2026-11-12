import { describe, expect, test } from "vitest";
import {
  CLIENT_CAPABILITY_BITS,
  CLIENT_CAPS,
  decodeCompactCapabilities,
  encodeCompactCapabilities,
} from "./client-capabilities.js";
import { WSHelloMessageSchema } from "./messages.js";

describe("compact hello capabilities (HS1)", () => {
  test("every boolean capability has a bit; browser_host stays in the map", () => {
    const all = Object.values(CLIENT_CAPS).filter((c) => c !== CLIENT_CAPS.browserHost);
    expect([...CLIENT_CAPABILITY_BITS].sort()).toEqual([...all].sort());
    expect(new Set(CLIENT_CAPABILITY_BITS).size).toBe(CLIENT_CAPABILITY_BITS.length);
  });

  test("bit order is append-only (pinned)", () => {
    expect(CLIENT_CAPABILITY_BITS[0]).toBe("hello_rejection");
    expect(CLIENT_CAPABILITY_BITS[23]).toBe("priority_sync");
    expect(CLIENT_CAPABILITY_BITS[24]).toBe("compact_v2");
  });

  test("round trip: true bits compact, everything else kept", () => {
    const browser = { supportedCommands: ["x"], hostKind: "desktop app" };
    const input: Record<string, unknown> = {
      ...Object.fromEntries(CLIENT_CAPABILITY_BITS.map((c) => [c, true])),
      [CLIENT_CAPS.zstdFrames]: false,
      [CLIENT_CAPS.browserHost]: browser,
      voice: true,
    };
    const { cb, rest } = encodeCompactCapabilities(input);
    expect(cb).toBe("1dfffff"); // zstd_frames is bit 21, compact_v2 bit 24
    expect(rest).toEqual({ [CLIENT_CAPS.browserHost]: browser, voice: true });
    const decoded = decodeCompactCapabilities(cb);
    expect(decoded[CLIENT_CAPS.zstdFrames]).toBeUndefined();
    expect(Object.keys(decoded)).toHaveLength(CLIENT_CAPABILITY_BITS.length - 1);
  });

  test("the app's default caps carry priority_sync and compact_v2 in cb", () => {
    const decoded = decodeCompactCapabilities(
      encodeCompactCapabilities({
        [CLIENT_CAPS.prioritySync]: true,
        [CLIENT_CAPS.compactV2]: true,
        compact_v2_fh: "abc",
      }).cb,
    );
    expect(decoded).toEqual({ [CLIENT_CAPS.prioritySync]: true, [CLIENT_CAPS.compactV2]: true });
  });

  test("unknown high bits from a newer client are ignored; junk decodes to nothing", () => {
    expect(Object.keys(decodeCompactCapabilities("f000000001"))).toEqual(["hello_rejection"]);
    expect(decodeCompactCapabilities("XYZ")).toEqual({});
  });

  test("an old-schema hello with cb parses (cb is optional and stripped by older daemons)", () => {
    const hello = {
      type: "hello",
      clientId: "c",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: {},
      cb: "ffffff",
    };
    expect(WSHelloMessageSchema.parse(hello).cb).toBe("ffffff");
    expect(WSHelloMessageSchema.safeParse({ ...hello, cb: "FF" }).success).toBe(false);
  });
});
