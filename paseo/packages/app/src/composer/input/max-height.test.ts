import { describe, expect, it } from "vitest";
import { resolveMaxInputHeight } from "./max-height";

describe("resolveMaxInputHeight", () => {
  it("keeps half the window on wide layouts, at least 160", () => {
    expect(resolveMaxInputHeight(1000)).toBe(500);
    expect(resolveMaxInputHeight(200)).toBe(160);
    expect(resolveMaxInputHeight(Number.NaN)).toBe(160);
  });

  it("caps phones at about six lines", () => {
    expect(resolveMaxInputHeight(874, true)).toBe(138);
  });

  it("never lets a phone input take more than 40 % of a short window", () => {
    expect(resolveMaxInputHeight(300, true)).toBe(120);
    expect(resolveMaxInputHeight(50, true)).toBe(30);
    expect(resolveMaxInputHeight(0, true)).toBe(138);
  });
});
