import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import { AppState } from "react-native";
import { Skia } from "@shopify/react-native-skia";
import * as LucideIcons from "lucide-react-native";
import { ICON_INDEX_KEY, loadIconNames, syncBotIcons, type IconNative } from "./icons";
import { iconStatusFromNative, type LiveActivityIconStatus, type NativeIconStatus } from "./status";
import { startLiveActivitySync, type LiveActivityNative } from "./sync";
import { tileSvg, type LucideNode } from "./tile";
import { pluginAvailable } from "@/plugins/plugin-available";

const ICON_PX = 96;

/**
 * The icon's drawing (Lucide's [tag, attrs] list). lucide-react-native keeps it inside each icon
 * component (forwardRef around <Icon icon={data} />), so render the component once and read the prop.
 */
function lucideNode(name: string): LucideNode | null {
  const candidate = Reflect.get(LucideIcons, name) as { render?: unknown } | undefined;
  if (!candidate || typeof candidate.render !== "function") return null;
  try {
    const element = (candidate.render as (props: object, ref: null) => unknown)({}, null) as {
      props?: { icon?: { node?: unknown } };
    } | null;
    const node = element?.props?.icon?.node;
    return Array.isArray(node) ? (node as LucideNode) : null;
  } catch {
    return null;
  }
}

/** SVG markup as a 96 px base64 PNG, drawn with Skia on the CPU; null when Skia cannot draw it. */
function rasterize(svgText: string | null): string | null {
  const svg = svgText ? Skia.SVG.MakeFromString(svgText) : null;
  const surface = svg ? Skia.Surface.Make(ICON_PX, ICON_PX) : null;
  if (!svg || !surface) return null;
  surface.getCanvas().drawSvg(svg, ICON_PX, ICON_PX);
  surface.flush();
  const base64 = surface.makeImageSnapshot().encodeToBase64();
  return base64 || null;
}

/** The bot's Lucide icon on its tile (tile.ts), as base64 PNG. */
async function renderLucide(name: string): Promise<string | null> {
  const node = lucideNode(name);
  return rasterize(node ? tileSvg(node, ICON_PX) : null);
}

/** A designer avatar the bots plugin composed from avatar.json (kept on the phone), as base64 PNG. */
async function renderSvg(svg: string): Promise<string | null> {
  return rasterize(svg);
}

function randomId(): string {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

function apnsEnvironment(): "development" | "production" {
  const push = (Constants.expoConfig?.extra as { push?: { apnsEnvironment?: unknown } } | undefined)
    ?.push;
  return push?.apnsEnvironment === "production" ? "production" : "development";
}

/** Live Activity of busy bots, synced with this host's paseo-apns plugin (see ./sync.ts). */
export function startLiveActivity(input: { client: DaemonClient; serverId: string }): () => void {
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
  const native = requireOptionalNativeModule<LiveActivityNative & IconNative>("PaseoLiveActivity");
  return startLiveActivitySync(input.client, {
    native,
    storage: AsyncStorage,
    syncIcons: native
      ? async (first) => {
          const result = await syncBotIcons(
            input.client,
            { native, storage: AsyncStorage, renderLucide, renderSvg, now: Date.now },
            { serverId: input.serverId, first },
          );
          return {
            changed: result.saved.length + result.removed.length > 0,
            names: result.names,
          };
        }
      : undefined,
    loadIconNames: () => loadIconNames(AsyncStorage),
    hasPlugin: (pluginId) => pluginAvailable(input.client, pluginId),
    onForeground: (listener) => {
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") listener();
      });
      return () => sub.remove();
    },
    isActive: () => AppState.currentState === "active",
    environment: apnsEnvironment(),
    topic: typeof bundleId === "string" && bundleId ? bundleId : null,
    randomId,
  });
}

export type { LiveActivityIconStatus, WidgetIconReport, WidgetMemory } from "./status";

/** Timer layers of the Lock Screen dino walk: 3 (3 fps, default) or 6 (6 fps). */
export type DinoLayers = 3 | 6;

interface DinoNative {
  getDinoLayers?: () => number;
  setDinoLayers?: (layers: number) => Promise<boolean>;
}

/** The Lock Screen dino's layer count the widget uses, or null when this build has no switch. */
export function getDinoLayers(): DinoLayers | null {
  const native = requireOptionalNativeModule<DinoNative>("PaseoLiveActivity");
  if (!native?.getDinoLayers) return null;
  try {
    return native.getDinoLayers() === 6 ? 6 : 3;
  } catch {
    return null;
  }
}

/** Stores the layer count for the widget and redraws the running Live Activity. */
export async function setDinoLayers(layers: DinoLayers): Promise<boolean> {
  const native = requireOptionalNativeModule<DinoNative>("PaseoLiveActivity");
  if (!native?.setDinoLayers) return false;
  return native.setDinoLayers(layers).catch(() => false);
}

/** Lock Screen dino 6 fps flicker fix: 0 = build 28, 1-3 test options (la-flicker); 3 is the default. */
export type DinoFix = 0 | 1 | 2 | 3;

export const DINO_FIXES: readonly DinoFix[] = [0, 1, 2, 3];

interface DinoFixNative {
  getDinoFix?: () => number;
  setDinoFix?: (fix: number) => Promise<boolean>;
}

/** The flicker fix the widget is sent, or null when this build has no picker. */
export function getDinoFix(): DinoFix | null {
  const native = requireOptionalNativeModule<DinoFixNative>("PaseoLiveActivity");
  if (!native?.getDinoFix) return null;
  try {
    const fix = native.getDinoFix();
    return (DINO_FIXES as readonly number[]).includes(fix) ? (fix as DinoFix) : 3;
  } catch {
    return null;
  }
}

/** Stores the flicker fix for the widget and redraws the running Live Activity. */
export async function setDinoFix(fix: DinoFix): Promise<boolean> {
  const native = requireOptionalNativeModule<DinoFixNative>("PaseoLiveActivity");
  if (!native?.setDinoFix) return false;
  return native.setDinoFix(fix).catch(() => false);
}

/** For the Network page: the bot icons stored for the widget, and what the widget last found. */
export async function getLiveActivityIconStatus(): Promise<LiveActivityIconStatus | null> {
  const native = requireOptionalNativeModule<{
    iconStatus?: () => Promise<NativeIconStatus>;
  }>("PaseoLiveActivity");
  if (!native?.iconStatus) return null;
  const answer = await native.iconStatus().catch(() => null);
  if (!answer) return null;
  const index = await AsyncStorage.getItem(ICON_INDEX_KEY).catch(() => null);
  return iconStatusFromNative(answer, index);
}
