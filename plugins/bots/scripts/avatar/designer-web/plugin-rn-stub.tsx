// @ts-nocheck -- dev-only web harness: built with a Paseo checkout's react-dom / react-native-svg / lucide (build.mjs), not this package's.
// Web harness stand-in for `@getpaseo/plugin/client/react-native`: what the Paseo app passes plugins, as far as
// the avatar designer uses it (Icon = the app's Lucide icons, SvgXml = react-native-svg, from paseo avatar/app).
import * as Lucide from "lucide-react-native";
import { SvgXml as RnSvgXml } from "react-native-svg";
import { createElement } from "react";

export function Icon({ name, size, color }: { name: string; size?: number; color?: string }) {
  const C = (Lucide as Record<string, unknown>)[name];
  return C ? createElement(C as never, { size, color }) : null;
}
export function SvgXml(props: { xml: string; width?: number | string; height?: number | string }) {
  return createElement(RnSvgXml, props);
}
export const pickImage = async () => null;
export const haptic = () => {};
export function useToast() {
  return { show: (m: string) => console.log("toast:", m), error: (m: string) => console.log("toast error:", m) };
}
