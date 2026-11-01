import { revokeSubscription, startSubscription, usesApnsTransport } from "./internal/subscriptions";
import { pushPromptGate } from "./internal/push-prompt";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  return startSubscription(input);
}

export function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}

/** Own iOS build pushing through paseo-apns instead of Expo push. */
export function isApnsPushBuild(): boolean {
  return usesApnsTransport();
}

/**
 * A bot (or agent) finished a reply. In the public flavour this is when iOS's notification prompt
 * may appear (not at Connect); a no-op once the gate is open or where it is off.
 */
export function noteReplyForPushPrompt(): void {
  pushPromptGate.noteReply();
}
