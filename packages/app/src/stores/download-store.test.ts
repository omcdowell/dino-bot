import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProfile } from "@/types/host-connection";

const written = vi.hoisted(() => ({ files: [] as Array<{ name: string; bytes: Uint8Array }> }));
const resumable = vi.hoisted(() => ({ created: [] as string[] }));
const shared = vi.hoisted(() => ({ uris: [] as string[] }));

vi.mock("expo-file-system", () => {
  class File {
    readonly uri: string;
    constructor(
      _dir: unknown,
      readonly name: string,
    ) {
      this.uri = `file:///cache/${name}`;
    }
    get exists() {
      return false;
    }
    create() {}
    write(bytes: Uint8Array) {
      written.files.push({ name: this.name, bytes });
    }
  }
  return { File, Paths: { cache: "/cache", document: "/docs" } };
});
vi.mock("expo-file-system/legacy", () => ({
  createDownloadResumable: (url: string) => {
    resumable.created.push(url);
    return { downloadAsync: async () => ({ uri: "file:///cache/http" }) };
  },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => true,
  shareAsync: async (uri: string) => {
    shared.uris.push(uri);
  },
}));
vi.mock("@/constants/platform", () => ({ isWeb: false }));

const { downloadRoute, useDownloadStore } = await import("./download-store");

function host(connections: HostProfile["connections"]): HostProfile {
  return { serverId: "srv", label: "Mac", connections } as unknown as HostProfile;
}

const keyed = host([
  { id: "d", type: "directTcp", endpoint: "100.64.0.2:6767", daemonPublicKeyB64: "KEY" },
] as HostProfile["connections"]);
const keyless = host([
  { id: "d", type: "directTcp", endpoint: "100.64.0.2:6767" },
] as HostProfile["connections"]);
const relayOnly = host([
  { id: "r", type: "relay", relayEndpoint: "relay.example:443", daemonPublicKeyB64: "KEY" },
] as HostProfile["connections"]);

describe("file downloads", () => {
  beforeEach(() => {
    written.files.length = 0;
    resumable.created.length = 0;
    shared.uris.length = 0;
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("route: the encrypted socket for keyed direct and relay hosts; HTTP only for a keyless direct host", () => {
    expect(downloadRoute(keyed)).toBe("socket");
    expect(downloadRoute(relayOnly)).toBe("socket");
    expect(downloadRoute(keyless)).toBe("http");
  });

  it("a keyed host reads the file over the socket: no token, no HTTP URL, bytes written and shared", async () => {
    const requestFileDownloadToken = vi.fn();
    const bytes = new TextEncoder().encode("hello file");
    const progress: number[] = [];
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "ws",
      fileName: "notes.txt",
      path: "docs/notes.txt",
      daemonProfile: keyed,
      requestFileDownloadToken,
      readFileOverSocket: async (path, onProgress) => {
        expect(path).toBe("docs/notes.txt");
        onProgress(5, bytes.length);
        progress.push(
          [...useDownloadStore.getState().downloads.values()][0]?.progress?.bytesWritten ?? -1,
        );
        onProgress(bytes.length, bytes.length);
        return { bytes, mime: "text/plain" };
      },
    });
    expect(requestFileDownloadToken).not.toHaveBeenCalled();
    expect(resumable.created).toEqual([]);
    expect(written.files).toEqual([{ name: "notes.txt", bytes }]);
    expect(shared.uris).toEqual(["file:///cache/notes.txt"]);
    expect(progress).toEqual([5]);
    const [download] = useDownloadStore.getState().downloads.values();
    expect(download?.status).toBe("complete");
  });

  it("a socket read error fails the download with its message", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "ws",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: keyed,
      requestFileDownloadToken: vi.fn(),
      readFileOverSocket: async () => {
        throw new Error("File not found");
      },
    });
    const [download] = useDownloadStore.getState().downloads.values();
    expect(download).toMatchObject({ status: "error", message: "File not found" });
    expect(written.files).toEqual([]);
  });

  it("a keyless direct host keeps the upstream HTTP download", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "ws",
      fileName: "a.txt",
      path: "a.txt",
      daemonProfile: keyless,
      requestFileDownloadToken: async () => ({
        token: "tok",
        fileName: "a.txt",
        mimeType: "text/plain",
        error: null,
      }),
      readFileOverSocket: async () => {
        throw new Error("must not be used");
      },
    });
    expect(resumable.created).toEqual(["http://100.64.0.2:6767/api/files/download?token=tok"]);
    expect(written.files).toEqual([]);
  });
});
