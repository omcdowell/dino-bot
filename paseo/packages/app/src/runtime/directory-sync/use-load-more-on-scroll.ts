import { useCallback, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/** Distance from the end of the list (px) at which the next page starts loading. */
const LOAD_MORE_THRESHOLD = 600;

export function isNearListEnd(event: NativeScrollEvent, threshold = LOAD_MORE_THRESHOLD): boolean {
  const { contentOffset, contentSize, layoutMeasurement } = event;
  return contentOffset.y + layoutMeasurement.height >= contentSize.height - threshold;
}

/**
 * slimDirectory (B3): the sidebar only receives the priority first page; this loads
 * later pages per host when the list scrolls near its end.
 */
export function useLoadMoreDirectoryOnScroll(serverIds: readonly string[]) {
  const loading = useRef(new Set<string>());
  return useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isNearListEnd(event.nativeEvent)) return;
      const runtime = getHostRuntimeStore();
      for (const serverId of serverIds) {
        if (loading.current.has(serverId) || !runtime.hasMoreDirectory(serverId)) continue;
        loading.current.add(serverId);
        void runtime
          .loadMoreDirectory(serverId)
          .catch(() => undefined)
          .finally(() => loading.current.delete(serverId));
      }
    },
    [serverIds],
  );
}
