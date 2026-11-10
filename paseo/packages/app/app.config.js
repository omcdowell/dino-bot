const fs = require("node:fs");
const path = require("node:path");
const pkg = require("./package.json");
const withAndroidAsyncStorageSize = require("./plugins/with-android-async-storage-size");
const withAndroidProfileable = require("./plugins/with-android-profileable");
const withFdroidAutolinking = require("./plugins/with-fdroid-autolinking");
const withPasteInput = require("./plugins/with-paste-input");
const withAndroidScroll = require("./modules/paseo-scroll/app.plugin");
const withIosDevSigning = require("./plugins/with-ios-dev-signing");
const withFlavourSources = require("./plugins/with-flavour-sources");
const { getNativeReleaseVersion } = require("./native-release-version");
const { resolveFlavour, resolveEas, resolveShownVersion } = require("./release-flavour");
// Build flavour (release-flavour.js): "own" (the owner's build, default) or "public" (TestFlight).
const flavour = resolveFlavour();
const appVariant = process.env.APP_VARIANT ?? "production";
const isFdroidBuild = process.env.PASEO_FDROID_BUILD === "1";
const isProfileBuild = process.env.PASEO_PROFILE_BUILD === "1";
// aps-environment entitlement: expo-notifications writes "development" unless told otherwise, so a
// distribution build (TestFlight/App Store, PASEO_APNS_ENVIRONMENT=production) must pass "production"
// or the archive keeps the sandbox entitlement and does not match the App Store profile.
const apsEnvironment =
  process.env.PASEO_APNS_ENVIRONMENT === "production" ? "production" : "development";

const buildProfile = isFdroidBuild
  ? {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
      cameraPlugins: [],
      fdroidPlugins: [withFdroidAutolinking],
      notificationPlugins: [],
    }
  : {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "CAMERA",
        "android.permission.CAMERA",
      ],
      cameraPlugins: [
        [
          "expo-camera",
          {
            cameraPermission:
              "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
          },
        ],
      ],
      fdroidPlugins: [],
      notificationPlugins: [
        [
          "expo-notifications",
          {
            icon: "./assets/images/notification-icon.png",
            color: "#20744A",
            mode: apsEnvironment,
          },
        ],
      ],
    };

function resolveSecretFile(params) {
  const fromEnv = process.env[params.envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const fallbackAbsolutePath = path.resolve(__dirname, params.fallbackRelativePath);
  if (fs.existsSync(fallbackAbsolutePath)) {
    return params.fallbackRelativePath;
  }

  return undefined;
}

// a developer's own iOS build (bots-home): own App ID on team PASEO_APPLE_TEAM_ID, signed with the
// "Paseo Dev" development profile. Android keeps the upstream package id.
// The public flavour uses its own bundle id (placeholder until the owner picks a name).
const ownIosBuild = {
  bundleIdentifier: flavour.iosBundleId,
  appleTeamId: flavour.appleTeamId,
  provisioningProfile: flavour.provisioningProfile,
  // Live Activity widget extension (targets/live-activity): its own App ID and development
  // profile, to be created on the Apple account (not there yet, 2026-10-11).
  extensionProfiles: flavour.extensionProfile
    ? { [flavour.widgetBundleId]: flavour.extensionProfile }
    : {},
  // Keychain groups. The first is the app's own default group (unchanged default for existing
  // items); the second is shared with the Live Activity widget for bot icons
  // (modules/paseo-live-activity BotIconStore). Both are covered by the profiles' `<team>.*`.
  keychainAccessGroups: flavour.keychainAccessGroups,
  sharedKeychainGroup: flavour.sharedKeychainGroup,
  // App Group shared with the Live Activity widget (SharedStore.swift: bot icons, the widget's
  // report, the dino setting). Off unless PASEO_APP_GROUP=1: the group has to be registered on the
  // Apple account and added to both App IDs and both profiles first (the App Store Connect API
  // cannot do that), or the device build will not sign. targets/live-activity reads the same env.
  appGroups: process.env.PASEO_APP_GROUP === "1" ? [flavour.appGroup] : [],
  // Public flavour: DINOBOT_IOS_BUILD (dinobot-version.js). Own build: ship.sh sets it per build
  // (CURRENT_PROJECT_VERSION).
  buildNumber: flavour.iosBuildNumber ?? "$(CURRENT_PROJECT_VERSION)",
  // Pushes come from the optional paseo-apns plugin on the daemon machine (signed with the key of
  // the team that signs this app), not Expo. ship.sh signs with the development profile, so device
  // tokens are for Apple's sandbox host; a distribution-signed build (TestFlight) sets
  // PASEO_APNS_ENVIRONMENT=production. PASEO_PUSH_TRANSPORT overrides the transport.
  push: {
    transport: ["apns", "expo", "none"].includes(process.env.PASEO_PUSH_TRANSPORT)
      ? process.env.PASEO_PUSH_TRANSPORT
      : flavour.defaultPushTransport,
    apnsEnvironment:
      process.env.PASEO_APNS_ENVIRONMENT === "production" ? "production" : "development",
  },
};

const variants = {
  production: {
    name: flavour.appName,
    packageId: "sh.paseo",
    iosBundleId: ownIosBuild.bundleIdentifier,
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_PROD",
      fallbackRelativePath: "./.secrets/google-services.prod.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_PROD",
      fallbackRelativePath: "./.secrets/GoogleService-Info.prod.plist",
    }),
  },
  development: {
    name: "Paseo Debug",
    packageId: "sh.paseo.debug",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_DEBUG",
      fallbackRelativePath: "./.secrets/google-services.debug.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_DEBUG",
      fallbackRelativePath: "./.secrets/GoogleService-Info.debug.plist",
    }),
  },
};

const variant = variants[appVariant] ?? variants.production;

// Push transport (src/push-notifications/internal/push-config.ts). "expo" is upstream: an Expo
// push token registered with the daemon. "apns": the raw APNs device token registered with the
// paseo-apns daemon plugin, which sends straight to Apple; set by own iOS builds. "none": no remote
// push (local-only public builds; the Live Activity updates only while the app is open).
// apnsEnvironment must match the signing: development (sandbox host) for ship.sh / Xcode builds.
const pushConfig = {
  transport: ["apns", "none"].includes(process.env.PASEO_PUSH_TRANSPORT)
    ? process.env.PASEO_PUSH_TRANSPORT
    : "expo",
  apnsEnvironment:
    process.env.PASEO_APNS_ENVIRONMENT === "production" ? "production" : "development",
};
const nativeReleaseVersion = getNativeReleaseVersion(pkg.version);
// Expo slug / owner / project id (release-flavour.js resolveEas): own = upstream's, as today;
// public = @dino-bot/dino-bot with the id only from PASEO_EAS_PROJECT_ID (a TestFlight build with
// Expo push and no id stops with an error rather than mint tokens under upstream's project).
const eas = resolveEas(
  flavour,
  variant.iosBundleId ? ownIosBuild.push.transport : pushConfig.transport,
);

export default {
  expo: {
    name: variant.name,
    slug: eas.slug,
    // CFBundleShortVersionString (app and, via apple-targets, the Live Activity extension). Public
    // flavour: DinoBot's display version (dinobot-version.js); Android versionCode and the engine
    // version (package.json) are unchanged.
    version: flavour.displayVersion ?? nativeReleaseVersion.appVersion,
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    // Deep links (<scheme>://pair/#offer=…, src/app/+native-intent.tsx): "paseo" for the own
    // build, the public app's own scheme from its name (release-flavour.js).
    scheme: flavour.linkScheme,
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      // Dino app icon (2026-10-11): colour in light mode, mono line art in dark mode.
      icon: {
        light: "./assets/images/icon.png",
        dark: "./assets/images/icon-dark.png",
      },
      supportsTablet: flavour.supportsTablet,
      infoPlist: {
        NSMicrophoneUsageDescription: "This app needs access to the microphone for voice commands.",
        // Dictation (and realtime voice) keep capturing and streaming to the daemon while the
        // screen is locked or the app is in the background (20 Oct). The audio session is
        // only active while capturing or playing, so this does not keep the app alive otherwise.
        UIBackgroundModes: ["audio"],
        // Export compliance: the app runs its own standard encryption (E2EE: @noble Noise NK /
        // X25519 / ChaCha20-Poly1305, tweetnacl), not only Apple's, so `false` would be wrong. But
        // `ITSAppUsesNonExemptEncryption: true` without an ITSEncryptionExportComplianceCode from App
        // Store Connect is rejected at upload (ITMS-90592, 28 Oct). So the key is left out: App Store
        // Connect asks the encryption questions on each build ("Missing Compliance"). Once it issues a
        // compliance code, set `ITSAppUsesNonExemptEncryption: true` plus
        // `ITSEncryptionExportComplianceCode: "<code>"` here.
        // Busy-bots Live Activity (targets/live-activity, modules/paseo-live-activity).
        NSSupportsLiveActivities: true,
        // Updates go out at priority 10 within ~5 s of a change; this raises Apple's budget for those.
        NSSupportsLiveActivitiesFrequentUpdates: true,
        // Plain-http loads to the daemon (Files-tab downloads, 27 Oct). Downloads use
        // URLSession, which App Transport Security blocks over http (error -1022); the chat
        // WebSocket is not affected because ATS does not cover it. Since iOS 17 an http load to
        // an IP address needs that IP or its range listed here: Tailscale IPs (100.64.0.0/10 and
        // fd7a:115c:a1e0::/48), MagicDNS names (ts.net) and private LAN ranges. Everything else
        // still needs https. NSAllowsLocalNetworking covers .local and unqualified names (and on
        // iOS 15/16 all IP addresses). Do not add NSAllowsArbitraryLoads: Apple ignores it when
        // NSAllowsLocalNetworking is set, and it would open http to every host.
        NSAppTransportSecurity: {
          NSAllowsLocalNetworking: true,
          NSExceptionDomains: Object.fromEntries(
            [
              "100.64.0.0/10",
              "fd7a:115c:a1e0::/48",
              "ts.net",
              // LAN ranges only where the flavour pairs over LAN (the public build is Tailscale
              // only, so App Review sees the smallest exception list).
              ...(flavour.httpOverLan
                ? [
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "169.254.0.0/16",
                    "fe80::/10",
                    "fc00::/7",
                  ]
                : []),
            ].map((domain) => [
              domain,
              {
                NSExceptionAllowsInsecureHTTPLoads: true,
                ...(domain.includes("/") ? {} : { NSIncludesSubdomains: true }),
              },
            ]),
          ),
        },
        ...(variant.iosBundleId
          ? { PaseoSharedKeychainGroup: ownIosBuild.sharedKeychainGroup }
          : {}),
      },
      ...(variant.iosBundleId
        ? {
            entitlements: {
              "keychain-access-groups": ownIosBuild.keychainAccessGroups,
              ...(ownIosBuild.appGroups.length > 0
                ? {
                    "com.apple.security.application-groups": ownIosBuild.appGroups,
                  }
                : {}),
            },
          }
        : {}),
      bundleIdentifier: variant.iosBundleId ?? variant.packageId,
      appleTeamId: ownIosBuild.appleTeamId,
      ...(variant.googleServiceInfoPlist
        ? { googleServicesFile: variant.googleServiceInfoPlist }
        : {}),
      buildNumber: variant.iosBundleId
        ? ownIosBuild.buildNumber
        : nativeReleaseVersion.iosBuildNumber,
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#141611",
        foregroundImage: "./assets/images/android-icon-foreground.png",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
      // Allow HTTP connections for local network hosts (required for release builds)
      usesCleartextTraffic: true,
      permissions: buildProfile.androidPermissions,
      package: variant.packageId,
      versionCode: nativeReleaseVersion.androidVersionCode,
      ...(variant.googleServicesFile ? { googleServicesFile: variant.googleServicesFile } : {}),
    },
    web: {
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "expo-router",
      withPasteInput,
      withAndroidScroll,
      [withAndroidAsyncStorageSize, 64],
      ...buildProfile.cameraPlugins,
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          // Dino line art: black lines on light, white lines on dark.
          dark: {
            image: "./assets/images/splash-icon-dark.png",
            backgroundColor: "#000000",
          },
        },
      ],
      ...buildProfile.notificationPlugins,
      "expo-audio",
      [
        "expo-gradle-jvmargs",
        {
          xmx: "4096m",
          maxMetaspace: "1024m",
        },
      ],
      [
        "expo-build-properties",
        {
          android: {
            minSdkVersion: 29,
            kotlinVersion: "2.1.20",
            // Allow HTTP connections for local network hosts in release builds
            usesCleartextTraffic: true,
          },
        },
      ],
      ...buildProfile.fdroidPlugins,
      ...(isProfileBuild ? [withAndroidProfileable] : []),
      ...(appVariant === "production" && ownIosBuild.provisioningProfile
        ? [
            [
              withIosDevSigning,
              {
                profile: ownIosBuild.provisioningProfile,
                extensions: ownIosBuild.extensionProfiles,
              },
            ],
          ]
        : []),
      // Public flavour: widget sources for the flavour (scripts/apply-flavour.mjs) at prebuild.
      [withFlavourSources, { flavourId: flavour.id }],
      // Widget extension for the busy-bots Live Activity (targets/live-activity). Last: plugins
      // that edit its target (signing above) must register their mods before its project provider.
      "@bacons/apple-targets",
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      // "own" | "public" (src/constants/flavour.ts).
      flavour: flavour.id,
      appName: flavour.appName,
      linkScheme: flavour.linkScheme,
      installUrl: flavour.installUrl,
      // Version shown to people (src/utils/app-version.ts resolveDisplayVersion); null = package.json.
      // The desktop app's web UI (PASEO_WEB_PLATFORM=electron) shows the release (lib/product.json);
      // the iPhone app its marketing version (dinobot-version.js).
      displayVersion: resolveShownVersion(flavour, process.env),
      fdroidBuild: isFdroidBuild,
      profileBuild: isProfileBuild,
      push: variant.iosBundleId ? ownIosBuild.push : pushConfig,
      router: {},
      // Expo push (transport "expo") needs the app built under the publisher's own EAS project,
      // with the publisher's APNs key uploaded to EAS: Expo push tokens are minted per project.
      // PASEO_EAS_PROJECT_ID / PASEO_EAS_OWNER set it (resolveEas above).
      eas: eas.projectId ? { projectId: eas.projectId } : {},
    },
    owner: eas.owner,
  },
};
