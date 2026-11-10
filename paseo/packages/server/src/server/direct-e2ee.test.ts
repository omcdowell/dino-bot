import { describe, expect, test } from "vitest";
import { isSameMachineRequest, trustLoopbackFromEnv } from "./direct-e2ee.js";

const tcp = (remoteAddress: string, localAddress = "127.0.0.1") => ({
  socket: { remoteAddress, localAddress },
});

describe("PASEO_TRUST_LOOPBACK", () => {
  test("defaults to trusting loopback; false/0/no/off turn it off", () => {
    expect(trustLoopbackFromEnv({})).toBe(true);
    expect(trustLoopbackFromEnv({ PASEO_TRUST_LOOPBACK: "true" })).toBe(true);
    for (const value of ["false", "0", "no", "off", " FALSE "]) {
      expect(trustLoopbackFromEnv({ PASEO_TRUST_LOOPBACK: value })).toBe(false);
    }
  });

  test("isSameMachineRequest: loopback TCP counts only while loopback is trusted; a local socket always", () => {
    expect(isSameMachineRequest(tcp("127.0.0.1"))).toBe(true);
    expect(isSameMachineRequest(tcp("::ffff:127.0.0.1"), { trustLoopback: true })).toBe(true);
    expect(isSameMachineRequest(tcp("127.0.0.1"), { trustLoopback: false })).toBe(false);
    expect(isSameMachineRequest(tcp("100.64.0.9", "100.64.0.9"), { trustLoopback: false })).toBe(
      false,
    );
    expect(isSameMachineRequest({ socket: {} }, { trustLoopback: false })).toBe(true);
    expect(isSameMachineRequest(tcp("100.64.0.8", "100.64.0.9"))).toBe(false);
  });
});
