import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { ProviderModelScope } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { optimisticModelScope, usableModelScope } from "@/provider-selection/model-scope";

export function modelScopeQueryKey(serverId: string | null, provider: string | null) {
  return ["model-scope", serverId ?? "", provider ?? ""] as const;
}

export interface ModelScopeState {
  /** Null when the host or provider has no scope: the picker then shows one list, as before. */
  scope: ProviderModelScope | null;
  /** Adds a model to Scoped or removes it (Pi's settings.json, through the host). */
  setScoped: (modelId: string, scoped: boolean) => Promise<void>;
}

/** The Scoped list (Pi's `enabledModels`) for a Pi-based provider on a host. */
export function useModelScope(input: {
  serverId: string | null;
  provider: string | null;
  enabled?: boolean;
}): ModelScopeState {
  const { serverId, provider, enabled = true } = input;
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();
  const supported = Boolean(serverId && provider && client?.supportsModelScope());
  const key = modelScopeQueryKey(serverId, provider);
  const query = useFetchQuery({
    queryKey: key,
    queryFn: async () => (client && provider ? await client.getProviderModelScope(provider) : null),
    enabled: enabled && supported && isConnected,
    dataShape: "value",
    // The Pi TUI can edit the same file, so a reopened picker reads it again.
    staleTimeMs: 5_000,
    retry: false,
  });

  const setScoped = useCallback(
    async (modelId: string, scoped: boolean) => {
      if (!client || !provider) return;
      const previous = queryClient.getQueryData<ProviderModelScope | null>(key);
      if (previous) queryClient.setQueryData(key, optimisticModelScope(previous, modelId, scoped));
      try {
        const next = await client.setProviderModelScope(provider, modelId, scoped);
        queryClient.setQueryData(key, next);
      } catch (error) {
        queryClient.setQueryData(key, previous ?? null);
        throw error;
      }
    },
    // key is derived from serverId/provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, provider, queryClient, serverId],
  );

  return { scope: usableModelScope(query.data), setScoped };
}
