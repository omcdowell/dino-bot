import { describe, expect, it } from "vitest";
import { ICON_SIZE } from "@/styles/theme";
import { stopSquareSize } from "./stop-square";

describe("stopSquareSize", () => {
  it("draws the stop square 10-15% smaller than the composer icons, in whole points", () => {
    expect(stopSquareSize(ICON_SIZE.lg)).toBe(17);
    expect(stopSquareSize(ICON_SIZE.md)).toBe(14);
    for (const size of [ICON_SIZE.md, ICON_SIZE.lg]) {
      const shrink = 1 - stopSquareSize(size) / size;
      expect(shrink).toBeGreaterThanOrEqual(0.1);
      expect(shrink).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });
});
