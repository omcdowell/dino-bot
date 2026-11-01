/**
 * The SVG drawer for avatars drawn from avatar.json (react-native-svg `SvgXml`). Plugin client code
 * can only import the host modules Paseo provides (react, react-native, zod, react-query, the
 * plugin SDK); apps with the paseo avatar/app change pass `SvgXml` on
 * `@getpaseo/plugin/client/react-native`, and index.client.tsx registers it here at start
 * (client/host-svg.ts registerAvatarSvg, feature-detected). Without it (older apps) the phone keeps
 * fetching PNGs (at the size it needs) and never asks for avatar.json.
 */
import type { ComponentType } from "react";

export type AvatarSvgComponent = ComponentType<{ xml: string; width?: number | string; height?: number | string }>;

let drawer: AvatarSvgComponent | null = null;

export function setAvatarSvg(component: AvatarSvgComponent | null): void {
  drawer = component;
}

export function avatarSvg(): AvatarSvgComponent | null {
  return drawer;
}
