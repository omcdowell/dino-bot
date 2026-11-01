/**
 * Phone home: a plugin screen registered with `mobileHome: true` becomes the start screen on phones
 * and replaces the main menu (the menu button turns into Back to it). Pure logic; the React side is
 * in `mobile-home-runtime.tsx`.
 */
import { z } from "zod";
import { buildPluginSurfaceRoute, parsePluginSurfaceRoute } from "./routes";

export interface MobileHome {
  serverId: string;
  pluginId: string;
  screenId: string;
}

interface HomeCandidate {
  serverId: string;
  id: string;
  surfaces: ReadonlyArray<{ id: string; mobileHome?: boolean }>;
}

/** The first `mobileHome` screen, preferring the given host (the last workspace's), then registry order. */
export function resolveMobileHome(
  plugins: readonly HomeCandidate[],
  preferredServerId: string | null,
): MobileHome | null {
  const homes = plugins.flatMap((plugin) =>
    plugin.surfaces
      .filter((surface) => surface.mobileHome === true)
      .map((surface) => ({ serverId: plugin.serverId, pluginId: plugin.id, screenId: surface.id })),
  );
  return homes.find((home) => home.serverId === preferredServerId) ?? homes[0] ?? null;
}

export function buildMobileHomeRoute(home: MobileHome): string {
  return buildPluginSurfaceRoute(home.serverId, home.pluginId, {
    kind: "surface",
    id: home.screenId,
  });
}

/** Whether `pathname` shows the home screen itself. */
export function isMobileHomePathname(pathname: string, home: MobileHome | null): boolean {
  if (!home) return false;
  const route = parsePluginSurfaceRoute(pathname);
  return (
    route?.serverId === home.serverId &&
    route.pluginId === home.pluginId &&
    route.identity.kind === "surface" &&
    route.identity.id === home.screenId
  );
}

export function sameMobileHome(left: MobileHome | null, right: MobileHome | null): boolean {
  return (
    left?.serverId === right?.serverId &&
    left?.pluginId === right?.pluginId &&
    left?.screenId === right?.screenId
  );
}

/**
 * What to persist after a registry change. The live home wins. With none, a recorded home is
 * dropped only once its host's catalog has loaded without it; until then (host offline, catalog
 * still loading) it stays, so the next start still opens on it.
 */
export function nextMobileHomeRecord(input: {
  recorded: MobileHome | null;
  live: MobileHome | null;
  hasCatalog: (serverId: string) => boolean;
}): MobileHome | null {
  if (input.live) return input.live;
  if (input.recorded && input.hasCatalog(input.recorded.serverId)) return null;
  return input.recorded;
}

const MobileHomeSchema: z.ZodType<MobileHome> = z.strictObject({
  serverId: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  screenId: z.string().trim().min(1),
});

export const MOBILE_HOME_STORAGE_KEY = "paseo:mobile-home";

export interface MobileHomeStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export function parseStoredMobileHome(stored: string | null): MobileHome | null {
  if (!stored) return null;
  try {
    const result = MobileHomeSchema.safeParse(JSON.parse(stored));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The persisted home record: hydrated once at start, written when the registry says otherwise. */
export function createMobileHomeRecordStore(storage: MobileHomeStorage) {
  let record: MobileHome | null = null;
  let hydrated = false;
  let hydration: Promise<void> | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  function set(next: MobileHome | null) {
    if (sameMobileHome(record, next)) return;
    record = next;
    revision += 1;
    notify();
    const write = next ? storage.write(JSON.stringify(next)) : storage.clear();
    void write.catch(() => {});
  }

  function hydrate(): Promise<void> {
    if (hydration) return hydration;
    const startRevision = revision;
    hydration = storage
      .read()
      .then((stored) => {
        if (revision === startRevision) record = parseStoredMobileHome(stored);
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        hydrated = true;
        notify();
      });
    return hydration;
  }

  return {
    get: () => record,
    isHydrated: () => hydrated,
    hydrate,
    set,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
