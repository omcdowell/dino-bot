import { NetworkStatusPage } from "@/screens/network-status/network-status-page";

/** The Network page inside the Explorer sidebar; the host being viewed is listed first. */
export function ExplorerNetworkTab({ serverId }: { serverId: string | null }) {
  return <NetworkStatusPage focusServerId={serverId} />;
}
