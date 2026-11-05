import { useSessionStore } from "@/stores/session-store";

/**
 * The outbox needs the daemon to dedupe by message ID and report canonical rows
 * (canonicalSubmittedPrompts). Older daemons keep the old send-once path.
 */
export function supportsOutbox(serverId: string): boolean {
  return (
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.canonicalSubmittedPrompts === true
  );
}

/** The daemon holds queued messages itself (grey double tick, force, cancel). */
export function supportsDaemonQueue(serverId: string): boolean {
  return (
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.agentMessageQueue === true
  );
}
