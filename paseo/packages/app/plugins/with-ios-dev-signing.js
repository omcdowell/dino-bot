const { withXcodeProject } = require("expo/config-plugins");

const unquote = (value) => String(value ?? "").replace(/^"(.*)"$/, "$1");

function sign(settings, { profile, extensions }, quote) {
  const bundleId = unquote(settings.PRODUCT_BUNDLE_IDENTIFIER);
  const name = extensions[bundleId] ?? profile;
  settings.CODE_SIGN_STYLE = "Manual";
  settings.PROVISIONING_PROFILE_SPECIFIER = quote ? `"${name}"` : name;
  settings.CODE_SIGN_IDENTITY = quote ? '"Apple Development"' : "Apple Development";
}

// Manual development signing: a named provisioning profile and the "Apple Development" identity
// for the app target, and for each app extension listed in `extensions` (bundle id -> profile),
// e.g. the Live Activity widget (targets/live-activity). Team comes from expo.ios.appleTeamId.
// Extension targets are added by @bacons/apple-targets in its own project mod, which runs after
// the standard one, so they are signed in that mod too.
function withIosDevSigning(config, { profile, extensions = {} }) {
  const options = { profile, extensions };
  config = withXcodeProject(config, (cfg) => {
    const configurations = cfg.modResults.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key].buildSettings;
      if (settings && settings.PRODUCT_BUNDLE_IDENTIFIER) sign(settings, options, true);
    }
    return cfg;
  });
  if (Object.keys(extensions).length === 0) return config;
  const { withXcodeProjectBeta } = require("@bacons/apple-targets/build/with-bacons-xcode");
  return withXcodeProjectBeta(config, (cfg) => {
    for (const target of cfg.modResults.rootObject.props.targets) {
      for (const conf of target.props.buildConfigurationList?.props.buildConfigurations ?? []) {
        const settings = conf.props.buildSettings;
        if (!settings || !extensions[unquote(settings.PRODUCT_BUNDLE_IDENTIFIER)]) continue;
        sign(settings, options, false);
        // apple-targets copies the app's build number, here the literal "$(CURRENT_PROJECT_VERSION)"
        // (ship.sh passes the real one on the command line): a self-reference that leaves the
        // extension without CFBundleVersion, which iOS refuses to install.
        if (settings.CURRENT_PROJECT_VERSION === "$(CURRENT_PROJECT_VERSION)") {
          settings.CURRENT_PROJECT_VERSION = "1";
        }
      }
    }
    return cfg;
  });
}

module.exports = withIosDevSigning;
