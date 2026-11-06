import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { IconStatusResult, LiveActivityIconStatus } from "./status";

/** Live Activity of busy bots: iOS only (index.ios.ts). */
export function startLiveActivity(_input: { client: DaemonClient; serverId: string }): () => void {
  return () => undefined;
}

export type {
  IconStatusResult,
  IconStatusUnavailable,
  LiveActivityIconStatus,
  WidgetIconReport,
  WidgetMemory,
} from "./status";

/** Timer layers of the Lock Screen dino walk: 3 (3 fps, default) or 6 (6 fps). */
export type DinoLayers = 3 | 6;

/** iOS only (index.ios.ts). */
export function getDinoLayers(): DinoLayers | null {
  return null;
}

/** iOS only (index.ios.ts). */
export async function setDinoLayers(_layers: DinoLayers): Promise<boolean> {
  return false;
}

/** Lock Screen dino 6 fps flicker fix: 0 = build 28, 1-3 test options (la-flicker); 3 is the default. */
export type DinoFix = 0 | 1 | 2 | 3;

export const DINO_FIXES: readonly DinoFix[] = [0, 1, 2, 3];

/** iOS only (index.ios.ts). */
export function getDinoFix(): DinoFix | null {
  return null;
}

/** iOS only (index.ios.ts). */
export async function setDinoFix(_fix: DinoFix): Promise<boolean> {
  return false;
}

/** iOS only (index.ios.ts). */
export async function getLiveActivityIconStatus(): Promise<LiveActivityIconStatus | null> {
  return null;
}

/** iOS only (index.ios.ts): elsewhere there is no Live Activity module. */
export async function readLiveActivityIconStatus(): Promise<IconStatusResult> {
  return { status: null, unavailable: "noModule", error: null };
}
