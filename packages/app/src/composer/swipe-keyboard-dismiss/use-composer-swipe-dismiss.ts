import { useMemo, useRef } from "react";
// Only the static TextInput.State API (blur the focused input); no raw TextInput is rendered here.
// oxlint-disable-next-line no-restricted-imports
import { Keyboard, PanResponder, TextInput, type GestureResponderHandlers } from "react-native";
import { useKeyboardShift } from "@/keyboard/shift";
import { isWeb } from "@/constants/platform";
import { isComposerDismissSwipe } from "./model";

/**
 * Swipe down on the composer to close the keyboard. Spread the result onto the composer's
 * container View.
 *
 * The composer never takes the touch: the PanResponder only watches moves in the capture phase,
 * dismisses once when the move reads as a quick swipe down, and always answers "not mine". Taps into
 * the input, the composer buttons and native text selection keep working. Web is left out: there a
 * mouse drag down is text selection.
 */
export function useComposerSwipeDismiss(): GestureResponderHandlers | undefined {
  const { shift } = useKeyboardShift();
  const startedAtRef = useRef(0);
  const doneRef = useRef(false);

  return useMemo(() => {
    if (isWeb) {
      return undefined;
    }
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        startedAtRef.current = Date.now();
        doneRef.current = false;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_event, gesture) => {
        if (
          doneRef.current ||
          !isComposerDismissSwipe(gesture, Date.now() - startedAtRef.current)
        ) {
          return false;
        }
        doneRef.current = true;
        // Same gate and blur+dismiss pair as the history's flick-to-dismiss
        // (agent-stream/scroll-keyboard-dismiss): a hardware keyboard leaves no inset, so the
        // focused composer is not blurred then.
        if (shift.value <= 0) {
          return false;
        }
        const focusedInput = TextInput.State.currentlyFocusedInput();
        if (focusedInput) {
          TextInput.State.blurTextInput(focusedInput);
        }
        Keyboard.dismiss();
        return false;
      },
    }).panHandlers;
  }, [shift]);
}
