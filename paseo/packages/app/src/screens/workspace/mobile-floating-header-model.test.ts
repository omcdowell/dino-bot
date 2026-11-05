import { describe, expect, it } from "vitest";
import {
  MOBILE_FLOATING_HEADER_CONTROL_SIZE,
  drawsUnderMobileFloatingHeader,
  findWorkspaceBot,
  orderTabsActiveFirst,
  parseBotsList,
  resolveMobileFloatingHeaderFade,
  resolveMobileFloatingHeaderInset,
} from "./mobile-floating-header-model";

describe("resolveMobileFloatingHeaderInset", () => {
  it("clears the status bar, the 44pt controls and a small gap below them", () => {
    expect(MOBILE_FLOATING_HEADER_CONTROL_SIZE).toBe(44);
    // iPhone 17: 62pt safe area + 2 top gap + 44 controls + 8 gap = 116
    expect(resolveMobileFloatingHeaderInset(62)).toBe(116);
    expect(resolveMobileFloatingHeaderInset(0)).toBe(54);
  });

  it("is far smaller than the old header plus tab row (safe area + 98pt)", () => {
    expect(resolveMobileFloatingHeaderInset(62)).toBeLessThan(62 + 98);
  });
});

describe("resolveMobileFloatingHeaderFade", () => {
  it("stays solid behind the status bar, then fades to clear below the controls", () => {
    const fade = resolveMobileFloatingHeaderFade(62);
    expect(fade.height).toBeGreaterThan(resolveMobileFloatingHeaderInset(62));
    const [first, ...rest] = fade.stops;
    expect(first).toEqual({ offset: 0, opacity: 1 });
    // solid through the status bar
    const solidEnd = fade.stops.find((stop) => stop.offset * fade.height >= 62);
    expect(solidEnd?.opacity).toBe(1);
    // ends fully transparent: no hard line at the bottom edge
    expect(rest.at(-1)).toEqual({ offset: 1, opacity: 0 });
    // monotonic: never gets more opaque further down
    for (let index = 1; index < fade.stops.length; index += 1) {
      expect(fade.stops[index].offset).toBeGreaterThan(fade.stops[index - 1].offset);
      expect(fade.stops[index].opacity).toBeLessThanOrEqual(fade.stops[index - 1].opacity);
    }
  });

  it("keeps the band under the controls mostly opaque so text under them stays readable", () => {
    const fade = resolveMobileFloatingHeaderFade(62);
    const controlsMiddle = 62 + 2 + MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2;
    const before = fade.stops.findLast((stop) => stop.offset * fade.height <= controlsMiddle);
    expect(before?.opacity ?? 0).toBeGreaterThanOrEqual(0.85);
  });
});

describe("drawsUnderMobileFloatingHeader", () => {
  it("lets the native chat scroll under the controls", () => {
    expect(drawsUnderMobileFloatingHeader({ kind: "agent", platform: "ios" })).toBe(true);
    expect(drawsUnderMobileFloatingHeader({ kind: "agent", platform: "android" })).toBe(true);
  });

  it("pads every other tab, and the web chat, below the controls", () => {
    expect(drawsUnderMobileFloatingHeader({ kind: "agent", platform: "web" })).toBe(false);
    expect(drawsUnderMobileFloatingHeader({ kind: "terminal", platform: "ios" })).toBe(false);
    expect(drawsUnderMobileFloatingHeader({ kind: "draft", platform: "ios" })).toBe(false);
    expect(drawsUnderMobileFloatingHeader({ kind: "browser", platform: "ios" })).toBe(false);
  });
});

describe("orderTabsActiveFirst", () => {
  const tabs = [{ key: "a" }, { key: "b" }, { key: "c" }];

  it("moves the active tab to the top and keeps the rest in order", () => {
    expect(orderTabsActiveFirst(tabs, "b").map((tab) => tab.key)).toEqual(["b", "a", "c"]);
    expect(orderTabsActiveFirst(tabs, "c").map((tab) => tab.key)).toEqual(["c", "a", "b"]);
  });

  it("leaves the order alone when the active tab is first or unknown", () => {
    expect(orderTabsActiveFirst(tabs, "a")).toEqual(tabs);
    expect(orderTabsActiveFirst(tabs, "zzz")).toEqual(tabs);
    expect(orderTabsActiveFirst([], "a")).toEqual([]);
  });
});

describe("bots plugin answers", () => {
  const answer = {
    bots: [
      {
        id: "emmet-brickowski",
        name: "Emmet",
        cwd: "/home/user/bots/emmet-brickowski",
        avatar: "avatar.png",
        avatarHash: "h1",
      },
      { id: "flint", name: "Flint", cwd: "/home/user/bots/flint/", avatar: null },
      { id: 7, name: "broken" },
    ],
  };

  it("keeps well-formed bots only", () => {
    expect(parseBotsList(answer)).toEqual([
      {
        id: "emmet-brickowski",
        name: "Emmet",
        cwd: "/home/user/bots/emmet-brickowski",
        hasAvatar: true,
        avatarHash: "h1",
      },
      {
        id: "flint",
        name: "Flint",
        cwd: "/home/user/bots/flint/",
        hasAvatar: false,
        avatarHash: null,
      },
    ]);
    expect(parseBotsList(null)).toEqual([]);
    expect(parseBotsList({ bots: "nope" })).toEqual([]);
  });

  it("finds the bot whose folder is the workspace, ignoring trailing slashes", () => {
    const bots = parseBotsList(answer);
    expect(findWorkspaceBot(bots, "/home/user/bots/emmet-brickowski/")?.id).toBe(
      "emmet-brickowski",
    );
    expect(findWorkspaceBot(bots, "/home/user/bots/flint")?.id).toBe("flint");
    expect(findWorkspaceBot(bots, "/home/user/bots/flint/research")).toBeNull();
    expect(findWorkspaceBot(bots, null)).toBeNull();
  });
});
