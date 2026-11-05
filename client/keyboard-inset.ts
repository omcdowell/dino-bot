/**
 * Keeps the group composer above the software keyboard.
 *
 * Why not React Native's KeyboardAvoidingView: it measures its own frame with onLayout, which is
 * relative to its parent, and compares that with the keyboard's top edge, which is in window
 * coordinates. That only works for a view whose parent starts at the top of the window. A plugin
 * screen is mounted under the app's ScreenHeader (safe area + 8 + 56 + 1 border ≈ 127 pt on an
 * iPhone 17), so the padding came out short by that much and the composer stayed behind the
 * keyboard. Here both edges are in window coordinates (measureInWindow), so the result is right
 * wherever the host mounts the screen.
 *
 * The app's own chat uses react-native-keyboard-controller (KeyboardTranslateView); plugins cannot
 * import it (the plugin runtime only provides react, react-native and the plugin SDK).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  type KeyboardEvent,
  type LayoutAnimationConfig,
  type View,
} from "react-native";
import { keyboardOverlap, keyboardTopFrom } from "./keyboard-geometry";

type Measurable = Pick<View, "measureInWindow">;

/**
 * Bottom inset for a full-height container: attach `ref` and `onLayout` to the container (not to a
 * child it pads), apply `inset` as its paddingBottom. Padding does not change the container's own
 * frame, so the measurement stays stable.
 */
export function useKeyboardInset(): {
  ref: (view: Measurable | null) => void;
  onLayout: () => void;
  inset: number;
} {
  const view = useRef<Measurable | null>(null);
  const keyboardTop = useRef<number | null>(null);
  const [inset, setInset] = useState(0);

  const update = useCallback((animation?: LayoutAnimationConfig) => {
    const target = view.current;
    if (!target) return;
    target.measureInWindow((x, y, width, height) => {
      const next = keyboardOverlap({ y, height }, keyboardTop.current);
      setInset((current) => {
        if (current === next) return current;
        if (animation) LayoutAnimation.configureNext(animation);
        return next;
      });
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const on = (kind: "show" | "hide" | "change") => (event: KeyboardEvent) => {
      keyboardTop.current = keyboardTopFrom(kind, event?.endCoordinates);
      const duration = event?.duration;
      update(
        duration
          ? {
              duration: Math.max(duration, 10),
              update: { duration: Math.max(duration, 10), type: (event.easing as never) || "keyboard" },
            }
          : undefined,
      );
    };
    // iOS: one frame-change event covers show, hide, and the QuickType bar resizing.
    // Android only sends did-show / did-hide.
    const subs =
      Platform.OS === "ios"
        ? [Keyboard.addListener("keyboardWillChangeFrame", on("change")), Keyboard.addListener("keyboardWillHide", on("hide"))]
        : [Keyboard.addListener("keyboardDidShow", on("show")), Keyboard.addListener("keyboardDidHide", on("hide"))];
    return () => subs.forEach((s) => s.remove());
  }, [update]);

  const ref = useCallback((next: Measurable | null) => {
    view.current = next;
  }, []);
  // Rotation, split view, or the host's header changing height: measure again.
  const onLayout = useCallback(() => update(), [update]);

  return { ref, onLayout, inset };
}
