import { describe, expect, it, vi } from "vitest";

vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-image-manipulator", () => ({}));

const { fitWithin } = await import("./image-picker");

describe("fitWithin", () => {
  it("scales the longest side down to the limit", () => {
    expect(fitWithin(2048, 1536, 512)).toEqual({ width: 512, height: 384 });
    expect(fitWithin(1000, 3000, 512)).toEqual({ width: 171, height: 512 });
  });

  it("never scales up and ignores a bad limit", () => {
    expect(fitWithin(300, 200, 512)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(800, 800, 0)).toEqual({ width: 800, height: 800 });
  });
});
