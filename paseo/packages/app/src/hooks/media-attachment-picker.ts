import { getFileExtension } from "@/attachments/file-types";
import type { SelectedFile } from "@/attachments/selected-file";

/**
 * Largest video the composer sends (200 MB). Claude models cannot watch video, so a video is
 * uploaded to the host as a file (the bot gets its path and name), never sent as an image.
 */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const VIDEO_MAX_LABEL = "200 MB";
/** Largest other file the composer uploads (the cap it had before videos). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
export const FILE_MAX_LABEL = "50MB";

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  "3gp": "video/3gpp",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

export function isVideoMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("video/");
}

/** The upload cap for one file: 200 MB for a video, 50 MB for anything else. */
export function maxUploadBytesFor(mimeType: string): { bytes: number; label: string } {
  return isVideoMimeType(mimeType)
    ? { bytes: VIDEO_MAX_BYTES, label: VIDEO_MAX_LABEL }
    : { bytes: FILE_MAX_BYTES, label: FILE_MAX_LABEL };
}

/** The fields of an expo-image-picker asset this module reads. */
export interface PickedMediaAssetLike {
  uri: string;
  type?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  /** Milliseconds (expo-image-picker reports video duration in ms). */
  duration?: number | null;
  file?: File | null;
}

export function isVideoAsset(asset: PickedMediaAssetLike): boolean {
  return (
    asset.type === "video" ||
    asset.type === "pairedVideo" ||
    isVideoMimeType(asset.mimeType) ||
    isVideoMimeType(asset.file?.type)
  );
}

function fileNameOf(asset: PickedMediaAssetLike, mimeType: string): string {
  const named = asset.fileName ?? asset.file?.name;
  if (named) return named;
  const fromUri = asset.uri.split(/[?#]/)[0]?.split("/").pop();
  if (fromUri && fromUri.includes(".")) return fromUri;
  const ext = mimeType === "video/quicktime" ? "mov" : (mimeType.split("/")[1] ?? "mp4");
  return `video.${ext}`;
}

/**
 * A picked video as a file to upload. `readBytes` reads it only when the upload starts, so a
 * video over the cap (known from `fileSize`) is refused before it is read into memory.
 */
export function videoAssetToSelectedFile(
  asset: PickedMediaAssetLike,
  readUri: (uri: string) => Promise<Uint8Array>,
): SelectedFile {
  const provisionalName = (asset.fileName ?? asset.file?.name ?? asset.uri).split(/[?#]/)[0] ?? "";
  const mimeType =
    [asset.mimeType, asset.file?.type].find(isVideoMimeType) ??
    VIDEO_MIME_BY_EXTENSION[getFileExtension(provisionalName).slice(1)] ??
    "video/mp4";
  const file = asset.file;
  const size = asset.fileSize ?? file?.size;
  return {
    fileName: fileNameOf(asset, mimeType),
    mimeType,
    ...(typeof size === "number" && size > 0 ? { size } : {}),
    ...(typeof asset.duration === "number" && asset.duration > 0
      ? { durationMs: Math.round(asset.duration) }
      : {}),
    readBytes: file
      ? async () => new Uint8Array(await file.arrayBuffer())
      : () => readUri(asset.uri),
  };
}

/** Splits picked library assets into images (sent as images) and videos (uploaded as files). */
export function splitPickedMediaAssets<T extends PickedMediaAssetLike>(
  assets: readonly T[],
): { images: T[]; videos: T[] } {
  const images: T[] = [];
  const videos: T[] = [];
  for (const asset of assets) (isVideoAsset(asset) ? videos : images).push(asset);
  return { images, videos };
}
