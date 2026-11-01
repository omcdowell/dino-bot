/**
 * Swipe down on the group composer to close the keyboard (13 Oct: "swiping down on the text
 * input box doesnt close the keyboard").
 *
 * The composer never takes the touch: the PanResponder only watches moves in the capture phase,
 * calls Keyboard.dismiss() once when the move reads as a quick downward swipe, and always answers
 * "not mine". So taps into the box, the send/@/mic buttons and native text selection keep working.
 *
 * A swipe counts (isDismissSwipe, keyboard-geometry.ts) when it has gone down more than SWIPE_MIN_DY, mostly vertically, and early in the
 * touch: a long-press (text selection / loupe) only starts dragging after ~500 ms, so it never counts.
 * Web is left out: there a mouse drag down is text selection and the keyboard is the hardware one.
 */
import { useMemo, useRef } from "react";
import { Keyboard, PanResponder, Platform, type GestureResponderHandlers } from "react-native";
import { isDismissSwipe } from "./keyboard-geometry";

/** Spread the result onto the composer's outer View. */
export function useSwipeDownDismiss(): GestureResponderHandlers | undefined {
  const startedAt = useRef(0);
  const done = useRef(false);
  return useMemo(() => {
    if (Platform.OS === "web") return undefined;
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        startedAt.current = Date.now();
        done.current = false;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        if (!done.current && isDismissSwipe(g, Date.now() - startedAt.current)) {
          done.current = true;
          Keyboard.dismiss();
        }
        return false;
      },
    }).panHandlers;
  }, []);
}
