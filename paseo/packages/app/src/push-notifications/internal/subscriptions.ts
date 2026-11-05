import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { z } from "zod";
import { readValidatedString } from "@/storage/validated-storage";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";
import { APNS_PLUGIN_ID, resolvePushConfig, type PushConfig } from "./push-config";
import { revokeApnsSubscription, startApnsSubscription } from "./apns-subscription";
import { pushPromptGate } from "./push-prompt";
import { pluginAvailable } from "@/plugins/plugin-available";

const STORAGE_PREFIX = "@paseo:expo-push-token:";
const ExpoPushTokenSchema = z.string().trim().min(1);

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

function getExpoProjectId(): string | null {
  const fromEas = ExpoPushTokenSchema.safeParse(Constants.easConfig?.projectId);
  if (fromEas.success) return fromEas.data;
  const fromExtra = ExpoPushTokenSchema.safeParse(Constants.expoConfig?.extra?.eas?.projectId);
  return fromExtra.success ? fromExtra.data : null;
}

async function ensurePushPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!existing.canAskAgain) return false;
  // Public flavour: iOS's prompt waits for the first bot reply, not Connect (prompt-gate.ts).
  await pushPromptGate.wait();
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === Notifications.PermissionStatus.GRANTED;
}

async function resolveToken(serverId: string): Promise<string | null> {
  const key = storageKey(serverId);
  const cached = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (!(await ensurePushPermission())) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    console.warn("[PushNotifications] Missing EAS projectId; cannot fetch Expo push token");
    return cached;
  }

  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = result.data.trim();
  if (!token) return cached;
  await AsyncStorage.setItem(key, token);
  return token;
}

export function getPushConfig(): PushConfig {
  return resolvePushConfig(Constants.expoConfig);
}

/** Own iOS builds with `extra.push.transport = "apns"`: paseo-apns instead of Expo push. */
export function usesApnsTransport(config: PushConfig = getPushConfig()): boolean {
  return config.transport === "apns" && Platform.OS === "ios";
}

/** `extra.push.transport = "none"`: no remote push at all (local-only builds). */
export function usesNoPush(config: PushConfig = getPushConfig()): boolean {
  return config.transport === "none";
}

export function startSubscription(input: StartPushNotificationsInput): () => void {
  const config = getPushConfig();
  if (usesNoPush(config)) return () => undefined;
  if (usesApnsTransport(config)) {
    return startApnsSubscription(input, {
      notifications: Notifications,
      storage: AsyncStorage,
      config,
      waitToAsk: () => pushPromptGate.wait(),
    });
  }
  return startExpoSubscription(input);
}

function startExpoSubscription(input: StartPushNotificationsInput): () => void {
  let stopped = false;
  let token: string | null = null;
  let pluginWarned = false;
  const register = () => {
    if (!stopped && token && input.client.isConnected) {
      // The daemon's own Expo push (agent attention, upstream).
      input.client.registerPushToken(token);
      // The push plugin in expo mode (bot DMs and other alerts). Best effort: a host without the
      // plugin is not asked at all (rel-demo bug 8), and an older one without `register-expo`
      // just does not get the token.
      const { client } = input;
      const expoToken = token;
      void pluginAvailable(client, APNS_PLUGIN_ID)
        .then((available) =>
          available
            ? client.invokePluginRpc(APNS_PLUGIN_ID, "register-expo", { token: expoToken })
            : undefined,
        )
        .catch((error: unknown) => {
          if (!pluginWarned) {
            pluginWarned = true;
            console.warn("[PushNotifications] push plugin did not take the Expo token", error);
          }
        });
    }
  };

  void resolveToken(input.serverId)
    .then((resolved) => {
      if (stopped) return undefined;
      token = resolved;
      register();
      return undefined;
    })
    .catch((error) => console.warn("[PushNotifications] Failed to register push token", error));

  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") register();
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

export async function revokeSubscription(input: RevokePushNotificationsInput): Promise<void> {
  if (usesNoPush()) return;
  if (usesApnsTransport()) {
    await revokeApnsSubscription(input, { storage: AsyncStorage });
    return;
  }
  const key = storageKey(input.serverId);
  const token = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (
    token &&
    input.client?.isConnected &&
    input.client.getLastServerInfoMessage()?.features?.pushTokenRevocation === true
  ) {
    try {
      await input.client.unregisterPushToken(token);
    } catch (error) {
      console.warn("[PushNotifications] Failed to revoke push token", error);
    }
  }
  if (token && input.client?.isConnected && (await pluginAvailable(input.client, APNS_PLUGIN_ID))) {
    await input.client
      .invokePluginRpc(APNS_PLUGIN_ID, "revoke-expo", { token })
      .catch(() => undefined);
  }
  await AsyncStorage.removeItem(key);
}
