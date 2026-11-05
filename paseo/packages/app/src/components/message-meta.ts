/**
 * Visibility rules for the metadata shown under chat bubbles (timestamps,
 * delivery ticks, turn duration). Nothing here depends on hover: the metadata
 * is always on screen so it can be read at a glance on desktop/web too.
 */

/**
 * The row under a user bubble (timestamp, tick, rewind, copy). Pending
 * bubbles render their own clock/tick inside the bubble, so the row stays
 * hidden (but keeps its space) until the message settles.
 */
export function isUserMessageTrailingRowVisible(input: {
  isPending: boolean;
  hasText: boolean;
}): boolean {
  return !input.isPending && input.hasText;
}

export interface AssistantFooterLabels {
  /** Text to render. */
  label: string;
  /** Text used to reserve width so the footer never jumps. */
  sizer: string;
  /** Whether tapping swaps between duration and end time. */
  canSwap: boolean;
}

/**
 * Labels for the assistant turn footer.
 *
 * - `showBoth` (desktop/web): duration and end time are shown together, so
 *   nothing is hidden behind hover.
 * - otherwise (phone): duration is shown and a tap reveals the end time.
 */
export function resolveAssistantFooterLabels(input: {
  durationLabel: string;
  timestampLabel: string;
  showBoth: boolean;
  revealTimestamp: boolean;
}): AssistantFooterLabels {
  const { durationLabel, timestampLabel, showBoth, revealTimestamp } = input;
  const primary = durationLabel || timestampLabel;
  const hasBoth = Boolean(durationLabel && timestampLabel);
  if (!hasBoth) {
    return { label: primary, sizer: primary, canSwap: false };
  }
  if (showBoth) {
    const combined = `${durationLabel} · ${timestampLabel}`;
    return { label: combined, sizer: combined, canSwap: false };
  }
  return {
    label: revealTimestamp ? timestampLabel : durationLabel,
    sizer: durationLabel.length >= timestampLabel.length ? durationLabel : timestampLabel,
    canSwap: true,
  };
}
