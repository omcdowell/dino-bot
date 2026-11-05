import Constants from "expo-constants";
import { nativeBuildVersion } from "expo-application";
import appPackage from "../../package.json";
import { pickDisplayVersion } from "./display-version";

function toVersionOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

/**
 * The engine version (package.json, upstream Paseo's line): what the daemon hello, the app/daemon
 * mismatch checks and plugin compatibility use. Not what people see in the public build: that is
 * resolveDisplayVersion().
 */
export function resolveAppVersion(): string | null {
  const packageVersion = toVersionOrNull(appPackage?.version);
  if (packageVersion) {
    return packageVersion;
  }

  const expoVersion = toVersionOrNull(Constants.expoConfig?.version);
  if (expoVersion) {
    return expoVersion;
  }

  const manifestVersion = toVersionOrNull(
    (Constants as unknown as { manifest?: { version?: unknown } }).manifest?.version,
  );
  if (manifestVersion) {
    return manifestVersion;
  }

  return null;
}

/**
 * The version shown to people: DinoBot's own (packages/app/dinobot-version.js, via
 * `extra.displayVersion`) in the public build, else the engine version. Display only; never send it
 * to the daemon or compare it with plugin requirements.
 */
export function resolveDisplayVersion(): string | null {
  const extra = Constants.expoConfig?.extra as { displayVersion?: unknown } | undefined;
  return pickDisplayVersion(extra?.displayVersion, resolveAppVersion());
}

/** The native build number (iOS CFBundleVersion, Android versionCode); null on web and desktop. */
export function resolveNativeBuildNumber(): string | null {
  return toVersionOrNull(nativeBuildVersion);
}
