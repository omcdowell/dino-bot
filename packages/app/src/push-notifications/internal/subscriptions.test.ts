import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const config = vi.hoisted(() => ({
  expoConfig: {
    extra: { push: { transport: "apns", apnsEnvironment: "development" }, eas: { projectId: "p" } },
    ios: { bundleIdentifier: "com.example.paseo" },
  } as Record<string, unknown>,
  platform: "ios",
}));

vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return config.expoConfig;
    },
    easConfig: null,
  },
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return config.platform;
    },
  },
}));
vi.mock("expo-notifications", () => ({
  PermissionStatus: { GRANTED: "granted" },
  AndroidImportance: { DEFAULT: 3 },
  getPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted", canAskAgain: true })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted" })),
  getDevicePushTokenAsync: vi.fn(async () => ({ type: "ios", data: "ef".repeat(32) })),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: "ExponentPushToken[abc]" })),
  addPushTokenListener: vi.fn(() => ({ remove: () => undefined })),
  setNotificationChannelAsync: vi.fn(),
}));

const gate = vi.hoisted(() => {
  let open = true;
  const waiters: Array<() => void> = [];
  return {
    setOpen(value: boolean) {
      open = value;
      if (value) for (const w of waiters.splice(0)) w();
    },
    wait: () => (open ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
});
vi.mock("./push-prompt", () => ({
  pushPromptGate: { wait: () => gate.wait(), noteReply: () => gate.setOpen(true) },
}));

import { startSubscription, usesApnsTransport, usesNoPush } from "./subscriptions";

function fakeClient() {
  return {
    isConnected: true,
    invokePluginRpc: vi.fn(async () => ({ ok: true, devices: 1, reason: null })),
    registerPushToken: vi.fn(),
    subscribeConnectionStatus: vi.fn(() => () => undefined),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("push transport switch", () => {
  beforeEach(() => {
    config.platform = "ios";
    config.expoConfig = {
      extra: {
        push: { transport: "apns", apnsEnvironment: "development" },
        eas: { projectId: "p" },
      },
      ios: { bundleIdentifier: "com.example.paseo" },
    };
  });

  it("apns build on iOS: plugin registration only, no Expo push token", async () => {
    const client = fakeClient();
    startSubscription({ client: client as unknown as DaemonClient, serverId: "s" });
    await flush();
    await flush();
    expect(usesApnsTransport()).toBe(true);
    expect(client.registerPushToken).not.toHaveBeenCalled();
    expect(client.invokePluginRpc).toHaveBeenCalledWith("apns", "register", {
      token: "ef".repeat(32),
      environment: "development",
      topic: "com.example.paseo",
    });
  });

  it("expo path: a host without the push plugin does not break the daemon registration", async () => {
    config.expoConfig = { extra: { eas: { projectId: "p" } }, ios: { bundleIdentifier: "x.y" } };
    const client = fakeClient();
    client.invokePluginRpc.mockRejectedValue(new Error("unknown plugin"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startSubscription({ client: client as unknown as DaemonClient, serverId: "s4" });
    await flush();
    await flush();
    await flush();
    expect(client.registerPushToken).toHaveBeenCalledWith("ExponentPushToken[abc]");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("upstream config keeps the Expo path", async () => {
    config.expoConfig = {
      extra: { eas: { projectId: "p" } },
      ios: { bundleIdentifier: "sh.paseo" },
    };
    const client = fakeClient();
    startSubscription({ client: client as unknown as DaemonClient, serverId: "s2" });
    await flush();
    await flush();
    expect(usesApnsTransport()).toBe(false);
    expect(client.registerPushToken).toHaveBeenCalledWith("ExponentPushToken[abc]");
    // Also handed to the push plugin (expo mode sends bot DMs through Expo).
    expect(client.invokePluginRpc).toHaveBeenCalledWith("apns", "register-expo", {
      token: "ExponentPushToken[abc]",
    });
  });

  it("none: registers nothing and asks for no permission", async () => {
    const Notifications = await import("expo-notifications");
    vi.mocked(Notifications.getPermissionsAsync).mockClear();
    config.expoConfig = {
      extra: { push: { transport: "none" }, eas: { projectId: "p" } },
      ios: { bundleIdentifier: "com.example.app" },
    };
    const client = fakeClient();
    const stop = startSubscription({ client: client as unknown as DaemonClient, serverId: "s3" });
    await flush();
    await flush();
    expect(usesNoPush()).toBe(true);
    expect(usesApnsTransport()).toBe(false);
    expect(client.invokePluginRpc).not.toHaveBeenCalled();
    expect(client.registerPushToken).not.toHaveBeenCalled();
    expect(client.subscribeConnectionStatus).not.toHaveBeenCalled();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    stop();
  });

  it("apns transport is iOS-only", () => {
    config.platform = "android";
    expect(usesApnsTransport()).toBe(false);
  });
  it("expo path: a host whose plugin list has no push plugin is not asked (rel-demo bug 8)", async () => {
    config.expoConfig = { extra: { eas: { projectId: "p" } }, ios: { bundleIdentifier: "x.y" } };
    const client = {
      ...fakeClient(),
      listPlugins: vi.fn(async () => [{ id: "bots", status: "running" }]),
    };
    startSubscription({ client: client as unknown as DaemonClient, serverId: "s5" });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(client.registerPushToken).toHaveBeenCalledWith("ExponentPushToken[abc]");
    expect(client.listPlugins).toHaveBeenCalled();
    expect(client.invokePluginRpc).not.toHaveBeenCalled();
  });

  it("public flavour: no permission prompt until the first reply (rel-demo bug 6)", async () => {
    const Notifications = await import("expo-notifications");
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
      status: "undetermined",
      canAskAgain: true,
    } as never);
    vi.mocked(Notifications.requestPermissionsAsync).mockClear();
    config.expoConfig = { extra: { eas: { projectId: "p" } }, ios: { bundleIdentifier: "x.y" } };
    gate.setOpen(false);
    const client = fakeClient();
    startSubscription({ client: client as unknown as DaemonClient, serverId: "s6" });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(client.registerPushToken).not.toHaveBeenCalled();
    gate.setOpen(true);
    for (let i = 0; i < 5; i += 1) await flush();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(client.registerPushToken).toHaveBeenCalledWith("ExponentPushToken[abc]");
  });
});
