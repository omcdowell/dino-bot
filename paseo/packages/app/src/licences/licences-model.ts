/** Rows for the Licences screen from licences.generated.json (pure, for tests). */
export interface LicenceData {
  /** The repo NOTICE (DinoBot, Copyright 2026 omcdowell, modified Paseo, brand assets). */
  product?: { notice: string | null };
  app: { licence: string; text: string };
  extra: {
    name: string;
    licence: string;
    copyright: string[];
    textId: string | null;
  }[];
  packages: {
    name: string;
    version: string;
    licence: string;
    copyright: string[];
    textId: string | null;
  }[];
  texts: Record<string, string>;
}

export interface LicenceRow {
  key: string;
  title: string;
  subtitle: string;
  copyright: string[];
  /** Full licence text, shown when the row is tapped. */
  text: string | null;
  /** A file with more notices, opened by the desktop app (Chromium's LICENSES.chromium.html). */
  file?: "chromium";
}

/** The desktop app's runtime (Electron, which bundles Chromium and Node.js), from its user agent. */
export interface ElectronRuntimeInfo {
  electronVersion: string | null;
  chromeVersion: string | null;
}

export function electronRuntimeFromUserAgent(userAgent: string): ElectronRuntimeInfo {
  return {
    electronVersion: /\bElectron\/([\d.]+)/.exec(userAgent)?.[1] ?? null,
    chromeVersion: /\bChrome\/([\d.]+)/.exec(userAgent)?.[1] ?? null,
  };
}

/** Electron's LICENSE (MIT), as shipped next to the app (LICENSE.electron.txt). */
export const ELECTRON_LICENCE = `Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** Rows for the desktop app's own runtime: Electron (MIT) and Chromium (BSD-3-Clause and others). */
export function electronLicenceRows(runtime: ElectronRuntimeInfo): LicenceRow[] {
  const version = (v: string | null) => (v ? ` ${v}` : "");
  return [
    {
      key: "runtime:electron",
      title: `Electron${version(runtime.electronVersion)}`,
      subtitle: "MIT. The desktop app's runtime; it includes Chromium and Node.js.",
      copyright: ["Copyright (c) Electron contributors", "Copyright (c) 2013-2020 GitHub Inc."],
      text: ELECTRON_LICENCE,
    },
    {
      key: "runtime:chromium",
      title: `Chromium${version(runtime.chromeVersion)}`,
      subtitle: "BSD-3-Clause and other open-source licences (in Electron)",
      copyright: ["Copyright 2015 The Chromium Authors"],
      text: "Chromium is built from many open-source projects, each under its own licence. Every one of them, with its full licence text, is listed in LICENSES.chromium.html, which ships with this app.",
      file: "chromium",
    },
  ];
}

export const APP_COPYRIGHT = "Copyright (c) 2025-present Mohamed Boudra";

/** Copyright line of the product notice (its second line, "Copyright 2026 omcdowell"). */
export function noticeCopyright(notice: string): string[] {
  return notice
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^copyright\b/i.test(l))
    .slice(0, 1);
}

/**
 * Rows for the screen. `appName` is the build's display name (release-flavour.js); when it is not
 * "Paseo" (the public build) the product's own notice comes first, so the app names its maker and
 * says it is a modified Paseo before the list of everything it includes.
 */
export function licenceRows(
  data: LicenceData,
  appName = "Paseo",
  electron: ElectronRuntimeInfo | null = null,
): LicenceRow[] {
  const rows: LicenceRow[] = [];
  const notice = data.product?.notice;
  if (notice && appName !== "Paseo") {
    rows.push({
      key: "product",
      title: appName,
      subtitle: `${data.app.licence}. Based on Paseo, modified. The ${appName} name, icon and artwork are not covered by the licence.`,
      copyright: noticeCopyright(notice),
      text: notice,
    });
  }
  rows.push({
    key: "app",
    title: "Paseo",
    subtitle: `${data.app.licence}. This app is a modified version of Paseo.`,
    copyright: [APP_COPYRIGHT],
    text: data.app.text,
  });
  // The desktop app (public build): the runtime it ships, before the host software and packages.
  if (electron) rows.push(...electronLicenceRows(electron));
  for (const extra of data.extra) {
    rows.push({
      key: `extra:${extra.name}`,
      title: extra.name,
      subtitle: `${extra.licence} (installed on your computer)`,
      copyright: extra.copyright,
      text: extra.textId ? (data.texts[extra.textId] ?? null) : null,
    });
  }
  for (const pkg of data.packages) {
    rows.push({
      key: `npm:${pkg.name}@${pkg.version}`,
      title: pkg.name,
      subtitle: `${pkg.version} · ${pkg.licence}`,
      copyright: pkg.copyright,
      text: pkg.textId ? (data.texts[pkg.textId] ?? null) : null,
    });
  }
  return rows;
}
