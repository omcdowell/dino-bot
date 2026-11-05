import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(state: unknown) => void> = [];
vi.mock("@react-native-community/netinfo", () => ({
  configure: vi.fn(),
  addEventListener: (listener: (state: unknown) => void) => {
    listeners.push(listener);
    return () => undefined;
  },
  refresh: vi.fn(() => Promise.resolve()),
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

import {
  detectNetworkChange,
  startNetworkMonitor,
  summariseNetInfo,
  useNetworkMonitorStore,
} from "./network-monitor";

function wifi(ipAddress: string) {
  return {
    type: "wifi",
    isConnected: true,
    isInternetReachable: null,
    details: { isConnectionExpensive: false, ipAddress, strength: 80, ssid: null },
  };
}
const cellular = {
  type: "cellular",
  isConnected: true,
  isInternetReachable: null,
  details: { isConnectionExpensive: true, cellularGeneration: "4g", carrier: null },
};
const none = { type: "none", isConnected: false, isInternetReachable: false, details: null };

describe("network monitor", () => {
  beforeEach(() => {
    listeners.length = 0;
    useNetworkMonitorStore.setState({
      phone: null,
      changedAt: null,
      lastOnlineAt: null,
      lastOfflineAt: null,
      lastChange: null,
    });
  });

  it("summarises NetInfo without the SSID", () => {
    const summary = summariseNetInfo(wifi("192.168.1.2") as never);
    expect(summary).toMatchObject({ type: "wifi", ipAddress: "192.168.1.2", wifiStrength: 80 });
    expect(JSON.stringify(summary)).not.toContain("ssid");
  });

  it("sees regained, lost and path changes", () => {
    const a = summariseNetInfo(wifi("192.168.1.2") as never);
    expect(detectNetworkChange(null, a)).toBeNull();
    expect(detectNetworkChange(a, summariseNetInfo(none as never))).toBe("lost");
    expect(detectNetworkChange(summariseNetInfo(none as never), a)).toBe("regained");
    expect(detectNetworkChange(a, summariseNetInfo(cellular as never))).toBe("path_changed");
    expect(detectNetworkChange(a, summariseNetInfo(wifi("10.0.0.4") as never))).toBe(
      "path_changed",
    );
    expect(detectNetworkChange(a, summariseNetInfo(wifi("192.168.1.2") as never))).toBeNull();
  });

  it("asks for a reconnect when the network comes back or moves", () => {
    const onReconnectNeeded = vi.fn();
    const stop = startNetworkMonitor({ onReconnectNeeded });
    const emit = (state: unknown) => listeners.forEach((listener) => listener(state));
    emit(wifi("192.168.1.2"));
    emit(none);
    emit(wifi("192.168.1.2"));
    emit(cellular);
    expect(onReconnectNeeded.mock.calls.map(([change]) => change)).toEqual([
      "regained",
      "path_changed",
    ]);
    expect(useNetworkMonitorStore.getState().lastOfflineAt).not.toBeNull();
    stop();
  });
});
