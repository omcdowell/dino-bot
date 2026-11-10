/**
 * Build-time flavour (release/app). One switch, read by app.config.js and the Live Activity target
 * config, exposed to the app as `extra.flavour` (src/constants/flavour.ts).
 *
 * - "own" (default): a developer's own build (bundle id from PASEO_OWN_BUNDLE_ID), bundled bot avatars, debug pickers,
 *   host badges, raw model ids.
 * - "public": the TestFlight build. Same coding features (workspaces, terminals, git all stay), but
 *   no owner-only parts: no bundled avatars or Live Activity debug pickers, no host name in the
 *   header unless there are several hosts, friendly model names instead of raw ids, and its own
 *   name and bundle id.
 *
 * Select with PASEO_FLAVOUR=public. The public names live only here (27 Oct 10:24: align on
 * "dino-bot"): Expo project @dino-bot/dino-bot, repo omcdowell/dino-bot.
 *
 * Apple IDs are build settings, not source (5 Nov): whoever builds the app signs it with their own
 * Apple developer account, so nobody's real IDs are wired in here.
 *   PASEO_BUNDLE_ID          the app's bundle id (either flavour; PASEO_OWN_BUNDLE_ID still works for "own")
 *   PASEO_WIDGET_BUNDLE_ID   the Live Activity extension's id; default <bundle id>.LiveActivity, and Apple
 *                            requires it to start with "<bundle id>."
 *   PASEO_APPLE_TEAM_ID      the developer team (10 characters)
 * Without PASEO_BUNDLE_ID a build gets the neutral placeholder (com.example.paseo / com.example.dinobot),
 * which is fine for the simulator; a distribution build (TestFlight / App Store) of the public flavour
 * refuses the placeholder instead of uploading under an id nobody owns.
 */

/** DinoBot's display version and iOS build: dinobot-version.js (the one place they live). */
const { DINOBOT_VERSION, DINOBOT_IOS_BUILD, dinobotReleaseVersion } = require("./dinobot-version.js");
/** The DinoBot release (lib/product.json): the desktop app's version. Null outside the DinoBot repo. */
const DINOBOT_RELEASE_VERSION = dinobotReleaseVersion();

/** Working name (27 Oct: "DinoBot"). The ONE place the public name lives. */
const PUBLIC_APP_NAME = "DinoBot";
/** One-line installer the public welcome screen shows (27 Oct; do not shorten to /i). */
const PUBLIC_INSTALL_URL = "https://omcdowell.github.io/dino-bot/install";
/** Deep-link scheme of the public app, from the name: dinobot://pair/#offer=… opens pairing. */
const PUBLIC_LINK_SCHEME = PUBLIC_APP_NAME.toLowerCase().replace(/[^a-z0-9+.-]/g, "");
/**
 * Placeholder bundle id of the public flavour: set PASEO_BUNDLE_ID to the App ID registered on your
 * Apple account (and <id>.LiveActivity for the widget). No hyphen: Android package names forbid it.
 */
const PUBLIC_IOS_BUNDLE_ID = "com.example.dinobot";
/** The placeholders, refused for distribution builds of the public flavour (resolveFlavour). */
const PLACEHOLDER_BUNDLE_IDS = new Set(["com.example.paseo", PUBLIC_IOS_BUNDLE_ID]);
/** The widget extension's id is the app's plus this, unless PASEO_WIDGET_BUNDLE_ID says otherwise. */
const WIDGET_SUFFIX = "LiveActivity";
/** Expo organisation and slug of the public app: project @dino-bot/dino-bot (never upstream's). */
const PUBLIC_EAS_OWNER = "dino-bot";
const PUBLIC_EXPO_SLUG = "dino-bot";
/** Upstream's Expo project and owner, kept only for the own build (unchanged). */
const UPSTREAM_EAS_PROJECT_ID = "0e7f65ce-0367-46c8-a238-2b65963d235a";
const UPSTREAM_EAS_OWNER = "getpaseo";

const FLAVOURS = {
  own: {
    id: "own",
    appName: "Paseo",
    /** Placeholder; set PASEO_OWN_BUNDLE_ID to your own App ID. */
    iosBundleId: "com.example.paseo",
    /** Display version: null = package.json's (upstream line), as today. */
    displayVersion: null,
    /** Desktop app version: null = package.json's, as today. */
    desktopVersion: null,
    /** iOS build number: null = ship.sh's CURRENT_PROJECT_VERSION, as today. */
    iosBuildNumber: null,
    /** Apple developer team: PASEO_APPLE_TEAM_ID (not kept in the source). */
    appleTeamId: null,
    /** Development profile names on the Apple account (ship.sh). */
    provisioningProfile: "Paseo Dev",
    extensionProfile: "Paseo LiveActivity Dev",
    widgetDisplayName: "Paseo Bots",
    /** URL scheme (paseo://pair/#offer=…), as today. */
    linkScheme: "paseo",
    /** No install step on the welcome screen (installs his own host). */
    installUrl: null,
    /** Push transport when PASEO_PUSH_TRANSPORT is unset: the paseo-apns plugin, as today. */
    defaultPushTransport: "apns",
    /** iPhone and iPad (as today). */
    supportsTablet: true,
    /** Expo slug, owner and default project id: upstream's, as today. */
    expoSlug: "voice-mobile",
    easOwner: UPSTREAM_EAS_OWNER,
    easProjectId: UPSTREAM_EAS_PROJECT_ID,
    /** ATS: plain-http downloads from the daemon over LAN ranges too (Tailscale always). */
    httpOverLan: true,
  },
  public: {
    id: "public",
    appName: PUBLIC_APP_NAME,
    iosBundleId: PUBLIC_IOS_BUNDLE_ID,
    /** Shown to people (dinobot-version.js); package.json stays the engine/plugin version. */
    displayVersion: DINOBOT_VERSION,
    iosBuildNumber: DINOBOT_IOS_BUILD,
    /**
     * The desktop app (dmg/AppImage, About panel, its web UI) shows the release it ships with
     * (lib/product.json), not the iPhone's marketing version (dinobot-version.js).
     */
    desktopVersion: DINOBOT_RELEASE_VERSION,
    /** Apple developer team: PASEO_APPLE_TEAM_ID (not kept in the source). */
    appleTeamId: null,
    // Distribution signing is set up with the App Store profile at upload time, not here.
    provisioningProfile: null,
    extensionProfile: null,
    widgetDisplayName: PUBLIC_APP_NAME,
    linkScheme: PUBLIC_LINK_SCHEME,
    installUrl: PUBLIC_INSTALL_URL,
    /** Expo push for public alerts (morning report Q4, rec "Expo"); "none" = local only. */
    defaultPushTransport: "expo",
    /** iPhone only for v1 (25 Oct). */
    supportsTablet: false,
    /** Expo project @dino-bot/dino-bot; its id comes only from PASEO_EAS_PROJECT_ID (resolveEas). */
    expoSlug: PUBLIC_EXPO_SLUG,
    easOwner: PUBLIC_EAS_OWNER,
    easProjectId: null,
    /** Tailscale only (27 Oct): no LAN ranges in the ATS exceptions. */
    httpOverLan: false,
  },
};

/** The flavour for this build. Unknown values fail loudly rather than build the owner's app by mistake. */
function resolveFlavour(env = process.env) {
  const id = (env.PASEO_FLAVOUR || "own").trim();
  const flavour = FLAVOURS[id];
  if (!flavour) throw new Error(`PASEO_FLAVOUR must be "own" or "public", got "${id}"`);
  const bundleId =
    (env.PASEO_BUNDLE_ID || "").trim() ||
    (id === "own" && (env.PASEO_OWN_BUNDLE_ID || "").trim()) ||
    flavour.iosBundleId;
  const widgetBundleId =
    (env.PASEO_WIDGET_BUNDLE_ID || "").trim() || `${bundleId}.${WIDGET_SUFFIX}`;
  if (!widgetBundleId.startsWith(`${bundleId}.`) || widgetBundleId.length <= bundleId.length + 1) {
    throw new Error(
      `PASEO_WIDGET_BUNDLE_ID must be the app's bundle id plus a suffix (${bundleId}.${WIDGET_SUFFIX}), got "${widgetBundleId}"`,
    );
  }
  const distribution = env.PASEO_APNS_ENVIRONMENT === "production" || env.EAS_BUILD === "true";
  if (id === "public" && distribution && PLACEHOLDER_BUNDLE_IDS.has(bundleId)) {
    throw new Error(
      `PASEO_BUNDLE_ID is not set: a ${flavour.appName} distribution build needs your own App ID ` +
        `(the placeholder ${bundleId} belongs to nobody). See docs/live-activities.md in the DinoBot repo.`,
    );
  }
  return {
    ...flavour,
    iosBundleId: bundleId,
    appleTeamId: (env.PASEO_APPLE_TEAM_ID || "").trim() || flavour.appleTeamId || undefined,
    keychainAccessGroups: [
      `$(AppIdentifierPrefix)${bundleId}`,
      `$(AppIdentifierPrefix)${bundleId}.shared`,
    ],
    sharedKeychainGroup: `$(AppIdentifierPrefix)${bundleId}.shared`,
    appGroup: `group.${bundleId}`,
    widgetBundleId,
    /** For the widget target (expo-target.config.js): relative to the app's id, e.g. ".LiveActivity". */
    widgetBundleSuffix: widgetBundleId.slice(bundleId.length),
  };
}

/**
 * Expo slug, owner and project id for this build. PASEO_EAS_OWNER / PASEO_EAS_PROJECT_ID override.
 * The public flavour has no default project id (never upstream's: Expo push tokens are minted per
 * project). A public distribution build (PASEO_APNS_ENVIRONMENT=production or an EAS build) with
 * Expo push and no PASEO_EAS_PROJECT_ID stops here with a clear error; other public builds
 * (simulator, dev) get no project id, so the app simply has no Expo push token.
 */
function resolveEas(flavour, pushTransport, env = process.env) {
  const projectId = (env.PASEO_EAS_PROJECT_ID || "").trim() || flavour.easProjectId || undefined;
  const owner = (env.PASEO_EAS_OWNER || "").trim() || flavour.easOwner;
  const distribution = env.PASEO_APNS_ENVIRONMENT === "production" || env.EAS_BUILD === "true";
  if (!projectId && pushTransport === "expo" && distribution) {
    throw new Error(
      `PASEO_EAS_PROJECT_ID is not set: the ${flavour.appName} TestFlight build needs the id of the ` +
        `Expo project @${owner}/${flavour.expoSlug} for push ("npx eas-cli project:info" in ` +
        `packages/app). Or build without notifications: PASEO_PUSH_TRANSPORT=none.`,
    );
  }
  return { slug: flavour.expoSlug, owner, projectId };
}

/**
 * The version the app's UI shows (app.config.js `extra.displayVersion`): the release
 * (desktopVersion, lib/product.json) in the desktop app's web UI (PASEO_WEB_PLATFORM=electron),
 * else the flavour's display version (the iPhone's, dinobot-version.js). null = package.json's.
 */
function resolveShownVersion(flavour, env = process.env) {
  if (env.PASEO_WEB_PLATFORM === "electron" && flavour.desktopVersion) return flavour.desktopVersion;
  return flavour.displayVersion;
}

module.exports = {
  resolveFlavour,
  resolveShownVersion,
  resolveEas,
  FLAVOURS,
  PUBLIC_APP_NAME,
  PUBLIC_IOS_BUNDLE_ID,
  PLACEHOLDER_BUNDLE_IDS,
  PUBLIC_LINK_SCHEME,
  PUBLIC_INSTALL_URL,
  PUBLIC_EAS_OWNER,
  PUBLIC_EXPO_SLUG,
  DINOBOT_VERSION,
  DINOBOT_IOS_BUILD,
  DINOBOT_RELEASE_VERSION,
};
