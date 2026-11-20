import { memo, useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineFile } from "@getpaseo/protocol/agent-types";
import { AttachmentFrame, AttachmentLabel } from "@/components/attachment-pill";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { getFileTypeLabel } from "@/attachments/file-types";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useDownloadStore } from "@/stores/download-store";
import { formatFileSize, middleTruncateFileName, sentFileKey } from "./sent-files";

/** Download store scope for files sent in chats (the toast does not group by it). */
const CHAT_FILES_SCOPE = "chat-files";

/**
 * Reads a sent file back from the host over the session socket (the file read RPC, encrypted
 * when the connection is), then the download store hands it on: the share sheet on iOS and
 * Android (Save to Files, Quick Look, other apps), a normal browser download on web.
 */
export function useSentFileDownload(input: {
  serverId: string | undefined;
  client: DaemonClient | null | undefined;
}): ((file: AgentTimelineFile) => void) | null {
  const { serverId, client } = input;
  const startDownload = useDownloadStore((state) => state.startDownload);
  const download = useCallback(
    (file: AgentTimelineFile) => {
      if (!serverId || !client) return;
      void startDownload({
        serverId,
        scopeId: CHAT_FILES_SCOPE,
        fileName: file.fileName,
        path: file.path,
        // No profile: the store's socket route, never the plain-HTTP token route.
        daemonProfile: undefined,
        requestFileDownloadToken: async () => ({
          token: null,
          fileName: null,
          mimeType: null,
          error: "Sent files are read over the host connection.",
        }),
        readFileOverSocket: async (path, onProgress) => {
          const target = resolveFilePreviewReadTarget({ path });
          if (!target) throw new Error("File unavailable.");
          const read = await client.readFile(target.cwd, target.path, undefined, undefined, {
            onProgress,
          });
          return { bytes: read.bytes, mime: file.mimeType || read.mime };
        },
      });
    },
    [client, serverId, startDownload],
  );
  return serverId && client ? download : null;
}

export function sentFileSubtitle(file: AgentTimelineFile): string {
  const type = getFileTypeLabel(file.fileName);
  const size = formatFileSize(file.size);
  return type ? `${type} · ${size}` : size;
}

const SentFileChip = memo(function SentFileChip({
  file,
  onDownload,
}: {
  file: AgentTimelineFile;
  onDownload: ((file: AgentTimelineFile) => void) | null;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onDownload?.(file), [file, onDownload]);
  const icon = useMemo(
    () => <MaterialFileIcon fileName={file.fileName} size={18} />,
    [file.fileName],
  );
  return (
    <AttachmentFrame
      testID="sent-file-chip"
      onPress={onDownload ? handlePress : undefined}
      accessibilityLabel={t("message.attachments.downloadFile", { fileName: file.fileName })}
    >
      <AttachmentLabel
        icon={icon}
        title={middleTruncateFileName(file.fileName)}
        subtitle={sentFileSubtitle(file)}
      />
    </AttachmentFrame>
  );
});

/** The files a user message carried: one chip each (icon, name, size); tap downloads it again. */
export function SentFileChips({
  files,
  serverId,
  client,
}: {
  files: AgentTimelineFile[];
  serverId?: string;
  client?: DaemonClient | null;
}) {
  const onDownload = useSentFileDownload({ serverId, client });
  if (files.length === 0) return null;
  return (
    <View style={styles.row} testID="user-message-files">
      {files.map((file, index) => (
        <SentFileChip key={sentFileKey(file, index)} file={file} onDownload={onDownload} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
