import { AppState } from "react-native";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { installOutboxSender, type OutboxSendClient } from "@/composer/outbox/sender";
import { hydrateOutbox } from "@/stores/outbox-store";
import { useSessionStore } from "@/stores/session-store";
import { encodeImages } from "@/utils/encode-images";

/**
 * Starts the outbox sender for the app: loads saved messages and sends them whenever a host is
 * online. Wakes on every host status change (the online edge resets the backoff), when the app
 * comes to the foreground, and when an agent's daemon queue changes.
 */
export function startOutboxRuntime(store: HostRuntimeStore): () => void {
  const sender = installOutboxSender({
    getClient: (serverId) => store.getClient(serverId) as OutboxSendClient | null,
    isOnline: (serverId) => store.getSnapshot(serverId)?.connectionStatus === "online",
    features: (serverId) => {
      const features = useSessionStore.getState().sessions[serverId]?.serverInfo?.features;
      return {
        messageReceivedAck: features?.messageReceivedAck === true,
        agentMessageQueue: features?.agentMessageQueue === true,
      };
    },
    daemonHolds: (serverId, agentId, messageId) =>
      useSessionStore
        .getState()
        .sessions[serverId]?.agents.get(agentId)
        ?.messageQueue?.items.some((item) => item.messageId === messageId) === true,
    encodeImages,
  });
  void hydrateOutbox().then(() => {
    sender.kick();
    return undefined;
  });

  const onlineByServer = new Map<string, boolean>();
  const unsubscribeHosts = store.subscribeAll(() => {
    for (const serverId of store.listServerIds()) {
      const online = store.getSnapshot(serverId)?.connectionStatus === "online";
      if (online && onlineByServer.get(serverId) !== true) sender.hostOnline(serverId);
      onlineByServer.set(serverId, online);
    }
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") sender.kick();
  });
  let lastAgents: unknown = null;
  const unsubscribeSessions = useSessionStore.subscribe((state) => {
    // Cheap identity check: agent maps are replaced when any agent snapshot changes.
    const agents = Object.values(state.sessions).map((session) => session.agents);
    if (lastAgents && sameArray(agents, lastAgents as unknown[])) return;
    lastAgents = agents;
    sender.kick();
  });
  return () => {
    unsubscribeHosts();
    appState.remove();
    unsubscribeSessions();
    sender.dispose();
  };
}

function sameArray(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
