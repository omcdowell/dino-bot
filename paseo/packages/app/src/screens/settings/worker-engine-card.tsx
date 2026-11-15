import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  WORKER_ENGINE_HINT,
  WORKER_ENGINE_OPTIONS,
  WORKER_ENGINE_RPC,
  WORKER_ENGINE_TITLE,
  getWorkerEngineCardState,
  parseWorkerEngineAnswer,
  type WorkerEngineAnswer,
  type WorkerEngineChoice,
} from "./worker-engine-config";

/**
 * Host > Agents: "Workers", the global default engine for the bots' herdr workers (Automatic / Claude Code / pi).
 * Per-bot defaults are not set here ("ask your bot"). Hidden when the host's bots plugin does not answer
 * workers.settings (no plugin, or an older one). See worker-engine-config.ts.
 */
export function WorkerEngineCard({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = ["worker-engine", serverId];
  const query = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 30_000,
    enabled: isConnected && client !== null,
    retry: false,
    queryFn: async (): Promise<WorkerEngineAnswer | null> => {
      if (!client) return null;
      try {
        return parseWorkerEngineAnswer(
          await client.invokePluginRpc(WORKER_ENGINE_RPC.pluginId, WORKER_ENGINE_RPC.get, {}),
        );
      } catch {
        return null;
      }
    },
  });
  const mutation = useMutation({
    mutationFn: async (engine: WorkerEngineChoice) => {
      if (!client) throw new Error("Not connected to this host.");
      const answer = parseWorkerEngineAnswer(
        await client.invokePluginRpc(WORKER_ENGINE_RPC.pluginId, WORKER_ENGINE_RPC.set, { engine }),
      );
      if (!answer) throw new Error("The host did not save the setting.");
      return answer;
    },
    onSuccess: (answer) => queryClient.setQueryData(queryKey, answer),
  });
  const state = getWorkerEngineCardState({
    isConnected,
    answer: mutation.data ?? query.data ?? null,
    isPending: mutation.isPending,
    error: mutation.error,
  });
  const handleValueChange = useCallback(
    (next: WorkerEngineChoice) => {
      if (!state.isDisabled) mutation.mutate(next);
    },
    [mutation, state.isDisabled],
  );

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-worker-engine-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{WORKER_ENGINE_TITLE}</Text>
          <Text style={settingsStyles.rowHint}>{WORKER_ENGINE_HINT}</Text>
          {state.statusText ? (
            <Text style={settingsStyles.rowHint} testID="host-page-worker-engine-status">
              {state.statusText}
            </Text>
          ) : null}
          {state.loadingText ? (
            <Text style={settingsStyles.rowHint}>{state.loadingText}</Text>
          ) : null}
          {state.errorText ? (
            <Text style={settingsStyles.rowError} testID="host-page-worker-engine-error">
              {state.errorText}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <SegmentedControl
          options={WORKER_ENGINE_OPTIONS}
          value={state.value}
          onValueChange={handleValueChange}
          size="sm"
          testID="host-page-worker-engine-choice"
        />
      </View>
    </View>
  );
}
