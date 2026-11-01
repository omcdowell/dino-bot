import type { AttachmentMetadata } from "@/attachments/types";
import { encodeAttachmentsForSend } from "@/attachments/service";
import { rememberSentChatImage } from "@/chat-images/sent-images";

type ImageInput = AttachmentMetadata;

/**
 * Base64 for the send. Each image is first listed as sent from this device under the daemon's id
 * for it (sha256 of these bytes), so this device's bubble shows its own copy and never downloads
 * the photo back.
 */
export async function encodeImages(
  images?: ImageInput[],
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  return await encodeAttachmentsForSend(images, { onEncoded: rememberSentChatImage });
}
