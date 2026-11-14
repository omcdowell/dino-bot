/**
 * DinoBot's iPhone app version: THE one place it lives. TestFlight raises DINOBOT_IOS_BUILD for
 * every upload, not the version (owner rule; builds 1 and 2 counted as 0.1.1 and 0.1.2).
 *
 * Shown to people only (public flavour, release-flavour.js): Settings > About, the sidebar help
 * menu, the welcome screen, the diagnostics report, CFBundleShortVersionString / MARKETING_VERSION of
 * the app and its Live Activity extension, and the iOS build number (CFBundleVersion).
 *
 * The desktop app (dmg/AppImage names, bundle version, About panel, its Settings > About) shows the
 * DinoBot RELEASE instead: lib/product.json `version`, the tag v<version> it is built for
 * (dinobotReleaseVersion below). The two move separately: a release need not ship a new iPhone build.
 *
 * It is NOT the engine version. package.json (0.11.x, upstream Paseo's line) stays what the daemon,
 * the CLI, the hello `appVersion`, the app/daemon mismatch checks and plugin compatibility
 * (`requirements.paseo` ranges such as ">=0.11.0") compare against. Never copy this into
 * package.json: plugins would be refused (report-version-bump.md, 4 Nov).
 */
const fs = require("node:fs");
const path = require("node:path");

const DINOBOT_VERSION = "0.1.3";
/** iOS CFBundleVersion of the next TestFlight build; must keep rising (App Store Connect). */
const DINOBOT_IOS_BUILD = "11";

/**
 * The DinoBot release version, read from the repo's lib/product.json (the one place it lives; tag
 * v<version>). Null when this paseo/ tree is not inside the DinoBot repo. `root` is for tests.
 */
function dinobotReleaseVersion(root = path.join(__dirname, "..", "..", "..")) {
  let product;
  try {
    product = JSON.parse(fs.readFileSync(path.join(root, "lib", "product.json"), "utf8"));
  } catch {
    return null;
  }
  const v = typeof product.version === "string" ? product.version.trim() : "";
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

module.exports = { DINOBOT_VERSION, DINOBOT_IOS_BUILD, dinobotReleaseVersion };
