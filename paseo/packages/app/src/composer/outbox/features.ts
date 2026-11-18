import { useSessionStore } from "@/stores/session-store";

/**
 * The outbox needs the daemon to dedupe by message ID and report canonical rows
 * (canonicalSubmittedPrompts). Older daemons keep the old send-once path.
 *
 * Until the host has handshaken (app relaunched or resumed, host reconnecting: no client and no
 * serverInfo yet) the features are unknown. Then the message still goes to the outbox: it shows
 * at once as a pending (clock) bubble, is saved to disk, and the sender delivers it when the host
 * comes online. Only a daemon known to lack the feature takes the old path.
 */
export function supportsOutbox(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().sessions[serverId]?.serverInfo;
  if (!serverInfo) return true;
  return serverInfo.features?.canonicalSubmittedPrompts === true;
}

/** The daemon holds queued messages itself (grey double tick, force, cancel). */
export function supportsDaemonQueue(serverId: string): boolean {
  return (
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.agentMessageQueue === true
  );
}
