import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { UserMessage } from "@/components/message";
import { Button } from "@/components/ui/button";
import { getOutboxSender } from "@/composer/outbox/sender";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import {
  getOutboxRecord,
  removeOutboxRecord,
  settleOutboxRecordsSeenInStream,
  useOutboxStore,
  type OutboxRecord,
} from "@/stores/outbox-store";
import {
  buildPinnedMessages,
  matchTakenRecordsByText,
  type DaemonQueueItem,
  type PinnedMessage,
  type StreamUserRow,
} from "./pinned-model";

/**
 * Messages the agent has not taken yet, drawn as normal user bubbles pinned after the stream
 * (above the composer), each with its tick. Bot output that arrives meanwhile goes into the
 * stream above them. When the canonical row for a message reaches the stream, the bubble leaves
 * this list in the same render, so it never shows twice or not at all.
 */

export function collectStreamClientMessageIds(
  session: SessionState | undefined,
  agentId: string,
  wanted: readonly string[],
  records: readonly OutboxRecord[] = [],
): string {
  if (!session || wanted.length === 0) return "";
  const want = new Set(wanted);
  const found = new Set<string>();
  const needTextMatch = records.some((record) => record.state === "taken");
  const rows: StreamUserRow[] = [];
  // Tail is the committed history, head the live turn after it: rows end up oldest first.
  for (const items of [
    session.agentStreamTail.get(agentId),
    session.agentStreamHead.get(agentId),
  ]) {
    if (!items) continue;
    for (const item of items) {
      if (item.kind !== "user_message") continue;
      if (item.clientMessageId && want.has(item.clientMessageId)) found.add(item.clientMessageId);
      if (needTextMatch) {
        rows.push({
          clientMessageId: item.clientMessageId,
          text: item.text,
          timestamp: item.timestamp instanceof Date ? item.timestamp.getTime() : Number.NaN,
        });
      }
    }
  }
  if (needTextMatch) {
    for (const id of matchTakenRecordsByText(records, rows, found)) found.add(id);
  }
  return [...found].sort().join("\n");
}

const EMPTY_QUEUE: DaemonQueueItem[] = [];

export const PinnedMessages = memo(function PinnedMessages({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const records = useOutboxStore(
    useShallow((state) =>
      state.records.filter((record) => record.serverId === serverId && record.agentId === agentId),
    ),
  );
  const daemonQueue = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.messageQueue?.items ?? EMPTY_QUEUE,
  );
  const wantedIds = useMemo(
    () => [
      ...records.map((record) => record.clientMessageId),
      ...daemonQueue.map((item) => item.messageId),
    ],
    [daemonQueue, records],
  );
  const inStreamKey = useSessionStore((state) =>
    collectStreamClientMessageIds(state.sessions[serverId], agentId, wantedIds, records),
  );
  const inStream = useMemo(
    () => new Set(inStreamKey ? inStreamKey.split("\n") : []),
    [inStreamKey],
  );

  useEffect(() => {
    if (inStream.size > 0) settleOutboxRecordsSeenInStream(inStream);
  }, [inStream]);

  const pinned = useMemo(
    () => buildPinnedMessages({ records, daemonQueue, inStream }),
    [daemonQueue, inStream, records],
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = useCallback(
    (key: string) => setOpenKey((current) => (current === key ? null : key)),
    [],
  );
  const openActions = useCallback((key: string) => setOpenKey(key), []);

  if (pinned.length === 0) return null;
  return (
    <View style={styles.container} testID="pinned-messages">
      {pinned.map((message, index) => (
        <PinnedBubble
          key={message.key}
          serverId={serverId}
          agentId={agentId}
          message={message}
          isFirst={index === 0}
          isLast={index === pinned.length - 1}
          open={openKey === message.key}
          onToggle={toggle}
          onOpen={openActions}
        />
      ))}
    </View>
  );
});

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The last action button: delete while not taken; hide a taken local message; none otherwise. */
function pinnedEndAction(message: { state: string; remote?: unknown }): "delete" | "hide" | null {
  if (message.state !== "taken") return "delete";
  return message.remote ? null : "hide";
}

const PinnedBubble = memo(function PinnedBubble({
  serverId,
  agentId,
  message,
  isFirst,
  isLast,
  open,
  onToggle,
  onOpen,
}: {
  serverId: string;
  agentId: string;
  message: PinnedMessage;
  isFirst: boolean;
  isLast: boolean;
  open: boolean;
  onToggle: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const canCancel = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentMessageQueue === true,
  );
  const meta = resolvePinnedMeta(message, isConnected, t);
  const messageKey = message.key;
  const handleToggle = useCallback(() => onToggle(messageKey), [messageKey, onToggle]);
  // Long-press / right-click open the same actions; opening (not toggling) is safe when one
  // hold fires both the long-press timer and the browser's contextmenu event.
  const handleOpen = useCallback(() => onOpen(messageKey), [messageKey, onOpen]);

  const run = useCallback(
    (action: () => Promise<void> | undefined, errorKey: string) => {
      onToggle(messageKey);
      void Promise.resolve(action()).catch((error: unknown) => {
        toast.error(t(errorKey, { error: error instanceof Error ? error.message : String(error) }));
      });
    },
    [messageKey, onToggle, t, toast],
  );
  const sender = getOutboxSender();
  const id = message.clientMessageId;
  const handleForce = useCallback(
    () => run(() => sender?.force(serverId, agentId, id), "delivery.actions.failedToForce"),
    [agentId, id, run, sender, serverId],
  );
  const handleDelete = useCallback(
    () =>
      run(
        () => (message.remote ? sender?.cancelRemote(serverId, agentId, id) : sender?.delete(id)),
        "delivery.actions.failedToDelete",
      ),
    [agentId, id, message.remote, run, sender, serverId],
  );
  const handleEdit = useCallback(
    () => run(() => sender?.edit(id), "delivery.actions.failedToEdit"),
    [id, run, sender],
  );
  // A taken message is the agent's already; hiding the bubble only clears this device's copy.
  const handleHideTaken = useCallback(
    () =>
      run(
        () => (getOutboxRecord(id)?.state === "taken" ? removeOutboxRecord(id) : undefined),
        "delivery.actions.failedToDelete",
      ),
    [id, run],
  );
  const handleResend = useCallback(
    () => run(() => sender?.resend(id), "delivery.actions.failedToForce"),
    [id, run, sender],
  );

  const halfSent = message.record ? message.record.everOnWire : true;
  const deleteLabel =
    !canCancel && halfSent && message.state !== "failed"
      ? t("delivery.actions.hide")
      : t("delivery.actions.delete");
  const canEdit = !message.remote && message.state !== "unknown" && message.state !== "taken";
  const canForce =
    canCancel &&
    (message.state === "queued" ||
      (message.record?.state === "outbox" &&
        !message.record.everOnWire &&
        message.record.activeTurnBehavior === "queue"));

  return (
    <View>
      <UserMessage
        message={message.text}
        images={message.record?.images}
        timestamp={message.createdAt}
        isFirstInGroup={isFirst}
        isLastInGroup={isLast}
        isPending
        deliveryState={message.state}
        deliveryMeta={meta}
        // Taken bubbles open too: Hide is their way out if the canonical row never matches.
        onPressBubble={handleToggle}
        onLongPressBubble={handleOpen}
      />
      {open ? (
        <View style={styles.actions} testID="pinned-message-actions">
          {canForce ? (
            <Button size="sm" variant="secondary" onPress={handleForce}>
              {t("delivery.actions.force")}
            </Button>
          ) : null}
          {message.state === "failed" ? (
            <Button size="sm" variant="secondary" onPress={handleResend}>
              {t("delivery.actions.retry")}
            </Button>
          ) : null}
          {message.state === "unknown" ? (
            <Button size="sm" variant="secondary" onPress={handleResend}>
              {t("delivery.actions.sendAgain")}
            </Button>
          ) : null}
          {canEdit ? (
            <Button size="sm" variant="ghost" onPress={handleEdit}>
              {t("delivery.actions.edit")}
            </Button>
          ) : null}
          {pinnedEndAction(message) === "delete" ? (
            <Button size="sm" variant="ghost" onPress={handleDelete}>
              {deleteLabel}
            </Button>
          ) : null}
          {pinnedEndAction(message) === "hide" ? (
            <Button size="sm" variant="ghost" onPress={handleHideTaken}>
              {t("delivery.actions.hide")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

function resolvePinnedMeta(
  message: PinnedMessage,
  isConnected: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const time = formatClock(message.createdAt);
  if (message.remote) return `${t("delivery.note.queuedOtherDevice")} · ${time}`;
  const record = message.record;
  if (record?.deletedTooLate) return t("delivery.note.deletedTooLate");
  if (message.state === "clock" && !isConnected) {
    return `${t("delivery.note.waitingOffline")} · ${time}`;
  }
  if (message.state === "failed" && record?.lastError) return record.lastError;
  return time;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: -theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
}));

/** Whether the agent may have pinned bubbles (cheap; the list itself filters precisely). */
export function useHasPinnedMessages(serverId: string, agentId: string): boolean {
  const hasRecords = useOutboxStore((state) =>
    state.records.some(
      (record) =>
        record.serverId === serverId && record.agentId === agentId && record.state !== "cancelling",
    ),
  );
  const hasQueue = useSessionStore(
    (state) => (state.sessions[serverId]?.agents.get(agentId)?.messageQueue?.items.length ?? 0) > 0,
  );
  return hasRecords || hasQueue;
}
