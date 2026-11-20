import { imageSaveFileName } from "./image-save";
import type { ChatImageActionTarget, ChatImageTranslate } from "./image-actions-types";

export type { ChatImageActionTarget } from "./image-actions-types";

/** Web: download the image as a file (there is no photo library to save to). */
export async function saveChatImage(
  target: ChatImageActionTarget,
  t: ChatImageTranslate,
): Promise<void> {
  if (typeof document === "undefined") return;
  let href = target.uri;
  let revoke: string | null = null;
  try {
    // A cross-origin URL ignores `download` and navigates; fetch it into a blob first.
    if (/^https?:/i.test(target.uri)) {
      const response = await fetch(target.uri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      href = URL.createObjectURL(await response.blob());
      revoke = href;
    }
    const link = document.createElement("a");
    link.href = href;
    link.download = imageSaveFileName({ uri: target.uri, mimeType: target.mimeType });
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    console.warn("[chat-images] Image download failed", error);
    window.alert(t("message.attachments.saveImageFailed"));
  } finally {
    if (revoke) {
      const url = revoke;
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }
}

/** Label for the lightbox toolbar's save button. */
export function chatImageSaveLabel(t: ChatImageTranslate): string {
  return t("message.attachments.downloadImage");
}

/** Long-press on web (touch screens) downloads the image. */
export function openChatImageActions(target: ChatImageActionTarget, t: ChatImageTranslate): void {
  void saveChatImage(target, t);
}
