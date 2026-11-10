// electron-builder config for the public DinoBot desktop app (PASEO_FLAVOUR=public).
// It is electron-builder.yml (the owner's own Paseo build, unchanged) with the shell rebranded:
//   name/executable DinoBot, appId com.dinobot.desktop (so userData, the single-instance lock and
//   the macOS bundle never collide with a Paseo desktop app on the same computer), the dinobot://
//   link scheme, Linux desktop id / WM class DinoBot, no update feed (publish: null; updates come
//   from the installer), maintainer omcdowell, and the dino icons (assets/ holds the dino tile made
//   from the app's art, commit 7311dd0ac).
// Build: PASEO_FLAVOUR=public npm run build:main && electron-builder --config electron-builder.dinobot.cjs
// No Apple Developer ID yet: signed ad hoc (mac.identity "-"), not notarised; the friend opens it
// with right-click > Open (macOS 15+: System Settings > Privacy & Security > Open Anyway).
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { resolveFlavour } = require("../app/release-flavour.js");

const base = yaml.load(readFileSync(path.join(__dirname, "electron-builder.yml"), "utf8"));
const flavour = resolveFlavour({ PASEO_FLAVOUR: "public" });
const NAME = flavour.appName; // "DinoBot" (release-flavour.js is the one place it lives)
const SCHEME = flavour.linkScheme; // "dinobot"
// The DinoBot release this app ships with (lib/product.json via release-flavour.js desktopVersion),
// not the iPhone's marketing version (app/dinobot-version.js): the bundle's
// CFBundleShortVersionString and CFBundleVersion and the file names. The packaged package.json keeps
// the engine version (0.11.x), which app.getVersion() returns for the daemon checks.
const VERSION = flavour.desktopVersion;
if (!VERSION) {
  throw new Error("no DinoBot release version: lib/product.json (beside paseo/) is missing or has no x.y.z version");
}

// Windows is not in v1 (27 Oct): no win/nsis section.
const { win: _win, nsis: _nsis, ...shared } = base;

// Electron's licence and Chromium's notices, where Settings > About > Licences opens them
// (resources/licences/, the same on macOS and Linux).
// electron-builder skips a missing extraResources file silently, so check them here: a build
// without Electron's own download (npm ci with the binary download skipped) must not ship without
// the notices. Fix: node node_modules/electron/install.js
const electronDist = path.join(path.dirname(require.resolve("electron/package.json")), "dist");
const licenceResources = [
  { from: path.join(electronDist, "LICENSE"), to: "licences/LICENSE.electron.txt" },
  {
    from: path.join(electronDist, "LICENSES.chromium.html"),
    to: "licences/LICENSES.chromium.html",
  },
];
for (const { from } of licenceResources) {
  if (!existsSync(from)) {
    throw new Error(`${from} is missing (run: node node_modules/electron/install.js)`);
  }
}

module.exports = {
  ...shared,
  extraResources: [...(shared.extraResources ?? []), ...licenceResources],
  appId: "com.dinobot.desktop",
  productName: NAME,
  executableName: NAME,
  copyright: "Copyright © 2026 omcdowell",
  protocols: [{ name: `${NAME} link`, schemes: [SCHEME] }],
  publish: null,
  buildVersion: VERSION,
  extraMetadata: {
    // Electron reads these from the packaged package.json at run time (Linux app_id / WM_CLASS,
    // About panel). The workspace package stays @getpaseo/desktop.
    productName: NAME,
    desktopName: `${NAME}.desktop`,
    description: `${NAME} desktop app`,
    homepage: "https://omcdowell.github.io/dino-bot/",
    author: "omcdowell",
  },
  mac: {
    ...base.mac,
    artifactName: `${NAME}-${VERSION}-\${arch}.\${ext}`,
    bundleShortVersion: VERSION,
    category: "public.app-category.productivity",
    notarize: false,
    // No Developer ID yet: sign ad hoc ("-") so the bundle has a sealed, valid signature. Unsigned
    // (only the linker's signature on the executable) fails `codesign --verify`, and macOS calls
    // such a download "damaged" instead of offering right-click > Open. The hardened runtime is off
    // because it needs a team-signed Electron Framework (library validation); it comes back with
    // a real identity and notarisation.
    identity: "-",
    hardenedRuntime: false,
    target: ["dmg"],
  },
  dmg: { title: NAME },
  linux: {
    ...base.linux,
    artifactName: `${NAME}-${VERSION}-\${arch}.\${ext}`,
    category: "Utility",
    maintainer: "omcdowell",
    vendor: NAME,
    syncDesktopName: true,
    target: ["AppImage"],
  },
  appImage: {
    ...base.appImage,
    executableArgs: [`--class=${NAME}`],
    artifactName: `${NAME}-\${arch}.\${ext}`,
  },
};
