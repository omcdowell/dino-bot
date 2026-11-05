import { describe, expect, it, vi } from "vitest";
import {
  ICONS_MIN_INTERVAL_MS,
  INSTALL_ID_KEY,
  POLL_MS,
  startLiveActivitySync,
  withIconNames,
  type LiveActivityNative,
  type NativeLiveActivityState,
  type SyncClient,
  type SyncDeps,
} from "./sync";

const START = "c".repeat(64);
const ACT = "d".repeat(64);
const flush = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

function setup(
  over: {
    answer?: unknown;
    state?: Partial<NativeLiveActivityState>;
    connected?: boolean;
    supported?: boolean;
  } = {},
) {
  let connected = over.connected ?? true;
  let connectionListener: ((s: { status: string }) => void) | null = null;
  let changeListener: (() => void) | null = null;
  let foregroundListener: (() => void) | null = null;
  const store = new Map<string, string>();
  const calls: unknown[] = [];
  const applied: Array<[string | null, number | null]> = [];
  const state: NativeLiveActivityState = {
    enabled: true,
    startToken: START,
    activities: [],
    ...over.state,
  };
  const client: SyncClient = {
    get isConnected() {
      return connected;
    },
    invokePluginRpc: vi.fn(async (_p: string, _m: string, input: unknown) => {
      calls.push(input);
      return over.answer ?? { ok: true, reason: null, state: null, staleDate: null };
    }),
    subscribeConnectionStatus: (l) => {
      connectionListener = l;
      return () => {
        connectionListener = null;
      };
    },
  };
  const native: LiveActivityNative = {
    isSupported: () => over.supported ?? true,
    getState: async () => state,
    apply: async (json, stale) => {
      applied.push([json, stale]);
      return "ok";
    },
    addListener: (_e, l) => {
      changeListener = l;
      return { remove: () => (changeListener = null) };
    },
  };
  const deps: SyncDeps = {
    native,
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => void store.set(k, v),
    },
    onForeground: (l) => {
      foregroundListener = l;
      return () => (foregroundListener = null);
    },
    environment: "development",
    topic: "com.example.paseo",
    randomId: () => "install-0001",
    warn: vi.fn(),
  };
  return {
    client,
    deps,
    calls,
    applied,
    state,
    store,
    setConnected: (v: boolean) => (connected = v),
    connect: () => connectionListener?.({ status: "connected" }),
    change: () => changeListener?.(),
    foreground: () => foregroundListener?.(),
    listeners: () =>
      [connectionListener, changeListener, foregroundListener].filter(Boolean).length,
  };
}

describe("startLiveActivitySync", () => {
  it("sends install id, environment, topic, start token and activities; applies the answer", async () => {
    const busy = {
      bots: [{ id: "emmet", name: "Emmet", working: true, workers: 0, since: 1 }],
      more: 0,
    };
    const h = setup({
      answer: { ok: true, reason: null, state: busy, staleDate: 99 },
      state: { activities: [{ id: "a1", token: ACT }] },
    });
    startLiveActivitySync(h.client, h.deps);
    await flush();
    expect(h.client.invokePluginRpc).toHaveBeenCalledWith("apns", "live-activity.sync", {
      installId: "install-0001",
      environment: "development",
      topic: "com.example.paseo",
      startToken: START,
      activities: [{ id: "a1", token: ACT }],
    });
    expect(h.applied).toEqual([[JSON.stringify(busy), 99]]);
    expect(h.store.get(INSTALL_ID_KEY)).toBe("install-0001");
  });

  it("reports the phone's appearance from the native state, so paseo-apns pushes carry it", async () => {
    const h = setup({ state: { appearance: "light" } });
    startLiveActivitySync(h.client, h.deps);
    await flush();
    expect(h.calls[0]).toMatchObject({ appearance: "light" });
    h.state.appearance = "dark";
    h.change();
    await flush();
    expect(h.calls[1]).toMatchObject({ appearance: "dark" });
  });

  it("leaves the appearance out when the native side has none or an unknown value", async () => {
    const none = setup({ state: { appearance: null } });
    startLiveActivitySync(none.client, none.deps);
    await flush();
    expect(none.calls[0]).not.toHaveProperty("appearance");
    const odd = setup({ state: { appearance: "sepia" } });
    startLiveActivitySync(odd.client, odd.deps);
    await flush();
    expect(odd.calls[0]).not.toHaveProperty("appearance");
  });

  it("reports the Lock Screen dino's layer count from the native state, so pushes can carry it", async () => {
    const h = setup({ state: { dinoLayers: 6 } });
    startLiveActivitySync(h.client, h.deps);
    await flush();
    expect(h.calls[0]).toMatchObject({ dinoLayers: 6 });
    h.state.dinoLayers = 3;
    h.change();
    await flush();
    expect(h.calls[1]).toMatchObject({ dinoLayers: 3 });
  });

  it("leaves the dino layer count out when the native side has none or an unknown value", async () => {
    const none = setup();
    startLiveActivitySync(none.client, none.deps);
    await flush();
    expect(none.calls[0]).not.toHaveProperty("dinoLayers");
    const odd = setup({ state: { dinoLayers: 5 } });
    startLiveActivitySync(odd.client, odd.deps);
    await flush();
    expect(odd.calls[0]).not.toHaveProperty("dinoLayers");
  });

  it("a null state ends the activities (apply(null))", async () => {
    const h = setup();
    startLiveActivitySync(h.client, h.deps);
    await flush();
    expect(h.applied).toEqual([[null, null]]);
  });

  it("re-syncs on connect, on a native token/activity change and on foreground; not while offline", async () => {
    const h = setup({ connected: false });
    startLiveActivitySync(h.client, h.deps);
    await flush();
    expect(h.calls).toHaveLength(0);
    h.setConnected(true);
    h.connect();
    await flush();
    h.state.activities = [{ id: "a2", token: null }];
    h.change();
    await flush();
    h.foreground();
    await flush();
    expect(h.calls).toHaveLength(3);
    expect((h.calls[1] as { activities: unknown }).activities).toEqual([{ id: "a2", token: null }]);
  });

  it("drops malformed tokens, keeps a stored install id, and does not apply a refusal", async () => {
    const h = setup({
      answer: { ok: false, reason: "wrong topic", state: null, staleDate: null },
      state: { startToken: "nothex", activities: [{ id: "a", token: "zz" }] },
    });
    h.store.set(INSTALL_ID_KEY, "kept-install-id");
    startLiveActivitySync(h.client, h.deps);
    await flush();
    expect(h.calls[0]).toMatchObject({
      installId: "kept-install-id",
      startToken: null,
      activities: [{ id: "a", token: null }],
    });
    expect(h.applied).toEqual([]);
    expect(h.deps.warn).toHaveBeenCalledTimes(1);
  });

  it("a host without the plugin: warns once, keeps going", async () => {
    const h = setup();
    h.client.invokePluginRpc = vi.fn(async () => {
      throw new Error("Unknown plugin apns");
    });
    startLiveActivitySync(h.client, h.deps);
    await flush();
    h.connect();
    await flush();
    expect(h.client.invokePluginRpc).toHaveBeenCalledTimes(2);
    expect(h.deps.warn).toHaveBeenCalledTimes(1);
  });

  it("unsupported (no module, old iOS, no bundle id) is a no-op; stop removes every listener", async () => {
    for (const over of [{ supported: false }]) {
      const h = setup(over);
      startLiveActivitySync(h.client, h.deps)();
      await flush();
      expect(h.calls).toHaveLength(0);
    }
    const none = setup();
    startLiveActivitySync(none.client, { ...none.deps, native: null });
    startLiveActivitySync(none.client, { ...none.deps, topic: null });
    await flush();
    expect(none.calls).toHaveLength(0);
    const h = setup();
    const stop = startLiveActivitySync(h.client, h.deps);
    expect(h.listeners()).toBe(3);
    stop();
    expect(h.listeners()).toBe(0);
  });

  it("refreshes bot icons on start, connect and foreground at most every 10 min; re-syncs when one changed", async () => {
    let now = 0;
    const h = setup();
    const syncIcons = vi.fn(async (_first: string[]) => ({ changed: true, names: {} }));
    startLiveActivitySync(h.client, { ...h.deps, syncIcons, now: () => now });
    await flush();
    expect(syncIcons).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2); // first sync, then again after the icons changed
    h.connect();
    h.foreground();
    await flush();
    expect(syncIcons).toHaveBeenCalledTimes(1);
    now += ICONS_MIN_INTERVAL_MS;
    syncIcons.mockResolvedValueOnce({ changed: false, names: {} });
    h.foreground();
    await flush();
    expect(syncIcons).toHaveBeenCalledTimes(2);
  });

  it("a failed icon refresh warns once and is retried on the next connect", async () => {
    const h = setup();
    const syncIcons = vi.fn(async () => {
      throw new Error("Unknown plugin bots");
    });
    startLiveActivitySync(h.client, { ...h.deps, syncIcons, now: () => 0 });
    await flush();
    h.connect();
    await flush();
    expect(syncIcons).toHaveBeenCalledTimes(2);
    expect(h.deps.warn).toHaveBeenCalledTimes(1);
  });

  it("adds the bots' icon names to the state it shows; the server's own name wins", () => {
    const state = {
      bots: [
        { id: "emmet", name: "Emmet", working: true, workers: 1, since: 1 },
        { id: "peggy", name: "Peggy", working: true, workers: 0, since: 2, icon: "Megaphone" },
        { id: "nobody", name: "Nobody", working: true, workers: 0, since: 3 },
      ],
      more: 0,
    };
    expect(withIconNames(state, { emmet: "Brain", peggy: "Box", nobody: "<bad>" })).toEqual({
      bots: [
        { id: "emmet", name: "Emmet", working: true, workers: 1, since: 1, icon: "Brain" },
        { id: "peggy", name: "Peggy", working: true, workers: 0, since: 2, icon: "Megaphone" },
        { id: "nobody", name: "Nobody", working: true, workers: 0, since: 3 },
      ],
      more: 0,
    });
    expect(withIconNames(null, { emmet: "Brain" })).toBeNull();
    expect(withIconNames({ odd: true }, { emmet: "Brain" })).toEqual({ odd: true });
  });

  it("applies the state with icon names; refreshes the busy bots' icons first", async () => {
    const answer = {
      ok: true,
      reason: null,
      state: {
        bots: [{ id: "emmet", name: "Emmet", working: true, workers: 1, since: 1 }],
        more: 0,
      },
      staleDate: 9,
    };
    const h = setup({ answer });
    const syncIcons = vi.fn(async (_first: string[]) => ({
      changed: true,
      names: { emmet: "Brain" },
    }));
    startLiveActivitySync(h.client, {
      ...h.deps,
      syncIcons,
      loadIconNames: async () => ({}),
      now: () => 0,
    });
    await flush();
    await flush();
    expect(syncIcons).toHaveBeenCalledWith(["emmet"]);
    expect(h.applied).toHaveLength(2);
    expect(JSON.parse(h.applied[0][0]!).bots[0].icon).toBeUndefined();
    expect(JSON.parse(h.applied[1][0]!).bots[0].icon).toBe("Brain");
  });

  it("uses the icon names kept from the last refresh at once", async () => {
    const answer = {
      ok: true,
      reason: null,
      state: {
        bots: [{ id: "emmet", name: "Emmet", working: true, workers: 1, since: 1 }],
        more: 0,
      },
      staleDate: 9,
    };
    const h = setup({ answer });
    startLiveActivitySync(h.client, { ...h.deps, loadIconNames: async () => ({ emmet: "Brain" }) });
    await flush();
    expect(JSON.parse(h.applied[0][0]!).bots[0].icon).toBe("Brain");
  });

  it("local mode (pushes: false): polls the sync every POLL_MS while open and connected; stops on stop", async () => {
    vi.useFakeTimers();
    try {
      let active = true;
      const h = setup({
        answer: { ok: true, reason: null, state: null, staleDate: null, pushes: false },
      });
      const stop = startLiveActivitySync(h.client, { ...h.deps, isActive: () => active });
      await flush();
      expect(h.calls).toHaveLength(1);
      vi.advanceTimersByTime(POLL_MS);
      await flush();
      expect(h.calls).toHaveLength(2);
      active = false;
      vi.advanceTimersByTime(POLL_MS);
      await flush();
      expect(h.calls).toHaveLength(2);
      active = true;
      h.setConnected(false);
      vi.advanceTimersByTime(POLL_MS);
      await flush();
      expect(h.calls).toHaveLength(2);
      h.setConnected(true);
      stop();
      vi.advanceTimersByTime(POLL_MS * 3);
      await flush();
      expect(h.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a host that pushes, or an older add-on without the field, is not polled", async () => {
    vi.useFakeTimers();
    try {
      for (const answer of [
        { ok: true, reason: null, state: null, staleDate: null, pushes: true },
        { ok: true, reason: null, state: null, staleDate: null },
      ]) {
        const h = setup({ answer });
        const stop = startLiveActivitySync(h.client, h.deps);
        await flush();
        vi.advanceTimersByTime(POLL_MS * 4);
        await flush();
        expect(h.calls).toHaveLength(1);
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("host without the push plugin: no sync call at all (rel-demo bug 8)", async () => {
    const t = setup();
    const hasPlugin = vi.fn(async () => false);
    const stop = startLiveActivitySync(t.client, { ...t.deps, hasPlugin });
    await flush();
    expect(hasPlugin).toHaveBeenCalledWith("apns");
    expect(t.client.invokePluginRpc).not.toHaveBeenCalled();
    expect(t.deps.warn).not.toHaveBeenCalled();
    stop();
  });

  it("host with the push plugin: syncs as before", async () => {
    const t = setup();
    const stop = startLiveActivitySync(t.client, { ...t.deps, hasPlugin: async () => true });
    await flush();
    expect(t.client.invokePluginRpc).toHaveBeenCalled();
    stop();
  });
});
