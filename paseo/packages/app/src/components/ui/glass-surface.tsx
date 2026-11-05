import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { StyleSheet } from "react-native-unistyles";

function canUseLiquidGlass(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

/** Reduce Transparency asks for solid chrome; Liquid Glass honours it only partly, so we do. */
function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let alive = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (alive) setReduce(value);
      return value;
    });
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduce);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/**
 * A floating control's surface: iOS 26 Liquid Glass (`UIGlassEffect`, regular) where the system
 * has it, otherwise a frosted stand-in — a tint layer of the theme's raised surface at 90% under the
 * content, a hairline rim and a soft shadow. The tint is a separate layer with its own opacity
 * (not an rgba colour) because web themes are CSS variables, so no alpha can be mixed into them.
 */
export function GlassSurface({
  children,
  style,
  radius,
  interactive = false,
  testID,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Corner radius, shared by the glass, the stand-in's tint layer and its rim. */
  radius: number;
  /** Native press response (the glass flexes and brightens under the finger). */
  interactive?: boolean;
  testID?: string;
}) {
  const reduceTransparency = useReduceTransparency();
  const liquid = useMemo(canUseLiquidGlass, []);
  const radiusStyle = useMemo(() => ({ borderRadius: radius }), [radius]);
  const glassStyle = useMemo(() => [style, radiusStyle], [radiusStyle, style]);
  const fallbackStyle = useMemo(() => [styles.fallback, style, radiusStyle], [radiusStyle, style]);
  const tintStyle = useMemo(
    () => [styles.tint, reduceTransparency && styles.tintOpaque, radiusStyle],
    [radiusStyle, reduceTransparency],
  );
  if (liquid && !reduceTransparency) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive={interactive}
        style={glassStyle}
        testID={testID}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View style={fallbackStyle} testID={testID}>
      <View style={tintStyle} pointerEvents="none" />
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fallback: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderAccent,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  tint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface2,
    opacity: 0.9,
  },
  tintOpaque: {
    opacity: 1,
  },
}));
