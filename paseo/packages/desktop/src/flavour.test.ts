import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDesktopFlavour, OWN_DESKTOP_FLAVOUR, resolveDesktopFlavour } from "./flavour.js";
// @ts-expect-error -- plain .mjs build script, no types
import { desktopFlavourJson } from "../scripts/stamp-flavour.mjs";

// The DinoBot release (repo root lib/product.json), which the public desktop build shows.
const releaseVersion: string = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "lib", "product.json"), "utf8"),
).version;

describe("desktop flavour", () => {
  it("is the own Paseo app unless flavour.json says public", () => {
    expect(resolveDesktopFlavour(undefined)).toBe(OWN_DESKTOP_FLAVOUR);
    expect(resolveDesktopFlavour({ id: "own", appName: "X", linkScheme: "x" })).toBe(
      OWN_DESKTOP_FLAVOUR,
    );
    expect(OWN_DESKTOP_FLAVOUR).toMatchObject({
      appName: "Paseo",
      linkScheme: "paseo",
      linuxDesktopName: "Paseo.desktop",
      linuxWmClass: "Paseo",
      appLinks: false,
      builtInDaemon: true,
      appUpdates: true,
      cliInstall: true,
      displayVersion: null,
    });
  });

  it("public: DinoBot name, dinobot:// links, own desktop id, no daemon/updates/CLI", () => {
    expect(
      resolveDesktopFlavour({ id: "public", appName: "DinoBot", linkScheme: "dinobot" }),
    ).toEqual({
      id: "public",
      appName: "DinoBot",
      linkScheme: "dinobot",
      linuxDesktopName: "DinoBot.desktop",
      linuxWmClass: "DinoBot",
      appLinks: true,
      builtInDaemon: false,
      appUpdates: false,
      cliInstall: false,
      displayVersion: null,
    });
  });

  it("public: carries DinoBot's display version; a malformed one is dropped", () => {
    const base = { id: "public", appName: "DinoBot", linkScheme: "dinobot" };
    expect(resolveDesktopFlavour({ ...base, displayVersion: "0.1.3" }).displayVersion).toBe(
      "0.1.3",
    );
    for (const bad of ["", "v0.1.3", "0.1", "0.1.3; rm -rf", 13, null]) {
      expect(resolveDesktopFlavour({ ...base, displayVersion: bad }).displayVersion).toBeNull();
    }
  });

  it("refuses unsafe or clashing values (falls back to own)", () => {
    for (const bad of [
      { id: "public", appName: "../x", linkScheme: "dinobot" },
      { id: "public", appName: "DinoBot", linkScheme: "paseo" },
      { id: "public", appName: "DinoBot", linkScheme: "Dino Bot" },
      { id: "public", appName: "", linkScheme: "dinobot" },
    ]) {
      expect(resolveDesktopFlavour(bad)).toBe(OWN_DESKTOP_FLAVOUR);
    }
  });

  it("reads dist/flavour.json, and a missing or broken file is the own flavour", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "desktop-flavour-"));
    try {
      expect(loadDesktopFlavour(dir)).toBe(OWN_DESKTOP_FLAVOUR);
      writeFileSync(path.join(dir, "flavour.json"), "{nope");
      expect(loadDesktopFlavour(dir)).toBe(OWN_DESKTOP_FLAVOUR);
      writeFileSync(
        path.join(dir, "flavour.json"),
        JSON.stringify({ id: "public", appName: "DinoBot", linkScheme: "dinobot" }),
      );
      expect(loadDesktopFlavour(dir).appName).toBe("DinoBot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stamp-flavour takes the name and scheme from the app's release-flavour.js", () => {
    expect(desktopFlavourJson({})).toEqual({
      id: "own",
      appName: "Paseo",
      linkScheme: "paseo",
      displayVersion: null,
    });
    expect(desktopFlavourJson({ PASEO_FLAVOUR: "public" })).toEqual({
      id: "public",
      appName: "DinoBot",
      linkScheme: "dinobot",
      // The DinoBot release (lib/product.json), not the iPhone's marketing version.
      displayVersion: releaseVersion,
    });
  });
});
