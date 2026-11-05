/**
 * react-native-svg for plugin code. Plugins cannot bundle react-native-svg (its views are native and the app
 * registers them once), so the app passes its own `SvgXml` on `@getpaseo/plugin/client/react-native`
 * (paseo branch avatar/app: plugins/react-native/runtime.ts). Feature-detected like `pickImage`: on apps without
 * it this is null and the avatar designer is not offered (the photo picker stays).
 *
 * No react-native import here, so it runs under `tsx --test`.
 */
import type { ComponentType } from "react";
import { setAvatarSvg } from "./avatar-svg";

export interface SvgXmlProps {
  xml: string;
  width?: number | string;
  height?: number | string;
}
export type SvgXmlComponent = ComponentType<SvgXmlProps>;

export function hostSvgXml(module: unknown): SvgXmlComponent | null {
  const m = (module && typeof module === "object" ? module : {}) as Record<string, unknown>;
  const svg = m.SvgXml;
  return typeof svg === "function" || (svg !== null && typeof svg === "object" && "$$typeof" in (svg as object))
    ? (svg as SvgXmlComponent)
    : null;
}

/**
 * Turns on AV4's JSON path (client/avatar-svg.ts): with the app's SvgXml the phone home draws designed avatars
 * from avatar.json; on an older app there is none and the phone keeps fetching PNGs. Returns whether it is on.
 */
export function registerAvatarSvg(module: unknown): boolean {
  const svg = hostSvgXml(module);
  setAvatarSvg(svg);
  return svg !== null;
}
