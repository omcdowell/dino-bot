/**
 * Push transport for this build, from `extra.push` in app.config.js.
 *
 * - "expo" (upstream): the app registers an Expo push token with the daemon, which sends through
 *   Expo's push service.
 * - "apns" (own iOS builds): the app registers its raw APNs device token with the `apns` daemon
 *   plugin (paseo-apns), which sends straight to Apple. No Expo token is registered, and the
 *   app shows foreground banners only for pushes from that plugin.
 * - "none" (public builds without a push service): no remote push. The app registers nothing and
 *   asks for no notification permission; the Live Activity is updated only while the app is open
 *   (the plugin's local mode, see live-activity/sync.ts).
 */
export type PushTransport = "expo" | "apns" | "none";
export type ApnsEnvironment = "development" | "production";

export interface PushConfig {
  transport: PushTransport;
  /** "development" for ship.sh / Xcode builds (Apple's sandbox host), "production" otherwise. */
  apnsEnvironment: ApnsEnvironment;
  /** APNs topic: the iOS bundle id. */
  topic: string | null;
}

/** Plugin id of paseo-apns on the daemon. */
export const APNS_PLUGIN_ID = "apns";
/** `data.source` the plugin stamps on every push it sends. */
export const APNS_PUSH_SOURCE = "paseo-apns";

interface ExpoConfigLike {
  extra?: { push?: { transport?: unknown; apnsEnvironment?: unknown } } | null;
  ios?: { bundleIdentifier?: unknown } | null;
}

export function resolvePushConfig(expoConfig: ExpoConfigLike | null | undefined): PushConfig {
  const push = expoConfig?.extra?.push;
  const bundleId = expoConfig?.ios?.bundleIdentifier;
  return {
    transport: push?.transport === "apns" || push?.transport === "none" ? push.transport : "expo",
    apnsEnvironment: push?.apnsEnvironment === "production" ? "production" : "development",
    topic: typeof bundleId === "string" && bundleId.trim() ? bundleId.trim() : null,
  };
}

/** True for a notification sent by paseo-apns (its data carries source "paseo-apns"). */
export function isApnsPluginPush(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).source === APNS_PUSH_SOURCE
  );
}
