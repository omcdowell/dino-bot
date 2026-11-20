import { ActionSheetIOS, Alert, Linking, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { classifyImageUri, imageSaveFileName } from "./image-save";
import type { ChatImageActionTarget, ChatImageTranslate } from "./image-actions-types";

export type { ChatImageActionTarget } from "./image-actions-types";

const SAVE_DIRECTORY = `${FileSystem.cacheDirectory ?? ""}paseo-image-save/`;

/** A file:// copy of the image with the right extension (Photos and the share sheet need one). */
async function toLocalFile(target: ChatImageActionTarget): Promise<string> {
  const source = classifyImageUri(target.uri);
  if (!source || source.kind === "blob") throw new Error("Unsupported image source");
  await FileSystem.makeDirectoryAsync(SAVE_DIRECTORY, { intermediates: true }).catch(() => {});
  const mimeType = target.mimeType ?? (source.kind === "data" ? source.mimeType : null);
  const destination = `${SAVE_DIRECTORY}${imageSaveFileName({ uri: target.uri, mimeType })}`;
  if (source.kind === "data") {
    await FileSystem.writeAsStringAsync(destination, source.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else if (source.kind === "file") {
    const from = source.uri.startsWith("/") ? `file://${source.uri}` : source.uri;
    await FileSystem.copyAsync({ from, to: destination });
  } else {
    await FileSystem.downloadAsync(source.uri, destination);
  }
  return destination;
}

function removeLater(uri: string): void {
  // The share sheet may still read the file after shareAsync resolves on some systems.
  setTimeout(() => {
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }, 60_000);
}

function showPermissionDenied(canAskAgain: boolean, t: ChatImageTranslate): void {
  const buttons: Parameters<typeof Alert.alert>[2] = [
    { text: t("common.actions.cancel"), style: "cancel" },
  ];
  if (!canAskAgain) {
    buttons.push({
      text: t("message.attachments.openSettings"),
      onPress: () => {
        void Linking.openSettings();
      },
    });
  }
  Alert.alert(
    t("message.attachments.photosAccessDeniedTitle"),
    t("message.attachments.photosAccessDeniedMessage"),
    buttons,
  );
}

/** Save the image to the photo library, asking for add-only access first. */
export async function saveChatImage(
  target: ChatImageActionTarget,
  t: ChatImageTranslate,
): Promise<void> {
  try {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      showPermissionDenied(permission.canAskAgain, t);
      return;
    }
    const file = await toLocalFile(target);
    try {
      await MediaLibrary.saveToLibraryAsync(file);
    } finally {
      void FileSystem.deleteAsync(file, { idempotent: true }).catch(() => {});
    }
    Alert.alert(t("message.attachments.savedToPhotos"));
  } catch (error) {
    console.warn("[chat-images] Save to Photos failed", error);
    Alert.alert(t("message.attachments.saveImageFailed"));
  }
}

async function shareChatImage(target: ChatImageActionTarget, t: ChatImageTranslate): Promise<void> {
  try {
    const file = await toLocalFile(target);
    removeLater(file);
    await Sharing.shareAsync(file, { mimeType: target.mimeType ?? undefined });
  } catch (error) {
    console.warn("[chat-images] Share image failed", error);
    Alert.alert(t("message.attachments.shareImageFailed"));
  }
}

/** Label for the lightbox toolbar's save button. */
export function chatImageSaveLabel(t: ChatImageTranslate): string {
  return t("message.attachments.saveToPhotos");
}

/** Long-press on a chat image: an action sheet with Save to Photos and Share. */
export function openChatImageActions(target: ChatImageActionTarget, t: ChatImageTranslate): void {
  const save = t("message.attachments.saveToPhotos");
  const share = t("message.attachments.shareImage");
  const cancel = t("common.actions.cancel");
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [save, share, cancel], cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) void saveChatImage(target, t);
        else if (index === 1) void shareChatImage(target, t);
      },
    );
    return;
  }
  Alert.alert(t("message.attachments.imageActionsTitle"), undefined, [
    { text: save, onPress: () => void saveChatImage(target, t) },
    { text: share, onPress: () => void shareChatImage(target, t) },
    { text: cancel, style: "cancel" },
  ]);
}
