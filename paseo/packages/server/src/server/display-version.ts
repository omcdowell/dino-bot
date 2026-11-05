/**
 * DinoBot's display version, sent in server_info as `productName` + `displayVersion` so apps show
 * "DinoBot 0.1.3" for the connected host. Display only: the daemon's `version` (package.json,
 * upstream Paseo's 0.11.x line) stays what plugin requirements, app/daemon mismatch checks, the CLI
 * and self-update compare. Keep DAEMON_DISPLAY_VERSION equal to DINOBOT_VERSION in
 * packages/app/dinobot-version.js (display-version.test.ts checks it).
 */
export const DAEMON_PRODUCT_NAME = "DinoBot";
export const DAEMON_DISPLAY_VERSION = "0.1.3";

export function getDaemonDisplayInfo(): { productName: string; displayVersion: string } {
  return { productName: DAEMON_PRODUCT_NAME, displayVersion: DAEMON_DISPLAY_VERSION };
}
