import { APP_DISPLAY_NAME, RELEASE_POLICY } from "@/constants/flavour";
import { isTailnetEndpoint } from "@/hosts/pair-deep-link";
import type { HostConnection } from "@/types/host-connection";

/**
 * Where the app may open a direct (plain ws://, no E2EE) socket, and so send the daemon password
 * (rel-security B1). With ReleasePolicy.tailnetOnly (the public build): only a Tailscale address
 * (*.ts.net or 100.64.0.0/10, where WireGuard encrypts and authenticates the link) or this device's
 * own loopback. A LAN IP, a `.local` name or any other address is refused before a socket is opened,
 * whatever the host's saved connections or a pairing link say. The own build keeps LAN addresses.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = endpoint
    .trim()
    .replace(/^\[([^\]]*)\](:\d+)?$/, "$1")
    .replace(/^([^:]*):\d+$/, "$1")
    .toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export const NON_TAILNET_ENDPOINT_MESSAGE = `${APP_DISPLAY_NAME} connects to your computer only through Tailscale, so it did not use this address. Turn on Tailscale on this phone and on your computer, then pair again from the ${APP_DISPLAY_NAME} setup on your computer.`;

/** Why the app may not open a direct socket to this connection, or null when it may. */
export function directEndpointProblem(
  connection: HostConnection,
  policy: { tailnetOnly: boolean } = RELEASE_POLICY,
): string | null {
  if (connection.type !== "directTcp" || !policy.tailnetOnly) return null;
  if (isTailnetEndpoint(connection.endpoint) || isLoopbackEndpoint(connection.endpoint))
    return null;
  return NON_TAILNET_ENDPOINT_MESSAGE;
}
