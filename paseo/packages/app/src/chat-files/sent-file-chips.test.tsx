import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { SentFileChips } from "./sent-file-chips";

const { theme, startDownload, readFile } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 8, lg: 10, xl: 12 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400", medium: "500" },
    colors: new Proxy({}, { get: () => "#888" }),
  },
  startDownload: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), mime: "" })),
}));

const CLIENT = { readFile } as unknown as DaemonClient;

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (component: unknown) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.fileName ? `${key}:${values.fileName}` : key,
  }),
}));

vi.mock("@/components/material-file-icon", () => ({
  MaterialFileIcon: ({ fileName }: { fileName: string }) =>
    React.createElement("span", { "data-file-icon": fileName }),
}));

vi.mock("@/stores/download-store", () => ({
  useDownloadStore: (select: (state: { startDownload: typeof startDownload }) => unknown) =>
    select({ startDownload }),
}));

const REPORT = {
  fileName: "quarterly-financial-report-final-v3.pdf",
  mimeType: "application/pdf",
  size: 48213,
  path: "/srv/paseo/uploads/upload_1/quarterly-financial-report-final-v3.pdf",
};

const FILES = [REPORT];
const NO_FILES: typeof FILES = [];

let root: Root | null = null;
let container: HTMLElement | null = null;

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
  startDownload.mockClear();
  readFile.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function render(element: React.ReactElement) {
  act(() => root?.render(element));
}

function chip(): HTMLElement {
  const found = container?.querySelector<HTMLElement>('[data-testid="sent-file-chip"]');
  if (!found) throw new Error("no file chip");
  return found;
}

describe("sent file chips", () => {
  it("shows each file's icon, shortened name, type and size", () => {
    render(<SentFileChips files={FILES} />);
    expect(chip().querySelector("[data-file-icon]")?.getAttribute("data-file-icon")).toBe(
      REPORT.fileName,
    );
    expect(chip().textContent).toContain("quarterly-financi…l-v3.pdf");
    expect(chip().textContent).toContain("47 KB");
  });

  it("renders nothing for no files", () => {
    render(<SentFileChips files={NO_FILES} />);
    expect(container?.querySelector('[data-testid="user-message-files"]')).toBeNull();
  });

  it("tapping a chip reads the file back over the host connection and hands it to the download", async () => {
    render(<SentFileChips files={FILES} serverId="server-1" client={CLIENT} />);

    expect(chip().getAttribute("aria-label")).toBe(
      `message.attachments.downloadFile:${REPORT.fileName}`,
    );
    act(() => chip().click());

    expect(startDownload).toHaveBeenCalledTimes(1);
    const request = (startDownload.mock.calls[0] as unknown[])[0] as {
      serverId: string;
      fileName: string;
      path: string;
      daemonProfile: unknown;
      readFileOverSocket: (
        path: string,
        onProgress: () => void,
      ) => Promise<{ bytes: Uint8Array; mime: string }>;
    };
    expect(request).toMatchObject({
      serverId: "server-1",
      fileName: REPORT.fileName,
      path: REPORT.path,
      daemonProfile: undefined,
    });
    const onProgress = vi.fn();
    const read = await request.readFileOverSocket(request.path, onProgress);
    expect(readFile).toHaveBeenCalledWith("/", REPORT.path, undefined, undefined, { onProgress });
    expect(read).toEqual({ bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" });
  });

  it("without a host connection the chip shows but does not download", () => {
    render(<SentFileChips files={FILES} />);
    act(() => chip().click());
    expect(startDownload).not.toHaveBeenCalled();
  });
});
