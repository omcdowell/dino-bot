import { getElectronHost } from "@/desktop/electron/host";

const MB = 1024 * 1024;
/** Share of the device cache kept for photos this device sent (chat-images/sent-images). */
const SENT_CHAT_IMAGES_SHARE = 0.2;

/**
 * On-device cache budget for the web build. The Electron desktop app gets the phone's half
 * gigabyte (2026-10-10: "The laptop cache should match at 500mb"); its IndexedDB store keeps
 * a payload-free index, so cold start does not read the cache. A plain browser tab stays at 64 MB:
 * its storage quota is the browser's call and is shared with every other site.
 */
export function getDeviceCacheMaxBytes(): number {
  return getElectronHost() ? 500 * MB : 64 * MB;
}

/** The chat rows' part of the device cache. */
export function getReplicaCacheMaxBytes(): number {
  return getDeviceCacheMaxBytes() - getSentChatImagesMaxBytes();
}

/** The local copies of sent photos' part of the device cache. */
export function getSentChatImagesMaxBytes(): number {
  return Math.round(getDeviceCacheMaxBytes() * SENT_CHAT_IMAGES_SHARE);
}
