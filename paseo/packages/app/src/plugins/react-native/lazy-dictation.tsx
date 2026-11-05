import type { ComponentType } from "react";
import type {
  DictationOverlayProps,
  PluginDictation,
  PluginDictationOptions,
} from "@getpaseo/plugin/client/react-native";

// Typed here rather than as `typeof import("./dictation")`, so no static edge to it is left.
export interface DictationModule {
  usePluginDictation(options: PluginDictationOptions): PluginDictation;
  DictationOverlay: ComponentType<DictationOverlayProps>;
}

// ./dictation pulls in @/runtime/host-runtime, which reaches back to this runtime through
// plugins/registry -> client-runtime -> evaluate (an import cycle). Load it when a plugin calls the
// hook or renders the overlay, as Modal and ScrollView load theirs, so nothing here is read while
// those modules are still evaluating (build 28: half-initialised exports at launch).
function loadDictation(): DictationModule {
  return require("./dictation") as DictationModule;
}

export function usePluginDictation(options: PluginDictationOptions): PluginDictation {
  const { usePluginDictation: useHostPluginDictation } = loadDictation();
  return useHostPluginDictation(options);
}

export function DictationOverlay(props: DictationOverlayProps) {
  const { DictationOverlay: HostDictationOverlay } = loadDictation();
  return <HostDictationOverlay {...props} />;
}
