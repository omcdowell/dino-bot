import { useEffect, useMemo, useState } from "react";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { findConnectionFault, type ConnectionFault } from "@/screens/network-status/model";
import { useOutboxStore, type OutboxRecord } from "@/stores/outbox-store";

/** A fault must hold this long before the banner shows, so a quick reconnect stays silent. */
export const CONNECTION_FAULT_DEBOUNCE_MS = 2000;

export interface ConnectionFaultView extends ConnectionFault {
  /** Messages for this host not yet with the daemon (clock, or failed). */
  waiting: number;
}

export function countWaitingMessages(
  records: readonly OutboxRecord[],
  serverId: string | null,
): number {
  return records.filter(
    (record) =>
      (serverId === null || record.serverId === serverId) &&
      (record.state === "outbox" || record.state === "failed" || record.state === "unknown"),
  ).length;
}

function faultKey(fault: ConnectionFault | null): string | null {
  return fault ? `${fault.serverId ?? ""}:${fault.link}:${fault.reason}` : null;
}

export function useConnectionFault(serverId: string | null): ConnectionFaultView | null {
  const status = useNetworkStatus();
  const records = useOutboxStore((state) => state.records);
  const fault = useMemo(() => findConnectionFault(status, serverId), [serverId, status]);
  const key = faultKey(fault);
  // Set once a fault has held for the debounce; cleared when the fault clears. While it is set,
  // a change of reason (reconnecting -> timed out -> reconnecting) shows at once, so the banner
  // does not blink off between reconnect attempts.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (key === null) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), CONNECTION_FAULT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return useMemo(() => {
    if (!fault || !shown) return null;
    return { ...fault, waiting: countWaitingMessages(records, serverId) };
  }, [fault, records, serverId, shown]);
}
