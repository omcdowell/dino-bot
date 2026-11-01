/**
 * Press and hold on the phone home (r5, 13 Oct): the home dims behind, the held item lifts,
 * and three flat pastel circles appear with it (Archive blue, Edit dino green, Pin/Unpin yellow,
 * no labels). A pinned item becomes a fixed 176 pt rounded square that slides sideways only, to the
 * horizontal centre; a list row becomes a pill where it is. Tap outside to drop it back.
 *
 * The app offers plugins no blur view, so the background is a grey dim instead of a grey blur.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Modal, Pressable, Text, useWindowDimensions, View } from "react-native";
import {
  CIRCLE_GAP,
  CIRCLE_SIZE,
  HELD_SQUARE,
  PILL_LIFT_SCALE,
  circlesPlacement,
  criticalSpringTime,
  heldPill,
  heldRowContent,
  heldSquare,
  heldTileContent,
  type Rect,
} from "./manage-format";
import { DINO_GREEN, ON_DINO_GREEN } from "./accent";

/** Press and hold: the item's frame on screen. */
export type OnHold = (rect: Rect) => void;
/** "held": drawn inside the lifted pop-out (no press handling, no row padding). */
export type Variant = "list" | "held";
/** Long press delay (ms), a little under iOS's context-menu delay. */
export const HOLD_DELAY_MS = 350;

/** Frame of a pressed view in window coordinates, for the hold overlay. */
export function measure(view: View | null, then: OnHold): void {
  if (!view) return;
  view.measureInWindow((x, y, width, height) => then({ x, y, width, height }));
}

/**
 * Flat fills, the same in light and dark (mock-ups r2+). Edit is the dino green (accent.ts) with its
 * dark ink icon; the pastel circles keep the dark ink.
 */
export const CIRCLE_COLORS = { archive: "#95C4E7", edit: DINO_GREEN, pin: "#E8CF8C", ink: "#1F2622", editInk: ON_DINO_GREEN } as const;

export interface HeldItem {
  key: string;
  name: string;
  /** Held from the pinned row (square) or the list (pill). */
  from: "pinned" | "row";
  /** The item's frame on screen when the hold started (measureInWindow). */
  rect: Rect;
  /**
   * The item as it rests on the home. It is the only copy drawn while held (no cross-fade, so never
   * two images): it starts exactly over the hidden original and is moved and scaled into the lifted
   * pill or square, with the surface growing behind it.
   */
  source: ReactNode;
  /** Pinned only: the resting avatar size (the held square shows it at 72 pt). */
  avatarSize?: number;
}

/** Landing flash: the tap colour shows this long once the tile has landed, then fades out. */
export const LANDING_HOLD_MS = 90;
export const LANDING_FADE_MS = 110;
/**
 * The flash starts when the tile is this close to rest (5%: ~155 ms into a full drop, a pinned tile
 * under 7 pt from home), so it overlaps the last frames; onClose follows ~55 ms later.
 */
export const LANDING_AT = 0.05;
/** Pinned tiles show a tap as 60% opacity; list rows as the surface1 background. */
export const PINNED_PRESSED_OPACITY = 0.6;

export interface PinCircleState {
  pinned: boolean;
  disabled: boolean;
  message: string | null;
}

function Circle({
  color,
  ink = CIRCLE_COLORS.ink,
  icon,
  label,
  disabled,
  onPress,
  testID,
}: {
  color: string;
  ink?: string;
  icon: string;
  label: string;
  disabled?: boolean;
  onPress(): void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: CIRCLE_SIZE,
        height: CIRCLE_SIZE,
        borderRadius: CIRCLE_SIZE / 2,
        backgroundColor: disabled ? "#D9D9DC" : color,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.55 : pressed ? 0.75 : 1,
      })}
    >
      <Icon name={icon} size={22} color={ink} />
    </Pressable>
  );
}

/**
 * Motion (13 Oct: "make the pop up and down after a long press smoother"). One spring for
 * both directions, critically damped (damping = 2·√(stiffness·mass)), so nothing overshoots and the
 * pop down retraces the pop up: ~95% there at 130 ms, at rest by ~200 ms (13 Oct 19:16: twice as fast,
 * stiffness x4 and damping x2 halve every time and keep the damping ratio). Everything runs on the
 * native driver. Springs start from the current value, so a tap mid-lift reverses without a jump.
 */
export const LIFT_SPRING = {
  stiffness: 1280,
  damping: 72,
  mass: 1,
  overshootClamping: true,
  restDisplacementThreshold: 0.005,
  restSpeedThreshold: 0.005,
} as const;
/** The circles follow the tile up this much later, and leave this much before it on the way down. */
export const CIRCLES_LAG_MS = 25;

export function HoldOverlay({
  held,
  theme,
  dark,
  pin,
  flash,
  onShown,
  onLanding,
  onClose,
  onArchive,
  onEdit,
  onPin,
}: {
  held: HeldItem | null;
  theme: PluginTheme;
  dark: boolean;
  pin: PinCircleState;
  /**
   * Landing flash (0 = none, 1 = the tap colour), owned by the home so it carries on over the
   * original once the overlay has gone. The overlay shows it on its copy for the last frames.
   */
  flash?: Animated.Value;
  /** The tile is about to land (LANDING_AT from rest): start the landing flash. */
  onLanding?(): void;
  /** The overlay is on screen and covers the held item: hide the original until onClose. */
  onShown?(): void;
  /** The tile has landed back where it came from and the overlay is gone. */
  onClose(): void;
  onArchive(item: HeldItem): void;
  onEdit(item: HeldItem): void;
  onPin(item: HeldItem): void;
}) {
  const { width, height } = useWindowDimensions();
  // `lift` drives the tile and the dim, `menu` the circles (a beat behind on the way up, ahead on the way down).
  const lift = useRef(new Animated.Value(0)).current;
  const menu = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<HeldItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const phase = useRef<"idle" | "waiting" | "up" | "down">("idle");

  useEffect(() => {
    if (!held) return;
    lift.setValue(0);
    menu.setValue(0);
    phase.current = "waiting";
    setMessage(null);
    setShown(held);
  }, [held, lift, menu]);

  // Start the pop up once the Modal is actually on screen (iOS presents it a frame or two later; a
  // spring started earlier would lose its first frames and look like a jump).
  const rise = () => {
    if (phase.current !== "waiting") return;
    phase.current = "up";
    onShown?.();
    Animated.parallel([
      Animated.spring(lift, { toValue: 1, useNativeDriver: true, ...LIFT_SPRING }),
      Animated.spring(menu, { toValue: 1, useNativeDriver: true, delay: CIRCLES_LAG_MS, ...LIFT_SPRING }),
    ]).start();
  };
  useEffect(() => {
    if (!shown) return;
    // Fallback if onShow never fires.
    const timer = setTimeout(rise, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const motion = useMemo(() => {
    if (!shown) return null;
    const along = (outputRange: number[]) => lift.interpolate({ inputRange: [0, 1], outputRange });
    // One copy of the item only. The surface (pill or square plus shadow) fades in behind it.
    const surfaceOpacity = lift.interpolate({ inputRange: [0, 0.35], outputRange: [0, 1], extrapolate: "clamp" });
    const circles = {
      opacity: menu,
      transform: [{ scale: menu.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
    };
    if (shown.from === "pinned") {
      const square = heldSquare(shown.rect, width);
      const { scale, shiftY } = heldTileContent(shown.rect, shown.avatarSize ?? 68);
      return {
        surfaceOpacity,
        circles,
        slide: along([0, square.endLeft - square.startLeft]),
        surfaceScale: along([0.9, 1]),
        content: [{ translateY: along([0, shiftY]) }, { scale: along([1, scale]) }],
        copyOpacity: flash ? flash.interpolate({ inputRange: [0, 1], outputRange: [1, PINNED_PRESSED_OPACITY] }) : 1,
      };
    }
    const { scale, shiftX } = heldRowContent(shown.rect, width);
    return {
      surfaceOpacity,
      circles,
      slide: null,
      surfaceScale: along([1, PILL_LIFT_SCALE]),
      content: [{ translateX: along([0, shiftX]) }, { scale: along([1, scale]) }],
      copyOpacity: 1,
    };
  }, [shown, width, lift, menu, flash]);

  const landingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (landingTimer.current) clearTimeout(landingTimer.current);
  }, []);

  if (!shown || !motion) return null;
  const drop = (then?: () => void) => {
    if (phase.current === "down") return;
    phase.current = "down";
    // Springs pick up from wherever the native values are now (mid-lift taps reverse smoothly).
    const delay = CIRCLES_LAG_MS * 0.8;
    lift.stopAnimation((from) => {
      // The flash starts as the tile is about to land, so it overlaps the last frames.
      const at = delay + criticalSpringTime(from, LANDING_AT, LIFT_SPRING.stiffness, LIFT_SPRING.mass);
      landingTimer.current = setTimeout(() => {
        landingTimer.current = null;
        onLanding?.();
      }, at);
    });
    menu.stopAnimation();
    Animated.parallel([
      Animated.spring(menu, { toValue: 0, useNativeDriver: true, ...LIFT_SPRING }),
      Animated.spring(lift, { toValue: 0, useNativeDriver: true, delay, ...LIFT_SPRING }),
    ]).start(() => {
      phase.current = "idle";
      setShown(null);
      onClose();
      then?.();
    });
  };

  const c = theme.colors;
  const lifted = dark ? c.surface2 : "#FFFFFF";
  const rect = shown.rect;
  // Bottom to top: (rows) the landing flash at the row's place, the lifted surface, the one copy of
  // the item. The copy starts exactly over the hidden original, so the hand-over is invisible.
  const pinned = shown.from === "pinned";
  const square = pinned ? heldSquare(rect, width) : null;
  const pill = pinned ? null : heldPill(rect, width);
  const frame = square
    ? { top: square.top, left: square.startLeft, width: HELD_SQUARE, height: HELD_SQUARE }
    : { top: pill!.y, left: pill!.x, width: pill!.width, height: pill!.height };
  const tileTop = frame.top;
  const tileHeight = frame.height;
  const atRect = { position: "absolute" as const, top: rect.y, left: rect.x, width: rect.width, height: rect.height };
  const tile = (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        transform: motion.slide ? [{ translateX: motion.slide }] : [],
      }}
    >
      {!pinned && flash ? <Animated.View style={[atRect, { backgroundColor: c.surface1, opacity: flash }]} /> : null}
      <Animated.View
        testID={pinned ? "bots-hold-square" : "bots-hold-pill"}
        style={{
          position: "absolute",
          ...frame,
          transform: [{ scale: motion.surfaceScale }],
          borderRadius: pinned ? 32 : frame.height / 2,
          backgroundColor: lifted,
          shadowColor: "#000",
          shadowOpacity: dark ? 0.5 : pinned ? 0.18 : 0.16,
          shadowRadius: pinned ? 18 : 16,
          shadowOffset: { width: 0, height: pinned ? 8 : 6 },
          elevation: pinned ? 12 : 10,
          opacity: motion.surfaceOpacity,
        }}
      />
      <Animated.View style={[atRect, { opacity: motion.copyOpacity, transform: motion.content }]}>{shown.source}</Animated.View>
    </Animated.View>
  );

  const placement = circlesPlacement(tileTop, tileHeight, height);
  const rowWidth = 3 * CIRCLE_SIZE + 2 * CIRCLE_GAP;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onShow={rise} onRequestClose={() => drop()}>
      <Animated.View
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: lift, backgroundColor: dark ? "rgba(0,0,0,0.62)" : "rgba(150,150,154,0.62)" }}
      >
        <Pressable accessibilityLabel="Close" testID="bots-hold-backdrop" style={{ flex: 1 }} onPress={() => drop()} />
      </Animated.View>
      {tile}
      <Animated.View
        style={[
          {
            position: "absolute",
            top: placement.top,
            left: (width - rowWidth) / 2,
            width: rowWidth,
            flexDirection: "row",
            justifyContent: "space-between",
          },
          motion.circles,
        ]}
      >
        <Circle testID="bots-hold-archive" color={CIRCLE_COLORS.archive} icon="Archive" label={`Archive ${shown.name}`} onPress={() => drop(() => onArchive(shown))} />
        <Circle testID="bots-hold-edit" color={CIRCLE_COLORS.edit} ink={CIRCLE_COLORS.editInk} icon="Pencil" label={`Edit ${shown.name}`} onPress={() => drop(() => onEdit(shown))} />
        <Circle
          testID="bots-hold-pin"
          color={CIRCLE_COLORS.pin}
          icon={pin.pinned ? "PinOff" : "Pin"}
          label={pin.pinned ? `Unpin ${shown.name}` : `Pin ${shown.name}`}
          disabled={pin.disabled}
          onPress={() => (pin.disabled ? setMessage(pin.message) : drop(() => onPin(shown)))}
        />
      </Animated.View>
      {message ? (
        <Text
          testID="bots-hold-message"
          style={{
            position: "absolute",
            left: 24,
            right: 24,
            textAlign: "center",
            fontSize: 14,
            color: dark ? "#C9CBCB" : "#55575C",
            top: placement.where === "below" ? placement.top + CIRCLE_SIZE + 14 : placement.top - 14 - 20,
          }}
        >
          {message}
        </Text>
      ) : null}
    </Modal>
  );
}
