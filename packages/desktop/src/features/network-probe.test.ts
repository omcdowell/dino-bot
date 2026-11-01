import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { listProbeInterfaces, resolveProbeHost, tcpConnectProbe } from "./network-probe";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("network probe", () => {
  it("lists the loopback interface", () => {
    expect(listProbeInterfaces().some((entry) => entry.internal)).toBe(true);
  });

  it("resolves localhost", async () => {
    const result = await resolveProbeHost("localhost");
    expect(result.addresses.length).toBeGreaterThan(0);
  });

  it("tells connected from refused", async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect((await tcpConnectProbe("127.0.0.1", port, 2000)).outcome).toBe("connected");
    expect((await tcpConnectProbe("127.0.0.1", 1, 2000)).outcome).toBe("refused");
  });
});
