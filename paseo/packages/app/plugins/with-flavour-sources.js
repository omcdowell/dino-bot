const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { withDangerousMod } = require("expo/config-plugins");

// Public flavour only: runs scripts/apply-flavour.mjs during `expo prebuild` (ios), so the Live
// Activity widget sources (bundled-avatar table: empty, or PASEO_BUNDLED_AVATARS_DIR's; the
// flavour's keychain group) can never be
// forgotten by a build script (ship.sh / paseo-build call prebuild; the own build is untouched).
// It edits targets/live-activity in place (@bacons/apple-targets links that folder, it does not
// copy it); undo with `git checkout -- targets/live-activity`.
function withFlavourSources(config, { flavourId }) {
  if (flavourId === "own") return config;
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const script = path.join(__dirname, "..", "scripts", "apply-flavour.mjs");
      const { applyFlavour, flavourSourcesEnv } = await import(pathToFileURL(script).href);
      // The build's env (PASEO_BUNDLE_ID) too, not only the flavour id: the widget's keychain group follows it.
      const changed = applyFlavour(flavourSourcesEnv(flavourId));
      if (changed.length) console.log(`[flavour ${flavourId}] rewrote ${changed.join(", ")}`);
      return cfg;
    },
  ]);
}

module.exports = withFlavourSources;
