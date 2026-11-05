/**
 * The version to show people: the build's display version (DinoBot's, packages/app/dinobot-version.js,
 * passed as `extra.displayVersion`) when set, else the engine version (package.json). No imports, so
 * tests and app-version.ts can use it without the native modules.
 */
export function pickDisplayVersion(
  displayVersion: unknown,
  engineVersion: string | null | undefined,
): string | null {
  if (typeof displayVersion === "string" && displayVersion.trim()) return displayVersion.trim();
  const engine = engineVersion?.trim();
  return engine ? engine : null;
}

/**
 * The text for a connected host's version: "DinoBot 0.1.3" when the daemon sends its display
 * version (server_info `productName` + `displayVersion`), else today's engine text ("v0.11.2"),
 * else null. Display only; mismatch and plugin checks keep comparing `version`.
 */
export function formatHostVersionLabel(
  info:
    | {
        version?: string | null;
        displayVersion?: string | null;
        productName?: string | null;
      }
    | null
    | undefined,
): string | null {
  const display = info?.displayVersion?.trim();
  if (display) {
    const product = info?.productName?.trim();
    return product ? `${product} ${display}` : withVPrefix(display);
  }
  const engine = info?.version?.trim();
  return engine ? withVPrefix(engine) : null;
}

function withVPrefix(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}
