/**
 * The box a chat image is shown in. The whole image always shows (contain, never crop), at its
 * real aspect ratio, inside tidy limits:
 * - width: at most the space the chat gives it, and never more than CHAT_IMAGE_MAX_WIDTH (laptops);
 * - height: at most 60% of the screen height, between 240 and CHAT_IMAGE_MAX_HEIGHT points, so a
 *   phone screenshot shows whole but smaller;
 * - shape: the box is clamped between 1:3 (tall) and 3:1 (wide). A longer image (a full-page
 *   screenshot, a panorama) is letterboxed inside it; a tap opens it full screen;
 * - small images are not blown up past their own pixel size, but the box is never smaller than
 *   CHAT_IMAGE_MIN_SIDE points on its short side, so tiny images stay easy to tap.
 * Width and height are explicit numbers: `aspectRatio` with `maxWidth` lets Yoga take the height
 * from the unclamped width, which made a tall, narrow box that cropped portrait screenshots.
 */

/** Widest an image gets (a laptop chat column), in points. */
export const CHAT_IMAGE_MAX_WIDTH = 480;
/** Tallest an image gets, in points (also capped at 60% of the screen height). */
export const CHAT_IMAGE_MAX_HEIGHT = 560;
/** The height cap never goes below this, even on a short (landscape phone) window. */
export const CHAT_IMAGE_MIN_HEIGHT_CAP = 240;
/** Share of the screen height an image may take. */
export const CHAT_IMAGE_SCREEN_HEIGHT_SHARE = 0.6;
/** The box's short side is at least this many points, so tiny images stay tappable. */
export const CHAT_IMAGE_MIN_SIDE = 96;
/** The box is never longer than 3:1 or taller than 1:3; longer images are letterboxed. */
export const CHAT_IMAGE_MAX_BOX_RATIO = 3;
const FALLBACK_ASPECT = 4 / 3;

export interface ChatImageBox {
  /** Box width in points. */
  width: number;
  /** Box height in points. */
  height: number;
  /** width / height of the image itself (4:3 when unknown). */
  imageAspectRatio: number;
  /** The box's shape differs from the image's (beyond 1:3 / 3:1, or the minimum size): the
   * image is letterboxed inside it. */
  letterboxed: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The image's size in pixels, or only its aspect ratio (width / height) when that is all known. */
export interface ChatImageDimensions {
  width?: number | null;
  height?: number | null;
  aspectRatio?: number | null;
}

/**
 * The box for an image. `space.width` is the measured width of the image's slot in the chat;
 * `space.screenHeight` the window height.
 */
export function chatImageBox(
  image: ChatImageDimensions,
  space: { width: number; screenHeight: number },
): ChatImageBox {
  const known = Boolean(image.width && image.height && image.width > 0 && image.height > 0);
  const naturalWidth = known ? (image.width as number) : null;
  const naturalHeight = known ? (image.height as number) : null;
  const ratioOnly =
    image.aspectRatio && Number.isFinite(image.aspectRatio) && image.aspectRatio > 0
      ? image.aspectRatio
      : null;
  const imageAspectRatio = known
    ? (naturalWidth as number) / (naturalHeight as number)
    : (ratioOnly ?? FALLBACK_ASPECT);
  const boxAspect = clamp(imageAspectRatio, 1 / CHAT_IMAGE_MAX_BOX_RATIO, CHAT_IMAGE_MAX_BOX_RATIO);

  const maxWidth = Math.max(1, Math.min(CHAT_IMAGE_MAX_WIDTH, Math.floor(space.width)));
  const maxHeight = clamp(
    Math.round(space.screenHeight * CHAT_IMAGE_SCREEN_HEIGHT_SHARE),
    CHAT_IMAGE_MIN_HEIGHT_CAP,
    CHAT_IMAGE_MAX_HEIGHT,
  );

  let width = Math.min(maxWidth, maxHeight * boxAspect);
  if (naturalWidth !== null && naturalHeight !== null) {
    // Not past the image's own size: the image fills the box's width (wide) or height (tall).
    width = Math.min(width, Math.max(naturalWidth, naturalHeight * boxAspect));
  }
  let height = width / boxAspect;

  const shortSide = Math.min(width, height);
  if (shortSide < CHAT_IMAGE_MIN_SIDE) {
    const scale = CHAT_IMAGE_MIN_SIDE / shortSide;
    width = Math.min(maxWidth, width * scale);
    height = Math.min(maxHeight, height * scale);
  }

  const boxWidth = Math.round(width);
  const boxHeight = Math.round(height);
  return {
    width: boxWidth,
    height: boxHeight,
    imageAspectRatio,
    // More than a point of empty band around the image (clamped ratio, or the minimum size).
    letterboxed:
      Math.abs(boxWidth - boxHeight * imageAspectRatio) > 1 &&
      Math.abs(boxHeight - boxWidth / imageAspectRatio) > 1,
  };
}

export function formatImageBytes(bytes: number | undefined | null): string | null {
  if (bytes === undefined || bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
