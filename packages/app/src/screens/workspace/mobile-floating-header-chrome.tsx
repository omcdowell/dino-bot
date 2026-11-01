/**
 * The phone floating header's chrome (header D): the fade, the row of glass controls, the plugin
 * screen's title pill and the button sizes. Kept free of the workspace screen's modules
 * (WorkspaceAvatar, workspace-header-menu-tabs, panels) because plugins/surface-screen.tsx uses it,
 * and reaching those from there closes an import cycle back through @/plugins (build 28: the
 * Release app crashed at launch). The bot chat's identity pill is in ./mobile-floating-header.
 */
import { useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { GlassSurface } from "@/components/ui/glass-surface";
import type { Theme } from "@/styles/theme";
import {
  MOBILE_FLOATING_HEADER_CONTROL_SIZE,
  MOBILE_FLOATING_HEADER_GAP,
  MOBILE_FLOATING_HEADER_SIDE_MARGIN,
  MOBILE_FLOATING_HEADER_TOP_GAP,
  resolveMobileFloatingHeaderFade,
  type MobileFloatingHeaderFadeStop,
} from "./mobile-floating-header-model";

const PILL_RADIUS = MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2;

/**
 * The scroll-edge fade: the screen colour, solid behind the status bar, easing to clear below the
 * controls. An SVG gradient rather than stacked bands, so there is no step and no line.
 */
function FadeSvg({ color, stops }: { color: string; stops: MobileFloatingHeaderFadeStop[] }) {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="workspaceHeaderFade" x1="0" y1="0" x2="0" y2="1">
          {stops.map((stop) => (
            <Stop
              key={stop.offset}
              offset={stop.offset}
              stopColor={color}
              stopOpacity={stop.opacity}
            />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#workspaceHeaderFade)" />
    </Svg>
  );
}

// The whole SVG is themed, not each Stop: withUnistyles does not reach a Stop's stopColor, which
// then defaults to black (build 21 round 1: a black fade in light mode).
const ThemedFadeSvg = withUnistyles(FadeSvg);
const surfaceColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });

/**
 * The scroll-edge fade: the screen colour, solid behind the status bar, easing to clear below the
 * controls. An SVG gradient rather than stacked bands, so there is no step and no line.
 */
function FloatingHeaderFade({ safeAreaTop }: { safeAreaTop: number }): ReactElement {
  const fade = useMemo(() => resolveMobileFloatingHeaderFade(safeAreaTop), [safeAreaTop]);
  const style = useMemo(() => [styles.fade, { height: fade.height }], [fade.height]);
  return (
    <View style={style} pointerEvents="none" testID="workspace-floating-header-fade">
      <ThemedFadeSvg stops={fade.stops} uniProps={surfaceColorMapping} />
    </View>
  );
}

/**
 * The title pill for a plugin screen that opens like a chat (`mobileFloatingHeader`, e.g. a group
 * thread): the plugin's avatar (its own component) and the screen title, as in the bot chat's
 * pill. Not a button: the plugin's controls sit in the pill on the right.
 */
export function MobileFloatingHeaderTitle({
  title,
  avatar,
}: {
  title: string;
  avatar: ReactNode;
}): ReactElement {
  return (
    <GlassSurface style={styles.identityPill} radius={PILL_RADIUS} testID="plugin-floating-title">
      <View style={avatar ? styles.identityPressableWithAvatar : styles.identityPressable}>
        {avatar}
        <Text style={styles.identityTitle} numberOfLines={1} testID="plugin-floating-title-text">
          {title}
        </Text>
      </View>
    </GlassSurface>
  );
}

/**
 * Phone workspace header, option D: no bar. The chat runs to the top of the screen and fades out
 * floating glass controls, laid out like the wide header:
 *   back (or the menu button where there is no plugin home) · [avatar name] ······ [Explorer].
 * Absolutely positioned; the content below takes `resolveMobileFloatingHeaderInset` as its top
 * inset (see FloatingHeaderInsetProvider).
 */
export function MobileFloatingHeader({
  leading,
  controls,
  identity,
}: {
  leading: ReactNode;
  /** The pill on the right; none when null (a plugin screen without controls). */
  controls: ReactNode | null;
  identity: ReactNode;
}): ReactElement {
  const insets = useSafeAreaInsets();
  const rowStyle = useMemo(
    () => [styles.row, { top: insets.top + MOBILE_FLOATING_HEADER_TOP_GAP }],
    [insets.top],
  );
  // Sized to the fade so the overlay has a real box (touches outside the controls still pass
  // through: box-none).
  const overlayStyle = useMemo(
    () => [styles.overlay, { height: resolveMobileFloatingHeaderFade(insets.top).height }],
    [insets.top],
  );
  return (
    <View style={overlayStyle} pointerEvents="box-none" testID="workspace-floating-header">
      <FloatingHeaderFade safeAreaTop={insets.top} />
      <View style={rowStyle} pointerEvents="box-none">
        <GlassSurface style={styles.circle} radius={PILL_RADIUS} interactive>
          {leading}
        </GlassSurface>
        {identity}
        <View style={styles.spacer} pointerEvents="none" />
        {controls === null ? null : (
          <GlassSurface
            style={styles.controlsPill}
            radius={PILL_RADIUS}
            testID="workspace-header-controls-pill"
          >
            {controls}
          </GlassSurface>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  fade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  row: {
    position: "absolute",
    left: MOBILE_FLOATING_HEADER_SIDE_MARGIN,
    right: MOBILE_FLOATING_HEADER_SIDE_MARGIN,
    height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    flexDirection: "row",
    alignItems: "center",
    gap: MOBILE_FLOATING_HEADER_GAP,
  },
  circle: {
    width: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    borderRadius: MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  controlsPill: {
    height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    borderRadius: MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 2,
    flexShrink: 0,
  },
  identityPill: {
    height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    borderRadius: MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2,
    flexShrink: 1,
    minWidth: 0,
  },
  identityPressable: {
    height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: 14,
    minWidth: 0,
  },
  identityPressableWithAvatar: {
    height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: 8,
    paddingRight: 14,
    minWidth: 0,
  },
  identityTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
}));

/** Shared with the bot chat's identity pill (./mobile-floating-header). */
export { styles as mobileFloatingHeaderStyles };

/** Size for a button sitting inside the controls pill (the pill itself is the chrome). */
export const mobileFloatingHeaderPillButtonStyle = {
  width: 40,
  height: 36,
  borderRadius: 18,
} as const;

/** Size for the back/menu button filling the round glass control. */
export const mobileFloatingHeaderCircleButtonStyle = {
  width: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
  height: MOBILE_FLOATING_HEADER_CONTROL_SIZE,
  borderRadius: MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2,
  marginLeft: 0,
} as const;
