import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  PROVISIONAL_MAX_AGE_MS,
  clearProvisionalReply,
  decideProvisional,
  useProvisionalReply,
} from "./provisional-open";

/**
 * B2a: the tapped notification's reply text under the painted (cached) chat, dimmed and labelled
 * as updating, until the live page replaces it. Display only: not selectable as a message, not in
 * the timeline, never persisted or sent. Renders nothing once live data has arrived.
 */
export function ProvisionalReplyPreview({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string | undefined;
}) {
  const { t } = useTranslation();
  const reply = useProvisionalReply(serverId, agentId);
  const decision = useSessionStore((state) => {
    if (!reply || !agentId) return "drop" as const;
    const timeline = selectAgentTimelineState(state.sessions[serverId], agentId);
    return decideProvisional({
      reply,
      synchronized: timeline.status === "synced",
      items: "items" in timeline ? timeline.items : [],
      now: Date.now(),
    });
  });

  useEffect(() => {
    if (!reply || !agentId) return;
    if (decision === "drop") {
      clearProvisionalReply(serverId, agentId);
      return;
    }
    const left = Math.max(0, reply.openedAt + PROVISIONAL_MAX_AGE_MS - Date.now());
    const timer = setTimeout(() => clearProvisionalReply(serverId, agentId), left);
    return () => clearTimeout(timer);
  }, [reply, decision, serverId, agentId]);

  if (!reply || decision === "drop") return null;
  return (
    <View style={styles.wrap} accessibilityLabel={t("agentPanel.states.updating")}>
      <Text style={styles.label}>{t("agentPanel.states.updating")}</Text>
      <Text style={styles.text} selectable={false}>
        {reply.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    opacity: 0.7,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[1],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
