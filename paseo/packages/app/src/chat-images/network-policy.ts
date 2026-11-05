import { create } from "zustand";
import { useNetworkMonitorStore, type PhoneNetworkState } from "@/runtime/network-monitor";

/**
 * When chat images download by themselves ("only if we've got good internet"). On a good
 * link the display image loads as soon as the row shows; otherwise the tile stays a blurred
 * placeholder with a download button until tapped. Cached images always show at once.
 *
 * Not good: the host's link is in constrained mode (slow round trips, lost heartbeats, 2G/3G,
 * repeated drops; see runtime/link-quality), the OS says the network is expensive (Android
 * "metered", iOS cellular or hotspot), or the browser asks to save data.
 */

interface ChatImageLinkState {
  constrainedHosts: ReadonlySet<string>;
}

const useChatImageLinkStore = create<ChatImageLinkState>(() => ({
  constrainedHosts: new Set<string>(),
}));

/** Called by the session's link-quality loop. */
export function setChatImageHostConstrained(serverId: string, constrained: boolean): void {
  const current = useChatImageLinkStore.getState().constrainedHosts;
  if (current.has(serverId) === constrained) return;
  const next = new Set(current);
  if (constrained) next.add(serverId);
  else next.delete(serverId);
  useChatImageLinkStore.setState({ constrainedHosts: next });
}

export interface AutoDownloadInput {
  constrained: boolean;
  phone: Pick<PhoneNetworkState, "isExpensive" | "isConnected"> | null;
  saveData: boolean;
}

export function shouldAutoDownloadImages(input: AutoDownloadInput): boolean {
  if (input.constrained || input.saveData) return false;
  if (input.phone?.isConnected === false) return false;
  return input.phone?.isExpensive !== true;
}

function browserSaveData(): boolean {
  const connection = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)
    ?.connection;
  return connection?.saveData === true;
}

export function useChatImageAutoDownload(serverId: string | undefined): boolean {
  const constrained = useChatImageLinkStore((state) =>
    serverId ? state.constrainedHosts.has(serverId) : false,
  );
  const phone = useNetworkMonitorStore((state) => state.phone);
  return shouldAutoDownloadImages({ constrained, phone, saveData: browserSaveData() });
}
