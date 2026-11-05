/**
 * DinoBot's display version: THE one place it lives. Bump both lines for every TestFlight build
 * (owner, 3 Nov: the patch goes up each build; builds 1 and 2 count as 0.1.1 and 0.1.2).
 *
 * Shown to people only (public flavour, release-flavour.js): Settings > About, the sidebar help
 * menu, the welcome screen, the diagnostics report, CFBundleShortVersionString / MARKETING_VERSION of
 * the app and its Live Activity extension, the iOS build number (CFBundleVersion), the DinoBot
 * desktop bundle and About panel, and the GitHub release tag (v<DINOBOT_VERSION>).
 *
 * It is NOT the engine version. package.json (0.11.x, upstream Paseo's line) stays what the daemon,
 * the CLI, the hello `appVersion`, the app/daemon mismatch checks and plugin compatibility
 * (`requirements.paseo` ranges such as ">=0.11.0") compare against. Never copy this into
 * package.json: plugins would be refused (report-version-bump.md, 4 Nov).
 */
const DINOBOT_VERSION = "0.1.3";
/** iOS CFBundleVersion of the next TestFlight build; must keep rising (App Store Connect). */
const DINOBOT_IOS_BUILD = "5";

module.exports = { DINOBOT_VERSION, DINOBOT_IOS_BUILD };
