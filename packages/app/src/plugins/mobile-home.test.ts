import { describe, expect, it, vi } from "vitest";
import {
  buildMobileHomeRoute,
  createMobileHomeRecordStore,
  isMobileHomePathname,
  nextMobileHomeRecord,
  parseStoredMobileHome,
  resolveMobileHome,
} from "./mobile-home";

const plugin = (
  serverId: string,
  id: string,
  surfaces: Array<{ id: string; mobileHome?: boolean }>,
) => ({
  serverId,
  id,
  surfaces,
});
const HOME = { serverId: "srv", pluginId: "bots", screenId: "home" };

describe("resolveMobileHome", () => {
  it("finds the first mobileHome screen, preferring the given host", () => {
    const plugins = [
      plugin("a", "bots", [{ id: "home", mobileHome: true }]),
      plugin("b", "bots", [{ id: "bot" }, { id: "home", mobileHome: true }]),
    ];
    expect(resolveMobileHome(plugins, null)).toEqual({
      serverId: "a",
      pluginId: "bots",
      screenId: "home",
    });
    expect(resolveMobileHome(plugins, "b")).toEqual({
      serverId: "b",
      pluginId: "bots",
      screenId: "home",
    });
    expect(resolveMobileHome(plugins, "zzz")?.serverId).toBe("a");
  });

  it("is null without a mobileHome screen", () => {
    expect(resolveMobileHome([plugin("a", "x", [{ id: "s" }])], null)).toBeNull();
    expect(resolveMobileHome([], "a")).toBeNull();
  });
});

describe("home routes", () => {
  it("builds the plugin surface route and recognises it", () => {
    const route = buildMobileHomeRoute(HOME);
    expect(route).toBe("/h/srv/plugin/bots/surface/home");
    expect(isMobileHomePathname(route, HOME)).toBe(true);
    expect(isMobileHomePathname("/h/srv/plugin/bots/surface/dms", HOME)).toBe(false);
    expect(isMobileHomePathname("/h/srv/workspace/w1", HOME)).toBe(false);
    expect(isMobileHomePathname(route, null)).toBe(false);
  });
});

describe("nextMobileHomeRecord", () => {
  const loaded = (ids: string[]) => (serverId: string) => ids.includes(serverId);
  it("takes the live home", () => {
    expect(nextMobileHomeRecord({ recorded: null, live: HOME, hasCatalog: loaded([]) })).toBe(HOME);
  });
  it("keeps the record until its host's catalog has loaded without it", () => {
    expect(nextMobileHomeRecord({ recorded: HOME, live: null, hasCatalog: loaded([]) })).toBe(HOME);
    expect(
      nextMobileHomeRecord({ recorded: HOME, live: null, hasCatalog: loaded(["srv"]) }),
    ).toBeNull();
  });
});

describe("record store", () => {
  it("rejects bad stored values", () => {
    expect(parseStoredMobileHome(null)).toBeNull();
    expect(parseStoredMobileHome("{")).toBeNull();
    expect(parseStoredMobileHome(JSON.stringify({ serverId: "srv" }))).toBeNull();
    expect(parseStoredMobileHome(JSON.stringify(HOME))).toEqual(HOME);
  });

  it("hydrates, writes changes once and clears", async () => {
    const storage = {
      read: vi.fn(async () => JSON.stringify(HOME)),
      write: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const store = createMobileHomeRecordStore(storage);
    expect(store.isHydrated()).toBe(false);
    await store.hydrate();
    expect(store.isHydrated()).toBe(true);
    expect(store.get()).toEqual(HOME);
    store.set({ ...HOME });
    expect(storage.write).not.toHaveBeenCalled();
    store.set({ ...HOME, screenId: "other" });
    expect(storage.write).toHaveBeenCalledTimes(1);
    store.set(null);
    expect(storage.clear).toHaveBeenCalledTimes(1);
    expect(store.get()).toBeNull();
  });
});
