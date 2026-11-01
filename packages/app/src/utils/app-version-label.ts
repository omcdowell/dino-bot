import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The app version as people quote it: "0.11.2 (21)", marketing version plus the native build
 * number (CFBundleVersion / versionCode). Without a native build (web, desktop) it stays the plain
 * "v0.11.2" the About row always showed.
 */
export function formatAppVersionLabel(
  version: string | null | undefined,
  buildNumber: string | null | undefined,
): string {
  const v = trimOrNull(version);
  const build = trimOrNull(buildNumber);
  if (v && build) return `${v} (${build})`;
  return formatVersionWithPrefix(v);
}

/** Same, for the diagnostics report, where an unknown version reads "unknown". */
export function formatDiagnosticAppVersion(
  version: string | null | undefined,
  buildNumber: string | null | undefined,
): string | null {
  const v = trimOrNull(version);
  if (!v) return null;
  const build = trimOrNull(buildNumber);
  return build ? `${v} (${build})` : v;
}
