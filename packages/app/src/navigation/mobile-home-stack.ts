/**
 * Phone home <-> chat as a native push (pure logic, no React).
 *
 * On phones with a plugin home, a chat opened from the home is pushed on top of it in the host
 * stack, so it slides in from the right, the home stays mounted underneath, and iOS's interactive
 * edge swipe pops back to it. These helpers read React Navigation state to tell when that applies.
 */
import type { MobileHome } from "@/plugins/mobile-home";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

export const HOST_ROUTE_NAME = "h/[serverId]";
export const HOST_WORKSPACE_ROUTE_NAME = "workspace/[workspaceId]/index";
export const HOST_PLUGIN_SURFACE_ROUTE_NAME =
  "plugin/[pluginId]/[contributionKind]/[contributionId]";

export interface NavRouteLike {
  key?: unknown;
  name?: unknown;
  params?: unknown;
  state?: unknown;
}

export interface NavStateLike {
  index?: unknown;
  routes?: unknown;
}

function routesOf(state: unknown): NavRouteLike[] {
  if (!state || typeof state !== "object") return [];
  const routes = (state as NavStateLike).routes;
  return Array.isArray(routes) ? (routes as NavRouteLike[]) : [];
}

function focusedIndex(state: unknown): number {
  const routes = routesOf(state);
  const index = (state as NavStateLike | null)?.index;
  if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < routes.length) {
    return index;
  }
  return routes.length - 1;
}

function param(route: NavRouteLike | undefined, name: string): string | null {
  const params = route?.params;
  if (!params || typeof params !== "object") return null;
  const value = (params as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

/** Whether a host-stack route is the phone home's plugin screen. */
export function isMobileHomeRoute(route: NavRouteLike | undefined, home: MobileHome): boolean {
  return (
    route?.name === HOST_PLUGIN_SURFACE_ROUTE_NAME &&
    param(route, "pluginId") === home.pluginId &&
    param(route, "contributionKind") === "surface" &&
    param(route, "contributionId") === home.screenId
  );
}

/** The focused host stack (the state under the focused `h/[serverId]` route) and its host. */
export function findFocusedHostStack(
  rootState: unknown,
): { serverId: string | null; state: unknown } | null {
  let state: unknown = rootState;
  for (let depth = 0; depth < 8; depth += 1) {
    const routes = routesOf(state);
    const route = routes[focusedIndex(state)];
    if (!route) return null;
    if (route.name === HOST_ROUTE_NAME) {
      return route.state ? { serverId: param(route, "serverId"), state: route.state } : null;
    }
    state = route.state;
  }
  return null;
}

/** The phone home is the screen on show (so a chat opened now should be pushed over it). */
export function isMobileHomeFocused(rootState: unknown, home: MobileHome): boolean {
  const host = findFocusedHostStack(rootState);
  if (!host || host.serverId !== home.serverId) return false;
  const routes = routesOf(host.state);
  return isMobileHomeRoute(routes[focusedIndex(host.state)], home);
}

/**
 * Whether opening `route` should push it over the home: the home is on show and the route is a
 * workspace (chat) on the home's host. Anything else keeps the existing replace/pop-to behaviour.
 */
export function shouldPushWorkspaceOverMobileHome(input: {
  rootState: unknown;
  route: string;
  home: MobileHome | null;
}): boolean {
  if (!input.home) return false;
  const target = parseHostWorkspaceRouteFromPathname(input.route);
  if (!target || target.serverId !== input.home.serverId) return false;
  return isMobileHomeFocused(input.rootState, input.home);
}

/**
 * Whether a plugin screen opens like a chat: it registered `mobileFloatingHeader` (e.g. the bots
 * plugin's group thread), so on top of the home it gets the same push and swipe back as a chat.
 */
export type IsPluginChatScreen = (screen: {
  serverId: string;
  pluginId: string;
  screenId: string;
}) => boolean;

/** A chat: a workspace, or a plugin screen that opens like one (never the home itself). */
function isChatRoute(
  route: NavRouteLike | undefined,
  home: MobileHome,
  isPluginChatScreen: IsPluginChatScreen | undefined,
): boolean {
  if (route?.name === HOST_WORKSPACE_ROUTE_NAME) return true;
  if (!isPluginChatScreen || route?.name !== HOST_PLUGIN_SURFACE_ROUTE_NAME) return false;
  if (isMobileHomeRoute(route, home) || param(route, "contributionKind") !== "surface") {
    return false;
  }
  const pluginId = param(route, "pluginId");
  const screenId = param(route, "contributionId");
  return (
    !!pluginId && !!screenId && isPluginChatScreen({ serverId: home.serverId, pluginId, screenId })
  );
}

/** Whether the host-stack route `routeKey` is a chat sitting directly on top of the home. */
export function isChatOverMobileHome(
  stackState: unknown,
  routeKey: string,
  home: MobileHome | null,
  isPluginChatScreen?: IsPluginChatScreen,
): boolean {
  if (!home) return false;
  const routes = routesOf(stackState);
  const index = routes.findIndex((route) => route.key === routeKey);
  if (index < 1) return false;
  return (
    isChatRoute(routes[index], home, isPluginChatScreen) &&
    isMobileHomeRoute(routes[index - 1], home)
  );
}

/** Whether the screen on show is a chat with the home directly underneath it. */
export function isFocusedChatOverMobileHome(
  rootState: unknown,
  home: MobileHome | null,
  isPluginChatScreen?: IsPluginChatScreen,
): boolean {
  if (!home) return false;
  const host = findFocusedHostStack(rootState);
  if (!host || host.serverId !== home.serverId) return false;
  const routes = routesOf(host.state);
  const focused = routes[focusedIndex(host.state)];
  return (
    typeof focused?.key === "string" &&
    isChatOverMobileHome(host.state, focused.key, home, isPluginChatScreen)
  );
}

/**
 * Host-stack options for the chat screen. A chat on top of the home uses the native iOS push
 * (slide from the right, parallax, interactive edge swipe back); everything else stays as the
 * host stack's default (no animation), so laptops and other flows are unchanged.
 */
export const CHAT_OVER_HOME_SCREEN_OPTIONS = {
  animation: "default",
  gestureEnabled: true,
  fullScreenGestureEnabled: false,
} as const;

export function workspaceScreenOptions(input: {
  stackState: unknown;
  routeKey: string;
  home: MobileHome | null;
  isPluginChatScreen?: IsPluginChatScreen;
}): typeof CHAT_OVER_HOME_SCREEN_OPTIONS | Record<string, never> {
  return isChatOverMobileHome(
    input.stackState,
    input.routeKey,
    input.home,
    input.isPluginChatScreen,
  )
    ? CHAT_OVER_HOME_SCREEN_OPTIONS
    : {};
}

/**
 * Host-stack options for plugin screens: one that opens like a chat (see `IsPluginChatScreen`)
 * slides in over the home and swipes back like a chat; the home and other screens are unchanged.
 */
export const pluginScreenOptions = workspaceScreenOptions;

/**
 * Phones: with the home pushed underneath a chat, touches starting this close to the left edge
 * belong to iOS's interactive back swipe (it tracks the finger and can be cancelled), so the
 * panel pan must not claim them.
 */
export const NATIVE_BACK_EDGE_WIDTH = 32;

/** Whether the open-panel pan gives a touch at `touchStartX` to the native back swipe. */
export function leavesTouchToNativeBack(touchStartX: number, chatOverHome: boolean): boolean {
  "worklet";
  return chatOverHome && touchStartX <= NATIVE_BACK_EDGE_WIDTH;
}
