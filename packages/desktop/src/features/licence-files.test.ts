import { describe, expect, it } from "vitest";
import { findChromiumNotices } from "./licence-files.js";

describe("Chromium notices file", () => {
  const input = { resourcesPath: "/opt/DinoBot/resources", execPath: "/opt/DinoBot/DinoBot.bin" };

  it("prefers the copy the DinoBot build puts in resources/licences", () => {
    expect(findChromiumNotices(input, () => true)).toBe(
      "/opt/DinoBot/resources/licences/LICENSES.chromium.html",
    );
  });

  it("falls back to Electron's copy next to the executable, else null", () => {
    expect(findChromiumNotices(input, (f) => f === "/opt/DinoBot/LICENSES.chromium.html")).toBe(
      "/opt/DinoBot/LICENSES.chromium.html",
    );
    expect(findChromiumNotices(input, () => false)).toBeNull();
  });
});
