import type { TFunction } from "i18next";
import type { IconStatusResult } from "@/live-activity";

/**
 * Which Live Activity rows the Network page shows (la-avatars, 5 Nov). Every iOS build shows the
 * icon rows (what the app stored, what the widget found, the App Group), the public flavour too, so
 * a missing avatar can be told apart on a tester's phone; the widget internals (memory, dino,
 * appearance) stay the owner's. When the icon status cannot be read, the page says why instead of
 * dropping the rows (DinoBot 0.1.3 (4) showed no section at all: the rows were owner-only).
 */
export function liveActivityRowsShown(input: { os: string; publicFlavour: boolean }): {
  section: boolean;
  internals: boolean;
} {
  const section = input.os === "ios";
  return { section, internals: section && !input.publicFlavour };
}

/** The "Live Activity icons" value when there is no status: why, plus the native error if any. */
export function iconStatusUnavailableText(
  t: TFunction,
  result: Extract<IconStatusResult, { status: null }>,
): string {
  const reason = t(`network.phone.liveActivityUnavailable.${result.unavailable}`);
  return result.error
    ? t("network.phone.liveActivityUnavailableError", { reason, error: result.error })
    : reason;
}
