import { describe, expect, it, vi } from "vitest";
import {
  ICON_INDEX_KEY,
  ICON_NAMES_KEY,
  ICON_REFRESH_MS,
  loadIconNames,
  pickSavedAvatar,
  syncBotIcons as sync,
  type IconClient,
  type IconDeps,
  type IconSyncOptions,
} from "./icons";
import { pluginQueriesKey } from "@/plugins/plugin-cache";

const PNG = (tag: string) => `data:image/png;base64,${tag}`;
const SERVER = "box";
/** The Live Activity reads the avatars the bots home kept for this host (persisted plugin queries). */
const syncBotIcons = (client: IconClient, deps: IconDeps, options: IconSyncOptions = {}) =>
  sync(client, deps, { serverId: SERVER, ...options });

/** What the bots home keeps per bot: [version (hash or path), variant, data]. */
type Kept = Array<
  [version: string, variant: number | "json" | null, data: Record<string, unknown>]
>;

/** The bots plugin's persisted queries (TanStack dehydrated state) as the app stores them. */
function keep(store: Map<string, string>, avatars: Record<string, Kept>, serverId = SERVER) {
  const queries = Object.entries(avatars).flatMap(([id, kept]) =>
    kept.map(([version, variant, data]) => ({
      queryKey: ["bots", "avatar", id, version, ...(variant === null ? [] : [variant])],
      queryHash: JSON.stringify(["bots", "avatar", id, version, variant]),
      state: { data, status: "success", dataUpdatedAt: 1 },
    })),
  );
  queries.push({
    queryKey: ["bots", "list"],
    queryHash: "list",
    state: { data: { bots: [] } as never, status: "success", dataUpdatedAt: 1 },
  });
  store.set(pluginQueriesKey(serverId, "bots"), JSON.stringify({ queries, mutations: [] }));
}

/** A full avatar.png kept under the bot's path (the default `avatar.png` of `bot()`). */
const full = (dataUri: string | null): Kept => [["avatar.png", null, { dataUri }]];

function setup(bots: unknown[], avatars: Record<string, string | null> = {}, start = 1_000_000) {
  let now = start;
  const store = new Map<string, string>();
  const icons = new Map<string, string>();
  const rendered: string[] = [];
  keep(store, Object.fromEntries(Object.entries(avatars).map(([id, tag]) => [id, full(tag)])));
  const client: IconClient & { bots: unknown[] } = {
    bots,
    invokePluginRpc: vi.fn(async (plugin: string, method: string) => {
      expect(plugin).toBe("bots");
      expect(method).toBe("bots.list"); // icons come from the phone, never bots.avatar
      return { bots: client.bots };
    }),
  };
  const deps: IconDeps = {
    native: {
      setBotIcon: vi.fn(async (id: string, png: string | null) => {
        if (png === null) icons.delete(id);
        else icons.set(id, png);
        return true;
      }),
      storedBotIcons: vi.fn(async () => [...icons.keys()]),
    },
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => void store.set(k, v),
    },
    renderLucide: vi.fn(async (name: string) => {
      rendered.push(name);
      return name === "Unknown" ? null : `tile-${name}`;
    }),
    renderSvg: vi.fn(async (svg: string) => (svg.includes("bad") ? null : `svg-${svg.length}`)),
    now: () => now,
  };
  return { client, deps, store, icons, rendered, advance: (ms: number) => (now += ms) };
}

const bot = (id: string, avatar: string | null, icon = "Bot") => ({ id, name: id, avatar, icon });

describe("syncBotIcons", () => {
  it("avatar first, then the Lucide icon on a tile, then nothing (letter)", async () => {
    const h = setup(
      [
        bot("emmet", "avatar.png", "Brain"),
        bot("wallace", null, "Package"),
        bot("peggy", null, "Megaphone"),
        bot("broken", "gone.png", "Wrench"),
        bot("odd", null, "Unknown"),
      ],
      { emmet: PNG("EMMET"), broken: null },
    );
    const result = await syncBotIcons(h.client, h.deps);
    expect(Object.fromEntries(h.icons)).toEqual({
      emmet: "EMMET",
      wallace: "tile-Package",
      peggy: "tile-Megaphone",
      broken: "tile-Wrench",
    });
    expect(result.saved.sort()).toEqual(["broken", "emmet", "peggy", "wallace"]);
    expect(h.rendered).toEqual(["Package", "Megaphone", "Wrench", "Unknown"]);
    expect(JSON.parse(h.store.get(ICON_INDEX_KEY)!)).toMatchObject({
      emmet: { source: "avatar:avatar.png" },
      wallace: { source: "icon:Package" },
    });
  });

  it("skips fresh icons, refreshes after a day or when the source changes", async () => {
    const h = setup([bot("emmet", "avatar.png"), bot("wallace", null, "Package")], {
      emmet: PNG("A"),
    });
    await syncBotIcons(h.client, h.deps);
    const again = await syncBotIcons(h.client, h.deps);
    expect(again).toMatchObject({ saved: [], removed: [] });

    h.client.bots = [bot("emmet", "avatar.png"), bot("wallace", null, "Box")];
    expect((await syncBotIcons(h.client, h.deps)).saved).toEqual(["wallace"]);
    expect(h.icons.get("wallace")).toBe("tile-Box");

    h.advance(ICON_REFRESH_MS);
    expect((await syncBotIcons(h.client, h.deps)).saved.sort()).toEqual(["emmet", "wallace"]);
  });

  it("removes icons of bots that are gone or now have nothing drawable", async () => {
    const h = setup([bot("emmet", "avatar.png"), bot("scrat", null, "Globe")], { emmet: PNG("A") });
    await syncBotIcons(h.client, h.deps);
    h.client.bots = [bot("scrat", null, "Unknown")];
    const result = await syncBotIcons(h.client, h.deps);
    expect(result.removed.sort()).toEqual(["emmet", "scrat"]);
    expect(h.icons.size).toBe(0);
  });

  it("an avatar the phone does not have keeps the stored icon; bad ids and names are ignored", async () => {
    const h = setup([bot("emmet", "avatar.png")], { emmet: PNG("A") });
    await syncBotIcons(h.client, h.deps);
    h.advance(ICON_REFRESH_MS);
    const missing = setup([bot("emmet", "avatar.png")]);
    missing.store.delete(pluginQueriesKey(SERVER, "bots")); // e.g. trimmed or not written yet
    missing.store.set(ICON_INDEX_KEY, h.store.get(ICON_INDEX_KEY)!);
    missing.icons.set("emmet", "A");
    missing.advance(ICON_REFRESH_MS);
    expect(await syncBotIcons(missing.client, missing.deps)).toMatchObject({
      saved: [],
      removed: [],
    });
    expect(missing.icons.get("emmet")).toBe("A");

    const bad = setup([bot("../x", null, "Package"), bot("ok", null, "<svg>")]);
    expect(await syncBotIcons(bad.client, bad.deps)).toMatchObject({ saved: [], removed: [] });
    expect(bad.rendered).toEqual([]);
  });

  it("throws when the host has no bots plugin answer", async () => {
    const h = setup([]);
    h.client.invokePluginRpc = vi.fn(async () => null);
    await expect(syncBotIcons(h.client, h.deps)).rejects.toThrow("bots.list");
  });

  it("stores again an icon the keychain lost, although the index says it is fresh", async () => {
    const h = setup([bot("emmet", "avatar.png", "Brain")], { emmet: PNG("A") });
    await syncBotIcons(h.client, h.deps);
    h.icons.clear(); // keychain reset, or a write that never landed
    const again = await syncBotIcons(h.client, h.deps);
    expect(again.saved).toEqual(["emmet"]);
    expect(h.icons.get("emmet")).toBe("A");
  });

  it("returns and keeps each bot's Lucide icon name, for the widget's own tile", async () => {
    const h = setup(
      [
        bot("emmet", "avatar.png", "Brain"),
        bot("wallace", null, "Package"),
        bot("odd", null, "<x>"),
      ],
      { emmet: PNG("A") },
    );
    const result = await syncBotIcons(h.client, h.deps);
    expect(result.names).toEqual({ emmet: "Brain", wallace: "Package" });
    expect(await loadIconNames(h.deps.storage)).toEqual({ emmet: "Brain", wallace: "Package" });
    h.store.set(ICON_NAMES_KEY, "{bad");
    expect(await loadIconNames(h.deps.storage)).toEqual({});
  });

  it("only removes icons this host stored (another host may list other bots)", async () => {
    const h = setup([bot("emmet", "avatar.png")], { emmet: PNG("A") });
    await syncBotIcons(h.client, h.deps, { serverId: "box" });
    h.client.bots = [bot("flint", null, "Lightbulb")];
    keep(h.store, {}, "mac");
    const other = await syncBotIcons(h.client, h.deps, { serverId: "mac" });
    expect(other.removed).toEqual([]);
    expect(h.icons.get("emmet")).toBe("A");
    h.client.bots = [];
    expect((await syncBotIcons(h.client, h.deps, { serverId: "box" })).removed).toEqual(["emmet"]);
  });

  it("stores the busy bots' icons first", async () => {
    const h = setup([bot("a", null, "Package"), bot("b", null, "Box"), bot("c", null, "Brain")]);
    await syncBotIcons(h.client, h.deps, { first: ["c"] });
    expect(h.rendered).toEqual(["Brain", "Package", "Box"]);
  });

  it("draws the copy the home kept for the listed hash: SVG first, else the smallest PNG of 96 px or more", async () => {
    const withHash = (id: string, avatarHash: string) => ({ ...bot(id, "avatar.png"), avatarHash });
    const h = setup([withHash("emmet", "h1"), withHash("wallace", "w1"), withHash("scrat", "s1")]);
    keep(h.store, {
      emmet: [
        ["h1", "json", { dataUri: null, svg: "<svg>emmet</svg>", avatar: {}, packVersion: 1 }],
        ["h1", 64, { dataUri: PNG("E64"), size: 64 }],
      ],
      wallace: [
        ["w1", 64, { dataUri: PNG("W64"), size: 64 }],
        ["w1", 512, { dataUri: PNG("W512"), size: 512 }],
        ["w1", 128, { dataUri: PNG("W128"), size: 128 }],
        ["w0", 128, { dataUri: PNG("OLD"), size: 128 }],
      ],
      scrat: [["s1", 64, { dataUri: PNG("S64"), size: 64 }]],
    });
    await syncBotIcons(h.client, h.deps);
    expect(Object.fromEntries(h.icons)).toEqual({
      emmet: `svg-${"<svg>emmet</svg>".length}`,
      wallace: "W128",
      scrat: "S64",
    });
    expect(JSON.parse(h.store.get(ICON_INDEX_KEY)!)).toMatchObject({
      emmet: { source: "avatar:h1" },
    });
    expect(h.deps.renderSvg).toHaveBeenCalledTimes(1);
  });

  it("a new hash the home has not loaded yet keeps the old avatar, then updates once it is kept", async () => {
    const h = setup([{ ...bot("emmet", "avatar.png", "Brain"), avatarHash: "h1" }]);
    keep(h.store, { emmet: [["h1", 128, { dataUri: PNG("ONE"), size: 128 }]] });
    await syncBotIcons(h.client, h.deps);
    h.client.bots = [{ ...bot("emmet", "avatar.png", "Brain"), avatarHash: "h2" }];
    expect(await syncBotIcons(h.client, h.deps)).toMatchObject({ saved: [], removed: [] });
    expect(h.icons.get("emmet")).toBe("ONE");
    expect(h.rendered).toEqual([]);
    keep(h.store, { emmet: [["h2", 128, { dataUri: PNG("TWO"), size: 128 }]] });
    expect((await syncBotIcons(h.client, h.deps)).saved).toEqual(["emmet"]);
    expect(h.icons.get("emmet")).toBe("TWO");
  });

  it("the home found nothing drawable for the hash: the Lucide tile, as the home shows", async () => {
    const h = setup([{ ...bot("emmet", "avatar.png", "Brain"), avatarHash: "h1" }]);
    keep(h.store, { emmet: [["h1", 128, { dataUri: PNG("ONE"), size: 128 }]] });
    await syncBotIcons(h.client, h.deps);
    h.client.bots = [{ ...bot("emmet", "avatar.png", "Brain"), avatarHash: "h2" }];
    keep(h.store, { emmet: [["h2", 128, { dataUri: null, hash: "h2" }]] });
    await syncBotIcons(h.client, h.deps);
    expect(h.icons.get("emmet")).toBe("tile-Brain");
  });

  it("an SVG Skia cannot draw: a kept PNG of the same hash, else the Lucide tile", async () => {
    const h = setup([
      { ...bot("emmet", "avatar.png", "Brain"), avatarHash: "h1" },
      { ...bot("flint", "avatar.png", "Box"), avatarHash: "f1" },
    ]);
    keep(h.store, {
      emmet: [["h1", "json", { dataUri: null, svg: "<svg>bad</svg>" }]],
      flint: [
        ["f1", "json", { dataUri: null, svg: "<svg>bad</svg>" }],
        ["f1", 64, { dataUri: PNG("F64"), size: 64 }],
      ],
    });
    await syncBotIcons(h.client, h.deps);
    expect(h.icons.get("emmet")).toBe("tile-Brain");
    expect(h.icons.get("flint")).toBe("F64");
  });

  it("without a host id nothing is read from the phone's plugin cache (Lucide tile)", async () => {
    const h = setup([bot("emmet", "avatar.png", "Brain")], { emmet: PNG("A") });
    await sync(h.client, h.deps);
    expect(h.icons.get("emmet")).toBe("tile-Brain");
  });

  it("pickSavedAvatar", () => {
    expect(pickSavedAvatar([])).toBeNull();
    expect(pickSavedAvatar([{ png: "a", size: 64 }])).toEqual({ png: "a", size: 64 });
    expect(pickSavedAvatar([{ png: "full" }, { png: "b", size: 128 }])).toEqual({
      png: "b",
      size: 128,
    });
    expect(pickSavedAvatar([{ png: "a", size: 64 }, { png: "full" }])).toEqual({ png: "full" });
  });
});
