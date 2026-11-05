import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  deviceTokenOf,
  revokeApnsSubscription,
  startApnsSubscription,
  type ApnsDeps,
  type ApnsNotificationsApi,
} from "./apns-subscription";
import { isApnsPluginPush, resolvePushConfig } from "./push-config";

const TOKEN = "ab".repeat(32);
const TOKEN_2 = "cd".repeat(32);

function harness(opts: { granted?: boolean; rpcError?: Error; connected?: boolean } = {}) {
  const statusListeners: Array<(s: { status: string }) => void> = [];
  const tokenListeners: Array<(t: { type: string; data: unknown }) => void> = [];
  const store = new Map<string, string>();
  const client = {
    isConnected: opts.connected ?? true,
    invokePluginRpc: vi.fn(async (_plugin: string, _method: string, _input: unknown) => {
      if (opts.rpcError) throw opts.rpcError;
      return { ok: true, devices: 1, reason: null };
    }),
    registerPushToken: vi.fn(),
    subscribeConnectionStatus: vi.fn((cb: (s: { status: string }) => void) => {
      statusListeners.push(cb);
      return () => undefined;
    }),
  };
  const notifications: ApnsNotificationsApi = {
    getPermissionsAsync: vi.fn(async () => ({
      granted: opts.granted ?? true,
      status: opts.granted === false ? "denied" : "granted",
      canAskAgain: false,
    })),
    requestPermissionsAsync: vi.fn(async () => ({ granted: false, status: "denied" })),
    getDevicePushTokenAsync: vi.fn(async () => ({ type: "ios", data: TOKEN.toUpperCase() })),
    addPushTokenListener: vi.fn((cb) => {
      tokenListeners.push(cb);
      return { remove: vi.fn() };
    }),
  };
  const warn = vi.fn();
  const deps: ApnsDeps = {
    notifications,
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => {
        store.set(k, v);
      },
      removeItem: async (k) => {
        store.delete(k);
      },
    },
    config: { transport: "apns", apnsEnvironment: "development", topic: "com.example.paseo" },
    warn,
  };
  const input = { client: client as unknown as DaemonClient, serverId: "srv_1" };
  return { client, notifications, deps, input, store, warn, statusListeners, tokenListeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("APNs push subscription", () => {
  it("registers the lower-cased device token with the apns plugin, never an Expo token", async () => {
    const h = harness();
    startApnsSubscription(h.input, h.deps);
    await flush();
    expect(h.client.invokePluginRpc).toHaveBeenCalledWith("apns", "register", {
      token: TOKEN,
      environment: "development",
      topic: "com.example.paseo",
    });
    expect(h.client.registerPushToken).not.toHaveBeenCalled();
    expect(h.store.get("@paseo:apns-device-token:srv_1")).toBe(TOKEN);
  });

  it("registers again on every reconnect", async () => {
    const h = harness();
    startApnsSubscription(h.input, h.deps);
    await flush();
    h.statusListeners.forEach((cb) => cb({ status: "connected" }));
    h.statusListeners.forEach((cb) => cb({ status: "disconnected" }));
    expect(h.client.invokePluginRpc).toHaveBeenCalledTimes(2);
  });

  it("registers a rotated token and revokes the old one", async () => {
    const h = harness();
    startApnsSubscription(h.input, h.deps);
    await flush();
    h.tokenListeners.forEach((cb) => cb({ type: "ios", data: TOKEN_2 }));
    await flush();
    expect(h.client.invokePluginRpc).toHaveBeenCalledWith(
      "apns",
      "register",
      expect.objectContaining({ token: TOKEN_2 }),
    );
    expect(h.client.invokePluginRpc).toHaveBeenCalledWith("apns", "revoke", { token: TOKEN });
  });

  it("without permission: no token, no registration, stored token cleared", async () => {
    const h = harness({ granted: false });
    h.store.set("@paseo:apns-device-token:srv_1", TOKEN);
    startApnsSubscription(h.input, h.deps);
    await flush();
    expect(h.notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(h.client.invokePluginRpc).not.toHaveBeenCalled();
    expect(h.store.has("@paseo:apns-device-token:srv_1")).toBe(false);
  });

  it("plugin missing: warns once, keeps retrying on reconnect", async () => {
    const h = harness({ rpcError: new Error("Unknown plugin apns") });
    startApnsSubscription(h.input, h.deps);
    await flush();
    h.statusListeners.forEach((cb) => cb({ status: "connected" }));
    await flush();
    expect(h.client.invokePluginRpc).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it("does not register while disconnected", async () => {
    const h = harness({ connected: false });
    startApnsSubscription(h.input, h.deps);
    await flush();
    expect(h.client.invokePluginRpc).not.toHaveBeenCalled();
  });

  it("stops listening after cleanup", async () => {
    const h = harness();
    const stop = startApnsSubscription(h.input, h.deps);
    await flush();
    stop();
    h.statusListeners.forEach((cb) => cb({ status: "connected" }));
    expect(h.client.invokePluginRpc).toHaveBeenCalledTimes(1);
  });

  it("revoke: tells the plugin and forgets the token", async () => {
    const h = harness();
    h.store.set("@paseo:apns-device-token:srv_1", TOKEN);
    await revokeApnsSubscription(h.input, h.deps);
    expect(h.client.invokePluginRpc).toHaveBeenCalledWith("apns", "revoke", { token: TOKEN });
    expect(h.store.size).toBe(0);
  });

  it("deviceTokenOf accepts iOS hex tokens only", () => {
    expect(deviceTokenOf({ type: "ios", data: TOKEN.toUpperCase() })).toBe(TOKEN);
    expect(deviceTokenOf({ type: "android", data: TOKEN })).toBeNull();
    expect(deviceTokenOf({ type: "ios", data: "ExponentPushToken[x]" })).toBeNull();
    expect(deviceTokenOf(null)).toBeNull();
  });
});

describe("push config", () => {
  it("defaults to the upstream Expo transport", () => {
    expect(resolvePushConfig({})).toEqual({
      transport: "expo",
      apnsEnvironment: "development",
      topic: null,
    });
    expect(resolvePushConfig(null).transport).toBe("expo");
  });

  it("reads extra.push and the bundle id", () => {
    expect(
      resolvePushConfig({
        extra: { push: { transport: "apns", apnsEnvironment: "production" } },
        ios: { bundleIdentifier: "com.example.paseo" },
      }),
    ).toEqual({ transport: "apns", apnsEnvironment: "production", topic: "com.example.paseo" });
  });

  it("reads transport none (local-only builds)", () => {
    expect(resolvePushConfig({ extra: { push: { transport: "none" } } }).transport).toBe("none");
    expect(resolvePushConfig({ extra: { push: { transport: "bogus" } } }).transport).toBe("expo");
  });

  it("recognises paseo-apns pushes only by data.source", () => {
    expect(isApnsPluginPush({ source: "paseo-apns", kind: "bot-dm" })).toBe(true);
    expect(isApnsPluginPush({ serverId: "s", agentId: "a", workspaceId: "w" })).toBe(false);
    expect(isApnsPluginPush(undefined)).toBe(false);
  });
});
