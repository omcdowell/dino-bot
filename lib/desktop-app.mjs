// The DinoBot desktop app is not updated by `dinobot update` (it is a separate download: a .dmg on
// macOS, an AppImage on Linux). The app itself shows a "New version available" notice; this is
// the same hint at the end of `dinobot update`, on macOS only, where the app's place and version
// can be read (/Applications/<Product>.app). On Linux the AppImage can be anywhere: no line.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function olderThan(a, b) {
  const pa = VERSION_RE.exec(a ?? "");
  const pb = VERSION_RE.exec(b ?? "");
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]);
  }
  return false;
}

/** CFBundleShortVersionString of an XML Info.plist (electron-builder writes XML), or null. */
export function plistShortVersion(text) {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text ?? "");
  return m ? m[1].trim() : null;
}

/** The installed desktop app's version on macOS (/Applications or ~/Applications), or null. */
export function macDesktopAppVersion({ product, home, platform = process.platform, read = (f) => readFileSync(f, "utf8") }) {
  if (platform !== "darwin") return null;
  for (const dir of ["/Applications", join(home, "Applications")]) {
    try {
      const v = plistShortVersion(read(join(dir, `${product}.app`, "Contents", "Info.plist")));
      if (v) return v;
    } catch {
      // not installed there
    }
  }
  return null;
}

/** One line telling the user to download the new desktop app, or null when it is not needed. */
export function desktopAppHint({ product, desktopVersion, newVersion, releaseRepo }) {
  if (!desktopVersion || !olderThan(desktopVersion, newVersion) || !releaseRepo) return null;
  return `The ${product} desktop app is ${desktopVersion}; download ${newVersion} from https://github.com/${releaseRepo}/releases/tag/v${newVersion} (the app does not update itself).`;
}
