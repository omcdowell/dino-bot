import * as Haptics from "expo-haptics";
import { isNative } from "@/constants/platform";

export type PluginHapticKind = "selection" | "light" | "medium" | "success" | "warning";

/** A short haptic tap on phones; nothing elsewhere. Never throws. */
export function haptic(kind: PluginHapticKind = "light"): void {
  if (!isNative) return;
  const done = (() => {
    switch (kind) {
      case "selection":
        return Haptics.selectionAsync();
      case "medium":
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      case "success":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      case "warning":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      default:
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  })();
  void done.catch(() => {});
}
