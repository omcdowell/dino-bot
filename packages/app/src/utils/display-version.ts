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
