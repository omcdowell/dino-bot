import { useId, useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { HOME_MENU_TRIGGER_SIZE, HOME_TOP_BAR_PADDING_BOTTOM } from "./home-top-bar";
import { homeFadeLayer, type HomeFadeStop } from "./home-top-fade-stops";

/** The fade layer for this screen. The bar is the safe area + its padding, the ⋯ button, padding. */
export function useHomeFadeLayer() {
  const insets = useSafeAreaInsets();
  return useMemo(
    () =>
      homeFadeLayer({
        safeAreaTop: insets.top,
        barBottomY:
          insets.top +
          HEADER_TOP_PADDING_MOBILE +
          HOME_MENU_TRIGGER_SIZE +
          HOME_TOP_BAR_PADDING_BOTTOM,
      }),
    [insets.top],
  );
}

function FadeSvg({ color, stops }: { color: string; stops: HomeFadeStop[] }) {
  const gradientId = `home-top-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          {stops.map((stop) => (
            <Stop
              key={stop.offset}
              offset={`${(stop.offset * 100).toFixed(2)}%`}
              stopColor={color}
              stopOpacity={stop.opacity}
            />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedFadeSvg = withUnistyles(FadeSvg);
const surfaceColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });

/**
 * Soft top edge of the phone home, one layer from the top of the screen: the screen colour, solid
 * behind the status bar, then the D mockup's curve, ending fully clear at the top of the first
 * item (home-top-fade-stops.ts). The top bar floats on it and the plugin's content runs under it
 * to the top of the screen, so there is no clip edge and no second piece to meet (the build 20
 * hard line). The content rests where it did in builds 18/19 (PluginScrollTopInsetProvider gives
 * the old bar height as scroll inset), so at rest the avatar is in clear view; only content
 * scrolled up under the bar fades. Takes no touches.
 */
export function MobileHomeTopFade() {
  const layer = useHomeFadeLayer();
  const style = useMemo(() => [styles.fade, { height: layer.height }], [layer.height]);
  return (
    <View pointerEvents="none" style={style} testID="mobile-home-top-fade">
      <ThemedFadeSvg stops={layer.stops} uniProps={surfaceColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  fade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
}));
