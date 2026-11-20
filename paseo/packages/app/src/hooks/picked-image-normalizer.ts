export type PickedImageSource = { kind: "file_uri"; uri: string } | { kind: "blob"; blob: Blob };

export interface PickedImageAttachmentInput {
  source: PickedImageSource;
  mimeType: string;
  fileName?: string | null;
}

export interface ExpoImagePickerAssetLike {
  uri: string;
  /** Pixel size from the picker, when known. */
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  fileName?: string | null;
  file?: File | null;
}

interface SupportedPickedImageFormat {
  mimeType: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
}

const JPEG_FORMAT: SupportedPickedImageFormat = {
  mimeType: "image/jpeg",
  extension: "jpg",
};

const PNG_FORMAT: SupportedPickedImageFormat = {
  mimeType: "image/png",
  extension: "png",
};

function extensionFromPath(path: string | null | undefined): string | null {
  const match = path?.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function supportedFormatForExtension(extension: string | null): SupportedPickedImageFormat | null {
  if (extension === "jpg" || extension === "jpeg") {
    return JPEG_FORMAT;
  }
  if (extension === "png") {
    return PNG_FORMAT;
  }
  return null;
}

function supportedFormatForMimeType(
  mimeType: string | null | undefined,
): SupportedPickedImageFormat | null {
  const normalizedMimeType = mimeType?.toLowerCase();
  if (normalizedMimeType === "image/jpeg" || normalizedMimeType === "image/jpg") {
    return JPEG_FORMAT;
  }
  if (normalizedMimeType === "image/png") {
    return PNG_FORMAT;
  }
  return null;
}

function pickedAssetSupportedFormat(
  asset: ExpoImagePickerAssetLike,
): SupportedPickedImageFormat | null {
  const uriExtension = extensionFromPath(asset.uri);
  const uriFormat = supportedFormatForExtension(uriExtension);
  if (uriExtension && !uriFormat) {
    return null;
  }

  return (
    supportedFormatForMimeType(asset.mimeType) ??
    supportedFormatForExtension(extensionFromPath(asset.fileName)) ??
    uriFormat
  );
}

function replaceFileExtension(
  fileName: string | null | undefined,
  extension: SupportedPickedImageFormat["extension"],
): string | null {
  if (!fileName) {
    return null;
  }

  return fileName.replace(/\.[^./\\]+$/, "") + `.${extension}`;
}

/**
 * Photos go to the bot at most this many pixels on the long edge. Claude reads images at about
 * 1.15 megapixels anyway (larger ones are scaled down by the API), and a phone camera photo at
 * full size is 4-8 MB as JPEG, tens of MB once a HEIC became a PNG: a handful of those froze the
 * app and stalled the send for hours (UF1). 2048 keeps a photographed document legible.
 */
export const PICKED_IMAGE_MAX_EDGE = 2048;
/** JPEG quality for photos the app re-encodes (HEIC and oversized photos). */
export const PICKED_IMAGE_JPEG_QUALITY = 0.85;

export type PickedImagePlan =
  | { kind: "keep"; format: SupportedPickedImageFormat }
  | {
      kind: "transcode";
      format: SupportedPickedImageFormat;
      /** Scale so this edge is PICKED_IMAGE_MAX_EDGE (the other follows the aspect ratio). */
      resize: { width: number } | { height: number } | null;
    };

/** Keep JPEG/PNG that already fit; scale down the rest; anything else (HEIC…) becomes JPEG. */
export function planPickedImage(asset: ExpoImagePickerAssetLike): PickedImagePlan {
  const supported = pickedAssetSupportedFormat(asset);
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const tooLarge = Math.max(width, height) > PICKED_IMAGE_MAX_EDGE;
  if (supported && !tooLarge) return { kind: "keep", format: supported };
  let resize: { width: number } | { height: number } | null = null;
  if (tooLarge) {
    resize = width >= height ? { width: PICKED_IMAGE_MAX_EDGE } : { height: PICKED_IMAGE_MAX_EDGE };
  }
  return { kind: "transcode", format: supported === PNG_FORMAT ? PNG_FORMAT : JPEG_FORMAT, resize };
}

/** Re-encodes (and scales) a picked image natively; returns the new file's URI. */
export type TranscodePickedImage = (
  uri: string,
  plan: Extract<PickedImagePlan, { kind: "transcode" }>,
) => Promise<string>;

export async function normalizePickedImageAssetsWith(
  assets: readonly ExpoImagePickerAssetLike[],
  transcode: TranscodePickedImage,
): Promise<PickedImageAttachmentInput[]> {
  // One at a time: decoding a dozen full-size photos at once would hold hundreds of MB.
  const result: PickedImageAttachmentInput[] = [];
  for (const asset of assets) {
    const plan = planPickedImage(asset);
    const uri = plan.kind === "keep" ? asset.uri : await transcode(asset.uri, plan);
    result.push({
      source: { kind: "file_uri", uri },
      mimeType: plan.format.mimeType,
      fileName: replaceFileExtension(asset.fileName, plan.format.extension),
    });
  }
  return result;
}
