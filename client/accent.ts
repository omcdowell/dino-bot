import type { PluginTheme } from "@getpaseo/plugin";

type Colors = PluginTheme["colors"];

/** The light dino green the app sends as its accent since 13 Oct (a pale fill). */
export const DINO_GREEN_LIGHT = "#C7D08E";
/**
 * The dino green, "spring" #9CC963 (13 Oct 21:02: "spring is my chosen green, but expect it
 * change again"; was #64A633, before that #84983F). The plugin draws every UI green with it, as text
 * and as a fill, in light and dark. White on it is only ~2:1, so text and icons on it are the dark
 * ink #2B3318. Change the green here (and ON_DINO_GREEN if needed); nothing else hard-codes it.
 */
export const DINO_GREEN = "#9CC963";
export const ON_DINO_GREEN = "#2B3318";

/** The app is on the dino green theme (its accent is the light dino green). */
function dino(c: Colors): boolean {
  return c.accent.toUpperCase() === DINO_GREEN_LIGHT;
}

/**
 * The accent as a foreground on the plugin's surfaces: text, outlines, unread dots. On dino green
 * apps that is the dino green, not the app's `accentText` (light #5E6C2D, dark #C7D08E). Other
 * apps send `accentText` or, before it was added, an accent that is a mid green readable as text.
 */
export function accentText(c: Colors): string {
  if (dino(c)) return DINO_GREEN;
  return (c as Colors & { accentText?: string }).accentText ?? c.accent;
}

/** The accent as a fill (primary buttons, send, Assign, member check): dino green on dino apps. */
export function accentFill(c: Colors): string {
  return dino(c) ? DINO_GREEN : c.accent;
}

/** Text and icons drawn on `accentFill`: dark ink on the dino green. */
export function accentOn(c: Colors): string {
  return dino(c) ? ON_DINO_GREEN : c.accentForeground;
}
