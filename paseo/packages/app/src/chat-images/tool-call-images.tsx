import { memo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineImage } from "@getpaseo/protocol/agent-types";
import { ChatImage } from "./chat-image";

/** Images a tool returned (pi `read` on a PNG, MCP screenshots), under the tool row. */
export const ToolCallImages = memo(function ToolCallImages({
  images,
  serverId,
  client,
}: {
  images: AgentTimelineImage[];
  serverId?: string;
  client?: DaemonClient | null;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID="tool-call-images">
      {images.map((image) => (
        <ChatImage
          key={image.id}
          image={image}
          serverId={serverId}
          client={client}
          accessibilityLabel={t("composer.attachments.openImage")}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[6],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
}));
