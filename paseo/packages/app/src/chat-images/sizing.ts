/**
 * Chat images show at the chat's width, with the photo's real aspect ratio (no crop), capped on
 * wide laptop windows. The frame is sized from the reference's width/height before anything
 * loads, so the chat does not jump when the image arrives.
 */

/** Widest an image gets in a laptop chat column, in points. */
export const CHAT_IMAGE_MAX_WIDTH = 480;
/** Tallest an image gets: portrait photos and long screenshots shrink to this height. */
export const CHAT_IMAGE_MAX_HEIGHT = 560;
const FALLBACK_ASPECT = 4 / 3;

export interface ChatImageFrameSize {
  /** width / height of the frame, from the image (or 4:3 when unknown). */
  aspectRatio: number;
  /** Max width in points: the cap, or less for tall images so their height fits. */
  maxWidth: number;
}

export function chatImageFrameSize(
  image: { width?: number; height?: number },
  viewport: { height: number },
): ChatImageFrameSize {
  const aspectRatio =
    image.width && image.height && image.width > 0 && image.height > 0
      ? image.width / image.height
      : FALLBACK_ASPECT;
  const maxHeight = Math.max(
    240,
    Math.min(CHAT_IMAGE_MAX_HEIGHT, Math.round(viewport.height * 0.6)),
  );
  return {
    aspectRatio,
    maxWidth: Math.min(CHAT_IMAGE_MAX_WIDTH, Math.round(maxHeight * aspectRatio)),
  };
}

export function formatImageBytes(bytes: number | undefined | null): string | null {
  if (bytes === undefined || bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
