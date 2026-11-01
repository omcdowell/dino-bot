import { createContext, forwardRef, useContext } from "react";
// eslint-disable-next-line no-restricted-imports -- plugin client runtime injects host ReactNative.
import * as ReactNative from "react-native";
import {
  Platform,
  ScrollView as NativeScrollView,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

/**
 * Room a plugin surface's scroll content must leave at its top, because the host draws something
 * over that part of the screen (the phone home: its top bar and the fade under it). Zero everywhere
 * else. Plugins do not opt in: the `react-native` module the host hands to plugin bundles has a
 * ScrollView that applies it, so no plugin (or daemon) change is needed and the inset tracks the
 * host's own geometry.
 */
const PluginScrollTopInsetContext = createContext(0);

export const PluginScrollTopInsetProvider = PluginScrollTopInsetContext.Provider;

/**
 * The props that give a vertical scroll view `inset` points of top room, merged with the plugin's
 * own. iOS uses the native content inset, so the resting offset, the pull-to-refresh spinner, the
 * scroll indicator and tap-the-status-bar-to-top all respect it; elsewhere it is top padding.
 */
export function resolveScrollTopInsetProps(input: {
  platform: string;
  inset: number;
  props: Pick<
    ScrollViewProps,
    "contentInset" | "scrollIndicatorInsets" | "contentOffset" | "contentContainerStyle"
  >;
}): Partial<ScrollViewProps> {
  const { platform, inset, props } = input;
  if (platform === "ios") {
    const contentInset = { ...props.contentInset, top: (props.contentInset?.top ?? 0) + inset };
    return {
      contentInset,
      scrollIndicatorInsets: {
        ...props.scrollIndicatorInsets,
        top: (props.scrollIndicatorInsets?.top ?? 0) + inset,
      },
      contentOffset: props.contentOffset ?? { x: 0, y: -contentInset.top },
      automaticallyAdjustContentInsets: false,
      contentInsetAdjustmentBehavior: "never",
    };
  }
  const contentContainerStyle: StyleProp<ViewStyle> = [
    props.contentContainerStyle,
    { paddingTop: inset },
  ];
  return { contentContainerStyle };
}

/**
 * The ScrollView plugins get. The outermost vertical one takes the inset and hides it from any
 * scroll view nested inside it.
 */
export const InsetScrollView = forwardRef<NativeScrollView, ScrollViewProps>(
  function InsetScrollView(props, ref) {
    const inset = useContext(PluginScrollTopInsetContext);
    if (inset <= 0 || props.horizontal) return <NativeScrollView {...props} ref={ref} />;
    const insetProps = resolveScrollTopInsetProps({ platform: Platform.OS, inset, props });
    return (
      <PluginScrollTopInsetProvider value={0}>
        <NativeScrollView {...props} {...insetProps} ref={ref} />
      </PluginScrollTopInsetProvider>
    );
  },
);

/** `react-native` as plugin bundles see it: the real module, with the inset-aware ScrollView. */
export const pluginReactNative: typeof ReactNative = new Proxy(ReactNative, {
  get(target, key, receiver) {
    if (key === "ScrollView") return InsetScrollView;
    return Reflect.get(target, key, receiver);
  },
});
