const DEFAULT_MAX_INPUT_HEIGHT = 160;
const MAX_INPUT_VIEWPORT_RATIO = 0.5;

/** Phones: about six lines, never more than 40 % of the screen; then the input scrolls inside. */
const PHONE_MAX_INPUT_LINES = 6;
const PHONE_INPUT_LINE_HEIGHT = 21;
const PHONE_INPUT_VERTICAL_PADDING = 12;
const PHONE_MAX_INPUT_VIEWPORT_RATIO = 0.4;
const PHONE_MIN_INPUT_HEIGHT = 30;

/**
 * The composer input's max height. Past it the input scrolls inside, so on a phone the chat above
 * stays visible while a long message is typed.
 */
export function resolveMaxInputHeight(windowHeight: number, phone = false): number {
  const valid = Number.isFinite(windowHeight) && windowHeight > 0;
  if (phone) {
    const lines = PHONE_MAX_INPUT_LINES * PHONE_INPUT_LINE_HEIGHT + PHONE_INPUT_VERTICAL_PADDING;
    if (!valid) return lines;
    return Math.max(
      PHONE_MIN_INPUT_HEIGHT,
      Math.min(lines, Math.floor(windowHeight * PHONE_MAX_INPUT_VIEWPORT_RATIO)),
    );
  }
  if (!valid) return DEFAULT_MAX_INPUT_HEIGHT;
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(windowHeight * MAX_INPUT_VIEWPORT_RATIO));
}
