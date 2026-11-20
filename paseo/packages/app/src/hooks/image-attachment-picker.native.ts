import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  normalizePickedImageAssetsWith,
  PICKED_IMAGE_JPEG_QUALITY,
  type ExpoImagePickerAssetLike,
  type PickedImageAttachmentInput,
  type TranscodePickedImage,
} from "./picked-image-normalizer";

export type {
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
  PickedImageSource,
} from "./picked-image-normalizer";

/** Native decode, scale and encode (expo-image-manipulator): none of it on the JS thread. */
const transcodePickedImage: TranscodePickedImage = async (uri, plan) => {
  const context = ImageManipulator.manipulate(uri);
  if (plan.resize) context.resize(plan.resize);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    image = await context.renderAsync();
    const result = await image.saveAsync(
      plan.format.mimeType === "image/png"
        ? { format: SaveFormat.PNG }
        : { format: SaveFormat.JPEG, compress: PICKED_IMAGE_JPEG_QUALITY },
    );
    return result.uri;
  } finally {
    image?.release();
    context.release();
  }
};

export async function normalizePickedImageAssets(
  assets: readonly ExpoImagePickerAssetLike[],
): Promise<PickedImageAttachmentInput[]> {
  return normalizePickedImageAssetsWith(assets, transcodePickedImage);
}

export async function pickImagesWithDesktopDialog(
  _dialog?: unknown,
): Promise<PickedImageAttachmentInput[]> {
  throw new Error("Desktop dialog API is not available on native.");
}
