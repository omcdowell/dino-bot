import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ChatImageReference } from "@/types/stream";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { bytesToBase64, chatImageDisplays, type FetchDisplayImage } from "./display-loader";
import { useChatImageAutoDownload } from "./network-policy";
import { loadChatImageOriginal } from "./original-loader";
import { useChatImagePlaceholder } from "./placeholder";
import { forgetSentChatImage, touchSentChatImage, useSentChatImage } from "./sent-images";
import { chatImageFrameSize, formatImageBytes } from "./sizing";

/** Display images are ~100-250 KB; the cap only guards against a wrong path. */
const MAX_DISPLAY_BYTES = 16 * 1024 * 1024;
/** Small chunks so a download over a slow link shows progress (old daemons send 256 KB). */
const DISPLAY_CHUNK_BYTES = 16 * 1024;

type DisplayState =
  | { status: "idle" }
  /** This device's own copy is being opened (no blur, no pill: it is here, not downloading). */
  | { status: "local" }
  | { status: "downloading"; progress: number | null }
  | { status: "loaded"; uri: string }
  | { status: "failed" };

function displayFetcher(client: DaemonClient, image: ChatImageReference): FetchDisplayImage {
  return async (onProgress) => {
    const display = await client.fetchAgentImageVariant(image.id, "display");
    if (display.path) {
      const target = resolveFilePreviewReadTarget({ path: display.path });
      if (!target) throw new Error("Image unavailable");
      const file = await client.readFile(target.cwd, target.path, undefined, MAX_DISPLAY_BYTES, {
        chunkBytes: DISPLAY_CHUNK_BYTES,
        onProgress,
      });
      return {
        data: bytesToBase64(file.bytes),
        mimeType: display.mimeType ?? file.mime,
        width: display.width ?? 0,
        height: display.height ?? 0,
      };
    }
    // A daemon before display images answers with an inline 640 px thumbnail.
    if (display.data && display.mimeType) {
      return {
        data: display.data,
        mimeType: display.mimeType,
        width: display.width ?? 0,
        height: display.height ?? 0,
      };
    }
    throw new Error("Image unavailable");
  };
}

function useDisplayImage(input: {
  image: ChatImageReference;
  serverId: string | undefined;
  client: DaemonClient | null | undefined;
  /** This device has its own copy: nothing is fetched, whatever the link. */
  local: LocalCopy;
  autoDownload: boolean;
}) {
  const { image, serverId, client, local, autoDownload } = input;
  const [state, setState] = useState<DisplayState>(() => {
    const inMemory = serverId ? chatImageDisplays.peek(serverId, image.id) : undefined;
    return inMemory ? { status: "loaded", uri: inMemory.uri } : { status: "idle" };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(() => {
    if (!serverId || !client) return;
    setState({ status: "downloading", progress: null });
    const run = async () => {
      try {
        const entry = await chatImageDisplays.load({
          serverId,
          imageId: image.id,
          fetch: displayFetcher(client, image),
          onProgress: (received, total) => {
            if (mounted.current && total > 0) {
              setState({ status: "downloading", progress: Math.min(1, received / total) });
            }
          },
        });
        if (mounted.current) setState({ status: "loaded", uri: entry.uri });
      } catch {
        if (mounted.current) setState({ status: "failed" });
      }
    };
    void run();
  }, [client, image, serverId]);

  // Cached on this device: show it, whatever the link. Otherwise download on a good link only.
  const status = state.status;
  const skipFetch = local.status !== "none";
  useEffect(() => {
    if (skipFetch || status !== "idle" || !serverId) return;
    let disposed = false;
    const check = async () => {
      const entry = await chatImageDisplays.cached(serverId, image.id).catch(() => null);
      if (disposed) return;
      if (entry) setState({ status: "loaded", uri: entry.uri });
      else if (autoDownload) start();
    };
    void check();
    return () => {
      disposed = true;
    };
  }, [autoDownload, image.id, serverId, skipFetch, start, status]);

  if (local.status === "ready") {
    return { state: { status: "loaded", uri: local.uri } as DisplayState, start };
  }
  if (local.status === "opening") return { state: { status: "local" } as DisplayState, start };
  return { state, start };
}

type LocalCopy =
  | { status: "none" }
  | { status: "opening" }
  | { status: "ready"; uri: string; onError: () => void };

/**
 * This device's own copy of the image: the copy paired on the live row (`image.local`), or a
 * photo it sent earlier, found by the daemon's id (sent-images: survives restarts). Until the
 * saved list has loaded, nothing is fetched either, so a restart does not start a download for a
 * photo that is here. A copy whose file is gone is forgotten and the image takes the normal path.
 */
function useLocalCopy(image: ChatImageReference): LocalCopy {
  const sent = useSentChatImage(image.id);
  const attachment = image.local ?? sent.attachment;
  const [result, setResult] = useState<{ key: string; uri: string | null } | null>(null);
  const key = attachment ? `${attachment.id}:${attachment.storageKey}` : null;
  const imageId = image.id;
  const fromSentList = !image.local && Boolean(sent.attachment);

  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;

  useEffect(() => {
    const current = attachmentRef.current;
    if (!current || !key) return;
    let disposed = false;
    let resolved: string | null = null;
    resolveAttachmentPreviewUrl(current).then(
      (uri) => {
        if (disposed) {
          void releaseAttachmentPreviewUrl({ attachment: current, url: uri });
          return undefined;
        }
        resolved = uri;
        setResult({ key, uri });
        return undefined;
      },
      () => {
        if (disposed) return;
        setResult({ key, uri: null });
      },
    );
    return () => {
      disposed = true;
      if (resolved) void releaseAttachmentPreviewUrl({ attachment: current, url: resolved });
    };
  }, [key]);

  const gone = result !== null && result.key === key && result.uri === null;
  useEffect(() => {
    if (gone && fromSentList) forgetSentChatImage(imageId);
  }, [fromSentList, gone, imageId]);

  const uri = result && result.key === key ? result.uri : null;
  useEffect(() => {
    if (uri && fromSentList) touchSentChatImage(imageId);
  }, [fromSentList, imageId, uri]);

  const onError = useCallback(() => {
    if (fromSentList) forgetSentChatImage(imageId);
    else if (key) setResult({ key, uri: null });
  }, [fromSentList, imageId, key]);

  if (!attachment) return sent.ready ? { status: "none" } : { status: "opening" };
  if (gone) return { status: "none" };
  if (!uri) return { status: "opening" };
  return { status: "ready", uri, onError };
}

interface ChatImageProps {
  image: ChatImageReference;
  serverId?: string;
  client?: DaemonClient | null;
  accessibilityLabel: string;
}

/**
 * A chat image by reference (chatImages), WhatsApp style: at the chat's width with the photo's
 * aspect ratio, blurred (ThumbHash) until its display image is here. On a good link the display
 * image downloads by itself; otherwise a tap downloads it, with progress. A tap on the shown image
 * opens it full screen and loads the original (or a JPEG of a HEIC where HEIC cannot be shown).
 */
export const ChatImage = memo(function ChatImage({
  image,
  serverId,
  client,
  accessibilityLabel,
}: ChatImageProps) {
  const { t } = useTranslation();
  const viewport = useWindowDimensions();
  // The copy this device sent shows at once; nothing to download for it.
  const local = useLocalCopy(image);
  const hasLocal = local.status !== "none";
  const autoDownload = useChatImageAutoDownload(serverId);
  const { state, start } = useDisplayImage({ image, serverId, client, local, autoDownload });
  const loaded = state.status === "loaded";
  const placeholder = useChatImagePlaceholder({
    image,
    serverId,
    client,
    needed: !loaded && !hasLocal,
  });
  const [lightbox, setLightbox] = useState<ImageLightboxSource | null>(null);

  const size = useMemo(() => chatImageFrameSize(image, viewport), [image, viewport]);
  const frameStyle = useMemo(
    () => [styles.frame, { aspectRatio: size.aspectRatio, maxWidth: size.maxWidth }],
    [size],
  );
  const knownSize = Boolean(image.width && image.height);
  const contentSize = useMemo(
    () => (image.width && image.height ? { width: image.width, height: image.height } : undefined),
    [image.height, image.width],
  );

  const handlePress = useCallback(() => {
    if (state.status === "idle" || state.status === "failed") {
      start();
      return;
    }
    if (state.status !== "loaded") return;
    setLightbox({ type: "uri", uri: state.uri, contentSize });
    // This device's own copy is the original: nothing to fetch.
    if (hasLocal || !client) return;
    const showOriginal = (uri: string) =>
      setLightbox((current) => (current ? { type: "uri", uri, contentSize } : current));
    loadChatImageOriginal({ client, image, acceptsHeic: Platform.OS === "ios" }).then(
      showOriginal,
      () => {},
    );
  }, [client, contentSize, hasLocal, image, start, state]);
  const handleClose = useCallback(() => setLightbox(null), []);

  const sizeLabel = formatImageBytes(placeholder.displayBytes ?? image.byteSize);
  const progress = state.status === "downloading" ? state.progress : null;
  const progressStyle = useMemo(
    () => [styles.progressFill, { width: `${Math.round((progress ?? 0) * 100)}%` as const }],
    [progress],
  );
  const dataSet = useMemo(
    () => ({ state: state.status, image: image.id }),
    [image.id, state.status],
  );
  const placeholderSource = useMemo(() => ({ uri: placeholder.uri ?? "" }), [placeholder.uri]);
  const displayUri = state.status === "loaded" ? state.uri : "";
  const displaySource = useMemo(() => ({ uri: displayUri }), [displayUri]);
  const onLocalError = local.status === "ready" ? local.onError : undefined;

  return (
    <>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={loaded ? accessibilityLabel : t("message.attachments.downloadImage")}
        style={frameStyle}
        testID="chat-image"
        dataSet={dataSet}
      >
        {!loaded && placeholder.uri ? (
          <Image
            source={placeholderSource}
            style={styles.fill}
            resizeMode="cover"
            blurRadius={6}
            testID="chat-image-placeholder"
          />
        ) : null}
        {loaded ? (
          <Image
            source={displaySource}
            style={styles.fill}
            resizeMode={knownSize ? "cover" : "contain"}
            onError={onLocalError}
            testID="chat-image-display"
          />
        ) : null}
        {state.status === "idle" ? (
          <View style={styles.center} pointerEvents="none">
            <View style={styles.pill} testID="chat-image-download">
              <ArrowDown size={16} color="#ffffff" />
              {sizeLabel ? <Text style={styles.pillText}>{sizeLabel}</Text> : null}
            </View>
          </View>
        ) : null}
        {state.status === "downloading" ? (
          <View style={styles.center} pointerEvents="none">
            <View style={styles.pill} testID="chat-image-progress">
              <Text style={styles.pillText}>
                {progress === null ? "…" : `${Math.round(progress * 100)}%`}
                {sizeLabel ? ` · ${sizeLabel}` : ""}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={progressStyle} />
            </View>
          </View>
        ) : null}
        {state.status === "failed" ? (
          <View style={styles.center} pointerEvents="none">
            <View style={styles.pill}>
              <Text style={styles.pillText}>{t("message.attachments.imageUnavailable")}</Text>
            </View>
          </View>
        ) : null}
      </Pressable>
      <AttachmentLightbox source={lightbox} onClose={handleClose} />
    </>
  );
});

interface LocalChatImageProps {
  metadata: AttachmentMetadata;
  onOpen: (metadata: AttachmentMetadata) => void;
  accessibilityLabel: string;
}

/** An image this device sent and still has locally (before the daemon's reference arrives). */
export const LocalChatImage = memo(function LocalChatImage({
  metadata,
  onOpen,
  accessibilityLabel,
}: LocalChatImageProps) {
  const viewport = useWindowDimensions();
  const uri = useAttachmentPreviewUrl(metadata);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!uri) return;
    let disposed = false;
    Image.getSize(
      uri,
      (width, height) => {
        if (!disposed) setNatural({ width, height });
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [uri]);
  const size = useMemo(() => chatImageFrameSize(natural ?? {}, viewport), [natural, viewport]);
  const frameStyle = useMemo(
    () => [styles.frame, { aspectRatio: size.aspectRatio, maxWidth: size.maxWidth }],
    [size],
  );
  const handlePress = useCallback(() => onOpen(metadata), [metadata, onOpen]);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={frameStyle}
      testID="chat-image-local"
    >
      {uri ? <Image source={source} style={styles.fill} resizeMode="contain" /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: "100%",
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: 999,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  },
  pillText: {
    color: "#ffffff",
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  progressTrack: {
    width: 96,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#ffffff",
  },
}));
