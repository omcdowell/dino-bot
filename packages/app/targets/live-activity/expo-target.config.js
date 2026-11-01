/**
 * Widget extension for the busy-bots Live Activity (@bacons/apple-targets). Bundle id is the app's
 * plus ".LiveActivity" (com.example.paseo.LiveActivity for the own iOS build), or PASEO_WIDGET_BUNDLE_ID
 * (release-flavour.js); a device build needs an App ID and a provisioning profile for it.
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
const { resolveFlavour } = require("../../release-flavour");

module.exports = () => {
  const flavour = resolveFlavour();
  return {
    type: "widget",
    // Not "PaseoLiveActivity": that is the native module's Swift module name (same products dir).
    name: "PaseoBotsWidget",
    displayName: flavour.widgetDisplayName,
    bundleIdentifier: flavour.widgetBundleSuffix,
    deploymentTarget: "16.2",
    frameworks: ["SwiftUI", "WidgetKit", "ActivityKit"],
    // Bot icons from the app (BotIconStore.swift): the team's shared keychain group, already allowed
    // by the profile's `<team>.*` wildcard. Info.plist names it as PaseoSharedKeychainGroup.
    // App Group (SharedStore.swift), only with PASEO_APP_GROUP=1, as for the app (app.config.js).
    entitlements: {
      "keychain-access-groups": [flavour.sharedKeychainGroup],
      ...(process.env.PASEO_APP_GROUP === "1"
        ? { "com.apple.security.application-groups": [flavour.appGroup] }
        : {}),
    },
  };
};
