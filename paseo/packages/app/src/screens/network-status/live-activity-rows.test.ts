import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { iconStatusUnavailableText, liveActivityRowsShown } from "./live-activity-rows";

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

describe("liveActivityRowsShown", () => {
  it("iOS public flavour (DinoBot): the icon rows, not the widget internals", () => {
    expect(liveActivityRowsShown({ os: "ios", publicFlavour: true })).toEqual({
      section: true,
      internals: false,
    });
  });
  it("iOS own build: everything", () => {
    expect(liveActivityRowsShown({ os: "ios", publicFlavour: false })).toEqual({
      section: true,
      internals: true,
    });
  });
  it("not iOS: nothing (there is no Live Activity)", () => {
    expect(liveActivityRowsShown({ os: "android", publicFlavour: false }).section).toBe(false);
    expect(liveActivityRowsShown({ os: "web", publicFlavour: true }).section).toBe(false);
  });
});

describe("iconStatusUnavailableText", () => {
  it("names the reason", () => {
    expect(
      iconStatusUnavailableText(t, { status: null, unavailable: "noIconStatus", error: null }),
    ).toBe("network.phone.liveActivityUnavailable.noIconStatus");
  });
  it("adds the native error", () => {
    expect(
      iconStatusUnavailableText(t, { status: null, unavailable: "failed", error: "boom" }),
    ).toContain('"error":"boom"');
  });
});
