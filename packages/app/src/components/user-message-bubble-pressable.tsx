import { useCallback, type ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";

/**
 * A user bubble that opens something (pinned bubbles open their actions). A tap calls `onPress`.
 * A long press (phone, or a held mouse button) and a right-click (desktop) call `onLongPress`
 * instead, like other rows with actions (file explorer, diff folders). With `onLongPress` set,
 * the release after a long press does not also fire `onPress`, and on web a touch long-press no
 * longer ends in the browser's context menu.
 */
export function UserMessageBubblePressable({
  style,
  onPress,
  onLongPress,
  children,
}: {
  style: StyleProp<ViewStyle>;
  onPress: () => void;
  /** Should open, not toggle: on a touch screen in a browser both the long-press timer and the
   * browser's `contextmenu` event can fire for one hold. */
  onLongPress: () => void;
  children: ReactNode;
}) {
  const handleContextMenu = useCallback(
    (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      onLongPress();
    },
    [onLongPress],
  );
  return (
    <Pressable
      style={style}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      // @ts-ignore - onContextMenu is web-only and not in RN types.
      onContextMenu={handleContextMenu}
    >
      {children}
    </Pressable>
  );
}
