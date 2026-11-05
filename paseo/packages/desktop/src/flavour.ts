import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Desktop shell flavour (the Electron main process). The renderer gets its flavour from the app
 * build (packages/app/release-flavour.js, PASEO_FLAVOUR); the main process gets the same choice
 * from `dist/flavour.json`, which `scripts/stamp-flavour.mjs` writes at `build:main`.
 *
 * - "own" (default, also when the file is missing): the owner's Paseo desktop app, unchanged.
 * - "public": the DinoBot desktop app. Its own name (so its own userData folder and single-instance
 *   lock), its own link scheme (`dinobot://`), its own Linux desktop id / WM class, no built-in
 *   daemon, no update checks against upstream Paseo, and no `paseo` CLI installer.
 */
export interface DesktopFlavour {
  id: "own" | "public";
  /** app.setName(): window title, menu name, and the userData folder (`<appData>/<appName>`). */
  appName: string;
  /** OS link scheme the app is registered for (electron-builder `protocols`). */
  linkScheme: string;
  /** Linux: app.setDesktopName() and the default `--class` (WM_CLASS); must match the .desktop file. */
  linuxDesktopName: string;
  linuxWmClass: string;
  /** Route `<linkScheme>://pair/#offer=…` and `<linkScheme>://provider/add?…` into the app. */
  appLinks: boolean;
  /** Built-in daemon (start/restart from the app), app updates and the CLI installer. */
  builtInDaemon: boolean;
  appUpdates: boolean;
  cliInstall: boolean;
  /**
   * Version shown to people (About panel): DinoBot's (packages/app/dinobot-version.js) in the public
   * build, null = app.getVersion(). Display only: app.getVersion() stays package.json's (engine)
   * version for the daemon checks.
   */
  displayVersion: string | null;
}

export const OWN_DESKTOP_FLAVOUR: DesktopFlavour = {
  id: "own",
  appName: "Paseo",
  linkScheme: "paseo",
  linuxDesktopName: "Paseo.desktop",
  linuxWmClass: "Paseo",
  appLinks: false,
  builtInDaemon: true,
  appUpdates: true,
  cliInstall: true,
  displayVersion: null,
};

export function publicDesktopFlavour(
  appName: string,
  linkScheme: string,
  displayVersion: string | null = null,
): DesktopFlavour {
  return {
    id: "public",
    appName,
    linkScheme,
    linuxDesktopName: `${appName}.desktop`,
    linuxWmClass: appName,
    appLinks: true,
    builtInDaemon: false,
    appUpdates: false,
    cliInstall: false,
    displayVersion,
  };
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/;
const SAFE_SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;
const SAFE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The flavour from a parsed flavour.json; anything unexpected falls back to the own flavour. */
export function resolveDesktopFlavour(raw: unknown): DesktopFlavour {
  if (typeof raw !== "object" || raw === null) return OWN_DESKTOP_FLAVOUR;
  const record = raw as Record<string, unknown>;
  if (record.id !== "public") return OWN_DESKTOP_FLAVOUR;
  const appName = typeof record.appName === "string" ? record.appName.trim() : "";
  const linkScheme = typeof record.linkScheme === "string" ? record.linkScheme.trim() : "";
  if (!SAFE_NAME.test(appName) || !SAFE_SCHEME.test(linkScheme) || linkScheme === "paseo") {
    return OWN_DESKTOP_FLAVOUR;
  }
  const displayVersion =
    typeof record.displayVersion === "string" && SAFE_VERSION.test(record.displayVersion.trim())
      ? record.displayVersion.trim()
      : null;
  return publicDesktopFlavour(appName, linkScheme, displayVersion);
}

export const FLAVOUR_FILENAME = "flavour.json";

/** Reads `<dir>/flavour.json` (dir = the compiled main's folder, `dist/`). */
export function loadDesktopFlavour(dir: string): DesktopFlavour {
  try {
    return resolveDesktopFlavour(
      JSON.parse(readFileSync(path.join(dir, FLAVOUR_FILENAME), "utf8")),
    );
  } catch {
    return OWN_DESKTOP_FLAVOUR;
  }
}

let cached: DesktopFlavour | null = null;

/** This build's flavour (read once). */
export function getDesktopFlavour(): DesktopFlavour {
  cached ??= loadDesktopFlavour(__dirname);
  return cached;
}
