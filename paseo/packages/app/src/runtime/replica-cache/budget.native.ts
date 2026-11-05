const MB = 1024 * 1024;
/** Share of the device cache kept for photos this device sent (chat-images/sent-images). */
const SENT_CHAT_IMAGES_SHARE = 0.2;

/** On-device cache budget on the phone: half a gigabyte (2026-10-10). */
export function getDeviceCacheMaxBytes(): number {
  return 500 * MB;
}

/** The chat rows' part of the device cache. */
export function getReplicaCacheMaxBytes(): number {
  return getDeviceCacheMaxBytes() - getSentChatImagesMaxBytes();
}

/** The local copies of sent photos' part of the device cache. */
export function getSentChatImagesMaxBytes(): number {
  return Math.round(getDeviceCacheMaxBytes() * SENT_CHAT_IMAGES_SHARE);
}
