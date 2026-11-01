import { useEffect } from "react";
import { router, useRootNavigationState, type Href } from "expo-router";
import { APP_LINK_SCHEME } from "@/constants/flavour";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { desktopAppLinkRoute } from "./app-link-route";

let attempts = 0;

/**
 * Desktop (public flavour): `dinobot://pair/#offer=…` and `dinobot://provider/add?…` opened from a
 * browser, the Terminal (`open`/`xdg-open`) or another app land on /pair or /provider-link, as on
 * the phone. The main process keeps the link; this takes it once navigation is ready and on every
 * "open-app-link" event.
 */
export function AppLinkNavigationListener() {
  const navigationReady = Boolean(useRootNavigationState()?.key);

  const openWaitingLink = useStableEvent(async () => {
    const take = getDesktopHost()?.appLinks?.take;
    if (typeof take !== "function") return;
    const link = await take();
    if (!link) return;
    attempts += 1;
    const route = desktopAppLinkRoute(
      link,
      APP_LINK_SCHEME,
      `${Date.now().toString(36)}-d${attempts}`,
    );
    if (route) router.push(route as Href);
  });

  useEffect(() => {
    if (!navigationReady) return undefined;
    if (typeof getDesktopHost()?.appLinks?.take !== "function") return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenToDesktopEvent("open-app-link", () => void openWaitingLink())
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
        return undefined;
      })
      .catch(() => undefined);
    void openWaitingLink();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigationReady, openWaitingLink]);

  return null;
}
