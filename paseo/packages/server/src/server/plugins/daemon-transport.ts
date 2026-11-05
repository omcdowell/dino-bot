import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

interface PluginProcessPort {
  send(message: PluginProcessMessage): void;
  onMessage(handler: (message: PluginProcessRequest) => void): () => void;
}

function normalizeFrame(data: string | Uint8Array | ArrayBuffer): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * Each transport is one link: a session with the daemon over the shared IPC channel. A frame or
 * close the daemon tags with another link belongs to a session this transport never had (one
 * the client abandoned while the daemon was still sending on it), so it is dropped here rather
 * than fed to a decoder whose history it does not match.
 */
export function createPluginDaemonTransportFactory(
  port: PluginProcessPort,
): DaemonTransportFactory {
  let lastLink = 0;
  return () => {
    const link = ++lastLink;
    const messageHandlers = new Set<(data: unknown, isBinary: boolean) => void>();
    const openHandlers = new Set<() => void>();
    const closeHandlers = new Set<(event?: unknown) => void>();
    let isOpen = true;
    const isForThisLink = (message: { link?: number }) =>
      message.link === undefined || message.link === link;
    const unsubscribe = port.onMessage((message) => {
      if (message.type === "paseo_frame" && isForThisLink(message)) {
        for (const handler of messageHandlers) {
          // An uncaught throw here would end the plugin process: report it and keep going.
          try {
            handler(message.data, message.isBinary);
          } catch (error) {
            console.error("Plugin daemon transport handler failed", error);
          }
        }
      }
      if (message.type === "paseo_close" && isForThisLink(message)) closeTransport();
    });

    function closeTransport(): void {
      if (!isOpen) return;
      isOpen = false;
      unsubscribe();
      for (const handler of closeHandlers) handler();
    }

    queueMicrotask(() => {
      if (!isOpen) return;
      for (const handler of openHandlers) handler();
    });

    return {
      send(data) {
        if (!isOpen) throw new Error("Plugin daemon transport is closed");
        const frame = normalizeFrame(data);
        port.send({ type: "paseo_frame", data: frame, isBinary: typeof frame !== "string", link });
      },
      close() {
        if (!isOpen) return;
        port.send({ type: "paseo_close", link });
        closeTransport();
      },
      onMessage(handler) {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onOpen(handler) {
        openHandlers.add(handler);
        return () => openHandlers.delete(handler);
      },
      onClose(handler) {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
      onError() {
        return () => undefined;
      },
    };
  };
}
