/**
 * @vitest-environment jsdom
 *
 * header-cache (Sam 2026-10-12: "the header avatar and titles aren't being cached"). The phone
 * header showed the workspace title and tab icon until the host answered `bots.list` and
 * `bots.avatar` — on every cold start, reconnect and chat switch — then jumped to the bot. It now
 * reads the bots plugin's device cache first and refreshes from the host when connected.
 */
import React, { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { hydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginCache,
  createPluginQueryClient,
  type PluginCacheStorage,
} from "@/plugins/plugin-cache";
import { fetchWorkspaceBot, readCachedWorkspaceBot } from "./workspace-bot-cache";

const host = vi.hoisted(() => ({
  client: null as null | { invokePluginRpc: (...args: unknown[]) => Promise<unknown> },
  connected: false,
  pluginQueryClient: null as QueryClient | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => host.client,
  useHostRuntimeIsConnected: () => host.connected,
}));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugin: () =>
    host.pluginQueryClient ? { queryClient: host.pluginQueryClient } : null,
}));

import { useWorkspaceBot } from "./use-workspace-bot";

const EMMET_DIR = "/home/user/bots/emmet-brickowski";
const OLD_PNG = "data:image/png;base64,T0xE";
const NEW_PNG = "data:image/png;base64,TkVX";

function listAnswer(name: string, avatarHash: string) {
  return {
    bots: [
      {
        id: "emmet-brickowski",
        name,
        cwd: EMMET_DIR,
        icon: "Bot",
        order: 0,
        avatar: "avatar.png",
        avatarHash,
        featured: false,
        agentId: null,
      },
    ],
  };
}

/** The bots plugin's client as the home leaves it: its list and one avatar, both persisted. */
function seededPluginClient(): QueryClient {
  const client = createPluginQueryClient();
  client
    .getQueryCache()
    .build(client, { queryKey: ["bots", "list"], meta: { persist: true } })
    .setData(listAnswer("Emmet", "old"));
  client
    .getQueryCache()
    .build(client, {
      queryKey: ["bots", "avatar", "emmet-brickowski", "old"],
      meta: { persist: true },
    })
    .setData({ dataUri: OLD_PNG, hash: "old" });
  return client;
}

function memoryStorage(): PluginCacheStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
  };
}

function rpcClient(answers: { list: unknown; avatar?: unknown }) {
  const calls: string[] = [];
  return {
    calls,
    invokePluginRpc: async (_plugin: unknown, method: unknown) => {
      calls.push(String(method));
      if (method === "bots.list") return answers.list;
      if (method === "bots.avatar") return answers.avatar;
      throw new Error(`unexpected ${String(method)}`);
    },
  };
}

let appQueryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  appQueryClient = new QueryClient();
  host.client = null;
  host.connected = false;
  host.pluginQueryClient = null;
});
afterEach(() => {
  appQueryClient.clear();
});

describe("useWorkspaceBot", () => {
  it("shows the cached bot and avatar on the first render while the host is not connected", () => {
    host.pluginQueryClient = seededPluginClient();
    const { result } = renderHook(
      () =>
        useWorkspaceBot({ serverId: "host-a", workspaceDirectory: `${EMMET_DIR}/`, enabled: true }),
      { wrapper },
    );
    expect(result.current?.bot.name).toBe("Emmet");
    expect(result.current?.avatarUri).toBe(OLD_PNG);
  });

  it("keeps showing the host's last answer after the host disconnects", async () => {
    host.pluginQueryClient = seededPluginClient();
    host.client = rpcClient({ list: listAnswer("Emmet B", "old") });
    host.connected = true;
    const { result, rerender } = renderHook(
      () => useWorkspaceBot({ serverId: "host-a", workspaceDirectory: EMMET_DIR, enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current?.bot.name).toBe("Emmet B"));
    host.connected = false;
    rerender();
    expect(result.current?.bot.name).toBe("Emmet B");
    expect(result.current?.avatarUri).toBe(OLD_PNG);
  });

  it("refreshes from the host when connected and replaces the cached identity", async () => {
    const pluginQueryClient = seededPluginClient();
    host.pluginQueryClient = pluginQueryClient;
    const rpc = rpcClient({
      list: listAnswer("Emmet Brickowski", "new"),
      avatar: { dataUri: NEW_PNG, hash: "new" },
    });
    host.client = rpc;
    host.connected = true;
    const { result } = renderHook(
      () => useWorkspaceBot({ serverId: "host-a", workspaceDirectory: EMMET_DIR, enabled: true }),
      { wrapper },
    );
    expect(result.current?.bot.name).toBe("Emmet");
    expect(result.current?.avatarUri).toBe(OLD_PNG);
    await waitFor(() => expect(result.current?.avatarUri).toBe(NEW_PNG));
    expect(result.current?.bot.name).toBe("Emmet Brickowski");
    expect(rpc.calls).toEqual(["bots.list", "bots.avatar"]);
    // The new avatar went into the plugin's cache, replacing the old copy.
    expect(pluginQueryClient.getQueryData(["bots", "avatar", "emmet-brickowski", "new"])).toEqual({
      dataUri: NEW_PNG,
      hash: "new",
    });
    expect(
      pluginQueryClient.getQueryData(["bots", "avatar", "emmet-brickowski", "old"]),
    ).toBeUndefined();
  });

  it("follows the plugin cache when the home updates it", () => {
    const pluginQueryClient = seededPluginClient();
    host.pluginQueryClient = pluginQueryClient;
    const { result } = renderHook(
      () => useWorkspaceBot({ serverId: "host-a", workspaceDirectory: EMMET_DIR, enabled: true }),
      { wrapper },
    );
    act(() => {
      pluginQueryClient.setQueryData(["bots", "list"], listAnswer("Emmet 2", "old"));
    });
    expect(result.current?.bot.name).toBe("Emmet 2");
  });

  it("is null for a workspace that is not a bot's, and when disabled", () => {
    host.pluginQueryClient = seededPluginClient();
    const other = renderHook(
      () =>
        useWorkspaceBot({
          serverId: "host-a",
          workspaceDirectory: "/home/user/code",
          enabled: true,
        }),
      { wrapper },
    );
    expect(other.result.current).toBeNull();
    const disabled = renderHook(
      () => useWorkspaceBot({ serverId: "host-a", workspaceDirectory: EMMET_DIR, enabled: false }),
      { wrapper },
    );
    expect(disabled.result.current).toBeNull();
  });
});

describe("workspace bot cache", () => {
  it("is persisted across an app restart through the plugin cache", async () => {
    const storage = memoryStorage();
    const cache = createPluginCache(storage, { debounceMs: 0 });
    await cache.saveCatalog("host-a", [
      { id: "bots", clientBundle: "bundle", clientBundleHash: "b1" },
    ]);
    const live = createPluginQueryClient();
    live
      .getQueryCache()
      .build(live, { queryKey: ["bots", "list"], meta: { persist: true } })
      .setData(listAnswer("Emmet", "new"));
    await cache.track("host-a", [
      { id: "bots", queryClient: live, lifetime: new AbortController() },
    ]);
    // A header refresh fetches the changed avatar and keeps it in the plugin's cache.
    await fetchWorkspaceBot({
      client: rpcClient({
        list: listAnswer("Emmet", "new"),
        avatar: { dataUri: NEW_PNG, hash: "new" },
      }),
      workspaceDirectory: EMMET_DIR,
      pluginQueryClient: live,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await cache.flush();

    const restarted = await createPluginCache(storage).load("host-a");
    const queries = restarted?.plugins.find((plugin) => plugin.entry.id === "bots")?.queries;
    expect(queries).toBeTruthy();
    const fresh = createPluginQueryClient();
    hydrate(fresh, queries!);
    expect(readCachedWorkspaceBot(fresh, EMMET_DIR)).toEqual({
      bot: {
        id: "emmet-brickowski",
        name: "Emmet",
        cwd: EMMET_DIR,
        hasAvatar: true,
        avatarHash: "new",
      },
      avatarUri: NEW_PNG,
    });
  });

  it("does not fetch an avatar the device already has under the same hash", async () => {
    const rpc = rpcClient({ list: listAnswer("Emmet", "old") });
    const identity = await fetchWorkspaceBot({
      client: rpc,
      workspaceDirectory: EMMET_DIR,
      pluginQueryClient: seededPluginClient(),
    });
    expect(identity?.avatarUri).toBe(OLD_PNG);
    expect(rpc.calls).toEqual(["bots.list"]);
  });

  it("keeps the cached avatar when the avatar call fails", async () => {
    const identity = await fetchWorkspaceBot({
      client: {
        invokePluginRpc: async (_plugin: unknown, method: unknown) => {
          if (method === "bots.list") return listAnswer("Emmet", "new");
          throw new Error("offline");
        },
      },
      workspaceDirectory: EMMET_DIR,
      pluginQueryClient: seededPluginClient(),
    });
    expect(identity?.avatarUri).toBe(OLD_PNG);
  });
});

void React;
