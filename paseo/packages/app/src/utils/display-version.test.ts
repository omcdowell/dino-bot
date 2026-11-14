import { describe, expect, it } from "vitest";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import appPackage from "../../package.json";
import { formatAppVersionLabel, formatDiagnosticAppVersion } from "./app-version-label";
import { formatHostVersionLabel, pickDisplayVersion } from "./display-version";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DINOBOT_VERSION, DINOBOT_IOS_BUILD } = require("../../dinobot-version.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveFlavour, resolveShownVersion } = require("../../release-flavour.js");

// Option A (Emmet, 4 Nov): DinoBot shows its own version (dinobot-version.js); package.json keeps
// the engine version that the daemon and plugin compatibility use (report-version-bump.md).
describe("DinoBot display version", () => {
  it("TestFlight build 11 reads 0.1.3 (11) in the About row and diagnostics", () => {
    const pub = resolveFlavour({ PASEO_FLAVOUR: "public" });
    expect(pub.displayVersion).toBe(DINOBOT_VERSION);
    expect(pub.iosBuildNumber).toBe(DINOBOT_IOS_BUILD);
    const shown = pickDisplayVersion(pub.displayVersion, appPackage.version);
    expect(formatAppVersionLabel(shown, pub.iosBuildNumber)).toBe("0.1.3 (11)");
    expect(formatDiagnosticAppVersion(shown, pub.iosBuildNumber)).toBe("0.1.3 (11)");
    // Desktop / web (no native build number).
    expect(formatAppVersionLabel(shown, null)).toBe("v0.1.3");
  });

  it("the desktop app's web UI shows the release (lib/product.json), the iPhone its own version", () => {
    const pub = resolveFlavour({ PASEO_FLAVOUR: "public" });
    expect(pub.desktopVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolveShownVersion(pub, { PASEO_WEB_PLATFORM: "electron" })).toBe(pub.desktopVersion);
    expect(resolveShownVersion(pub, {})).toBe(DINOBOT_VERSION);
    expect(resolveShownVersion(resolveFlavour({}), { PASEO_WEB_PLATFORM: "electron" })).toBeNull();
  });

    it("the own build keeps showing the engine version", () => {
    const own = resolveFlavour({});
    expect(own.displayVersion).toBeNull();
    expect(own.iosBuildNumber).toBeNull();
    expect(pickDisplayVersion(own.displayVersion, appPackage.version)).toBe(appPackage.version);
    expect(pickDisplayVersion(" ", " 0.11.2 ")).toBe("0.11.2");
    expect(pickDisplayVersion(undefined, null)).toBeNull();
  });

  it("plugin compatibility still uses the engine version (0.11.2), not 0.1.3", () => {
    // 0.11.2 today; any upstream 0.11+ release passes after a merge.
    expect(appPackage.version).toMatch(/^0\.(1[1-9]|[2-9]\d)\.\d+/);
    expect(DINOBOT_VERSION).not.toBe(appPackage.version);
    // Bundled plugins ask for >=0.9.2 .. >=0.11.0 (plugins/*/paseo-plugin.json).
    for (const paseo of [">=0.9.2", ">=0.10.0", ">=0.11.0"]) {
      expect(() =>
        assertPluginCompatibility({
          id: "p",
          requirements: { paseo },
          version: appPackage.version,
          runtime: "app",
        }),
      ).not.toThrow();
      // The display version would be refused: why it must never reach package.json.
      expect(() =>
        assertPluginCompatibility({
          id: "p",
          requirements: { paseo },
          version: DINOBOT_VERSION,
          runtime: "app",
        }),
      ).toThrow();
    }
  });
});

// DV1: the connected-host row reads "DinoBot 0.1.3" when the daemon sends it.
describe("connected host version label", () => {
  it("shows the daemon's product and display version when sent", () => {
    expect(
      formatHostVersionLabel({
        version: "0.11.2",
        productName: "DinoBot",
        displayVersion: "0.1.3",
      }),
    ).toBe("DinoBot 0.1.3");
    expect(formatHostVersionLabel({ version: "0.11.2", displayVersion: "0.1.3" })).toBe("v0.1.3");
  });

  it("falls back to today's text for an older daemon without the field", () => {
    expect(formatHostVersionLabel({ version: "0.11.2" })).toBe("v0.11.2");
    expect(
      formatHostVersionLabel({ version: "0.11.2", displayVersion: " ", productName: "DinoBot" }),
    ).toBe("v0.11.2");
    expect(formatHostVersionLabel({ version: null })).toBeNull();
    expect(formatHostVersionLabel(null)).toBeNull();
  });
});
