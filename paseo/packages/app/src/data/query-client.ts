import AsyncStorage from "@react-native-async-storage/async-storage";
import { PersistedQueryClient } from "@/plugins/plugin-cache";
import { createPersistedQueries } from "./persisted-queries";

/**
 * The app's query client. Queries marked `meta: { persist: true }` are kept on the device (see
 * persisted-queries.ts), so they are never garbage-collected; all others keep TanStack's default.
 */
export const queryClient = new PersistedQueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    },
  },
});

export const persistedQueries = createPersistedQueries(AsyncStorage);

let started = false;

/** Restores the device-cached queries and keeps them written. Once, at app start. */
export function startPersistedQueries(): void {
  if (started) return;
  started = true;
  persistedQueries.track(queryClient);
  void persistedQueries.restore(queryClient);
}
