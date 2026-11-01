import React from "react";
import { act } from "react";
import { createHash } from "node:crypto";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import type { ChatImageReference } from "@/types/stream";
import {
  forgetSentChatImage,
  rememberSentChatImage,
  resetSentChatImagesForTests,
  SENT_CHAT_IMAGES_STORAGE_KEY,
  useSentChatImagesStore,
} from "./sent-images";
import { ChatImage } from "./chat-image";

const { theme, previewUrls } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { xl: 12 },
    fontSize: { sm: 13 },
    colors: { border: "#555", surface2: "#222" },
  },
  /** Attachment id → preview URL; a missing id means the local file is gone. */
  previewUrls: new Map<string, string>(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react-native", () => ({
  ArrowDown: () => React.createElement("span", { "data-icon": "ArrowDown" }),
}));

vi.mock("@/components/attachment-lightbox", () => ({
  AttachmentLightbox: () => null,
}));

vi.mock("./network-policy", () => ({
  // A good link: images the device does not have download by themselves.
  useChatImageAutoDownload: () => true,
}));

vi.mock("./thumbnail-disk", () => ({
  thumbnailDiskStore: { read: async () => null, write: async () => null },
}));

vi.mock("@/attachments/service", () => ({
  resolveAttachmentPreviewUrl: async (metadata: AttachmentMetadata) => {
    const url = previewUrls.get(metadata.id);
    if (!url) throw new Error("attachment file is gone");
    return url;
  },
  releaseAttachmentPreviewUrl: async () => {},
}));

const PHOTO = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256));
const PHOTO_BASE64 = PHOTO.toString("base64");
const PHOTO_ID = createHash("sha256").update(PHOTO).digest("hex");

function attachment(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/jpeg",
    storageType: "web-indexeddb",
    storageKey: id,
    fileName: "photo.jpg",
    byteSize: PHOTO.byteLength,
    createdAt: 1,
  };
}

function reference(id: string): ChatImageReference {
  return {
    id,
    mimeType: "image/jpeg",
    source: `/home/paseo/chat-images/${id.slice(0, 2)}/${id}.jpg`,
    byteSize: PHOTO.byteLength,
    width: 1200,
    height: 900,
  };
}

function fakeClient() {
  return {
    fetchAgentImageVariant: vi.fn(async () => ({
      path: "/home/paseo/chat-images/thumbs/display.jpg",
      mimeType: "image/jpeg",
      width: 1080,
      height: 810,
      byteSize: 3,
      thumbhash: null,
    })),
    readFile: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" })),
  };
}

function memoryStorage(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let serverCounter = 0;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  previewUrls.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

/** A fresh server id per test: the display loader's memory cache is keyed by it. */
function nextServerId(): string {
  serverCounter += 1;
  return `server-${serverCounter}`;
}

async function renderImage(image: ChatImageReference, client: ReturnType<typeof fakeClient>) {
  const serverId = nextServerId();
  await act(async () => {
    root?.render(
      <ChatImage
        image={image}
        serverId={serverId}
        client={client as unknown as DaemonClient}
        accessibilityLabel="Open image"
      />,
    );
  });
  // Let the async lookups (saved list, preview URL, disk cache, auto download) run.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function tile(): HTMLElement | null {
  return document.querySelector('[data-testid="chat-image"]');
}

function shownUri(): string | null {
  const display = document.querySelector('[data-testid="chat-image-display"]');
  const img = display?.querySelector("img");
  return img?.getAttribute("src") ?? null;
}

describe("ChatImage on the device that sent the photo", () => {
  it("own sent image makes no thumb/original request: it shows the local copy at once, no blur", async () => {
    resetSentChatImagesForTests({ storage: memoryStorage() });
    previewUrls.set("local-1", "blob:local-1");
    expect(await rememberSentChatImage(attachment("local-1"), PHOTO_BASE64)).toBe(PHOTO_ID);
    const client = fakeClient();

    await renderImage(reference(PHOTO_ID), client);

    expect(client.fetchAgentImageVariant).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
    expect(tile()?.getAttribute("data-state")).toBe("loaded");
    expect(document.querySelector('[data-testid="chat-image-placeholder"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-image-download"]')).toBeNull();
    expect(shownUri()).toBe("blob:local-1");
  });

  it("after a restart the saved list still finds the local copy, and nothing downloads meanwhile", async () => {
    const saved = memoryStorage();
    resetSentChatImagesForTests({ storage: saved });
    await rememberSentChatImage(attachment("local-2"), PHOTO_BASE64);
    // Restart: the in-memory list is empty until the saved one loads.
    resetSentChatImagesForTests({ storage: saved });
    expect(saved.data.has(SENT_CHAT_IMAGES_STORAGE_KEY)).toBe(true);
    previewUrls.set("local-2", "blob:local-2");
    const client = fakeClient();

    await renderImage(reference(PHOTO_ID), client);

    expect(useSentChatImagesStore.getState().hydrated).toBe(true);
    expect(client.fetchAgentImageVariant).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
    expect(shownUri()).toBe("blob:local-2");
  });

  it("falls back to the normal download when the local file is gone", async () => {
    resetSentChatImagesForTests({ storage: memoryStorage() });
    await rememberSentChatImage(attachment("local-3"), PHOTO_BASE64);
    const client = fakeClient();

    await renderImage(reference(PHOTO_ID), client);

    expect(useSentChatImagesStore.getState().byImageId[PHOTO_ID]).toBeUndefined();
    expect(client.fetchAgentImageVariant).toHaveBeenCalledWith(PHOTO_ID, "display");
  });

  it("another device (no local copy) keeps the current path", async () => {
    resetSentChatImagesForTests({ storage: memoryStorage() });
    const client = fakeClient();

    await renderImage(reference(PHOTO_ID), client);

    expect(client.fetchAgentImageVariant).toHaveBeenCalledWith(PHOTO_ID, "display");
    expect(client.readFile).toHaveBeenCalledTimes(1);
  });

  it("an evicted entry takes the normal path again", async () => {
    resetSentChatImagesForTests({ storage: memoryStorage() });
    previewUrls.set("local-4", "blob:local-4");
    await rememberSentChatImage(attachment("local-4"), PHOTO_BASE64);
    forgetSentChatImage(PHOTO_ID);
    const client = fakeClient();

    await renderImage(reference(PHOTO_ID), client);

    expect(client.fetchAgentImageVariant).toHaveBeenCalledWith(PHOTO_ID, "display");
  });
});
