import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  GROUP_CHAT_TOOLS_HINT,
  GROUP_CHAT_TOOLS_RPC,
  GROUP_CHAT_TOOLS_TITLE,
  getGroupChatToolsCardState,
  parseGroupChatToolsAnswer,
  type GroupChatToolsAnswer,
} from "./group-chat-tools-config";

/**
 * Host > Agents: "Group chats: full tools" (both flavours). Hidden when the host's bots plugin does not answer
 * rooms.settings (no plugin, or an older one). See group-chat-tools-config.ts.
 */
export function GroupChatToolsCard({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = ["group-chat-tools", serverId];
  const query = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 30_000,
    enabled: isConnected && client !== null,
    retry: false,
    queryFn: async (): Promise<GroupChatToolsAnswer | null> => {
      if (!client) return null;
      try {
        return parseGroupChatToolsAnswer(
          await client.invokePluginRpc(GROUP_CHAT_TOOLS_RPC.pluginId, GROUP_CHAT_TOOLS_RPC.get, {}),
        );
      } catch {
        return null;
      }
    },
  });
  const mutation = useMutation({
    mutationFn: async (fullTools: boolean) => {
      if (!client) throw new Error("Not connected to this host.");
      const answer = parseGroupChatToolsAnswer(
        await client.invokePluginRpc(GROUP_CHAT_TOOLS_RPC.pluginId, GROUP_CHAT_TOOLS_RPC.set, {
          fullTools,
        }),
      );
      if (!answer) throw new Error("The host did not save the setting.");
      return answer;
    },
    onSuccess: (answer) => queryClient.setQueryData(queryKey, answer),
  });
  const state = getGroupChatToolsCardState({
    isConnected,
    answer: mutation.data ?? query.data ?? null,
    isPending: mutation.isPending,
    error: mutation.error,
  });
  const handleValueChange = useCallback((next: boolean) => mutation.mutate(next), [mutation]);

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-group-chat-tools-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{GROUP_CHAT_TOOLS_TITLE}</Text>
          <Text style={settingsStyles.rowHint}>{GROUP_CHAT_TOOLS_HINT}</Text>
          {state.loadingText ? (
            <Text style={settingsStyles.rowHint}>{state.loadingText}</Text>
          ) : null}
          {state.errorText ? (
            <Text style={settingsStyles.rowError} testID="host-page-group-chat-tools-error">
              {state.errorText}
            </Text>
          ) : null}
        </View>
        <Switch
          value={state.isEnabled}
          onValueChange={handleValueChange}
          disabled={state.isSwitchDisabled}
          accessibilityLabel={GROUP_CHAT_TOOLS_TITLE}
          testID="host-page-group-chat-tools-switch"
        />
      </View>
    </View>
  );
}
