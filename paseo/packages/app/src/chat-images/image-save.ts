/**
 * Where a chat image's bytes are, for saving or sharing it. Chat images are shown from data: URIs
 * (a display image the disk cache could not keep), file:// URIs (the display cache, this device's
 * own copy, a loaded original), blob: URIs (web) or http(s) URLs.
 */
export type ImageSaveSource =
  | { kind: "data"; base64: string; mimeType: string }
  | { kind: "file"; uri: string }
  | { kind: "blob"; uri: string }
  | { kind: "remote"; uri: string };

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};
const KNOWN_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "avif",
  "bmp",
  "tif",
  "tiff",
]);

export function classifyImageUri(uri: string): ImageSaveSource | null {
  const data = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(uri);
  if (data) return { kind: "data", mimeType: data[1] ?? "image/jpeg", base64: data[2] ?? "" };
  if (uri.startsWith("file:") || uri.startsWith("/")) return { kind: "file", uri };
  if (uri.startsWith("blob:")) return { kind: "blob", uri };
  if (/^https?:/i.test(uri)) return { kind: "remote", uri };
  return null;
}

/** The file extension to save under: from the MIME type, else the URI's own, else jpg. */
export function imageFileExtension(input: { uri: string; mimeType?: string | null }): string {
  const fromMime = input.mimeType ? EXTENSION_BY_MIME[input.mimeType.toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  const data = classifyImageUri(input.uri);
  if (data?.kind === "data") return EXTENSION_BY_MIME[data.mimeType.toLowerCase()] ?? "jpg";
  const path = input.uri.split(/[?#]/)[0] ?? "";
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = match?.[1]?.toLowerCase();
  if (ext && KNOWN_EXTENSIONS.has(ext)) return ext === "jpeg" ? "jpg" : ext;
  return "jpg";
}

/** A neutral file name for a saved chat image, e.g. `image-20261119-153012.png`. */
export function imageSaveFileName(
  input: { uri: string; mimeType?: string | null },
  now: Date = new Date(),
): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `image-${stamp}.${imageFileExtension(input)}`;
}
