import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Chromium's notices (LICENSES.chromium.html, ~20 MB) for Settings > About > Licences. The DinoBot
 * build copies it to resources/licences/ (electron-builder.dinobot.cjs); a Linux build also has
 * Electron's own copy next to the executable.
 */
export function chromiumNoticesCandidates(input: {
  resourcesPath: string;
  execPath: string;
}): string[] {
  return [
    path.join(input.resourcesPath, "licences", "LICENSES.chromium.html"),
    path.join(path.dirname(input.execPath), "LICENSES.chromium.html"),
  ];
}

export function findChromiumNotices(
  input: { resourcesPath: string; execPath: string },
  exists: (file: string) => boolean = existsSync,
): string | null {
  return chromiumNoticesCandidates(input).find((file) => exists(file)) ?? null;
}
