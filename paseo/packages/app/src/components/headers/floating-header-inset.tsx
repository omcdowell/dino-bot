import { createContext, useContext } from "react";

/**
 * How much of the top of this subtree is covered by floating header controls (the phone
 * workspace header, option D). Zero everywhere else.
 *
 * A surface that scrolls under the controls (the native chat) takes this as scroll inset; things
 * pinned to its top edge (toasts) move down by it. Tabs that do not scroll under are padded by the
 * workspace screen instead, and see zero here.
 */
const FloatingHeaderInsetContext = createContext(0);

export const FloatingHeaderInsetProvider = FloatingHeaderInsetContext.Provider;

export function useFloatingHeaderInset(): number {
  return useContext(FloatingHeaderInsetContext);
}
