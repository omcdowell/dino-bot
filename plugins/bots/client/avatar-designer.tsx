/**
 * Avatar designer (AV3): designer-b layout B (r9) on the phone with react-native-svg.
 *
 * - Opens with no network: everything is drawn from the bundled pack (shared/avatar) by composeAvatarSvg.
 *   Taps, Shuffle and Undo stay on the phone; Save hands the look to the caller (which queues avatar.json).
 * - Layout B: preview stage + name, then Fullscreen / Undo / Shuffle (the 48 px preview was dropped); carousels
 *   for Character, Colour, Eyes (the pack's 9 options, the character's own look hidden: Original shows it) and Accessories.
 * - Accessories: tap a tile to add (it lands where autoPlaceAccessory puts it, selected), drag on the stage to
 *   move, pinch to resize and turn, × removes. A tap off the accessory deselects (on the stage: on release, so a
 *   second finger can still arrive for a pinch; elsewhere: at touch-down, except the accessory rows, the
 *   fullscreen buttons, Undo and Fullscreen).
 * - Fullscreen arrange view: the bot's name as title, Done, a big stage, the accessory row, and buttons to
 *   move / turn / resize (hold to repeat), select the next accessory and delete.
 * - No tile pop (designer-b r8/r9): tiles are memoised with markup cached by what they show, so a tap redraws only
 *   the tiles whose ring changes; rings keep one width; nothing scales on press. No text selection (RN Text is not
 *   selectable; web gets user-select none).
 * - No Details toggle (details are always drawn).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Modal as NativeModal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { AvatarAccessory, AvatarPack } from "../shared/avatar";
import { DINO_GREEN, accentFill, accentOn } from "./accent";
import {
  NUDGE_ACTIONS,
  accessoryCounts,
  addAccessory,
  applyGesture,
  boxCorner,
  counters,
  createDesigner,
  cycleSelection,
  deleteSelected,
  deselect,
  hints,
  hitTest,
  layerBox,
  nudge,
  pickCharacter,
  removeAllAccessories,
  select,
  setColour,
  setEyes,
  shownEyes,
  shuffle,
  undo,
  type Designer,
  type Look,
  type NudgeAction,
} from "./avatar-designer-state";
import { designerSvgs, tileSvgs, type Tile } from "./avatar-designer-svg";
import type { SvgXmlComponent } from "./host-svg";
import { isDarkSurface } from "./manage-format";

type Colors = PluginTheme["colors"];
const DANGER = "#E5484D";
const NOOP = () => {};
const NO_SELECT = (Platform.OS === "web" ? { userSelect: "none" } : {}) as ViewStyle;
/**
 * The selected outline: one green ring, the same width on the square tiles (Character, Eyes, Accessories,
 * None) and the Colour circles. Unselected tiles keep the same width in their border colour (no layout jump).
 */
export const SELECTED_RING_WIDTH = 2.5;
/**
 * The designer's vertical scroll. Not the `react-native` ScrollView plugins get: the host's one adds the
 * phone home's top-bar room (its PluginScrollTopInset context, which reaches this full-screen Modal through
 * React context because the designer opens from a sheet on the home). The designer draws its own header, so
 * that room was a large empty gap under X / Save. Animated.ScrollView is React Native's own ScrollView.
 */
const PlainScrollView = Animated.ScrollView;

/* ---------- static art ---------- */

const checkerSvg = (dark: boolean) => {
  const [a, b] = dark ? ["#333335", "#3D3D3F"] : ["#EDEFEA", "#F7F8F5"];
  const id = dark ? "avck-d" : "avck-l";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><defs><pattern id="${id}" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="${b}"/><rect width="7" height="7" fill="${a}"/><rect x="7" y="7" width="7" height="7" fill="${a}"/></pattern></defs><rect width="100%" height="100%" fill="url(#${id})"/></svg>`;
};
/** The Original swatch: a ring of the character colours (designer-b's conic ring). */
const ORIGINAL_SWATCH = (() => {
  const cols = ["#FF6A59", "#FECB3E", "#9CC963", "#3EC3EA", "#1572B4", "#C77BD6"];
  const r = 15, len = 2 * Math.PI * r, seg = len / cols.length;
  const arcs = cols
    .map((c, i) => `<circle cx="22" cy="22" r="${r}" fill="none" stroke="${c}" stroke-width="9" stroke-dasharray="${seg.toFixed(2)} ${(len - seg).toFixed(2)}" stroke-dashoffset="${(-i * seg).toFixed(2)}" transform="rotate(-90 22 22)"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">${arcs}</svg>`;
})();

/* ---------- small parts ---------- */

/** A touch that should not deselect the accessory: marks the event, and the root's tap-off handler (which sees
 *  the same event as it bubbles up) leaves it alone. */
type Exempt = (e: GestureResponderEvent) => void;

const Tap = memo(function Tap({
  id,
  onPick,
  label,
  style,
  children,
  testID,
}: {
  id: string;
  onPick(id: string): void;
  label: string;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} testID={testID} onPress={() => onPick(id)} style={style}>
      {children}
    </Pressable>
  );
});

/** One carousel tile. Memoised: a tap re-renders only tiles whose `on` / `cur` / `badge` changed. */
const TileView = memo(function TileView({
  tile,
  size,
  on,
  cur,
  badge,
  onPick,
  Svg,
  c,
  checker,
  testID,
  inset = 0.1,
}: {
  tile: Tile;
  size: number;
  on: boolean;
  cur?: boolean;
  badge?: string;
  onPick(id: string): void;
  Svg: SvgXmlComponent;
  c: Colors;
  checker?: string;
  testID: string;
  /** Art inset as a share of the tile (eye close-ups fill the tile: 0). */
  inset?: number;
}) {
  const ring = on || cur ? DINO_GREEN : c.border;
  const pad = Math.round(size * inset);
  return (
    <Tap
      id={tile.id}
      onPick={onPick}
      label={tile.name}
      testID={testID}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.24,
        // One ring width in every state (designer-b r8): only its colour changes.
        borderWidth: SELECTED_RING_WIDTH,
        borderColor: ring,
        backgroundColor: c.surface1,
        overflow: "hidden",
        opacity: 1,
      }}
    >
      {checker ? (
        <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
          <Svg xml={checker} width="100%" height="100%" />
        </View>
      ) : null}
      <View pointerEvents="none" style={{ position: "absolute", left: pad, top: pad, right: pad, bottom: pad }}>
        <Svg xml={tile.xml} width="100%" height="100%" />
      </View>
      {badge ? (
        <View pointerEvents="none" style={{ position: "absolute", right: 3, top: 3, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: DINO_GREEN, paddingHorizontal: 4, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 10.5, fontWeight: "700", color: "#2B3318" }}>{badge}</Text>
        </View>
      ) : null}
    </Tap>
  );
});

function Row({ label, count, children, c, onTouchStart, testID }: { label: string; count: string; children: ReactNode; c: Colors; onTouchStart?: Exempt; testID: string }) {
  return (
    <View style={{ marginTop: 18 }} testID={testID}>
      <View style={{ flexDirection: "row", alignItems: "baseline", paddingHorizontal: 16, marginBottom: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "700", letterSpacing: 1, color: c.foregroundMuted }}>{label.toUpperCase()}</Text>
        <Text numberOfLines={1} style={{ fontSize: 13, color: c.foregroundMuted, maxWidth: "70%" }}>{count}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4, gap: 10, alignItems: "center" }}
        onTouchStart={onTouchStart}
        testID={`${testID}-tiles`}
      >
        {children}
      </ScrollView>
    </View>
  );
}

function RoundButton({ icon, label, onPress, disabled, c, onTouchStart, testID, size = 44 }: { icon: string; label: string; onPress(): void; disabled?: boolean; c: Colors; onTouchStart?: Exempt; testID: string; size?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      onTouchStart={onTouchStart}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={icon} size={20} color={c.foreground} />
    </Pressable>
  );
}

function Pill({ label, onPress, c, primary, icon, testID, onTouchStart, iconOnly }: { label: string; onPress(): void; c: Colors; primary?: boolean; icon?: string; testID: string; onTouchStart?: Exempt; iconOnly?: boolean }) {
  const fg = primary ? accentOn(c) : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      onTouchStart={onTouchStart}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: primary ? accentFill(c) : c.surface2 }}
    >
      {icon ? <Icon name={icon} size={18} color={fg} /> : null}
      {iconOnly ? null : <Text style={{ fontSize: 16, fontWeight: "700", color: fg }}>{label}</Text>}
    </Pressable>
  );
}

/* ---------- the stage (drag, pinch, tap to select, tap off to deselect) ---------- */

type Pt = { x: number; y: number };
const touchPoints = (e: GestureResponderEvent): Pt[] => {
  const t = e.nativeEvent.touches;
  if (t && t.length) return Array.from(t, (q) => ({ x: q.pageX, y: q.pageY }));
  return [{ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }];
};

function Stage({
  size,
  big,
  designer,
  pack,
  xml,
  Svg,
  checker,
  c,
  dispatch,
  onActive,
  onTouchStart,
  testID,
}: {
  size: number;
  big: boolean;
  /** Marks the touch as the stage's own (the root's tap-off rule leaves it to the stage). */
  onTouchStart: Exempt;
  designer: Designer;
  pack: AvatarPack;
  xml: string;
  Svg: SvgXmlComponent;
  checker: string;
  c: Colors;
  dispatch(update: (d: Designer) => Designer): void;
  onActive(active: boolean): void;
  testID: string;
}) {
  const live = useRef({ designer, size, dispatch, onActive });
  live.current = { designer, size, dispatch, onActive };
  type Gesture = { start: AvatarAccessory | null; base: Pt[]; moved: boolean; pushed: boolean; off: boolean; maxPts: number };
  const gest = useRef<Gesture | null>(null);

  const responder = useMemo(() => {
    const restart = (g: Gesture, pts: Pt[]) => {
      const d = live.current.designer;
      g.start = d.state.look.accessories[d.sel] ? { ...d.state.look.accessories[d.sel]! } : null;
      g.base = pts;
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        const { designer: d, size: s, dispatch: set } = live.current;
        const hit = hitTest(pack, d.state.look, e.nativeEvent.locationX / s, e.nativeEvent.locationY / s);
        const g: Gesture = { start: null, base: [], moved: false, pushed: false, off: hit < 0, maxPts: 1 };
        gest.current = g;
        if (hit >= 0 && hit !== d.sel) {
          const next = select(d, hit);
          live.current.designer = next;
          set(() => next);
        }
        restart(g, touchPoints(e));
        live.current.onActive(true);
      },
      onPanResponderMove: (e) => {
        const g = gest.current;
        if (!g) return;
        const pts = touchPoints(e);
        g.maxPts = Math.max(g.maxPts, pts.length);
        if (pts.length !== g.base.length) restart(g, pts);
        const start = g.start;
        if (!start) return;
        if (g.off && pts.length < 2) return; // one finger off the accessory never drags it
        if (!g.moved) {
          const dd = Math.hypot(pts[0]!.x - g.base[0]!.x, pts[0]!.y - g.base[0]!.y);
          if (dd < 3 && pts.length < 2) return;
          g.moved = true;
        }
        const s = live.current.size;
        let gesture: { dx: number; dy: number; scale?: number; rotation?: number };
        if (pts.length >= 2 && g.base.length >= 2) {
          const [p0, p1] = [pts[0]!, pts[1]!], [b0, b1] = [g.base[0]!, g.base[1]!];
          const d0 = Math.hypot(b1.x - b0.x, b1.y - b0.y) || 1;
          const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          const a0 = Math.atan2(b1.y - b0.y, b1.x - b0.x), a1 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          gesture = {
            dx: ((p0.x + p1.x) / 2 - (b0.x + b1.x) / 2) / s,
            dy: ((p0.y + p1.y) / 2 - (b0.y + b1.y) / 2) / s,
            scale: d1 / d0,
            rotation: ((a1 - a0) * 180) / Math.PI,
          };
        } else {
          gesture = { dx: (pts[0]!.x - g.base[0]!.x) / s, dy: (pts[0]!.y - g.base[0]!.y) / s };
        }
        const first = !g.pushed;
        g.pushed = true;
        live.current.dispatch((d) => applyGesture(d, pack, start, gesture, first));
      },
      onPanResponderRelease: () => {
        const g = gest.current;
        gest.current = null;
        live.current.onActive(false);
        if (g && !g.moved && g.off && g.maxPts === 1) live.current.dispatch(deselect); // tap off
      },
      onPanResponderTerminate: () => {
        gest.current = null;
        live.current.onActive(false);
      },
    });
  }, [pack]);

  const box = layerBox(pack, designer.state.look, designer.sel);
  const bw = big ? 44 : 30;
  const corner = box ? boxCorner(box) : null;
  const clampPx = (v: number) => Math.max(2, Math.min(size - bw - 2, v));
  return (
    <View
      testID={testID}
      style={{ width: size, height: size, borderRadius: big ? 32 : 28, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}
      onTouchStart={onTouchStart}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: size, height: size }}>
        <Svg xml={checker} width={size} height={size} />
      </View>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: size, height: size }}>
        <Svg xml={xml} width={size} height={size} />
      </View>
      {box ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: (box.cx - box.w / 2) * size,
            top: (box.cy - box.h / 2) * size,
            width: box.w * size,
            height: box.h * size,
            borderWidth: 2,
            borderStyle: "dashed",
            borderColor: DINO_GREEN,
            borderRadius: 6,
            transform: [{ rotate: `${box.rotation}deg` }],
          }}
        />
      ) : null}
      {corner ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete accessory"
          testID={`${testID}-delete`}
          hitSlop={7}
          onPress={() => live.current.dispatch(deleteSelected)}
          style={{
            position: "absolute",
            left: clampPx(corner.x * size - bw / 2),
            top: clampPx(corner.y * size - bw / 2),
            width: bw,
            height: bw,
            borderRadius: bw / 2,
            backgroundColor: DANGER,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="X" size={big ? 20 : 16} color="#FFFFFF" />
        </Pressable>
      ) : null}
    </View>
  );
}

/* ---------- fullscreen control buttons (hold to repeat) ---------- */

type Act = NudgeAction | "prev" | "del";
const ICONS: Record<Act, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  rotl: "RotateCcw",
  rotr: "RotateCw",
  smaller: "ZoomOut",
  bigger: "ZoomIn",
  prev: "ArrowRightLeft",
  del: "Trash2",
};
const LABELS: Record<Act, string> = {
  up: "Move up",
  down: "Move down",
  left: "Move left",
  right: "Move right",
  rotl: "Rotate left",
  rotr: "Rotate right",
  smaller: "Smaller",
  bigger: "Bigger",
  prev: "Select the next accessory",
  del: "Delete accessory",
};

function ControlButton({ act, disabled, onAct, c, wide }: { act: Act; disabled: boolean; onAct(act: Act, isNew: boolean): void; c: Colors; wide?: boolean }) {
  const timers = useRef<{ first?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  const stop = () => {
    clearTimeout(timers.current.first);
    clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={LABELS[act]}
      accessibilityState={{ disabled }}
      testID={`avatar-fs-${act}`}
      disabled={disabled}
      onPressIn={() => {
        onAct(act, true);
        if ((NUDGE_ACTIONS as readonly string[]).includes(act))
          timers.current.first = setTimeout(() => {
            timers.current.every = setInterval(() => onAct(act, false), 70);
          }, 380);
      }}
      onPressOut={stop}
      // The action runs on press-in (and repeats while held). An onPress is still needed: react-native-web only
      // treats a Pressable as pressable when it has one.
      onPress={NOOP}
      style={({ pressed }) => ({
        width: wide ? 64 : 48,
        height: 48,
        borderRadius: 14,
        backgroundColor: pressed ? "rgba(156,201,99,0.25)" : c.surface2,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.3 : 1,
      })}
    >
      <Icon name={ICONS[act]} size={24} color={act === "del" ? DANGER : c.foreground} />
    </Pressable>
  );
}

/* ---------- the designer ---------- */

export interface AvatarDesignerProps {
  open: boolean;
  /** The bot's name (preview name line and the fullscreen title). */
  botName: string;
  initial: Look;
  pack: AvatarPack;
  theme: PluginTheme;
  Svg: SvgXmlComponent;
  onCancel(): void;
  onSave(look: Look): void;
}

export function AvatarDesigner(props: AvatarDesignerProps) {
  return (
    <NativeModal
      visible={props.open}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onCancel}
      supportedOrientations={["portrait"]}
    >
      {props.open ? <DesignerBody {...props} /> : null}
    </NativeModal>
  );
}

export function DesignerBody({ botName, initial, pack, theme, Svg, onCancel, onSave }: AvatarDesignerProps) {
  const c = theme.colors;
  const dark = isDarkSurface(c.surface0);
  const checker = useMemo(() => checkerSvg(dark), [dark]);
  const [designer, setDesigner] = useState<Designer>(() => createDesigner(initial));
  const dispatch = useCallback((update: (d: Designer) => Designer) => setDesigner((d) => update(d)), []);
  const [fs, setFs] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { width } = useWindowDimensions();
  const W = Math.min(width, 520);

  // Tap off: a touch anywhere except the exempt areas deselects (designer-b r3).
  const exempted = useRef<{ ev: unknown; ts: number } | null>(null);
  const exempt = useCallback((e: GestureResponderEvent) => {
    exempted.current = { ev: e.nativeEvent, ts: e.nativeEvent.timestamp };
  }, []);
  const onRootTouch = useCallback((e: GestureResponderEvent) => {
    const x = exempted.current;
    exempted.current = null;
    if (x && (x.ev === e.nativeEvent || (x.ts && x.ts === e.nativeEvent.timestamp))) return;
    setDesigner((d) => (d.sel >= 0 ? deselect(d) : d));
  }, []);

  const look = designer.state.look;
  const svgs = useMemo(() => designerSvgs(pack, look), [pack, look]);
  const tiles = tileSvgs(pack, look);
  const count = counters(pack, designer);
  const hint = hints(pack, designer);
  const n = accessoryCounts(look);
  const selId = look.accessories[designer.sel]?.id ?? null;
  const eyesOn = shownEyes(pack, look);

  const onChar = useCallback((id: string) => dispatch((d) => pickCharacter(d, pack, id)), [dispatch, pack]);
  const onColour = useCallback((id: string) => dispatch((d) => setColour(d, id === "original" ? undefined : id)), [dispatch]);
  const onEyes = useCallback((id: string) => dispatch((d) => setEyes(d, id)), [dispatch]);
  const onAcc = useCallback(
    (id: string) => dispatch((d) => (id === "none" ? removeAllAccessories(d) : addAccessory(d, pack, id))),
    [dispatch, pack],
  );
  const onAct = useCallback(
    (act: Act, isNew: boolean) =>
      dispatch((d) => (act === "prev" ? cycleSelection(d) : act === "del" ? deleteSelected(d) : nudge(d, pack, act, isNew, Date.now()))),
    [dispatch, pack],
  );
  const openFs = () => {
    dispatch((d) => (d.sel < 0 && d.state.look.accessories.length === 1 ? select(d, 0) : d));
    setFs(true);
  };

  const noneTile = useMemo<Tile>(() => ({ id: "none", name: "None (remove all)", xml: "" }), []);
  const accRow = (size: number, prefix: string) => (
    <>
      <Tap
        id="none"
        onPick={onAcc}
        label={noneTile.name}
        testID={`${prefix}-none`}
        style={{ width: size, height: size, borderRadius: size * 0.24, borderWidth: SELECTED_RING_WIDTH, borderColor: look.accessories.length ? c.border : DINO_GREEN, backgroundColor: c.surface1, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="Ban" size={Math.round(size * 0.45)} color={c.foregroundMuted} />
      </Tap>
      {tiles.accessories.map((t) => (
        <TileView
          key={t.id}
          tile={t}
          size={size}
          on={!!n[t.id]}
          cur={t.id === selId}
          badge={(n[t.id] ?? 0) > 1 ? String(n[t.id]) : undefined}
          onPick={onAcc}
          Svg={Svg}
          c={c}
          checker={checker}
          testID={`${prefix}-${t.id}`}
        />
      ))}
    </>
  );

  if (fs) {
    const has = designer.sel >= 0 && !!look.accessories[designer.sel];
    const total = look.accessories.length;
    const dis = (act: Act) => (act === "prev" ? !total || (total === 1 && has) : !has);
    return (
      <SafeAreaView style={[{ flex: 1, backgroundColor: c.surface0 }, NO_SELECT]}>
        <View style={{ flex: 1 }} onTouchStart={onRootTouch} testID="avatar-fs">
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 17, fontWeight: "700", color: c.foreground }} testID="avatar-fs-title">
              {botName}
            </Text>
            <Pill label="Done" primary c={c} onPress={() => setFs(false)} testID="avatar-fs-done" />
          </View>
          <FsStage>
            {(size) => (
              <Stage
                size={size}
                big
                designer={designer}
                pack={pack}
                xml={svgs.full}
                Svg={Svg}
                checker={checker}
                c={c}
                dispatch={dispatch}
                onActive={() => {}}
                onTouchStart={exempt}
                testID="avatar-stage-big"
              />
            )}
          </FsStage>
          <View style={{ paddingBottom: 10 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} onTouchStart={exempt} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4, gap: 10 }}>
              {accRow(56, "avatar-fs-acc")}
            </ScrollView>
            <View style={{ height: 34, marginVertical: 6, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" }}>
              <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 17, color: c.foregroundMuted, textAlign: "center" }} testID="avatar-fs-hint">
                {hint.fs}
              </Text>
            </View>
            <View onTouchStart={exempt} style={{ flexDirection: "row", gap: 18, justifyContent: "center", alignItems: "center" }}>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
                  <ControlButton act="up" disabled={dis("up")} onAct={onAct} c={c} />
                </View>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <ControlButton act="left" disabled={dis("left")} onAct={onAct} c={c} />
                  <View style={{ width: 48, alignItems: "center" }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.border }} />
                  </View>
                  <ControlButton act="right" disabled={dis("right")} onAct={onAct} c={c} />
                </View>
                <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
                  <ControlButton act="down" disabled={dis("down")} onAct={onAct} c={c} />
                </View>
              </View>
              <View style={{ gap: 8 }}>
                {(
                  [
                    ["rotl", "rotr"],
                    ["smaller", "bigger"],
                    ["prev", "del"],
                  ] as const
                ).map((pair) => (
                  <View key={pair[0]} style={{ flexDirection: "row", gap: 8 }}>
                    {pair.map((act) => (
                      <ControlButton key={act} act={act} wide disabled={dis(act)} onAct={onAct} c={c} />
                    ))}
                  </View>
                ))}
              </View>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // designer-b layout B: the stage takes ~40% of the width, the name / buttons column the rest.
  const small = Math.round((W - 32) * 0.37);
  return (
    <SafeAreaView style={[{ flex: 1, backgroundColor: c.surface0 }, NO_SELECT]}>
      <View style={{ flex: 1 }} onTouchStart={onRootTouch} testID="avatar-designer">
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 6 }}>
          <View style={{ flex: 1, alignItems: "flex-start" }}>
            <RoundButton icon="X" label="Cancel" onPress={onCancel} c={c} testID="avatar-cancel" />
          </View>
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Pill label="Save" primary c={c} onPress={() => onSave(designer.state.look)} testID="avatar-save" />
          </View>
        </View>
        <PlainScrollView scrollEnabled={!dragging} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ paddingBottom: 32 }} testID="avatar-scroll">
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
            <Stage
              size={small}
              big={false}
              designer={designer}
              pack={pack}
              xml={svgs.full}
              Svg={Svg}
              checker={checker}
              c={c}
              dispatch={dispatch}
              onActive={setDragging}
              onTouchStart={exempt}
              testID="avatar-stage"
            />
            <View style={{ flex: 1, justifyContent: "space-between", minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 26, fontWeight: "800", color: c.foreground }} testID="avatar-name">
                {botName}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <RoundButton icon="Maximize2" label="Full screen editor" onPress={openFs} c={c} onTouchStart={exempt} testID="avatar-fullscreen" size={42} />
                <RoundButton icon="Undo2" label="Undo" onPress={() => dispatch(undo)} disabled={!designer.history.length} c={c} onTouchStart={exempt} testID="avatar-undo" size={42} />
                <Pill label="Shuffle" icon="Dice5" iconOnly={W < 360} c={c} onPress={() => dispatch((d) => shuffle(d, pack))} testID="avatar-shuffle" />
              </View>
            </View>
          </View>
          <View style={{ height: 40, marginTop: 8, paddingHorizontal: 16, justifyContent: "center" }}>
            <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: c.foregroundMuted }} testID="avatar-tip">
              {hint.tip}
            </Text>
          </View>
          <Row label="Character" count={count.character} c={c} testID="avatar-row-character">
            {tiles.characters.map((t) => (
              <TileView key={t.id} tile={t} size={66} on={t.id === look.character} onPick={onChar} Svg={Svg} c={c} testID={`avatar-char-${t.id}`} />
            ))}
          </Row>
          <Row label="Colour" count={count.colour} c={c} testID="avatar-row-colour">
            {[["original", "Original"] as [string, string], ...pack.palette].map(([hex, name]) => {
              const on = hex === "original" ? !look.colour : look.colour?.toUpperCase() === hex.toUpperCase();
              return (
                <Tap
                  key={hex}
                  id={hex}
                  onPick={onColour}
                  label={name}
                  testID={`avatar-colour-${hex === "original" ? "original" : hex.slice(1)}`}
                  style={{ width: 46, height: 46, borderRadius: 23, borderWidth: SELECTED_RING_WIDTH, borderColor: on ? DINO_GREEN : "transparent", alignItems: "center", justifyContent: "center" }}
                >
                  {hex === "original" ? (
                    <View pointerEvents="none" style={{ width: 36, height: 36 }}>
                      <Svg xml={ORIGINAL_SWATCH} width={36} height={36} />
                    </View>
                  ) : (
                    <View pointerEvents="none" style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: hex }} />
                  )}
                </Tap>
              );
            })}
          </Row>
          <Row label="Eyes" count={count.eyes} c={c} testID="avatar-row-eyes">
            {tiles.eyes.map((t) => (
              <TileView key={t.id} tile={t} size={66} on={t.id === eyesOn} onPick={onEyes} Svg={Svg} c={c} inset={0} testID={`avatar-eyes-${t.id.replace(":", "-")}`} />
            ))}
          </Row>
          <Row label="Accessories" count={count.accessories} c={c} onTouchStart={exempt} testID="avatar-row-acc">
            {accRow(66, "avatar-acc")}
          </Row>
        </PlainScrollView>
      </View>
    </SafeAreaView>
  );
}

/** The fullscreen stage's square: as big as the space between the title and the panel allows. */
function FsStage({ children }: { children(size: number): ReactNode }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height }));
  };
  const size = box ? Math.floor(Math.max(120, Math.min(box.w - 32, box.h - 16))) : 0;
  return (
    <View style={{ flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center" }} onLayout={onLayout}>
      {size ? children(size) : null}
    </View>
  );
}
