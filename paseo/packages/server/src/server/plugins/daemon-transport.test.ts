import { describe, expect, it, vi } from "vitest";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

describe("plugin daemon IPC transport", () => {
  it("preserves incoming text and binary frame order", async () => {
    let receive: ((message: PluginProcessRequest) => void) | null = null;
    const sent: PluginProcessMessage[] = [];
    const factory = createPluginDaemonTransportFactory({
      send(message) {
        sent.push(message);
      },
      onMessage(handler) {
        receive = handler;
        return () => {
          receive = null;
        };
      },
    });
    const transport = factory({ url: "ipc://plugin" });
    const frames: Array<{ data: unknown; isBinary: boolean }> = [];
    transport.onMessage((data, isBinary) => frames.push({ data, isBinary }));
    const opened = new Promise<void>((resolve) => transport.onOpen(resolve));

    await opened;
    receive?.({ type: "paseo_frame", data: "first", isBinary: false });
    receive?.({ type: "paseo_frame", data: new Uint8Array([7, 8]), isBinary: true });
    transport.send("outbound");

    expect(frames).toEqual([
      { data: "first", isBinary: false },
      { data: new Uint8Array([7, 8]), isBinary: true },
    ]);
    expect(sent).toEqual([{ type: "paseo_frame", data: "outbound", isBinary: false, link: 1 }]);
  });

  it("takes only its own link's frames and closes, and names its link", async () => {
    const handlers = new Set<(message: PluginProcessRequest) => void>();
    const receive = (message: PluginProcessRequest) => {
      for (const handler of Array.from(handlers)) handler(message);
    };
    const sent: PluginProcessMessage[] = [];
    const factory = createPluginDaemonTransportFactory({
      send(message) {
        sent.push(message);
      },
      onMessage(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    });
    const first = factory({ url: "ipc://plugin" });
    first.close();
    const second = factory({ url: "ipc://plugin" });
    const frames: unknown[] = [];
    let closed = false;
    second.onMessage((data) => frames.push(data));
    second.onClose(() => {
      closed = true;
    });

    receive({ type: "paseo_frame", data: "for the abandoned link", isBinary: false, link: 1 });
    receive({ type: "paseo_close", link: 1 });
    receive({ type: "paseo_frame", data: "for this link", isBinary: false, link: 2 });
    receive({ type: "paseo_frame", data: "untagged", isBinary: false });

    expect(frames).toEqual(["for this link", "untagged"]);
    expect(closed).toBe(false);
    expect(sent).toEqual([{ type: "paseo_close", link: 1 }]);
    receive({ type: "paseo_close", link: 2 });
    expect(closed).toBe(true);
  });

  it("keeps the process alive when a frame handler throws", () => {
    let receive: ((message: PluginProcessRequest) => void) | null = null;
    const factory = createPluginDaemonTransportFactory({
      send() {},
      onMessage(handler) {
        receive = handler;
        return () => undefined;
      },
    });
    const transport = factory({ url: "ipc://plugin" });
    const frames: unknown[] = [];
    transport.onMessage(() => {
      throw new Error("handler failed");
    });
    transport.onMessage((data) => frames.push(data));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        receive?.({ type: "paseo_frame", data: "frame", isBinary: false, link: 1 }),
      ).not.toThrow();
      expect(frames).toEqual(["frame"]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
