import { describe, expect, it } from "vitest";
import { deviceCopyFor } from "./device-copy";

describe("device copy", () => {
  it("phone wording on native, computer wording in the desktop/web build", () => {
    expect(deviceCopyFor(true)).toEqual({
      thisDevice: "this phone",
      thisApp: "this phone",
      press: "Tap",
    });
    expect(deviceCopyFor(false)).toEqual({
      thisDevice: "this computer",
      thisApp: "this app",
      press: "Click",
    });
  });
});
