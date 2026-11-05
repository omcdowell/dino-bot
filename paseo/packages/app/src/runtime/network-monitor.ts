import {
  addEventListener,
  configure,
  refresh,
  type NetInfoState,
} from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { create } from "zustand";

/**
 * Watches the phone's own network (NetInfo) so the app reacts when the network comes back or the
 * path changes (Wi-Fi ↔ cellular), instead of waiting for the next reconnect backoff. Nothing
 * here polls: NetInfo's own reachability pinger is turned off, and the Network page runs its
 * probes only when asked.
 */

export type PhoneNetworkType =
  | "wifi"
  | "cellular"
  | "ethernet"
  | "vpn"
  | "bluetooth"
  | "wimax"
  | "other"
  | "none"
  | "unknown";

export interface PhoneNetworkState {
  type: PhoneNetworkType;
  /** null until NetInfo has answered once. */
  isConnected: boolean | null;
  isExpensive: boolean | null;
  cellularGeneration: string | null;
  carrier: string | null;
  ipAddress: string | null;
  subnet: string | null;
  /** Android only. */
  wifiStrength: number | null;
  wifiFrequency: number | null;
  linkSpeedMbps: number | null;
}

export type NetworkChange = "regained" | "path_changed" | "lost";

interface NetworkMonitorState {
  phone: PhoneNetworkState | null;
  changedAt: number | null;
  lastOnlineAt: number | null;
  lastOfflineAt: number | null;
  lastChange: NetworkChange | null;
}

export const useNetworkMonitorStore = create<NetworkMonitorState>(() => ({
  phone: null,
  changedAt: null,
  lastOnlineAt: null,
  lastOfflineAt: null,
  lastChange: null,
}));

function readDetail<T>(details: unknown, key: string): T | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  return value === undefined || value === null ? null : (value as T);
}

export function summariseNetInfo(state: NetInfoState): PhoneNetworkState {
  const details = state.details;
  return {
    type: state.type as PhoneNetworkType,
    isConnected: state.isConnected,
    isExpensive: readDetail<boolean>(details, "isConnectionExpensive"),
    cellularGeneration: readDetail<string>(details, "cellularGeneration"),
    carrier: readDetail<string>(details, "carrier"),
    ipAddress: readDetail<string>(details, "ipAddress"),
    subnet: readDetail<string>(details, "subnet"),
    wifiStrength: readDetail<number>(details, "strength"),
    wifiFrequency: readDetail<number>(details, "frequency"),
    linkSpeedMbps: readDetail<number>(details, "linkSpeed"),
  };
}

/** What a NetInfo update means for open sockets and the outbox. */
export function detectNetworkChange(
  previous: PhoneNetworkState | null,
  next: PhoneNetworkState,
): NetworkChange | null {
  if (!previous || previous.isConnected === null) return null;
  if (previous.isConnected && next.isConnected === false) return "lost";
  if (!previous.isConnected && next.isConnected === true) return "regained";
  if (!previous.isConnected || !next.isConnected) return null;
  if (previous.type !== next.type) return "path_changed";
  if (previous.ipAddress && next.ipAddress && previous.ipAddress !== next.ipAddress) {
    return "path_changed";
  }
  return null;
}

export function applyPhoneNetworkState(
  next: PhoneNetworkState,
  now: number = Date.now(),
): NetworkChange | null {
  const current = useNetworkMonitorStore.getState();
  const change = detectNetworkChange(current.phone, next);
  useNetworkMonitorStore.setState({
    phone: next,
    changedAt: change ? now : current.changedAt,
    lastChange: change ?? current.lastChange,
    lastOnlineAt: next.isConnected ? now : current.lastOnlineAt,
    lastOfflineAt: next.isConnected === false ? now : current.lastOfflineAt,
  });
  return change;
}

export interface NetworkMonitorHooks {
  /** Network came back or moved to a new path: re-check sockets and retry the outbox now. */
  onReconnectNeeded: (change: Exclude<NetworkChange, "lost">) => void;
}

let configured = false;

export function startNetworkMonitor(hooks: NetworkMonitorHooks): () => void {
  if (!configured) {
    configured = true;
    configure({
      reachabilityShouldRun: () => false,
      shouldFetchWiFiSSID: false,
    });
  }
  const handle = (state: NetInfoState) => {
    const change = applyPhoneNetworkState(summariseNetInfo(state));
    if (change === "regained" || change === "path_changed") hooks.onReconnectNeeded(change);
  };
  const unsubscribe = addEventListener(handle);
  // The NetInfo README: on iOS, re-fetch when the app returns to the foreground.
  const appState = AppState.addEventListener("change", (next) => {
    if (next === "active") void refresh().then(handle, () => undefined);
  });
  return () => {
    unsubscribe();
    appState.remove();
  };
}
