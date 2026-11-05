import type { DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { DirectTcpHostConnection } from "@/types/host-connection";

/**
 * Shown when the public app has a direct connection to another machine without a daemon key
 * (a connection saved before pairing carried keys, or typed in by hand): the app will not send
 * the password over it, because nothing proves who is at that address.
 */
export const DIRECT_KEY_MISSING_MESSAGE =
  "This connection has no security key, so the app will not send your password over it. " +
  "Pair again by scanning the QR code from your computer.";

function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim().toLowerCase();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  const colon = trimmed.lastIndexOf(":");
  return colon > 0 ? trimmed.slice(0, colon) : trimmed;
}

/** localhost, 127.x and ::1: a daemon on this device, where the bytes never leave it. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = endpointHost(endpoint);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Client E2EE settings for a direct TCP connection.
 *
 * With the daemon key from pairing, the socket runs the encrypted channel: the client sends only
 * the handshake until the daemon proves that key, and the password travels only inside it.
 * Without a key, the connection stays plaintext (upstream behaviour) unless `required` is set
 * (public flavour) and the endpoint is another machine; then this throws before any socket opens.
 */
export function directTcpE2eeConfig(
  connection: Pick<DirectTcpHostConnection, "endpoint" | "daemonPublicKeyB64">,
  options: { required: boolean },
): Pick<DaemonClientConfig, "e2ee"> {
  const daemonPublicKeyB64 = connection.daemonPublicKeyB64?.trim();
  if (daemonPublicKeyB64) {
    return {
      e2ee: { enabled: true, daemonPublicKeyB64, minimumMode: "protected" },
    };
  }
  if (options.required && !isLoopbackEndpoint(connection.endpoint)) {
    throw new Error(DIRECT_KEY_MISSING_MESSAGE);
  }
  return {};
}
