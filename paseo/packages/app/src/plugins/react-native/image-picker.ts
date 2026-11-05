import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { branded } from "@/constants/flavour";

export interface PluginPickImageOptions {
  /** Crop to a square in the picker (where the platform supports it). Default true. */
  square?: boolean;
  /** Longest side of the returned PNG, in pixels. Default 512. */
  maxSize?: number;
}

export interface PluginPickedImage {
  /** `data:image/png;base64,…` */
  dataUri: string;
  width: number;
  height: number;
}

/** Scales `[width, height]` so its longest side is at most `maxSize` (never up). */
export function fitWithin(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > maxSize) || maxSize <= 0) return { width, height };
  const scale = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * One image from the photo library, scaled down and re-encoded as PNG. Null when cancelled.
 * Throws when photo access is denied.
 */
export async function pickImage(
  options: PluginPickImageOptions = {},
): Promise<PluginPickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted)
    throw new Error(branded("Paseo has no access to your photos. Allow it in Settings."));
  const square = options.square ?? true;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"] as ImagePicker.MediaType[],
    allowsMultipleSelection: false,
    allowsEditing: square,
    ...(square ? { aspect: [1, 1] as [number, number] } : {}),
    quality: 1,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const size = fitWithin(asset.width, asset.height, options.maxSize ?? 512);
  const context = ImageManipulator.manipulate(asset.uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    if (size.width !== asset.width || size.height !== asset.height) context.resize(size);
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
    if (!saved.base64) throw new Error("The picked image could not be read.");
    return {
      dataUri: `data:image/png;base64,${saved.base64}`,
      width: saved.width,
      height: saved.height,
    };
  } finally {
    image?.release();
    context.release();
  }
}
