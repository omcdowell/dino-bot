import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineImage } from "@getpaseo/protocol/agent-types";
import { thumbHashToDataURL } from "./thumbhash";

/**
 * The blurred preview of a chat image before its display image is here: the ThumbHash carried on
 * the reference (~25 bytes, decoded to a 32 px PNG data URL here and scaled up blurred). A live
 * row can arrive before the daemon finished preparing the image; then one small request asks for
 * it (`agent.image.thumbnail` variant `placeholder`, ~150 bytes), along with the display size.
 */

export interface ChatImagePlaceholderInfo {
  uri: string | null;
  /** Bytes of the display image a tap downloads. */
  displayBytes: number | null;
}

const decoded = new Map<string, string | null>();
const fetched = new Map<string, Promise<{ thumbhash: string | null; byteSize: number | null }>>();
const MAX_DECODED = 500;

export function thumbhashDataUri(thumbhash: string | undefined | null): string | null {
  if (!thumbhash) return null;
  const known = decoded.get(thumbhash);
  if (known !== undefined) return known;
  let uri: string | null = null;
  try {
    const binary = atob(thumbhash);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    uri = thumbHashToDataURL(bytes);
  } catch {
    uri = null;
  }
  if (decoded.size >= MAX_DECODED) decoded.delete(decoded.keys().next().value as string);
  decoded.set(thumbhash, uri);
  return uri;
}

function fetchPlaceholder(client: DaemonClient, serverId: string, imageId: string) {
  const key = `${serverId}:${imageId}`;
  let pending = fetched.get(key);
  if (!pending) {
    pending = client
      .fetchAgentImageVariant(imageId, "placeholder")
      .then((result) => ({ thumbhash: result.thumbhash, byteSize: result.byteSize }));
    pending.catch(() => fetched.delete(key));
    fetched.set(key, pending);
  }
  return pending;
}

export function useChatImagePlaceholder(input: {
  image: AgentTimelineImage;
  serverId: string | undefined;
  client: DaemonClient | null | undefined;
  /** False when the display image is already showing: no request then. */
  needed: boolean;
}): ChatImagePlaceholderInfo {
  const { image, serverId, client, needed } = input;
  const inline = thumbhashDataUri(image.thumbhash);
  const [late, setLate] = useState<{ thumbhash: string | null; byteSize: number | null } | null>(
    null,
  );
  const hasInline = Boolean(image.thumbhash && image.display);
  useEffect(() => {
    if (hasInline || !needed || !client || !serverId) return;
    let disposed = false;
    const run = async () => {
      try {
        const value = await fetchPlaceholder(client, serverId, image.id);
        if (!disposed) setLate(value);
      } catch {
        // No placeholder: the frame stays plain, the download button still works.
      }
    };
    void run();
    return () => {
      disposed = true;
    };
  }, [client, hasInline, image.id, needed, serverId]);
  return {
    uri: inline ?? thumbhashDataUri(late?.thumbhash),
    displayBytes: image.display?.byteSize ?? late?.byteSize ?? null,
  };
}
