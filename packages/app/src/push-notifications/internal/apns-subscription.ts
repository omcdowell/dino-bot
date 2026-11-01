import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";
import { APNS_PLUGIN_ID, type PushConfig } from "./push-config";

/**
 * APNs transport: the raw device token goes to the paseo-apns daemon plugin over plugin RPC
 * (`register` on every connect and on token rotation, `revoke` when the host is removed).
 * Nothing is registered with the daemon's own (Expo) push path.
 */

const STORAGE_PREFIX = "@paseo:apns-device-token:";
const DEVICE_TOKEN_RE = /^[0-9a-f]{64,200}$/;

export interface ApnsNotificationsApi {
  getPermissionsAsync(): Promise<{ granted?: boolean; status: string; canAskAgain: boolean }>;
  requestPermissionsAsync(): Promise<{ granted?: boolean; status: string }>;
  getDevicePushTokenAsync(): Promise<{ type: string; data: unknown }>;
  addPushTokenListener(listener: (token: { type: string; data: unknown }) => void): {
    remove(): void;
  };
}

export interface ApnsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ApnsDeps {
  notifications: ApnsNotificationsApi;
  storage: ApnsStorage;
  config: PushConfig;
  warn?: (message: string, error?: unknown) => void;
  /** Resolves when the app may show iOS's prompt (prompt-gate.ts); default: at once. */
  waitToAsk?: () => Promise<void>;
}

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

/** Hex APNs token from expo-notifications' DevicePushToken, or null. */
export function deviceTokenOf(
  token: { type: string; data: unknown } | null | undefined,
): string | null {
  if (!token || token.type !== "ios" || typeof token.data !== "string") return null;
  const hex = token.data.trim().toLowerCase();
  return DEVICE_TOKEN_RE.test(hex) ? hex : null;
}

async function ensurePermission(
  api: ApnsNotificationsApi,
  waitToAsk?: () => Promise<void>,
): Promise<boolean> {
  const granted = (s: { granted?: boolean; status: string }) =>
    s.granted === true || s.status === "granted";
  const existing = await api.getPermissionsAsync();
  if (granted(existing)) return true;
  if (!existing.canAskAgain) return false;
  await waitToAsk?.();
  return granted(await api.requestPermissionsAsync());
}

export function startApnsSubscription(
  input: StartPushNotificationsInput,
  deps: ApnsDeps,
): () => void {
  const warn = deps.warn ?? ((message: string, error?: unknown) => console.warn(message, error));
  const key = storageKey(input.serverId);
  let stopped = false;
  let token: string | null = null;
  let registeredToken: string | null = null;
  let warned = false;
  const topic = deps.config.topic;

  const register = () => {
    if (stopped || !token || !topic || !input.client.isConnected) return;
    const sending = token;
    input.client
      .invokePluginRpc(APNS_PLUGIN_ID, "register", {
        token: sending,
        environment: deps.config.apnsEnvironment,
        topic,
      })
      .then((output) => {
        registeredToken = sending;
        const result = output as { ok?: boolean; reason?: string | null } | null;
        if (result && result.ok === false && !warned) {
          warned = true;
          warn(`[PushNotifications] paseo-apns refused the device: ${result.reason ?? "unknown"}`);
        }
        return undefined;
      })
      .catch((error: unknown) => {
        // Plugin missing or daemon without plugins: say so once per session, retry on reconnect.
        if (!warned) {
          warned = true;
          warn("[PushNotifications] Could not register with paseo-apns", error);
        }
      });
  };

  const adopt = (next: string | null) => {
    if (stopped || !next || next === token) return;
    const previous = token;
    token = next;
    void deps.storage.setItem(key, next).catch(() => undefined);
    register();
    if (previous && previous === registeredToken && input.client.isConnected) {
      void input.client
        .invokePluginRpc(APNS_PLUGIN_ID, "revoke", { token: previous })
        .catch(() => undefined);
    }
  };

  if (!topic) {
    warn("[PushNotifications] No iOS bundle identifier; APNs registration skipped");
    return () => undefined;
  }

  void ensurePermission(deps.notifications, deps.waitToAsk)
    .then(async (allowed) => {
      if (!allowed) {
        await deps.storage.removeItem(key);
        return undefined;
      }
      adopt(deviceTokenOf(await deps.notifications.getDevicePushTokenAsync()));
      return undefined;
    })
    .catch((error: unknown) =>
      warn("[PushNotifications] Failed to get the APNs device token", error),
    );

  // iOS can hand out a new token (restore, reinstall); register it as soon as it arrives.
  const tokenListener = deps.notifications.addPushTokenListener((next) =>
    adopt(deviceTokenOf(next)),
  );
  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") register();
  });

  return () => {
    stopped = true;
    tokenListener.remove();
    unsubscribe();
  };
}

export async function revokeApnsSubscription(
  input: RevokePushNotificationsInput,
  deps: Pick<ApnsDeps, "storage" | "warn">,
): Promise<void> {
  const key = storageKey(input.serverId);
  const token = await deps.storage.getItem(key);
  if (token && DEVICE_TOKEN_RE.test(token) && input.client?.isConnected) {
    try {
      await input.client.invokePluginRpc(APNS_PLUGIN_ID, "revoke", { token });
    } catch (error) {
      (deps.warn ?? console.warn)("[PushNotifications] Failed to revoke the APNs token", error);
    }
  }
  await deps.storage.removeItem(key);
}
