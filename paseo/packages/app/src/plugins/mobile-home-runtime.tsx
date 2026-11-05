import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, usePathname, useRootNavigationState, type Href } from "expo-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  buildMobileHomeRoute,
  createMobileHomeRecordStore,
  isMobileHomePathname,
  MOBILE_HOME_STORAGE_KEY,
  nextMobileHomeRecord,
  resolveMobileHome,
  type MobileHome,
} from "./mobile-home";
import { pluginRegistry, useInstalledPlugins } from "./registry";
import {
  isFocusedChatOverMobileHome,
  type IsPluginChatScreen,
} from "@/navigation/mobile-home-stack";
import { pluginScreenOpensLikeChat } from "./surface-contribution";
import { setWorkspaceNavigationMobileHome } from "@/navigation/workspace-route-navigation";
import { isPublicDesktopApp } from "@/desktop/public-desktop";

const recordStore = createMobileHomeRecordStore({
  read: () => AsyncStorage.getItem(MOBILE_HOME_STORAGE_KEY),
  write: (value) => AsyncStorage.setItem(MOBILE_HOME_STORAGE_KEY, value),
  clear: () => AsyncStorage.removeItem(MOBILE_HOME_STORAGE_KEY),
});
if (isNative || isPublicDesktopApp()) void recordStore.hydrate();

/** Phones only: compact layout in the native app. */
export function useMobileHomeEnabled(): boolean {
  return useIsCompactFormFactor() && isNative;
}

/**
 * Where the app starts: the phone home on phones, and the same Bots home in the DinoBot desktop app
 * (public flavour in Electron, wide window). Only the start and host-index redirects use this; the
 * phone-only parts (top bar, Back to home, gestures) still follow useMobileHome.
 */
export function useStartHomeEnabled(): boolean {
  const phone = useMobileHomeEnabled();
  const compact = useIsCompactFormFactor();
  return phone || (!compact && isPublicDesktopApp());
}

function useLiveMobileHome(): MobileHome | null {
  const plugins = useInstalledPlugins();
  const preferred = useLastWorkspaceSelection()?.serverId ?? null;
  return useMemo(() => resolveMobileHome(plugins, preferred), [plugins, preferred]);
}

/** Persisted record: lets the start redirect go to the home before plugins have loaded. */
export function useMobileHomeRecord(): { record: MobileHome | null; hydrated: boolean } {
  const record = useSyncExternalStore(recordStore.subscribe, recordStore.get, recordStore.get);
  const hydrated = useSyncExternalStore(
    recordStore.subscribe,
    recordStore.isHydrated,
    recordStore.isHydrated,
  );
  return { record, hydrated };
}

/** The phone home (live registry first, else the record); null off phones or when none exists. */
export function useMobileHome(): MobileHome | null {
  const enabled = useMobileHomeEnabled();
  const live = useLiveMobileHome();
  const { record } = useMobileHomeRecord();
  if (!enabled) return null;
  return live ?? record;
}

/** The start home (see useStartHomeEnabled): live registry first, else the record. */
export function useStartHome(): MobileHome | null {
  const enabled = useStartHomeEnabled();
  const live = useLiveMobileHome();
  const { record } = useMobileHomeRecord();
  if (!enabled) return null;
  return live ?? record;
}

/** Start-route input: the start home's route, with whether the record has been read yet. */
export function useMobileHomeStartRoute(): { route: string | null; ready: boolean } {
  const enabled = useStartHomeEnabled();
  const home = useStartHome();
  const { hydrated } = useMobileHomeRecord();
  if (!enabled) return { route: null, ready: true };
  return { route: home ? buildMobileHomeRoute(home) : null, ready: hydrated };
}

export function useIsOnMobileHome(): boolean {
  const home = useMobileHome();
  const pathname = usePathname();
  return isMobileHomePathname(pathname, home);
}

/**
 * Whether an installed plugin screen opens like a chat (`mobileFloatingHeader`). Reads the registry
 * when asked, so navigator options see the plugins installed by the time a screen is pushed.
 */
export const isInstalledPluginChatScreen: IsPluginChatScreen = (screen) =>
  pluginScreenOpensLikeChat(pluginRegistry.getSnapshot(), screen);

/** A chat (or a plugin screen that opens like one) is on show with the home directly underneath. */
export function useIsChatOverMobileHome(): boolean {
  const home = useMobileHome();
  const rootState = useRootNavigationState();
  return isFocusedChatOverMobileHome(rootState, home, isInstalledPluginChatScreen);
}

/** Back to the home: pops to it when it is in the stack, else replaces the current screen. */
export function goToMobileHome(home: MobileHome): void {
  router.dismissTo(buildMobileHomeRoute(home) as Href);
}

/** Keeps the persisted record in step with the plugin registry. Mount once, at the root. */
export function MobileHomeSync() {
  const enabled = useStartHomeEnabled();
  const live = useLiveMobileHome();
  const { hydrated } = useMobileHomeRecord();
  const plugins = useInstalledPlugins();
  const home = useMobileHome();
  useEffect(() => {
    setWorkspaceNavigationMobileHome(home);
  }, [home]);
  useEffect(() => {
    if (!enabled || !hydrated) return;
    recordStore.set(
      nextMobileHomeRecord({
        recorded: recordStore.get(),
        live,
        hasCatalog: pluginRegistry.hasCatalog,
      }),
    );
  }, [enabled, hydrated, live, plugins]);
  return null;
}

/** Drops the record (the home's plugin went away) so the next start falls back to the workspace. */
export function forgetMobileHome(): void {
  recordStore.set(null);
}
