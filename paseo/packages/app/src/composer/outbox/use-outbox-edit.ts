import { useEffect, useRef } from "react";
import { useOutboxStore } from "@/stores/outbox-store";

/**
 * Calls `onEdit` when a pinned bubble's Edit has put text into this agent's composer draft
 * (composer/outbox/edit-handoff.ts), so the composer can show the draft and focus.
 *
 * Every composer mounted for the agent reacts; none consumes the request, so a second copy of
 * the chat mounted under the one on show cannot take it from the one the user sees. Requests
 * from before a composer mounted are skipped: they are already in the draft it loaded.
 */
export function useOutboxEditRequests(input: {
  serverId: string;
  agentId: string;
  onEdit: () => void;
}): void {
  const { serverId, agentId, onEdit } = input;
  const request = useOutboxStore((state) => state.editRequest);
  const appliedIdRef = useRef<number | null>(request?.id ?? null);
  useEffect(() => {
    if (!request || appliedIdRef.current === request.id) return;
    appliedIdRef.current = request.id;
    if (request.serverId !== serverId || request.agentId !== agentId) return;
    onEdit();
  }, [agentId, onEdit, request, serverId]);
}
