import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(_input: StartPushNotificationsInput): () => void {
  return () => undefined;
}

export async function revokePushNotifications(_input: RevokePushNotificationsInput): Promise<void> {
  // Push notifications are native-only.
}

/** Own iOS build pushing through paseo-apns (native only). */
export function isApnsPushBuild(): boolean {
  return false;
}

/** A reply finished: may open the notification-prompt gate (native only). */
export function noteReplyForPushPrompt(): void {}
