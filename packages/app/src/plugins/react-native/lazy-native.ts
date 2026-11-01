import { createElement, type ReactElement } from "react";
import type {
  PluginHapticKind,
  PluginPickedImage,
  PluginPickImageOptions,
} from "@getpaseo/plugin/client/react-native";

// Native modules load on first use, as dictation does, so evaluating the plugin runtime pulls in
// no expo module (and tests of the runtime need none).
export function pickImage(options?: PluginPickImageOptions): Promise<PluginPickedImage | null> {
  const picker = require("./image-picker") as {
    pickImage(options?: PluginPickImageOptions): Promise<PluginPickedImage | null>;
  };
  return picker.pickImage(options);
}

export function haptic(kind?: PluginHapticKind): void {
  try {
    const haptics = require("./haptics") as { haptic(kind?: PluginHapticKind): void };
    haptics.haptic(kind);
  } catch {
    // no haptics on this client
  }
}

/** As `PluginSvgXmlProps` in @getpaseo/plugin/client/react-native. */
interface SvgXmlProps {
  xml: string;
  width?: number | string;
  height?: number | string;
}

/** react-native-svg's SvgXml for plugin code (plugins cannot bundle react-native-svg: its views are native). */
export function SvgXml(props: SvgXmlProps): ReactElement {
  const svg = require("react-native-svg") as typeof import("react-native-svg");
  return createElement(svg.SvgXml, props);
}
