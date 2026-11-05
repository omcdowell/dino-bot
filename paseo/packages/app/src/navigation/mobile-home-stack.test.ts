import { describe, expect, it } from "vitest";
import type { MobileHome } from "@/plugins/mobile-home";
import {
  CHAT_OVER_HOME_SCREEN_OPTIONS,
  isChatOverMobileHome,
  isFocusedChatOverMobileHome,
  isMobileHomeFocused,
  leavesTouchToNativeBack,
  NATIVE_BACK_EDGE_WIDTH,
  pluginScreenOptions,
  shouldPushWorkspaceOverMobileHome,
  workspaceScreenOptions,
} from "./mobile-home-stack";

// Sam 2026-10-12: "can we have a nice swipe between the bot home page and chats, at the moment
// its a harsh transition". The chat replaced the home with no animation; now it is pushed over it.

const HOME: MobileHome = { serverId: "srv", pluginId: "bots", screenId: "home" };

const homeRoute = {
  key: "home-1",
  name: "plugin/[pluginId]/[contributionKind]/[contributionId]",
  params: {
    serverId: "srv",
    pluginId: "bots",
    contributionKind: "surface",
    contributionId: "home",
  },
};
const otherPluginRoute = {
  key: "plugin-2",
  name: "plugin/[pluginId]/[contributionKind]/[contributionId]",
  params: { serverId: "srv", pluginId: "bots", contributionKind: "surface", contributionId: "bot" },
};
const chatRoute = {
  key: "chat-1",
  name: "workspace/[workspaceId]/index",
  params: { serverId: "srv", workspaceId: "ws-a" },
};

function rootWithHostStack(
  hostRoutes: object[],
  options: { serverId?: string; overlay?: object } = {},
) {
  const host = {
    key: "host",
    name: "h/[serverId]",
    params: { serverId: options.serverId ?? "srv" },
    state: { key: "host-stack", index: hostRoutes.length - 1, routes: hostRoutes },
  };
  const routes = options.overlay ? [host, options.overlay] : [host];
  return { key: "root-stack", index: routes.length - 1, routes };
}

describe("isMobileHomeFocused", () => {
  it("is true when the home is the focused host screen", () => {
    expect(isMobileHomeFocused(rootWithHostStack([homeRoute]), HOME)).toBe(true);
  });

  it("is false with a chat on top of the home", () => {
    expect(isMobileHomeFocused(rootWithHostStack([homeRoute, chatRoute]), HOME)).toBe(false);
  });

  it("is false for another screen of the same plugin", () => {
    expect(isMobileHomeFocused(rootWithHostStack([otherPluginRoute]), HOME)).toBe(false);
  });

  it("is false for the home on another host", () => {
    expect(isMobileHomeFocused(rootWithHostStack([homeRoute], { serverId: "other" }), HOME)).toBe(
      false,
    );
  });

  it("is false while Settings covers the home", () => {
    const settings = { key: "settings", name: "settings/index" };
    expect(isMobileHomeFocused(rootWithHostStack([homeRoute], { overlay: settings }), HOME)).toBe(
      false,
    );
  });

  it("finds the host stack under a wrapping root navigator", () => {
    const wrapped = {
      index: 0,
      routes: [{ key: "__root", state: rootWithHostStack([homeRoute]) }],
    };
    expect(isMobileHomeFocused(wrapped, HOME)).toBe(true);
  });
});

describe("shouldPushWorkspaceOverMobileHome", () => {
  const rootState = rootWithHostStack([homeRoute]);

  it("pushes a chat opened from the home", () => {
    expect(
      shouldPushWorkspaceOverMobileHome({ rootState, route: "/h/srv/workspace/ws-a", home: HOME }),
    ).toBe(true);
  });

  it("pushes a chat opened with an open intent (deferred agent tab)", () => {
    expect(
      shouldPushWorkspaceOverMobileHome({
        rootState,
        route: "/h/srv/workspace/ws-a?open=agent%3Aa1",
        home: HOME,
      }),
    ).toBe(true);
  });

  it("does not push without a phone home (laptops, web)", () => {
    expect(
      shouldPushWorkspaceOverMobileHome({ rootState, route: "/h/srv/workspace/ws-a", home: null }),
    ).toBe(false);
  });

  it("does not push a chat on another host", () => {
    expect(
      shouldPushWorkspaceOverMobileHome({
        rootState,
        route: "/h/other/workspace/ws-a",
        home: HOME,
      }),
    ).toBe(false);
  });

  it("does not push from a chat (chat to chat stays in place)", () => {
    expect(
      shouldPushWorkspaceOverMobileHome({
        rootState: rootWithHostStack([homeRoute, chatRoute]),
        route: "/h/srv/workspace/ws-b",
        home: HOME,
      }),
    ).toBe(false);
  });
});

describe("isChatOverMobileHome / workspaceScreenOptions", () => {
  it("gives a chat directly on top of the home the native push and edge swipe", () => {
    const stack = { routes: [homeRoute, chatRoute] };
    expect(isChatOverMobileHome(stack, "chat-1", HOME)).toBe(true);
    expect(workspaceScreenOptions({ stackState: stack, routeKey: "chat-1", home: HOME })).toEqual(
      CHAT_OVER_HOME_SCREEN_OPTIONS,
    );
    expect(CHAT_OVER_HOME_SCREEN_OPTIONS).toMatchObject({
      animation: "default",
      gestureEnabled: true,
    });
  });

  it("leaves a chat that replaced everything (no home underneath) unanimated", () => {
    const stack = { routes: [chatRoute] };
    expect(isChatOverMobileHome(stack, "chat-1", HOME)).toBe(false);
    expect(workspaceScreenOptions({ stackState: stack, routeKey: "chat-1", home: HOME })).toEqual(
      {},
    );
  });

  it("leaves a chat above another screen unanimated", () => {
    const stack = { routes: [otherPluginRoute, chatRoute] };
    expect(isChatOverMobileHome(stack, "chat-1", HOME)).toBe(false);
  });

  it("is off without a phone home", () => {
    const stack = { routes: [homeRoute, chatRoute] };
    expect(workspaceScreenOptions({ stackState: stack, routeKey: "chat-1", home: null })).toEqual(
      {},
    );
  });

  it("tells when the chat on show has the home underneath", () => {
    expect(isFocusedChatOverMobileHome(rootWithHostStack([homeRoute, chatRoute]), HOME)).toBe(true);
    expect(isFocusedChatOverMobileHome(rootWithHostStack([homeRoute]), HOME)).toBe(false);
    expect(isFocusedChatOverMobileHome(rootWithHostStack([chatRoute]), HOME)).toBe(false);
  });
});

// Sam 2026-10-13: "i want the header and swipe animation implemented for group chats". A plugin
// screen that opens like a chat (it registers `mobileFloatingHeader`) slides over the home too.
describe("plugin screens that open like a chat", () => {
  const groupRoute = {
    key: "group-1",
    name: "plugin/[pluginId]/[contributionKind]/[contributionId]",
    params: {
      serverId: "srv",
      pluginId: "bots",
      contributionKind: "surface",
      contributionId: "group",
      groupId: "alarm-clock",
    },
  };
  const calls: object[] = [];
  const isGroup = (screen: { serverId: string; pluginId: string; screenId: string }) => {
    calls.push(screen);
    return screen.pluginId === "bots" && screen.screenId === "group";
  };

  it("gives a chat-like plugin screen on top of the home the native push and edge swipe", () => {
    const stack = { routes: [homeRoute, groupRoute] };
    expect(isChatOverMobileHome(stack, "group-1", HOME, isGroup)).toBe(true);
    expect(
      pluginScreenOptions({
        stackState: stack,
        routeKey: "group-1",
        home: HOME,
        isPluginChatScreen: isGroup,
      }),
    ).toEqual(CHAT_OVER_HOME_SCREEN_OPTIONS);
    expect(calls).toContainEqual({ serverId: "srv", pluginId: "bots", screenId: "group" });
  });

  it("leaves other plugin screens, and the home itself, unanimated", () => {
    expect(
      isChatOverMobileHome({ routes: [homeRoute, otherPluginRoute] }, "plugin-2", HOME, isGroup),
    ).toBe(false);
    expect(
      pluginScreenOptions({
        stackState: { routes: [homeRoute, { ...homeRoute, key: "home-2" }] },
        routeKey: "home-2",
        home: HOME,
        isPluginChatScreen: () => true,
      }),
    ).toEqual({});
  });

  it("is off without the predicate (older callers) or without the home underneath", () => {
    expect(isChatOverMobileHome({ routes: [homeRoute, groupRoute] }, "group-1", HOME)).toBe(false);
    expect(isChatOverMobileHome({ routes: [groupRoute] }, "group-1", HOME, isGroup)).toBe(false);
    expect(
      isChatOverMobileHome({ routes: [homeRoute, groupRoute] }, "group-1", null, isGroup),
    ).toBe(false);
  });

  it("tells when the group on show has the home underneath (edge touches go to the back swipe)", () => {
    expect(
      isFocusedChatOverMobileHome(rootWithHostStack([homeRoute, groupRoute]), HOME, isGroup),
    ).toBe(true);
    expect(isFocusedChatOverMobileHome(rootWithHostStack([homeRoute, groupRoute]), HOME)).toBe(
      false,
    );
  });
});

describe("leavesTouchToNativeBack", () => {
  it("leaves left-edge touches to the iOS back swipe when the home is underneath", () => {
    expect(leavesTouchToNativeBack(4, true)).toBe(true);
    expect(leavesTouchToNativeBack(NATIVE_BACK_EDGE_WIDTH, true)).toBe(true);
  });

  it("keeps mid-screen touches for the panel pan", () => {
    expect(leavesTouchToNativeBack(NATIVE_BACK_EDGE_WIDTH + 1, true)).toBe(false);
  });

  it("keeps edge touches when nothing is underneath to swipe back to", () => {
    expect(leavesTouchToNativeBack(4, false)).toBe(false);
  });
});
