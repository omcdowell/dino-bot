/**
 * Direct-socket end-to-end encryption policy (PASEO_DIRECT_E2EE).
 *
 * Direct sockets always accept the encrypted channel (DIRECT_E2EE_SUBPROTOCOL). The policy only
 * decides what happens to a plaintext WebSocket from another machine:
 * - "optional" (default, upstream behaviour): admitted as before (bearer header or hello).
 * - "required": closed with 4426 "Encrypted connection required: update the app" before any
 *   hello is read. Same-machine clients (loopback, local socket/pipe: CLI, desktop) are exempt.
 *
 * The same rule covers plain-HTTP file downloads (/api/files/download): with "required" the app
 * reads files over the encrypted socket instead, and a download from another machine gets 426.
 *
 * An old app that still sends the password in clear has already sent it by the time the daemon
 * refuses it; "required" makes that app fail visibly instead of working insecurely.
 */
export type DirectE2eePolicy = "optional" | "required";

/** What a refused plaintext client is told (WebSocket close 4426, HTTP 426). */
export const DIRECT_E2EE_REQUIRED_MESSAGE = "Encrypted connection required: update the app";

interface RequestSocketLike {
  socket?: { remoteAddress?: string; localAddress?: string } | null;
}

/**
 * A request from this machine: a local socket/pipe (no remote address), loopback TCP, or TCP to
 * one of this machine's own addresses (the installer listens on the tailnet IP only, so the local
 * CLI and bots connect from that IP to that IP). None of these bytes leave the machine.
 */
export function isSameMachineRequest(request: RequestSocketLike): boolean {
  const remoteAddress = request.socket?.remoteAddress;
  if (!remoteAddress) return true;
  return isLoopbackAddress(remoteAddress) || remoteAddress === request.socket?.localAddress;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return ipv4.startsWith("127.");
}

export function directE2eePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): DirectE2eePolicy {
  return (env.PASEO_DIRECT_E2EE ?? "").trim().toLowerCase() === "required"
    ? "required"
    : "optional";
}
