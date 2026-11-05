export const DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT = 120;

/** Reserve both endpoints during motion so content cannot grow into a closing IME. */
export function reserveKeyboardLayoutShift(input: {
  current: number;
  target: number;
  phase: "start" | "end";
}): number {
  "worklet";
  return input.phase === "start" ? Math.max(input.current, input.target) : input.target;
}

/**
 * Scroll room at the inverted chat's far end (the visual top). The keyboard shift translates the
 * list up by `settledShift`; `farEndOverlayInset` is chrome floating over the top of the list (the
 * phone's glass header), which the history scrolls under but must be able to clear.
 */
export function resolveStreamKeyboardInset(input: {
  platform: "android" | "ios";
  settledShift: number;
  farEndOverlayInset?: number;
}): {
  contentContainerPaddingBottom: number;
  contentInset: { bottom: number } | undefined;
} {
  const settledShift = Math.max(0, input.settledShift);
  const farEnd = settledShift + Math.max(0, input.farEndOverlayInset ?? 0);
  if (input.platform === "ios") {
    return {
      contentContainerPaddingBottom: 0,
      contentInset: { bottom: farEnd },
    };
  }
  return {
    contentContainerPaddingBottom: farEnd,
    contentInset: undefined,
  };
}

export function shouldUseCompactExplorerKeyboardPadding(input: {
  isGit: boolean;
  explorerTab: "changes" | "files" | "pr" | "network";
}): boolean {
  return !input.isGit || input.explorerTab !== "changes";
}

export function resolveKeyboardShift(input: {
  rawKeyboardHeight: number;
  keyboardProgress: number;
  bottomInset: number;
  isIos: boolean;
  iosMinHeight: number;
}): number {
  "worklet";

  if (!(input.keyboardProgress > 0) || !(input.rawKeyboardHeight > 0)) {
    return 0;
  }

  // iOS can report a small accessory/prediction bar height during touch focus.
  // Treat that as non-keyboard so layouts don't "bounce" while interacting.
  if (input.isIos && input.rawKeyboardHeight < input.iosMinHeight) {
    return 0;
  }

  return Math.max(0, input.rawKeyboardHeight - input.bottomInset);
}

export function shouldReconcileHiddenKeyboardEnd(input: {
  height: number;
  progress: number;
}): boolean {
  "worklet";
  return !(input.height > 0) || !(input.progress > 0);
}
